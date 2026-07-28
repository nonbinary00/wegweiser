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
import { EDGE_MAP, findPath, markerName, metersDE, pathToText } from './graph.js';
import { destSel, uiState } from './dom.js';
import { say, speaking } from './speech.js';
import { updatePanel } from './ui.js';
import { W, H } from './frame-state.js';

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
  var arrivalBelowCount = 0;      // v13: Frames in Folge mit arrivalDistance <= Schwelle
  var lastTrackDbgAt = 0;         // v13: Drossel fuer Debug-Log
  var milestonesM = [];           // Zwischenansage-Punkte, abhängig von der Abschnittslänge
  var lastProgressAt = 0;
  var awayWarned = false;
  var stopSaidAt = 0;
  var offRouteSaid = {};          // fremde Tags: höchstens EINMAL pro Abschnitt melden

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
    milestonesM = [];
    lastProgressAt = 0;
    awayWarned = false;
    stopSaidAt = 0;
    offRouteSaid = {};
    emaDist = null;
    rawRecent = [];                  // v13
    lastRawDist = null; lastRawAt = 0;
    trackDetCount = 0;
    arrivalBelowCount = 0;
    lastTrackDbgAt = 0;
  }


  function navLog(msg, data){
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
    currentScanDelayMs = SETTINGS.scanHintAfterMs;
    setNavState(NavState.SEARCHING_START_TAG);
    updatePanel(null);
    say("Ziel gewählt: " + markerName(destId) + ". Richten Sie das Smartphone auf die " +
        "nächste Markierung in Ihrer Nähe. Von dort wird die Route berechnet.",
        {interrupt:true});
  }

  function endNavigation(announce){
    navigationActive = false;
    pathTagIds = null;
    segIndex = -1;
    currentTagId = null;
    expectedNextTagId = null;
    destinationId = null;
    destinationReached = false;
    resetSegmentState();
    setNavState(NavState.IDLE);
    updatePanel(null);
    if(announce) say("Navigation beendet.", {interrupt:true});
  }

  // Abschnitt segIndex beginnen: nach dem Tag am ENDE der Kante suchen.
  function beginSegment(){
    var edge = currentEdge();
    expectedNextTagId = pathTagIds[segIndex + 1];
    resetSegmentState();
    setNavState(NavState.SEARCHING_NEXT_TAG);
    updatePanel(null);
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
    beginSegment();
  }

  // Erwarteter Tag der aktuellen Kante erstmals bestätigt -> TRACKING beginnt.
  function onNextTagFound(dist){
    var edge = currentEdge();
    setNavState(NavState.TRACKING);
    minTrackDist = dist != null ? dist : null;
    lastProgressAt = performance.now();
    awayWarned = false;
    // Zwischenansagen abhängig von der Abschnittslänge planen:
    //   >= 8 m  -> bei ~6 m und ~3 m Restdistanz
    //   4..8 m  -> einmal etwa auf halber Strecke
    //   <  4 m  -> keine (found + reached genügen)
    var base = (edge && edge.distanceM != null) ? edge.distanceM : dist;
    if(dist != null && base != null && dist < base) base = dist;
    milestonesM = [];
    if(base != null){
      if(base >= 8)      milestonesM = [6, 3];
      else if(base >= 4) milestonesM = [Math.round(base / 2)];
    }
    lastRouteInstruction = edge.found;
    say(edge.found, {interrupt:true});
    updatePanel(dist);
  }

  // Punkt erreicht (Distanz <= Schwelle oder Near-Loss-Fallback).
  function reachPoint(reason){
    var edge = currentEdge();
    var reachedTagId = pathTagIds[segIndex + 1];
    currentTagId = reachedTagId;

    if(reachedTagId === destinationId){
      navLog("REACHED destination", { tag: reachedTagId, reason: reason || "distance-threshold" });
      arriveAtDestination();
      return;
    }
    var t = edge.reached;
    lastRouteInstruction = t;
    say(t, {interrupt:true});
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
    var t = ARRIVALS[destinationId] || ("Ziel erreicht. Sie sind bei " + markerName(destinationId) + ".");
    lastRouteInstruction = t;
    setNavState(NavState.DESTINATION_REACHED);
    say(t, {interrupt:true});
    updatePanel(null);
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
      // Zwischenansage NUR an geplanten Meilensteinen (nicht dauernd sprechen)
      while(milestonesM.length && emaDist <= milestonesM[0] + 0.3){
        milestonesM.shift();
        if(emaDist > reachedM + 0.5 &&
           (now - lastProgressAt) >= SETTINGS.progressMinGapMs && !speaking()){
          if(say("Noch ungefähr " + metersDE(emaDist) + ".", {})) lastProgressAt = now;
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
    if(emaDist != null && emaDist <= SETTINGS.nearLostM){
      // Sehr nah verloren: vorsichtig weiter, Marke erneut suchen.
      say("Der Orientierungspunkt ist sehr nah. Gehen Sie langsam weiter " +
          "und suchen Sie die Markierung erneut.", {interrupt:true});
    } else {
      say("Stopp. Der Orientierungspunkt ist nicht mehr sichtbar. Bleiben Sie stehen " +
          "und bewegen Sie das Smartphone langsam nach links und rechts, " +
          "bis die Markierung wieder erkannt wird.", {interrupt:true});
    }
  }

  // ---- LOST_STOPPED: warten, bis derselbe Tag wieder im Bild ist ----
  function handleLostStopped(now, det){
    if(det){
      // Wieder gefunden: Messung geht weiter.
      setNavState(NavState.TRACKING);
      var d = (det.dist != null) ? det.dist : emaDist;
      if(d != null) emaDist = d;
      say("Markierung wieder gefunden." +
          (emaDist != null ? " Noch ungefähr " + metersDE(emaDist) + "." : ""), {interrupt:true});
      return;
    }
    // Weiter verloren: Hinweis periodisch wiederholen.
    if(now - stopSaidAt >= SETTINGS.scanHintRepeatMs && !speaking()){
      stopSaidAt = now;
      say("Bewegen Sie das Smartphone weiter langsam nach links und rechts. Gesucht wird Tag " +
          expectedNextTagId + " bei " + markerName(expectedNextTagId) + ".", {});
    }
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
  setNavState,
  currentEdge,
  startNavigation,
  endNavigation,
  handleTracking,
  handleLostStopped,
  onStartTagConfirmed,
  onNextTagFound,
  onOtherTagConfirmed,
  aimGuidance,
  scanHint,
  touchExpectedSeen,
  touchCandidateSeen,
  setLastExpectedVisual,
  setWrongCandidate,
  setCandidate,
  setEmaDist
};
