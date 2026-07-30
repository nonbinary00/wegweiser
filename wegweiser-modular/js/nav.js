// ==================== Navigations-Zustandsmaschine ====================
// Verbatim aus wegweiser-v13.html (Abschnitte "ZUSTANDSMODELL" und "NAVIGATION").
// Zwei Relozierungen, wie in der genehmigten Abhaengigkeitskarte vermerkt:
//  - emaDist war urspruenglich bei den Laufzeit-Variablen deklariert (Zeile 2562),
//    wird aber ausschliesslich von der Zustandsmaschine gelesen/geschrieben/zurueckgesetzt
//    (resetSegmentState, handleLostStopped) -> hierher verschoben, direkt neben minTrackDist.
//  - NAV_DEBUG wird aus config.js importiert statt hier neu deklariert (Stufe 2).
// Zirkelbezug nav.js <-> ui.js (updatePanel) ist genehmigt (Entscheidung 2).

import { SETTINGS, NAV_DEBUG } from './config.js';
import { NODES, START_TEXTS, ARRIVALS, OFF_ROUTE_HINTS } from './graph-data.js';
import { EDGE_MAP, findPath, markerName, pathToText, isTurnAction, departureActionSpeech } from './graph.js';
import { destSel, uiState } from './dom.js';
import { say, speaking, buzz } from './speech.js';
import { updatePanel } from './ui.js';
import { W, H } from './frame-state.js';
import { record, getTestName } from './logger.js';

  // ==================== ZUSTANDSMODELL ====================
  // Kernschleife pro Abschnitt A->B:
  //   SEARCHING_NEXT_TAG -> (Tag B bestätigt) -> TRACKING
  //   TRACKING: Distanz sinkt -> Zwischenansagen; <= Schwelle -> Punkt erreicht
  //   TRACKING: Tag > 1,3 s weg -> LOST_STOPPED ("Stopp ...") -> wieder gefunden -> TRACKING
  var NavState = {
    IDLE: "IDLE",
    SEARCHING_START_TAG: "SEARCHING_START_TAG",
    TAG_CANDIDATE: "TAG_CANDIDATE",
    SEARCHING_NEXT_TAG: "SEARCHING_NEXT_TAG",
    TRACKING: "TRACKING",
    LOST_STOPPED: "LOST_STOPPED",
    DESTINATION_REACHED: "DESTINATION_REACHED"
  };

  var navState = NavState.IDLE;
  var destinationId = null;
  var pathTagIds = null;
  var segIndex = -1;              // Index der aktuellen Kante: path[segIndex]->path[segIndex+1]
  var currentTagId = null;        // zuletzt ERREICHTER Knoten
  var expectedNextTagId = null;   // Tag, der voraus liegt (B der aktuellen Kante)
  var navigationActive = false;
  var destinationReached = false;

  var lastRouteInstruction = "";
  var expectedLastSeenAt = 0;
  var searchStartedAt = 0;
  var scanHintCount = 0;
  var lastScanHintAt = 0;
  var currentScanDelayMs = 8000;
  var candLastSeenAt = 0;
  var lastExpectedVis = null;
  var lastWrongTagAt = 0;
  var wrongCandId = null, wrongCandCount = 0;
  var candId = null, candCount = 0;
  var lastAimZone = null, lastAimAt = 0;

  // Tracking-Zustand

  // v13: emaDist war urspruenglich Zeile 2562 (Abschnitt "Laufzeit"), hierher verschoben,
  // da es Teil des Tracking-Zustands ist (siehe Kommentar oben).
  var emaDist = null;
  var minTrackDist = null;        // kleinste gemessene Distanz (Fortschrittsreferenz)
  var rawRecent = [];             // v13: letzte N Roh-Distanzen (Fenster fuer "juengstes Minimum")
  var lastRawDist = null;         // v13: letzte gueltige Roh-Distanz
  var lastRawAt = 0;              // v13: Zeitpunkt der letzten gueltigen Messung
  var trackDetCount = 0;          // v13: Anzahl gueltiger Messungen im aktuellen Abschnitt
  var trackingConfirmed = false;  // neu: erst nach SETTINGS.trackingConfirmDetections
                                   // gueltigen Messungen darf ueberhaupt "verloren" gemeldet werden
  var arrivalBelowCount = 0;      // v13: Frames in Folge mit arrivalDistance <= Schwelle
  var lastTrackDbgAt = 0;         // v13: Drossel fuer Debug-Log
  var lastProgressAt = 0;
  var awayWarned = false;
  var stopSaidAt = 0;
  var offRouteSaid = {};          // fremde Tags: höchstens EINMAL pro Abschnitt melden
  var lostInstructionSpoken = false; // neu: ob in der aktuellen Verlust-Episode bereits
                                      // eine Stopp-/Verlust-Ansage erfolgt ist (steuert,
                                      // ob die Wiederfindung "Weitergehen." ansagt)

  // ---- Geradeaus-Lauf (ROUTEN-Zustand — bewusst NICHT in resetSegmentState()) ----
  // Ein "Lauf" kann mehrere aufeinanderfolgende Kanten mit departureAction "continue-straight"
  // umfassen (z.B. 3->6->4->7 ist geometrisch EIN gerader Korridor, obwohl im Graphen als
  // drei Kanten modelliert). Diese Variablen ueberleben daher Abschnittswechsel und werden
  // NUR bei einem echten Abbiegen, Routenstart/-abbruch oder Zielankunft zurueckgesetzt
  // (siehe resetStraightRunState()). Vereinfacht ggue. der fruehren Fassung: JEDE
  // Zwischen-Tag-Ansage ist jetzt immer die volle "Gehen Sie weiter geradeaus." (siehe
  // reachPoint()) — es gibt keine Alternation/Wiederholungssperre mehr dafuer. Einzige
  // verbleibende Zusatzfunktion: auf einem sehr langen geraden Korridor darf WAEHREND
  // des Gehens (nicht erst beim naechsten Tag) hoechstens EINMAL eine kurze Rueckmeldung
  // "Weiter geradeaus." erfolgen (siehe handleTracking()).
  var straightRunTotalM = null;         // Gesamtlaenge des aktuellen Laufs (mehrere Kanten), oder null
  var straightRunProgressM = 0;         // bereits ABGESCHLOSSENE Kantenlaenge seit Laufbeginn
  var straightRunReassured = false;     // wurde die einmalige Zwischen-Rueckmeldung fuer
                                         // diesen Lauf bereits gesprochen?

  function resetStraightRunState(){
    straightRunTotalM = null;
    straightRunProgressM = 0;
    straightRunReassured = false;
  }

  // ---- Instrumentierung (neu, nur fuer Feldtest-Logging) ----
  // Diese Variablen beeinflussen KEINE Navigationsentscheidung; sie werden ausschliesslich
  // gelesen, um SEGMENT_SUMMARY/ROUTE_*-Ereignisse mit Zahlen zu fuellen.
  var routeRunId = null;          // eine Id pro Routenlauf, gesetzt in startNavigation()
  var segLostCount = 0;           // Anzahl LOST_STOPPED-Uebergaenge im aktuellen Abschnitt
  var segReacquireCount = 0;      // Anzahl Wiederfindungen im aktuellen Abschnitt
  var segLostMs = 0;              // Summe der Zeit (ms) im aktuellen Abschnitt in LOST_STOPPED
  var segLostSince = null;        // Zeitpunkt des aktuellen Verlusts (falls gerade verloren)
  var segTrackingStartedAt = null;// Zeitpunkt, an dem TRACKING fuer diesen Abschnitt begann

  function generateRouteRunId(){
    return "run_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  }

  function setNavState(s){
    navState = s;
    uiState.textContent = s;
  }
  function currentEdge(){
    if(!pathTagIds || segIndex < 0 || segIndex >= pathTagIds.length - 1) return null;
    return EDGE_MAP[pathTagIds[segIndex] + "->" + pathTagIds[segIndex + 1]];
  }

  // ---- Cross-Modul-Mutatoren (neu, mechanisch; siehe genehmigte Abhaengigkeitskarte) ----
  // main-loop.js (tick) und app.js (flipBtn) muessen expectedLastSeenAt, candLastSeenAt,
  // lastExpectedVis, wrongCandId/wrongCandCount, candId/candCount bzw. emaDist von
  // ausserhalb dieses Moduls schreiben. ES-Module erlauben nur dem deklarierenden Modul
  // das Neuzuweisen exportierter Bindungen; jede Funktion hier ist ein reiner 1:1-Wrapper
  // um genau die Original-Zuweisung (kein geaendertes Verhalten). Lesend greifen andere
  // Module weiterhin ueber die (live gebundenen) Exports der Variablen selbst zu.
  function touchExpectedSeen(now){ expectedLastSeenAt = now; }
  function touchCandidateSeen(now){ candLastSeenAt = now; }
  function setLastExpectedVisual(v){ lastExpectedVis = v; }
  function setWrongCandidate(id, count){ wrongCandId = id; wrongCandCount = count; }
  function setCandidate(id, count){ candId = id; candCount = count; }
  function setEmaDist(v){ emaDist = v; }

  // ==================== NAVIGATION ====================
  function resetSegmentState(){
    searchStartedAt = performance.now();
    expectedLastSeenAt = 0;
    scanHintCount = 0;
    lastScanHintAt = 0;
    candLastSeenAt = 0;
    lastExpectedVis = null;
    wrongCandId = null; wrongCandCount = 0;
    candId = null; candCount = 0;
    lastAimZone = null; lastAimAt = 0;
    minTrackDist = null;
    lastProgressAt = 0;
    awayWarned = false;
    stopSaidAt = 0;
    offRouteSaid = {};
    lostInstructionSpoken = false;
    emaDist = null;
    rawRecent = [];                  // v13
    lastRawDist = null; lastRawAt = 0;
    trackDetCount = 0;
    trackingConfirmed = false;
    arrivalBelowCount = 0;
    lastTrackDbgAt = 0;
    // ---- Instrumentierung (neu): pro Abschnitt zuruecksetzen ----
    segLostCount = 0;
    segReacquireCount = 0;
    segLostMs = 0;
    segLostSince = null;
    segTrackingStartedAt = null;
    resetSkipCandidate();
  }


  // ---- Instrumentierung (neu): reine ES5-Kopie von `data` + routeRunId angehaengt,
  // ohne die existierenden Aufrufstellen von navLog() anzufassen. ----
  function mergeRouteRunId(data){
    var merged = {};
    if(data){
      for(var k in data){
        if(Object.prototype.hasOwnProperty.call(data, k)) merged[k] = data[k];
      }
    }
    merged.routeRunId = routeRunId;
    return merged;
  }

  function navLog(msg, data){
    record(msg, mergeRouteRunId(data));
    if(!NAV_DEBUG) return;
    try{ console.log("[NavDbg " + Math.round(performance.now()) + "ms] " + msg,
                     data ? JSON.stringify(data) : ""); }catch(e){}
  }
  function r1(v){ return v == null ? null : Math.round(v * 100) / 100; }

  function startNavigation(){
    var destId = destSel.value ? parseInt(destSel.value, 10) : null;
    if(destId == null || !NODES[destId] || !NODES[destId].destination){
      say("Bitte wählen Sie zuerst ein Ziel.", {interrupt:true});
      return;
    }
    destinationId = destId;
    pathTagIds = null;
    segIndex = -1;
    currentTagId = null;
    expectedNextTagId = null;
    navigationActive = true;
    destinationReached = false;
    lastRouteInstruction = "";
    resetSegmentState();
    resetStraightRunState();
    currentScanDelayMs = SETTINGS.scanHintAfterMs;
    setNavState(NavState.SEARCHING_START_TAG);
    updatePanel(null);
    say("Ziel gewählt: " + markerName(destId) + ". Richten Sie das Smartphone auf die " +
        "nächste Markierung in Ihrer Nähe. Von dort wird die Route berechnet.",
        {interrupt:true});
    // ---- Instrumentierung (neu) ----
    routeRunId = generateRouteRunId();
    navLog("ROUTE_START", { destinationId: destId, destination: markerName(destId),
      testName: getTestName() });
  }

  function endNavigation(announce){
    // ---- Instrumentierung (neu): vor dem Zuruecksetzen erfassen, ob eine laufende
    // (noch nicht angekommene) Route abgebrochen wird. ----
    var wasCancelled = navigationActive && !destinationReached;
    navigationActive = false;
    pathTagIds = null;
    segIndex = -1;
    currentTagId = null;
    expectedNextTagId = null;
    destinationId = null;
    destinationReached = false;
    resetSegmentState();
    resetStraightRunState();
    setNavState(NavState.IDLE);
    updatePanel(null);
    if(announce) say("Navigation beendet.", {interrupt:true});
    // ---- Instrumentierung (neu) ----
    if(wasCancelled) navLog("ROUTE_CANCELLED", {});
    routeRunId = null;
  }

  // Abschnitt segIndex beginnen: nach dem Tag am ENDE der Kante suchen.
  function beginSegment(){
    var edge = currentEdge();
    var fromTag = pathTagIds[segIndex];
    expectedNextTagId = pathTagIds[segIndex + 1];
    resetSegmentState();
    setNavState(NavState.SEARCHING_NEXT_TAG);
    updatePanel(null);
    // ---- Instrumentierung (neu) ----
    navLog("SEGMENT_START", { segIndex: segIndex, fromTag: fromTag, toTag: expectedNextTagId });
  }

  // Startknoten bestätigt: Route berechnen und ersten Abschnitt beginnen.
  function onStartTagConfirmed(tagId){
    if(tagId === destinationId){
      arriveAtDestination();
      return;
    }
    var p = findPath(tagId, destinationId);
    if(!p){
      var t = (OFF_ROUTE_HINTS[tagId] || ("Sie sind bei " + markerName(tagId) + ".")) +
              " Von hier ist noch kein Weg zum Ziel beschrieben. " +
              "Bitte gehen Sie zum Eingang und suchen Sie Tag 1.";
      say(t, {interrupt:true});
      setNavState(NavState.SEARCHING_START_TAG);
      return;
    }
    pathTagIds = p;
    segIndex = 0;
    currentTagId = tagId;
    console.log("[Route] " + pathToText(p));
    var start = START_TEXTS[tagId] ||
      ("Sie sind bei " + markerName(tagId) + ". Halten Sie das Smartphone vor sich " +
       "und suchen Sie die nächste Markierung.");
    lastRouteInstruction = start;
    say("Route berechnet. " + start, {interrupt:true});
    // ---- Instrumentierung (neu) ----
    navLog("ROUTE_PATH", { startTag: tagId, path: p, pathText: pathToText(p) });
    beginSegment();
  }

  // Erwarteter Tag der aktuellen Kante erstmals bestätigt -> TRACKING beginnt. KEINE
  // automatische "Orientierungspunkt gefunden"-Ansage (rein technisches Kamera-/Marker-
  // Ereignis) — stattdessen eine kurze, optionale Vibration fuer Zwischen-Tags (NIE fuer
  // das Ziel selbst). lastRouteInstruction bleibt bewusst auf der zuletzt gesprochenen
  // Handlungsanweisung stehen, bis am naechsten reachPoint() eine neue Handlung noetig
  // ist. Die Vibration ist rein optionales Feedback: auf Geraeten ohne Vibrations-API
  // (z.B. iPhone/Safari) ist buzz() ein No-Op (siehe speech.js) — unschaedlich, weil die
  // eigentliche Anweisung erst SPAETER, unabhaengig davon, bei reachPoint() gesprochen
  // wird (siehe dort).
  function onNextTagFound(dist){
    var edge = currentEdge();
    setNavState(NavState.TRACKING);
    minTrackDist = dist != null ? dist : null;
    lastProgressAt = performance.now();
    awayWarned = false;
    if(expectedNextTagId !== destinationId) buzz(50);
    // Geradeaus-Lauf ueber mehrere Kanten hinweg erkennen: nur wenn noch kein Lauf aktiv
    // ist (sonst laeuft bereits einer, siehe reachPoint()). Die AKTUELL verfolgte Kante
    // gehoert IMMER zum (moeglicherweise gerade erst beginnenden) Lauf dazu — auch wenn
    // SIE SELBST mit einem Abbiegen beginnt (das Abbiegen passierte ja bereits beim
    // vorherigen reachPoint()-Aufruf; diese Kante wird DANACH geradeaus gegangen). Danach
    // wird nur so lange weitergeschaut, wie KEINE weitere Kante ein Abbiegen erfordert.
    // Reine Vorausschau ueber bereits bekannte EDGE_MAP-Distanzen entlang des
    // BERECHNETEN Pfads — keine neue Kamera-Messung, keine Graph-Aenderung. Wird fuer
    // die einmalige Zwischen-Rueckmeldung auf sehr langen Korridoren gebraucht (siehe
    // handleTracking()).
    if(edge && straightRunTotalM == null){
      var totalM = edge.distanceM || 0;
      var i = segIndex + 1;
      while(i < pathTagIds.length - 1){
        var e2 = EDGE_MAP[pathTagIds[i] + "->" + pathTagIds[i + 1]];
        if(!e2 || isTurnAction(e2)) break;
        totalM += e2.distanceM || 0;
        i++;
      }
      straightRunTotalM = totalM;
    }
    updatePanel(dist);
    // ---- Instrumentierung (neu) ----
    segTrackingStartedAt = performance.now();
    navLog("TTS_SUPPRESSED_MARKER_FOUND", { expectedTag: expectedNextTagId,
      isDestination: expectedNextTagId === destinationId,
      buzzed: expectedNextTagId !== destinationId });
  }

  // Punkt erreicht (Distanz <= Schwelle, Near-Loss-Fallback oder kontrollierter Skip).
  function reachPoint(reason){
    var edge = currentEdge();
    var reachedTagId = pathTagIds[segIndex + 1];
    currentTagId = reachedTagId;

    // ---- Instrumentierung (neu): Zusammenfassung des GERADE abgeschlossenen Abschnitts,
    // ausschliesslich aus bereits vorhandenen nav.js-Variablen, keine Duplizierung.
    // reachPoint() wird jetzt IMMER ganz normal aufgerufen (auch nach einem zuvor
    // bestaetigten Vorgriffs-Kandidaten, siehe beginTrackingForwardCandidate() — dort
    // wird NICHT reachPoint() aufgerufen, sondern nur der verfolgte Tag umgeschaltet).
    // Es gibt daher keinen Sonderfall mehr, der diese SEGMENT_SUMMARY unterdruecken
    // muesste. ----
    navLog("SEGMENT_SUMMARY", {
      segIndex: segIndex,
      fromTag: pathTagIds[segIndex],
      toTag: reachedTagId,
      reason: reason || "distance-threshold",
      edgeDistanceM: edge ? edge.distanceM : null,
      lastRawDist: r1(lastRawDist),
      lastEma: r1(emaDist),
      minSegDist: r1(minTrackDist),
      trackingDurationMs: segTrackingStartedAt != null ?
        Math.round(performance.now() - segTrackingStartedAt) : null,
      detectionCount: trackDetCount,
      lostCount: segLostCount,
      reacquireCount: segReacquireCount,
      lostTotalMs: Math.round(segLostMs),
      awayWarned: awayWarned
    });

    if(reachedTagId === destinationId){
      navLog("REACHED destination", { tag: reachedTagId, reason: reason || "distance-threshold" });
      arriveAtDestination();
      return;
    }
    // neu: Zwischen-Tag (nicht das Ziel) — NUR die kurze Handlungsanweisung sprechen,
    // KEINE Orts-/Tuerbeschreibung mehr automatisch (edge.reached bleibt als Doku/
    // Fallback im Datensatz erhalten, wird hier aber bewusst nicht mehr verwendet).
    // WICHTIG: die Handlung gehoert zur AUSGEHENDEN Kante ab reachedTagId (naechster
    // Schritt der GEWAEHLTEN Route), NICHT zur soeben abgeschlossenen eingehenden Kante
    // "edge" (= currentEdge(), pathTagIds[segIndex]->reachedTagId). Siehe departureAction-
    // Kommentar in graph-data.js: eine Kante X->Y beschreibt die Handlung BEI X, um nach
    // Y zu gehen — reachedTagId ist hier das neue X, pathTagIds[segIndex+2] das neue Y.
    // reachedTagId ist an dieser Stelle garantiert NICHT das Ziel (siehe Check oben),
    // also existiert in der berechneten Route immer ein naechster Tag danach.
    var nextEdge = EDGE_MAP[reachedTagId + "->" + pathTagIds[segIndex + 2]];
    var isTurn = isTurnAction(nextEdge);
    var t = departureActionSpeech(nextEdge);
    lastRouteInstruction = t;

    if(isTurn){
      // Echtes Abbiegen: genau einmal ansagen, danach jeden laufenden Geradeaus-Lauf
      // beenden. Die optionale einmalige Korridor-Rueckmeldung ("Weiter geradeaus.")
      // lebt ausschliesslich in handleTracking() — hier nicht dupliziert.
      say(t, {interrupt:true});
      navLog("TTS_DIRECTION", { reachedTag: reachedTagId, action: nextEdge.departureAction,
        isTurn: true, text: t });
      resetStraightRunState();
    } else {
      // Kein Abbiegen: die soeben abgeschlossene Kante zum laufenden Korridor-Fortschritt
      // addieren (straightRunProgressM wird von handleTracking() fuer die getrennte,
      // EINMALIGE Zwischen-Rueckmeldung auf sehr langen Korridoren gebraucht), dann
      // bedingungslos genau EINMAL "Gehen Sie weiter geradeaus." ansagen — keine
      // Alternation, keine Wiederholungssperre, keine Unterdrueckung dieser Ansage.
      straightRunProgressM += (edge && edge.distanceM != null) ? edge.distanceM : 0;
      say(t, {interrupt:true});
      navLog("TTS_DIRECTION", { reachedTag: reachedTagId, action: nextEdge.departureAction,
        isTurn: false, text: t, straightRunProgressM: r1(straightRunProgressM) });
    }
    segIndex++;
    // beginSegment() setzt expectedNextTagId SOFORT auf den naechsten Tag und
    // wechselt in SEARCHING_NEXT_TAG — ab dem naechsten Frame wird er erkannt.
    beginSegment();
    navLog("REACHED -> next segment", { reachedTag: reachedTagId,
      reason: reason || "distance-threshold", newExpectedTag: expectedNextTagId,
      state: navState });
  }

  function arriveAtDestination(){
    destinationReached = true;
    navigationActive = false;
    expectedNextTagId = null;
    resetStraightRunState();
    var t = ARRIVALS[destinationId] || ("Ziel erreicht. Sie sind bei " + markerName(destinationId) + ".");
    lastRouteInstruction = t;
    setNavState(NavState.DESTINATION_REACHED);
    say(t, {interrupt:true});
    updatePanel(null);
    // ---- Instrumentierung (neu) ----
    navLog("ROUTE_END", { destinationId: destinationId, reason: "arrived" });
    navLog("TTS_DESTINATION", { destinationId: destinationId, text: t });
  }

  // ---- TRACKING: laufende Distanzmessung zum Tag voraus ----
  // v13: rawDist = frische Roh-Messung dieses Frames (oder null).
  function handleTracking(now, visible, rawDist){
    var edge = currentEdge();
    var reachedM = (edge && edge.reachedM != null) ? edge.reachedM : SETTINGS.reachedM;

    // v13: Roh-Messungen protokollieren (Fenster der letzten N)
    if(rawDist != null){
      lastRawDist = rawDist; lastRawAt = now;
      trackDetCount++;
      rawRecent.push(rawDist);
      if(rawRecent.length > SETTINGS.rawWindowN) rawRecent.shift();
      // neu: Tracking gilt erst als bestaetigt, wenn der erwartete Tag mindestens
      // trackingConfirmDetections mal gueltig gemessen wurde. Vorher darf kein
      // Verlust ("TAG LOST"/LOST_STOPPED/Stopp-Ansage/REACQUIRED) ausgeloest werden.
      if(!trackingConfirmed && trackDetCount >= SETTINGS.trackingConfirmDetections){
        trackingConfirmed = true;
        navLog("TRACKING_CONFIRMED", { expectedTag: expectedNextTagId,
          detections: trackDetCount, raw: r1(rawDist), ema: r1(emaDist) });
      }
    }
    var recentMin = rawRecent.length ? Math.min.apply(null, rawRecent) : null;

    if(visible && emaDist != null){
      // v13: Ankunftsdistanz = min(Roh, EMA). Die EMA hinkt beim schnellen
      // Annaehern hinterher; die Roh-Messung allein kann ausreissen.
      // Schutz vor Ausreissern: Schwelle muss in arrivalConfirmFrames
      // aufeinanderfolgenden Frames MIT frischer Messung unterschritten sein.
      var arrival = emaDist;
      if(rawDist != null && rawDist < arrival) arrival = rawDist;

      // Debug: ~1x pro Sekunde Zustand loggen
      if(now - lastTrackDbgAt >= 1000){
        lastTrackDbgAt = now;
        navLog("TRACK", { expectedTag: expectedNextTagId, raw: r1(rawDist),
          ema: r1(emaDist), recentMin: r1(recentMin), arrival: r1(arrival),
          minSeg: r1(minTrackDist), reachedM: reachedM,
          lastSeenMsAgo: Math.round(now - expectedLastSeenAt) });
      }

      if(rawDist != null && arrival <= reachedM){
        arrivalBelowCount++;
        if(arrivalBelowCount >= SETTINGS.arrivalConfirmFrames){
          navLog("REACHED reason=distance-threshold", { expectedTag: expectedNextTagId,
            raw: r1(rawDist), ema: r1(emaDist), recentMin: r1(recentMin),
            arrival: r1(arrival), minSeg: r1(minTrackDist), reachedM: reachedM });
          reachPoint("distance-threshold");
          return;
        }
      } else if(rawDist != null){
        arrivalBelowCount = 0;
      }
      // Fortschritt (Distanz sinkt): Referenzminimum pflegen
      // v13: auch mit Roh-Minimum, nicht nur EMA
      if(minTrackDist == null || emaDist < minTrackDist){
        minTrackDist = emaDist;
        awayWarned = false;
      }
      if(rawDist != null && recentMin != null &&
         (minTrackDist == null || recentMin < minTrackDist)){
        minTrackDist = recentMin;
        awayWarned = false;
      }
      // Einmalige Zwischen-Rueckmeldung WAEHREND einer laufenden Geradeaus-Kante, NUR
      // auf einem genuegend langen zusammenhaengenden Korridor (SETTINGS.longCorridorMinM)
      // — kurze Abschnitte bekommen ihre einzige Rueckmeldung bereits bei Ankunft
      // (reachPoint()). Hoechstens EINMAL pro Lauf (straightRunReassured), keine
      // Wiederholung, keine Alternation mit der Ansage bei reachPoint(). Nicht-interrupt:
      // darf keine wichtigere Ansage (Stopp/Ziel/Abbiegen) ueberschreiben — emaDist >
      // reachedM + 0.5 haelt Abstand zur bevorstehenden Ankunfts-Ansage; die zusaetzliche
      // nearTarget-Pruefung unterdrueckt sie zusaetzlich kurz vor dem gewaehlten Ziel.
      if(edge && straightRunTotalM != null &&
         straightRunTotalM >= SETTINGS.longCorridorMinM && edge.distanceM != null){
        var withinEdgeM = Math.max(0, edge.distanceM - emaDist);
        var liveProgressM = straightRunProgressM + withinEdgeM;
        var nearTarget = expectedNextTagId === destinationId &&
                          arrival < SETTINGS.longCorridorNoReassuranceNearTargetM;
        if(!straightRunReassured && !nearTarget &&
           liveProgressM >= SETTINGS.longCorridorFirstProgressM &&
           emaDist > reachedM + 0.5 &&
           (now - lastProgressAt) >= SETTINGS.progressMinGapMs && !speaking()){
          if(say("Weiter geradeaus.", {})){
            lastProgressAt = now;
            straightRunReassured = true;
            navLog("TTS_PROGRESS_REASSURANCE", { expectedTag: expectedNextTagId,
              segIndex: segIndex, liveProgressM: r1(liveProgressM), emaDist: r1(emaDist),
              text: "Weiter geradeaus.", reason: "long-corridor-progress" });
          }
        } else if(nearTarget){
          navLog("TTS_PROGRESS_REASSURANCE_SUPPRESSED_NEAR_TARGET", {
            expectedTag: expectedNextTagId, segIndex: segIndex,
            liveProgressM: r1(liveProgressM), arrival: r1(arrival),
            thresholdM: SETTINGS.longCorridorNoReassuranceNearTargetM });
        }
      }
      // Distanz steigt deutlich über das Minimum -> Nutzer entfernt sich
      if(!awayWarned && minTrackDist != null &&
         emaDist - minTrackDist >= SETTINGS.awayDeltaM && !speaking()){
        if(say("Sie entfernen sich von der Markierung. Bleiben Sie stehen.", {}))
          awayWarned = true;
      }
      return;
    }

    // Tag nicht (mehr) im Bild
    // neu: Tracking noch nicht bestaetigt (< trackingConfirmDetections gueltige
    // Messungen) -> keine Verlust-Erkennung, Anwendung bleibt effektiv im Suchzustand.
    if(!trackingConfirmed) return;
    var lostFor = now - expectedLastSeenAt;
    if(lostFor <= SETTINGS.trackLostStopMs) return;  // kurzes Flackern ignorieren

    navLog("TAG LOST before REACHED", { expectedTag: expectedNextTagId,
      lostForMs: Math.round(lostFor), lastRaw: r1(lastRawDist),
      recentMin: r1(recentMin), minSeg: r1(minTrackDist), ema: r1(emaDist),
      dets: trackDetCount, awayWarned: awayWarned });

    // v13: Near-Loss-Fallback. Verlust allein gilt weiterhin NIE als "erreicht" —
    // ABER: wurde der Tag unmittelbar zuvor STABIL und NAH angenaehert und ging
    // dann verloren (typisch: steiler Winkel / Bildrand direkt vor dem Ziel),
    // zaehlt das als Ankunfts-Bestaetigung. Alle Bedingungen zusammen:
    //   - genug Messungen im Abschnitt (kein kurzes Aufblitzen)
    //   - juengstes Roh-Minimum nah an der Schwelle (<= nearLossFallbackM)
    //   - LETZTE Messung nahe am Minimum => Nutzer naeherte sich beim Verlust,
    //     entfernte sich nicht
    //   - keine "Sie entfernen sich"-Warnung im Abschnitt
    if(!awayWarned &&
       trackDetCount >= SETTINGS.nearLossMinDets &&
       recentMin != null && recentMin <= SETTINGS.nearLossFallbackM &&
       minTrackDist != null && minTrackDist <= SETTINGS.nearLossFallbackM &&
       lastRawDist != null && lastRawDist <= minTrackDist + 0.4){
      navLog("REACHED reason=near-loss-fallback", { expectedTag: expectedNextTagId,
        lastRaw: r1(lastRawDist), recentMin: r1(recentMin), minSeg: r1(minTrackDist),
        lostForMs: Math.round(lostFor), dets: trackDetCount });
      reachPoint("near-loss-fallback");
      return;
    }

    // Sonst: Verlust gilt NICHT als "erreicht". Der Nutzer könnte das Telefon
    // weggedreht, die Kamera verdeckt oder zu früh abgebogen haben.
    setNavState(NavState.LOST_STOPPED);
    stopSaidAt = now;
    // ---- Instrumentierung (neu) ----
    segLostCount++;
    segLostSince = now;
    navLog("LOST_STOPPED", { expectedTag: expectedNextTagId, lastEma: r1(emaDist),
      lastRaw: r1(lastRawDist) });
    // neu: einmalige, kurze Verlust-Ansage pro bestaetigter Verlust-Episode (kein
    // Wiederholen bei jedem Frame — handleTracking() laeuft nach setNavState(LOST_STOPPED)
    // ohnehin nicht mehr; handleLostStopped() uebernimmt). lostInstructionSpoken haelt
    // fest, dass eine Stopp-/Verlust-Ansage in dieser Episode bereits erfolgt ist, damit
    // die Wiederfindung unten weiss, dass "Weitergehen." angebracht ist.
    var lostText;
    if(emaDist != null && emaDist <= SETTINGS.nearLostM){
      // Sehr nah verloren: vorsichtig weiter, Marke erneut suchen (kein volles "Stopp").
      lostText = "Der Orientierungspunkt ist sehr nah. Gehen Sie langsam weiter " +
                 "und suchen Sie die Markierung erneut.";
    } else {
      lostText = "Stopp. Suchen Sie die Markierung. Bewegen Sie die Kamera langsam " +
                 "nach links und rechts.";
    }
    say(lostText, {interrupt:true});
    lostInstructionSpoken = true;
    navLog("TTS_LOST_INSTRUCTION", { expectedTag: expectedNextTagId,
      variant: (emaDist != null && emaDist <= SETTINGS.nearLostM) ? "near" : "stop",
      text: lostText });
  }

  // ---- LOST_STOPPED: warten, bis derselbe Tag wieder im Bild ist ----
  function handleLostStopped(now, det){
    if(det){
      // Wieder gefunden: Messung geht weiter.
      setNavState(NavState.TRACKING);
      var d = (det.dist != null) ? det.dist : emaDist;
      if(d != null) emaDist = d;
      // neu: kurze Wiederaufnahme-Ansage NUR "Weitergehen." (kein "Markierung wieder
      // gefunden", keine Distanz) — und nur ueberhaupt, weil dieser Codepfad
      // strukturell ausschliesslich nach einer bestaetigten Stopp-Episode erreicht
      // wird (main-loop.js ruft handleLostStopped() nur im Zustand LOST_STOPPED auf).
      say("Weitergehen.", {interrupt:true});
      // ---- Instrumentierung (neu) ----
      segReacquireCount++;
      if(segLostSince != null){ segLostMs += (now - segLostSince); segLostSince = null; }
      navLog("REACQUIRED", { expectedTag: expectedNextTagId, dist: r1(emaDist) });
      navLog("TTS_REACQUIRED_CONTINUE", { expectedTag: expectedNextTagId,
        dist: r1(emaDist), wasLostInstructionSpoken: lostInstructionSpoken });
      lostInstructionSpoken = false;
      // Der laufende Geradeaus-Lauf selbst (straightRunTotalM/straightRunProgressM/
      // straightRunReassured) wird NICHT zurueckgesetzt — er ist ja nicht zu Ende,
      // nur unterbrochen gewesen.
      return;
    }
    // Weiter verloren: NUR noch ein kurzer, seltener Hinweis — NICHT die volle
    // Verlust-Ansage aus handleTracking() wiederholen (das waere derselbe "lange Text
    // wiederholt sich"-Effekt nur mit anderem Wortlaut). Deutlich seltener als vorher
    // (SETTINGS.lostReminderRepeatMs statt scanHintRepeatMs).
    if(now - stopSaidAt >= SETTINGS.lostReminderRepeatMs && !speaking()){
      stopSaidAt = now;
      say("Suchen Sie weiter.", {});
      navLog("TTS_LOST_REMINDER", { expectedTag: expectedNextTagId });
    }
  }

  // ==================== Kontrollierter Routen-Skip (generisch, neu) ====================
  // KEIN genereller Graph-Shortcut: nur bereits im BERECHNETEN Pfad (pathTagIds) liegende
  // Tags kommen ueberhaupt infrage, und nur, wenn JEDE Kante zwischen dem erwarteten Tag
  // und dem Kandidaten (einschliesslich) "continue-straight" ist — also KEIN noch nicht
  // angesagtes Abbiegen uebersprungen wuerde. Automatisch gueltig fuer JEDEN zukuenftigen
  // Pfad, keine tag-spezifische Regel-Tabelle mehr (ersetzt die alten ROUTE_SKIP_RULES/
  // canSkipExpectedTag()/skipExpectedTag()). Graph/EDGE_MAP/findPath() bleiben unveraendert.
  //
  // WICHTIG (Architektur-Korrektur): eine bestaetigte Kandidatur bedeutet NUR "ab jetzt
  // wird DIESER Tag verfolgt" (wie ein normales onNextTagFound()) — KEINE synthetische
  // Ankunft. Die eigentliche Ankunfts-Ansage (Abbiegen oder "Gehen Sie weiter geradeaus.")
  // erfolgt weiterhin ausschliesslich ueber die unveraenderte, distanzbasierte
  // reachPoint()/handleTracking()-Kette, sobald der Tag TATSAECHLICH erreicht wird.
  var skipCandTagId = null;
  var skipCandTargetIdx = -1;
  var skipCandDist = null;
  var skipCandCount = 0;
  var skipCandLastSeenAt = 0;

  function resetSkipCandidate(){
    skipCandTagId = null;
    skipCandTargetIdx = -1;
    skipCandDist = null;
    skipCandCount = 0;
    skipCandLastSeenAt = 0;
  }

  // Ermittelt den FRUEHESTEN, diesmal sichtbaren Tag weiter vorne auf pathTagIds, der
  // ohne Ueberspringen eines NOCH NICHT angesagten Abbiegens erreichbar waere.
  // detectedList: [{id, dist}, ...] — ALLE diesmal decodierten Tags, nicht nur bestKnown.
  // Sicherheitsfrage: "wuerde die Auswahl dieses Tags ein noch nicht gesprochenes
  // Abbiegen ueberspringen?" — NICHT "enthaelt irgendeine Kante ab dem AKTUELLEN Tag
  // ein Abbiegen" (die Kante segIndex->expectedIdx wurde bereits angesagt, als
  // pathTagIds[segIndex] erreicht wurde; sie wird daher bewusst NICHT geprueft).
  function findForwardStraightCandidate(detectedList){
    if(!pathTagIds || segIndex < 0 || expectedNextTagId == null) return null;
    var expectedIdx = segIndex + 1;
    var farthestIdx = expectedIdx;
    var i = expectedIdx;
    while(i + 1 < pathTagIds.length){
      var e = EDGE_MAP[pathTagIds[i] + "->" + pathTagIds[i + 1]];
      if(!e || isTurnAction(e)) break;   // erstes NOCH NICHT angesagtes Abbiegen -> Grenze
      i++;
      farthestIdx = i;
    }
    for(var k = expectedIdx + 1; k <= farthestIdx; k++){
      for(var j = 0; j < detectedList.length; j++){
        if(detectedList[j].id === pathTagIds[k]){
          return { tagId: pathTagIds[k], targetIdx: k, dist: detectedList[j].dist };
        }
      }
    }
    return null;
  }

  // Pro Frame von main-loop.js aufgerufen (NUR wenn der erwartete Tag selbst diesmal
  // NICHT sichtbar ist — das gibt dem normalen Pfad automatisch Vorrang, siehe
  // main-loop.js). Haelt eine EIGENSTAENDIGE, "klebrige" Bestaetigungsserie: ein
  // gleichzeitig sichtbarer weiter entfernter Tag kann einen bereits aktiven, naeheren
  // Kandidaten NIE verdraengen; ein kurzzeitiges Verschwinden des aktiven Kandidaten
  // wird bis SETTINGS.candMemoryMs toleriert, bevor ueberhaupt ein anderer Kandidat in
  // Betracht gezogen wird.
  function updateSkipCandidate(detectedList, now){
    if(navState !== NavState.SEARCHING_NEXT_TAG && navState !== NavState.TAG_CANDIDATE) return;
    if(!pathTagIds || segIndex < 0 || expectedNextTagId == null) return;

    var found = findForwardStraightCandidate(detectedList);

    if(found && found.tagId === skipCandTagId){
      skipCandCount++;
      skipCandTargetIdx = found.targetIdx;
      skipCandDist = found.dist;
      skipCandLastSeenAt = now;
      navLog("SKIP_CANDIDATE_PROGRESS", { expectedTag: expectedNextTagId,
        candidateTag: skipCandTagId, count: skipCandCount,
        neededFrames: SETTINGS.otherTagFrames, state: navState });
    } else if(skipCandTagId != null && (now - skipCandLastSeenAt) <= SETTINGS.candMemoryMs){
      // Aktiver Kandidat diesmal nicht die fruehste sichtbare Wahl (abwesend, oder ein
      // weiter entfernter Tag ist sichtbar) — aber noch innerhalb der Toleranz. NICHTS
      // aendern: kein Reset, kein Wechsel zu einem anderen (weiter entfernten) Tag.
    } else if(found){
      if(skipCandTagId != null){
        navLog("SKIP_CANDIDATE_EXPIRED", { expectedTag: expectedNextTagId,
          expiredCandidateTag: skipCandTagId, countAtExpiry: skipCandCount, state: navState });
      }
      skipCandTagId = found.tagId;
      skipCandTargetIdx = found.targetIdx;
      skipCandDist = found.dist;
      skipCandCount = 1;
      skipCandLastSeenAt = now;
      navLog("SKIP_CANDIDATE_STARTED", { expectedTag: expectedNextTagId,
        candidateTag: found.tagId, candidateTargetIdx: found.targetIdx, state: navState });
    } else if(skipCandTagId != null){
      navLog("SKIP_CANDIDATE_EXPIRED", { expectedTag: expectedNextTagId,
        expiredCandidateTag: skipCandTagId, countAtExpiry: skipCandCount, state: navState });
      resetSkipCandidate();
    }

    if(skipCandTagId != null && skipCandCount >= SETTINGS.otherTagFrames){
      var tagId = skipCandTagId, targetIdx = skipCandTargetIdx, dist = skipCandDist;
      resetSkipCandidate();
      beginTrackingForwardCandidate(targetIdx, tagId, dist, now);
    }
  }

  // Bestaetigte Kandidatur -> NUR Umschalten des verfolgten Tags (wie ein normales
  // "gefunden", siehe onNextTagFound()) — KEINE Ansage, KEINE synthetische Ankunft.
  // Tag 4 (und jeder weitere uebersprungene Zwischen-Tag) wird aus der aktiven
  // Verfolgung entfernt, OHNE als "erreicht" gezaehlt zu werden (currentTagId bleibt
  // unveraendert); currentEdge() zeigt danach auf die Kante ZUM Kandidaten (z.B. 4->7),
  // deren Distanz spaeter — bei TATSAECHLICHER Ankunft — ganz normal von reachPoint()
  // addiert wird, wie im nicht uebersprungenen Fall.
  function beginTrackingForwardCandidate(targetIdx, confirmedTagId, dist, now){
    var routeIndexBefore = segIndex;
    var bypassedTags = pathTagIds.slice(routeIndexBefore + 1, targetIdx);

    var bypassedDistanceM = 0;
    for(var i = routeIndexBefore; i < targetIdx - 1; i++){
      var e = EDGE_MAP[pathTagIds[i] + "->" + pathTagIds[i + 1]];
      bypassedDistanceM += (e && e.distanceM != null) ? e.distanceM : 0;
    }

    navLog("SKIPPED_FORWARD", { previousTag: pathTagIds[routeIndexBefore],
      bypassedTags: bypassedTags, confirmedTag: confirmedTagId,
      routeIndexBefore: routeIndexBefore, routeIndexAfter: targetIdx - 1,
      confirmationFrames: SETTINGS.otherTagFrames, bypassedDistanceM: r1(bypassedDistanceM),
      reason: "forward-tag-confirmed" });

    straightRunProgressM += bypassedDistanceM;
    segIndex = targetIdx - 1;
    expectedNextTagId = confirmedTagId;
    resetSegmentState();     // frische EMA/Tracking-Zustaende — keine Reste vom
                              // abgebrochenen Verfolgen des uebersprungenen Tags
    onNextTagFound(dist);    // identischer Uebergang wie bei normalem Fund: TRACKING
                              // beginnt, optionale Vibration, KEINE Sprachausgabe hier
  }

  // Bekannter, aber NICHT erwarteter Tag: sehr zurückhaltend melden.
  //  - kurz aufblitzende fremde Tags werden IGNORIERT (Frame-Schwellen im tick)
  //  - der soeben erreichte Tag ist noch im Bild: normal, KEINE Meldung
  //  - stabil sichtbarer fremder Tag: höchstens EINMAL pro Abschnitt benennen
  //  - bereits passierter Routen-Tag: "zurück"-Warnung nur bei hoher Sicherheit
  function onOtherTagConfirmed(tagId){
    if(tagId === currentTagId) return;   // gerade erreicht — kein Fehler
    if(offRouteSaid[tagId]) return;      // pro Abschnitt nur einmal
    var now = performance.now();
    if(now - lastWrongTagAt < SETTINGS.wrongTagCooldownMs) return;
    var p;
    var passedIdx = pathTagIds ? pathTagIds.indexOf(tagId) : -1;
    if(passedIdx >= 0 && passedIdx <= segIndex){
      p = "Sie gehen möglicherweise zurück. Sie sind wieder bei " + markerName(tagId) +
          ". Bitte folgen Sie der letzten Anweisung.";
    } else {
      p = (OFF_ROUTE_HINTS[tagId] || ("Erkannt: " + markerName(tagId) + ".")) +
          " Diese Markierung liegt nicht auf dem Weg. Bitte folgen Sie der letzten Anweisung.";
    }
    if(say(p, {})){
      lastWrongTagAt = now;
      offRouteSaid[tagId] = true;
    }
  }

  // Ausricht-Hinweise, solange der erwartete Tag sichtbar, aber unbestätigt ist.
  function aimGuidance(corners){
    var cx = 0, cy = 0;
    for(var i = 0; i < corners.length; i++){ cx += corners[i].x; cy += corners[i].y; }
    cx /= corners.length; cy /= corners.length;
    var zone;
    if(cx < W * 0.33)      zone = "left";
    else if(cx > W * 0.67) zone = "right";
    else if(cy < H * 0.30) zone = "up";
    else if(cy > H * 0.70) zone = "down";
    else                   zone = "center";
    var now = performance.now();
    if(zone === lastAimZone) return;
    if(now - lastAimAt < SETTINGS.aimCooldownMs) return;
    if(speaking()) return;
    var msg = { left:"Markierung links.", right:"Markierung rechts.",
                up:"Smartphone etwas höher.", down:"Smartphone etwas tiefer.",
                center:"Markierung mittig." }[zone];
    if(say(msg, {})){ lastAimZone = zone; lastAimAt = now; }
  }

  // Suchhinweise (vor dem ersten Kontakt mit dem Kanten-Tag). Wiederholen sich.
  function scanHint(){
    var now = performance.now();
    var idleSince = Math.max(expectedLastSeenAt, searchStartedAt, lastScanHintAt);
    var delay = (scanHintCount === 0) ? currentScanDelayMs : SETTINGS.scanHintRepeatMs;
    if(now - idleSince < delay) return;
    if(speaking()) return;
    var edge = currentEdge();
    var msg;
    if(edge){
      var msgs = [
        edge.searchHint || "Bewegen Sie das Smartphone langsam nach links und rechts und suchen Sie die nächste Markierung.",
        "Gesucht wird Tag " + expectedNextTagId + " bei " + markerName(expectedNextTagId) +
          ". Bewegen Sie das Smartphone langsam nach links und rechts, auch etwas höher und tiefer.",
        "Immer noch keine Markierung. Sie können jederzeit Anweisung wiederholen oder Wo bin ich drücken."
      ];
      msg = msgs[(scanHintCount < 3) ? scanHintCount : ((scanHintCount % 2) + 1)];
    } else {
      msg = "Bewegen Sie das Smartphone langsam nach links und rechts und suchen Sie eine Markierung in Ihrer Nähe.";
    }
    if(say(msg, {})){
      scanHintCount++;
      lastScanHintAt = now;
    }
  }

export {
  NavState,
  navState,
  destinationId,
  pathTagIds,
  segIndex,
  currentTagId,
  expectedNextTagId,
  navigationActive,
  destinationReached,
  lastRouteInstruction,
  emaDist,
  candId,
  candCount,
  wrongCandId,
  wrongCandCount,
  lastExpectedVis,
  candLastSeenAt,
  routeRunId,
  setNavState,
  currentEdge,
  startNavigation,
  endNavigation,
  handleTracking,
  handleLostStopped,
  onStartTagConfirmed,
  onNextTagFound,
  onOtherTagConfirmed,
  updateSkipCandidate,
  aimGuidance,
  scanHint,
  touchExpectedSeen,
  touchCandidateSeen,
  setLastExpectedVisual,
  setWrongCandidate,
  setCandidate,
  setEmaDist
};
