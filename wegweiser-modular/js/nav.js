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
import { updatePanel, renderNavigationUi } from './ui.js';
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
    // neu: Tag 1 (Eingang) ist visuell bestaetigt, aber noch nicht per Distanz
    // erreicht -- siehe beginStartTagTracking()/reachStartTag() unten. Physisch und
    // fuer main-loop.js absichtlich wie TRACKING behandelt (siehe dort), NUR als
    // eigener Zustand gefuehrt, damit Vorgriffs-Logik/Scan-Hinweise fuer Tag 2 waehrend
    // dieser Phase sicher unterbleiben (trackingStartTagActive, siehe unten).
    TRACKING_START_TAG: "TRACKING_START_TAG",
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
  // neu (Tag-1-Sonderbehandlung): true GENAU waehrend Tag 1 physisch verfolgt wird
  // (NavState.TRACKING_START_TAG ODER ein LOST_STOPPED, das AUS dieser Phase heraus
  // entstanden ist) -- unabhaengig von navState, weil navState waehrend eines
  // Verlusts zwischenzeitlich LOST_STOPPED ist (siehe handleTracking()). Einzige
  // Aufgabe: verhindert, dass updateSkipCandidate() (main-loop.js) Vorgriffs-
  // Kandidaten ab Tag 2 sucht, BEVOR Tag 1 tatsaechlich erreicht wurde, und steuert
  // in handleTracking(), ob reachStartTag() statt reachPoint() aufgerufen wird.
  var trackingStartTagActive = false;
  var arrivalBelowCount = 0;      // v13: Frames in Folge mit arrivalDistance <= Schwelle
  var lastTrackDbgAt = 0;         // v13: Drossel fuer Debug-Log
  var awayWarned = false;
  // neu (Fehlalarm-Fix "Sie entfernen sich..."): dedizierte, ausschliesslich NACH
  // TRACKING_CONFIRMED gefuehrte EMA-Baseline fuer den Entfernungs-Vergleich in
  // handleTracking(). Grund: main-loop.js speist emaDist bereits waehrend der
  // Kandidaten-Bestaetigungsphase (VOR trackingConfirmed), waehrend minTrackDist
  // von onNextTagFound() aus einem EINZELNEN ROHWERT zum Bestaetigungszeitpunkt
  // gesetzt wird — ein Vergleich von emaDist gegen minTrackDist verglich daher
  // zwei unterschiedliche Basen und konnte in den ersten (unbestaetigten) Frames
  // faelschlich "Entfernen" erkennen, obwohl der Nutzer sich naeherte (Roh-Distanz
  // sank). minAwayEmaDist wird NIE aus einer Kandidaten-Phase-Messung gesetzt,
  // NUR aus emaDist NACH Bestaetigung, und beruehrt minTrackDist (REACHED/TAG-
  // LOST/Segment-Statistik) nicht. awayPostConfirmSamples zaehlt gueltige
  // Messungen NACH Etablierung der Baseline (die Etablierungs-Frame selbst zaehlt
  // nicht mit) — verhindert eine Ansage im selben Frame, in dem die Baseline
  // gerade erst gesetzt wurde.
  var minAwayEmaDist = null;
  var awayPostConfirmSamples = 0;
  var AWAY_BASELINE_MIN_SAMPLES = 3;
  var stopSaidAt = 0;
  var offRouteSaid = {};          // fremde Tags: höchstens EINMAL pro Abschnitt melden
  var lostInstructionSpoken = false; // ob in der aktuellen Verlust-Episode bereits eine
                                      // TATSAECHLICH GESPROCHENE Stopp-Ansage erfolgt ist
                                      // (steuert, ob die Wiederfindung etwas ansagt)
  var lostSpeechPending = false;     // neu (TTS-Aufraeumung): LOST_STOPPED wurde erreicht,
                                      // aber die Stopp-ANSAGE ist noch zurueckgehalten
                                      // (siehe SETTINGS.lostSpeechDelayMs) — der interne
                                      // Zustandsuebergang (trackLostStopMs) bleibt unveraendert,
                                      // NUR die Sprachausgabe wird zusaetzlich verzoegert.
  var lostSpeechPendingSince = 0;    // performance.now() bei Eintritt in LOST_STOPPED

  // ---- Gemeinsamer Dedup-Zustand fuer die "aktive Richtungsansage" (neu, TTS-Aufraeumung) ----
  // EIN einziger geteilter Zustand fuer ALLE Stellen, die "Gehen Sie weiter geradeaus."
  // oder eine Abbiege-Ansage sprechen koennten (reachPoint(), Wiederaufnahme nach Stopp,
  // Vorgriffs-Retarget) — verhindert, dass mehrere unabhaengige Mechanismen dieselbe
  // Formulierung wiederholt aussprechen. activeDirectionText haelt die zuletzt TATSAECHLICH
  // gesprochene Richtungs-Formulierung; ein erneuter Versuch mit demselben Text wird
  // unterdrueckt, bis sich die aktive Richtung aendert (Abbiegen setzt sie direkt neu) oder
  // der Zustand gezielt zurueckgesetzt wird (Routenstart/-ende, Zielankunft, tatsaechlich
  // gesprochenes Stopp, Vorgriffs-Retarget waehrend eines anstehenden Verlusts).
  var activeDirectionText = null;

  function resetActiveDirectionState(){
    activeDirectionText = null;
  }

  // ---- Bestaetigung "geradeaus" NACH einem echten Abbiegen (neu) ----
  // Rein additiver Zustand: merkt sich, dass ein ECHTES Abbiegen soeben angesagt wurde
  // (isTurn===true in reachPoint(), siehe dort) und die anschliessende Bestaetigung
  // "Gehen Sie geradeaus." noch aussteht, bis der NAECHSTE erwartete Tag zum ERSTEN MAL
  // ueber den bestehenden onNextTagFound()-Pfad bestaetigt wird (normale Suche ODER
  // Vorgriffs-Retarget — bei Vorgriffs-Retarget wird dieser Zustand jedoch VORHER explizit
  // storniert, siehe beginTrackingForwardCandidate(), weil dort bereits eine eigene
  // "Gehen Sie weiter geradeaus."-Bestaetigung erfolgt). An (routeRunId, expectedTag)
  // gebunden, damit ein spaeter/anderswo eintreffender Tag NIE faelschlich als
  // Abschluss dieses konkreten Abbiegens gewertet wird. Beeinflusst KEINE
  // Erkennungs-, Routen- oder Abbiege-Logik — nur, OB zusaetzlich "Gehen Sie
  // geradeaus." gesprochen wird.
  // neu (Bugfix): begrenzte, gedrosselte Wiederholung, falls der TTS-Kanal genau im
  // Moment des ersten Versuchs belegt ist ("busy") — OHNE bei jedem Frame erneut zu
  // versuchen. postTurnAttempts zaehlt JEDEN Sprechversuch (der erste eingeschlossen);
  // postTurnNextRetryAt drosselt, wann der NAECHSTE Versuch fruehestens stattfinden darf.
  var POST_TURN_RETRY_INTERVAL_MS = 400;   // 300-500ms Fenster laut Vorgabe
  var POST_TURN_MAX_ATTEMPTS = 3;          // insgesamt, ersten Versuch eingeschlossen

  var postTurnPending = false;
  var postTurnRouteRunId = null;
  var postTurnTurnTag = null;       // Tag, AN DEM das Abbiegen angesagt wurde
  var postTurnExpectedTag = null;   // Tag, dessen Bestaetigung die Ansage abschliesst
  var postTurnAttempts = 0;
  var postTurnNextRetryAt = 0;

  function setPostTurnPending(turnTag, expectedTag){
    postTurnPending = true;
    postTurnRouteRunId = routeRunId;
    postTurnTurnTag = turnTag;
    postTurnExpectedTag = expectedTag;
    postTurnAttempts = 0;
    postTurnNextRetryAt = 0;
    navLog("POST_TURN_CONFIRMATION_PENDING", { routeRunId: routeRunId, turnTag: turnTag,
      expectedTag: expectedTag, reason: "turn-instruction-accepted" });
  }

  function clearPostTurnPending(reason){
    if(!postTurnPending) return;
    navLog("POST_TURN_CONFIRMATION_CLEARED", { routeRunId: postTurnRouteRunId,
      turnTag: postTurnTurnTag, expectedTag: postTurnExpectedTag, reason: reason,
      attempts: postTurnAttempts });
    postTurnPending = false;
    postTurnRouteRunId = null;
    postTurnTurnTag = null;
    postTurnExpectedTag = null;
    postTurnAttempts = 0;
    postTurnNextRetryAt = 0;
  }

  // Einziger Ort, der tatsaechlich versucht, die anstehende Nach-Abbiege-Bestaetigung
  // zu sprechen — aufrufbar sowohl aus onNextTagFound() (der erste, sofortige Versuch)
  // als auch aus handleTracking() (laeuft bereits jeden Tick waehrend TRACKING; siehe
  // dort). Spricht NIEMALS pro Frame: der erste Versuch (postTurnAttempts===0) laeuft
  // sofort durch, JEDER weitere Versuch ist zusaetzlich durch postTurnNextRetryAt
  // gedrosselt (mindestens POST_TURN_RETRY_INTERVAL_MS seit dem letzten Versuch).
  // Prueft vor JEDEM Versuch erneut: Route aktiv, gleicher Routenlauf, gleicher
  // erwarteter Tag, weiterhin im TRACKING-Zustand, Ziel noch nicht erreicht, Zustand
  // noch nicht anderweitig geloescht (erste Zeile). Keine Erkennungs-, Routen-,
  // Vorgriffs- oder Verlust-Logik wird hier gelesen oder veraendert.
  function tryPostTurnConfirmation(){
    if(!postTurnPending) return;
    if(!navigationActive || destinationReached) return;
    if(postTurnRouteRunId !== routeRunId) return;
    if(postTurnExpectedTag !== expectedNextTagId) return;
    if(navState !== NavState.TRACKING) return;

    var now = performance.now();
    if(postTurnAttempts > 0 && now < postTurnNextRetryAt) return;   // Drossel — kein Versuch pro Frame

    postTurnAttempts++;
    var isRetry = postTurnAttempts > 1;
    var turnTagForLog = postTurnTurnTag, expectedTagForLog = postTurnExpectedTag;
    if(isRetry){
      navLog("POST_TURN_CONFIRMATION_RETRY_ATTEMPT", { routeRunId: routeRunId,
        turnTag: turnTagForLog, expectedTag: expectedTagForLog, attempt: postTurnAttempts });
    }

    var confirmResult = speakDirectionIfNew("Gehen Sie geradeaus.",
      ttsOpts({interrupt:true, source:"nav.postTurnConfirmation", category:"NAVIGATION_CONTEXT"}),
      "POST_TURN_CONFIRMATION_SPOKEN",
      { turnTag: turnTagForLog, expectedTag: expectedTagForLog, attempt: postTurnAttempts });

    if(confirmResult.accepted){
      if(isRetry){
        navLog("POST_TURN_CONFIRMATION_RETRY_ACCEPTED", { routeRunId: routeRunId,
          turnTag: turnTagForLog, expectedTag: expectedTagForLog, attempt: postTurnAttempts,
          speechId: confirmResult.speechId });
      }
      clearPostTurnPending("confirmed");
      return;
    }

    if(confirmResult.suppressionReason === "busy"){
      if(postTurnAttempts >= POST_TURN_MAX_ATTEMPTS){
        navLog("POST_TURN_CONFIRMATION_RETRY_ABANDONED", { routeRunId: routeRunId,
          turnTag: turnTagForLog, expectedTag: expectedTagForLog, attempts: postTurnAttempts,
          reason: "busy-max-attempts" });
        clearPostTurnPending("retry-exhausted-busy");
      } else {
        postTurnNextRetryAt = now + POST_TURN_RETRY_INTERVAL_MS;
        navLog("POST_TURN_CONFIRMATION_RETRY_SCHEDULED", { routeRunId: routeRunId,
          turnTag: turnTagForLog, expectedTag: expectedTagForLog, attempt: postTurnAttempts,
          nextRetryInMs: POST_TURN_RETRY_INTERVAL_MS });
      }
      return;
    }

    // "muted"/"unsupported"/sofortiger Fehlschlag: nicht wiederholbar (naechster
    // Versuch wuerde denselben Grund liefern) — sofort mit explizitem Grund loeschen,
    // statt den Zustand unbegrenzt haengen zu lassen.
    clearPostTurnPending("suppressed-" + (confirmResult.suppressionReason || "failed"));
  }

  // ---- Rueckversicherung auf langen geraden Korridoren (neu) ----
  // Rein additiv, rein distanzbasiert aus bereits vorhandenen Kantendistanzen
  // (EDGE_MAP[...].distanceM, dieselbe Quelle wie bypassedDistanceM im Vorgriffs-Skip
  // und remainingRouteMeters() in app.js) — KEINE neue Distanzmessung, KEIN neuer
  // Zeit-Timer, KEINE Aenderung an reachedM/Tracking/Verlust/Vorgriffs-Logik.
  // corridorProgressM summiert die Distanz JEDER bereits abgeschlossenen, geraden
  // Kante seit dem letzten Abbiegen (oder Routenstart/-ende/Zielankunft). Sobald der
  // Abstand seit der letzten TATSAECHLICH gehoerten Geradeaus-Bestaetigung
  // SETTINGS.longCorridorReassuranceM erreicht, darf "Gehen Sie weiter geradeaus."
  // ERNEUT gesprochen werden — bewusst UNABHAENGIG von activeDirectionText/
  // speakDirectionIfNew()'s Text-Gleichheits-Dedup (die auf einem langen, stillen
  // Korridor sonst JEDE Wiederholung fuer immer unterdruecken wuerde, siehe
  // Kommentar dort: "genau EINE Ansage pro Korridor") — activeDirectionText wird
  // trotzdem aktualisiert, damit andere Aufrufstellen weiterhin korrekt gegen die
  // zuletzt gehoerte Formulierung abgleichen.
  var corridorProgressM = 0;          // aufsummierte gerade Distanz seit letztem Reset
  var corridorLastReassuranceAtM = 0; // Wert von corridorProgressM bei der letzten
                                       // TATSAECHLICH gehoerten Geradeaus-Bestaetigung
                                       // (egal ob normale Ansage, Vorgriffs-Bestaetigung
                                       // oder diese Rueckversicherung selbst)
  var corridorActive = false;         // fuer STRAIGHT_CORRIDOR_STARTED, nur einmal pro Korridor

  function resetCorridorState(reason){
    if(!corridorActive && corridorProgressM === 0) return;
    navLog("STRAIGHT_CORRIDOR_RESET", { reason: reason, progressAtResetM: r1(corridorProgressM) });
    corridorProgressM = 0;
    corridorLastReassuranceAtM = 0;
    corridorActive = false;
  }

  // Schreibt die Distanz einer bereits abgeschlossenen, geraden Kante gut — aufgerufen
  // aus reachPoint() (normal erreichter Zwischen-Tag) und beginTrackingForwardCandidate()
  // (uebersprungene Kanten, siehe dort: nur Kandidaten OHNE Abbiegen dazwischen sind
  // ueberhaupt als Vorgriffs-Ziel zulaessig, daher hier keine erneute Abbiege-Pruefung
  // noetig). Loggt STRAIGHT_CORRIDOR_STARTED nur beim UEBERGANG von 0 auf >0 (nicht bei
  // jedem weiteren Beitrag), STRAIGHT_CORRIDOR_PROGRESS bei jedem Beitrag — beides
  // ausschliesslich an echten Segment-/Skip-Ereignissen, NIE pro Frame.
  function creditCorridorProgress(distanceM){
    if(distanceM == null || distanceM <= 0) return;
    var wasActive = corridorActive;
    corridorProgressM += distanceM;
    corridorActive = true;
    if(!wasActive){
      navLog("STRAIGHT_CORRIDOR_STARTED", { progressM: r1(corridorProgressM) });
    }
    navLog("STRAIGHT_CORRIDOR_PROGRESS", { addedM: r1(distanceM), progressM: r1(corridorProgressM),
      sinceReassuranceM: r1(corridorProgressM - corridorLastReassuranceAtM) });
  }

  // Prueft, ob seit der letzten gehoerten Geradeaus-Bestaetigung genug Korridor-
  // Fortschritt vorliegt, um "Gehen Sie weiter geradeaus." erneut zu sprechen — NICHT
  // ueber speakDirectionIfNew() (siehe Kommentar oben, wuerde durch Text-Gleichheit
  // dauerhaft blockiert), sondern direkt ueber say() mit interrupt:false: darf NIEMALS
  // eine wichtigere Ansage unterbrechen (Abbiegen/Stopp/Ankunft/Vorgriffs-Bestaetigung)
  // und bleibt bei belegtem Kanal einfach bis zum naechsten Kanten-Ereignis stumm
  // (kein eigener Retry-Mechanismus noetig, da corridorProgressM ohnehin weiterwaechst).
  function maybeTriggerCorridorReassurance(){
    if(!navigationActive || destinationReached) return;
    var sinceLast = corridorProgressM - corridorLastReassuranceAtM;
    if(sinceLast < SETTINGS.longCorridorReassuranceM) return;
    var text = "Gehen Sie weiter geradeaus.";
    var result = say(text, ttsOpts({source:"nav.corridorReassurance", category:"NAVIGATION_CONTEXT"}));
    if(result.accepted){
      activeDirectionText = text;
      corridorLastReassuranceAtM = corridorProgressM;
      navLog("STRAIGHT_REASSURANCE_TRIGGERED", { text: text, progressM: r1(corridorProgressM),
        sinceLastM: r1(sinceLast), speechId: result.speechId });
    } else {
      navLog("STRAIGHT_REASSURANCE_SUPPRESSED", { progressM: r1(corridorProgressM),
        sinceLastM: r1(sinceLast),
        suppressionReason: result.suppressionReason || (result.failed ? "failed" : "unknown") });
    }
  }

  // Versucht, `text` als Richtungsansage zu sprechen — NUR wenn sie sich von der aktuell
  // aktiven Richtungsansage unterscheidet. Bei Unterdrueckung wird IMMER
  // TTS_STRAIGHT_SUPPRESSED_DUPLICATE geloggt (keine Sprachausgabe dabei); bei
  // tatsaechlicher Ansage wird logEvent geloggt und activeDirectionText aktualisiert.
  function speakDirectionIfNew(text, opts, logEvent, logData){
    if(activeDirectionText === text){
      var suppressedData = { text: text, activeDirectionText: activeDirectionText };
      for(var k in (logData || {})) suppressedData[k] = logData[k];
      navLog("TTS_STRAIGHT_SUPPRESSED_DUPLICATE", suppressedData);
      return { speechId: null, accepted: false, spoken: false, failed: false,
               suppressionReason: "duplicate-direction", error: null };
    }
    // neu (Audit-Korrektur F-1/Ziel 4): activeDirectionText darf NUR aktualisiert
    // werden, wenn say() die Anfrage TATSAECHLICH angenommen hat (result.accepted) —
    // vorher wurde jeder Wahrheitswert von say() (auch "stumm/beschaeftigt/fehlgeschlagen"
    // faelschlich als "true" behandelt bei stumm) als Erfolg gewertet, was den Dedup-
    // Zustand verfaelschen konnte.
    var result = say(text, opts);
    if(result.accepted){
      activeDirectionText = text;
      var spokenData = { text: text, speechId: result.speechId };
      for(var k2 in (logData || {})) spokenData[k2] = logData[k2];
      navLog(logEvent, spokenData);
    }
    return result;
  }

  // Gemeinsame Log-Nutzlast fuer alle Stopp-Entscheidungen (Anforderung: expectedTag,
  // aktive Route, Navigationszustand, Verlustdauer, aktiver Vorgriffs-Kandidat,
  // Vorgriffs-Bestaetigungszaehler, ob Stopp bereits gesprochen wurde, Abbruchgrund).
  function buildLostDecisionLogData(now, cancellationReason){
    return {
      expectedTag: expectedNextTagId,
      activePath: pathTagIds,
      state: navState,
      lostDurationMs: lostSpeechPendingSince ? Math.round(now - lostSpeechPendingSince) : null,
      activeForwardCandidate: skipCandTagId,
      forwardConfirmationCount: skipCandCount,
      stopAlreadySpoken: lostInstructionSpoken,
      cancellationReason: cancellationReason || null
    };
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
    awayWarned = false;
    minAwayEmaDist = null;
    awayPostConfirmSamples = 0;
    stopSaidAt = 0;
    offRouteSaid = {};
    lostInstructionSpoken = false;
    lostSpeechPending = false;       // neu: defensiv, falls ein Segment mitten in einer
    lostSpeechPendingSince = 0;      // anstehenden Stopp-Ansage endet (siehe handleLostStopped())
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

  // ---- TTS-Observability (neu) ----
  // Baut die gemeinsamen say()-Metadaten (state/expectedTag/routeRunId) aus dem
  // AKTUELLEN Modul-Zustand zum Zeitpunkt des Aufrufs; `extra` kann jedes Feld gezielt
  // ueberschreiben (z.B. expectedTag, falls die naechste erwartete Markierung an dieser
  // Stelle noch nicht in expectedNextTagId steht). source/category MUESSEN in `extra`
  // mitgegeben werden.
  function ttsOpts(extra){
    var o = { state: navState, expectedTag: expectedNextTagId, routeRunId: routeRunId };
    if(extra) for(var k in extra) o[k] = extra[k];
    return o;
  }

  function startNavigation(){
    var destId = destSel.value ? parseInt(destSel.value, 10) : null;
    if(destId == null || !NODES[destId] || !NODES[destId].destination){
      say("Bitte wählen Sie zuerst ein Ziel.",
        ttsOpts({interrupt:true, source:"nav.noDestinationSelected", category:"STATUS"}));
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
    resetActiveDirectionState();
    clearPostTurnPending("route-start");
    resetCorridorState("route-start");
    currentScanDelayMs = SETTINGS.scanHintAfterMs;
    setNavState(NavState.SEARCHING_START_TAG);
    updatePanel(null);
    renderNavigationUi();
    // neu: routeRunId wird weiterhin hier (vor jeglicher Ansage) erzeugt — reine
    // Instrumentierungs-Id, keine Auswirkung auf Navigationslogik.
    routeRunId = generateRouteRunId();
    // neu (VoiceOver-Fix): die bisherige sofortige "Ziel gewählt..."-Ansage direkt bei
    // Tastendruck ist ENTFERNT worden — sie lief synchron im selben Klick-Handler wie
    // die VoiceOver-Doppeltipp-Aktivierung von "Navigation starten" und ueberlagerte
    // dadurch garantiert VoiceOvers eigene Ansage der aktivierten Schaltflaeche
    // (bestaetigtes Verhalten auf echtem Geraet). Es handelt sich um eine reine
    // Tastendruck-Bestaetigung, die die spaeter ohnehin folgende, bereits bestehende
    // Sprachfuehrung nur vorwegnahm: scanHint() (nav.js) meldet sich automatisch nach
    // SETTINGS.scanHintAfterMs, falls noch kein Tag gefunden wurde, und
    // onStartTagConfirmed() spricht die eigentliche erste Anweisung, sobald der erste
    // Tag TATSAECHLICH bestaetigt ist — beide bereits vorhandene, zustandsgetriebene
    // Ausloeser, kein neuer Timer noetig. lastRouteInstruction bleibt bewusst "" (siehe
    // oben), bis onStartTagConfirmed() sie setzt; repeatBtn faengt den Zwischenzustand
    // bereits ab ("Noch keine Anweisung vorhanden.", app.js).
    // ---- Instrumentierung (neu) ----
    navLog("ROUTE_START", { destinationId: destId, destination: markerName(destId),
      testName: getTestName() });
  }

  function endNavigation(announce, reason){
    // ---- Instrumentierung (neu, Audit-Korrektur Ziel 5): vor dem Zuruecksetzen
    // erfassen, WELCHER der drei unterscheidbaren Faelle vorliegt — manueller Abbruch
    // (Route lief noch, Ziel nicht erreicht), Beenden NACH Zielankunft (kein Abbruch),
    // oder ein zukuenftiger Fehler-Reset (reason==="error", heute von keiner
    // Aufrufstelle ausgeloest, aber die Unterscheidung ist ab jetzt moeglich, ohne das
    // Fehler-System neu zu entwerfen). wasActive/wasReached MUESSEN vor jedem Reset
    // gelesen werden. ----
    var wasActive = navigationActive;
    var wasReached = destinationReached;
    var effectiveReason = reason || (wasReached ? "after-arrival" : "manual");
    navigationActive = false;
    pathTagIds = null;
    segIndex = -1;
    currentTagId = null;
    expectedNextTagId = null;
    destinationId = null;
    destinationReached = false;
    resetSegmentState();
    resetActiveDirectionState();
    clearPostTurnPending("route-end");
    resetCorridorState("route-end");
    setNavState(NavState.IDLE);
    updatePanel(null);
    renderNavigationUi();
    // neu (Audit-Korrektur): NACH erfolgreicher Zielankunft wurde die Ankunfts-Ansage
    // (arriveAtDestination(), "Ziel erreicht...") bereits gesprochen — "Navigation
    // beendet." wuerde diese Information nur redundant wiederholen (und koennte, falls
    // die Ankunfts-Ansage noch liefe, sie unnoetig unterbrechen). wasReached wurde HIER
    // OBEN, VOR dem Zuruecksetzen von destinationReached, gelesen und beschreibt exakt
    // "kam diese Beendigung NACH einer bereits erfolgten Zielankunft" — bei echtem
    // manuellem Abbruch VOR Ankunft (wasReached===false) bleibt "Navigation beendet."
    // unveraendert erhalten.
    if(announce && !wasReached){
      say("Navigation beendet.",
        ttsOpts({interrupt:true, source:"nav.navigationEnded", category:"STATUS"}));
    }
    // ---- Instrumentierung (neu): EIN Ereignis feuert immer (unabhaengig von
    // `announce`), damit die Sprach- und die Protokoll-Bedingung nicht mehr
    // auseinanderlaufen koennen (Audit-Befund F-6). Die eigentliche Ankunfts-
    // Bestaetigung (ROUTE_END) wird weiterhin ausschliesslich in
    // arriveAtDestination() geloggt — hier geht es nur um das Beenden/Abbrechen
    // selbst, NIE um eine normal abgeschlossene Route als "abgebrochen" zu werten. ----
    navLog("NAVIGATION_END_REQUESTED", { announce: !!announce, wasActive: wasActive,
      wasReached: wasReached, reason: effectiveReason });
    if(wasActive && !wasReached && effectiveReason !== "error"){
      navLog("ROUTE_CANCELLED", { reason: effectiveReason });
    } else if(effectiveReason === "error"){
      navLog("ROUTE_RESET_ERROR", { reason: "error", wasActive: wasActive, wasReached: wasReached });
    }
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
      say(t, ttsOpts({interrupt:true, source:"nav.noPathFound", category:"NAVIGATION_CONTEXT"}));
      setNavState(NavState.SEARCHING_START_TAG);
      return;
    }
    pathTagIds = p;
    segIndex = 0;
    currentTagId = tagId;
    console.log("[Route] " + pathToText(p));

    // neu (Tag-1-Sonderbehandlung): Tag 1 (Eingang) ist ein physisch entfernter
    // Startpunkt -- die Route ist hier bereits berechnet, aber der erste Abschnitt
    // (1->2) darf erst BEGINNEN, wenn Tag 1 TATSAECHLICH per Distanzmessung erreicht
    // wurde (siehe beginStartTagTracking()/reachStartTag() unten). Jeder ANDERE
    // Startknoten verhaelt sich weiterhin EXAKT wie zuvor (sofortiger Segmentbeginn,
    // Code unten unveraendert) -- diese Weiche ist ein reiner frueher Ausstieg.
    if(tagId === 1){
      navLog("ROUTE_PATH", { startTag: tagId, path: p, pathText: pathToText(p) });
      beginStartTagTracking(tagId);
      return;
    }

    var start = START_TEXTS[tagId] ||
      ("Sie sind bei " + markerName(tagId) + ". Halten Sie das Smartphone vor sich " +
       "und suchen Sie die nächste Markierung.");
    lastRouteInstruction = start;
    say("Route berechnet. " + start, ttsOpts({interrupt:true, source:"nav.routeCalculated",
      category:"NAVIGATION_CONTEXT", expectedTag: p[1]}));
    // ---- Instrumentierung (neu) ----
    navLog("ROUTE_PATH", { startTag: tagId, path: p, pathText: pathToText(p) });
    beginSegment();
  }

  // ---- Tag 1 (Eingang) als physisch verfolgter Startpunkt (neu) ----
  // Ersetzt fuer Tag 1 NUR den unmittelbaren Uebergang in beginSegment() (siehe
  // onStartTagConfirmed() oben) durch eine Zwischenphase: Tag 1 bleibt der verfolgte
  // Tag (expectedNextTagId bleibt 1, NICHT 2), segIndex bleibt bei 0 (zeigt weiterhin
  // auf die Kante 1->2 -- WICHTIG: dadurch liefert currentEdge() in handleTracking()
  // unveraendert die Kante 1->2 fuer die reachedM-Schwelle, exakt wie bei jeder
  // gewoehnlichen Kante, OHNE eigene Schwelle). Sobald Tag 1 die bestehende
  // 1,8-m-Ankunftslogik erfuellt, ruft handleTracking() reachStartTag() auf (siehe
  // dort und trackingStartTagActive oben) statt reachPoint() -- ab dann laeuft der
  // Abschnitt 1->2 exakt wie jeder andere Abschnitt weiter (beginSegment(),
  // unveraendert).
  function beginStartTagTracking(tagId){
    navLog("START_TAG_CONFIRMED", { startTag: tagId });

    var entranceText = START_TEXTS[tagId] ||
      ("Sie sind bei " + markerName(tagId) + ". Halten Sie das Smartphone gerade vor " +
       "sich. Gehen Sie geradeaus.");
    lastRouteInstruction = entranceText;
    // neu: KEIN "Route berechnet."-Praefix hier (Anforderung) -- die Route wurde
    // bereits still berechnet (siehe ROUTE_PATH oben), der Nutzer braucht JETZT nur
    // die Orientierungs- und Handlungsinformation, bevor er zu gehen beginnt.
    var entranceResult = say(entranceText, ttsOpts({interrupt:true,
      source:"nav.startTagEntrance", category:"NAVIGATION_CONTEXT", expectedTag: tagId}));
    navLog("TTS_START_ENTRANCE", { startTag: tagId, text: entranceText,
      speechId: entranceResult.speechId });

    expectedNextTagId = tagId;
    resetSegmentState();
    trackingStartTagActive = true;
    setNavState(NavState.TRACKING_START_TAG);
    updatePanel(null);
    // ---- Instrumentierung (neu) ----
    navLog("START_TAG_TRACKING_STARTED", { expectedTag: tagId });
  }

  // Tag 1 tatsaechlich erreicht (Distanz <= Schwelle, ueber die UNVERAENDERTEN
  // Ankunfts-Pruefungen in handleTracking()) -- spricht die NEUE, von Tag 2s eigener
  // Abbiege-Ansage bewusst GETRENNTE Anweisung (siehe graph-data.js: Kante 1->2 bleibt
  // "continue-straight", das Abbiegen bei Tag 2 fuer 2->3 bleibt unberuehrt) und
  // startet danach den Abschnitt 1->2 ganz normal ueber beginSegment().
  function reachStartTag(reason){
    var reachedTagId = pathTagIds[segIndex];   // = 1
    currentTagId = reachedTagId;
    trackingStartTagActive = false;

    navLog("START_TAG_REACHED", { startTag: reachedTagId, reason: reason || "distance-threshold" });

    var t = "Stopp. Biegen Sie rechts ab.";
    lastRouteInstruction = t;
    var turnResult = say(t, ttsOpts({interrupt:true, source:"nav.startTagTurn",
      category:"ACTION_REQUIRED"}));
    activeDirectionText = t;
    navLog("TTS_DIRECTION", { reachedTag: reachedTagId, action: "turn-right", isTurn: true,
      text: t, speechId: turnResult.speechId });
    // neu: wie jedes echte Abbiegen beginnt danach ein neuer Korridor (siehe
    // reachPoint()) -- corridorProgressM ist an dieser Stelle ohnehin noch 0 (vor Tag 1
    // wurde noch keine Kante gutgeschrieben), macht diesen Aufruf zu einem No-Op, haelt
    // aber die Invariante "jedes echte Abbiegen setzt den Korridor zurueck" exakt ein.
    resetCorridorState("start-tag-turn");

    beginSegment();
    // neu: dieselbe Nach-Abbiege-Bestaetigungs-Infrastruktur wie bei jedem anderen
    // echten Abbiegen (siehe reachPoint()) -- sobald Tag 2 gefunden ist, wird einmalig
    // "Gehen Sie geradeaus." bestaetigt. Voellig unabhaengig von Tag 2s EIGENER,
    // spaeterer Abbiege-Bestaetigung (nach dessen Kante 2->3), da an (routeRunId,
    // turnTag=1, expectedTag=2) gebunden -- siehe setPostTurnPending().
    setPostTurnPending(reachedTagId, expectedNextTagId);
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
    setNavState(NavState.TRACKING);
    minTrackDist = dist != null ? dist : null;
    awayWarned = false;
    if(expectedNextTagId !== destinationId) buzz(50);
    updatePanel(dist);
    // ---- Instrumentierung (neu) ----
    segTrackingStartedAt = performance.now();
    navLog("TTS_SUPPRESSED_MARKER_FOUND", { expectedTag: expectedNextTagId,
      isDestination: expectedNextTagId === destinationId,
      buzzed: expectedNextTagId !== destinationId });

    // neu: sofortiger erste Versuch der anstehenden Nach-Abbiege-Bestaetigung (falls
    // eine ansteht) — Wiederholung bei "busy" uebernimmt tryPostTurnConfirmation()
    // selbst (siehe dort); wird ab dem naechsten Tick zusaetzlich aus handleTracking()
    // heraus erneut geprueft (gedrosselt, siehe dort), NICHT hier erneut aufgerufen.
    tryPostTurnConfirmation();
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
    // neu: die soeben abgeschlossene Kante ("edge") ist bereits zurueckgelegte,
    // garantiert gerade Strecke (ihr eigenes Abbiegen-Erfordernis, falls vorhanden,
    // wurde bereits BEIM VORHERIGEN reachPoint()-Aufruf entschieden und angesagt) —
    // wird dem Korridor-Fortschritt IMMER gutgeschrieben, unabhaengig davon, ob JETZT
    // (fuer die naechste Kante) ein Abbiegen ansteht.
    creditCorridorProgress(edge ? edge.distanceM : null);

    var nextEdge = EDGE_MAP[reachedTagId + "->" + pathTagIds[segIndex + 2]];
    var isTurn = isTurnAction(nextEdge);
    // neu: bei einem ECHTEN Abbiegen wird der Text generisch aus der vorhandenen
    // departureAction abgeleitet und mit "Stopp. " vorangestellt — GENAU EIN Ort im
    // Code, der das tut, unabhaengig davon, welcher Tag/welche Kante betroffen ist
    // (keine Tag-2-spezifische Sonderbehandlung). Kein neuer Stopp-Abstand, keine neue
    // Schwelle: der Ausloeser bleibt exakt der bestehende REACHED-Zeitpunkt
    // (arrival <= SETTINGS.reachedM, siehe handleTracking()).
    var baseText = departureActionSpeech(nextEdge);
    var t = isTurn ? ("Stopp. " + baseText) : baseText;
    lastRouteInstruction = t;

    if(isTurn){
      // Echtes Abbiegen: MUSS IMMER hoerbar sein (nie durch Dedup unterdrueckt) — direkt
      // say() statt speakDirectionIfNew(), aber activeDirectionText wird trotzdem auf den
      // Abbiege-Text gesetzt, damit die naechste Geradeaus-Bestaetigung danach korrekt
      // als NEU erkannt wird (nicht identisch mit dem vorherigen Abbiege-Text). Dieses
      // unconditional-Update ist ABSICHTLICH unabhaengig von result.accepted (anders als
      // die Faelle unten, die ueber speakDirectionIfNew laufen): der logische
      // "aktuelle Richtungszeiger" muss auch bei stummem Modus weiterlaufen, sonst
      // wuerde die naechste Geradeaus-Ansage nach einem Entstummen faelschlich als
      // Duplikat einer NIE gehoerten Abbiege-Ansage unterdrueckt.
      var turnResult = say(t, ttsOpts({interrupt:true, source:"nav.turnInstruction",
        category:"ACTION_REQUIRED"}));
      activeDirectionText = t;
      navLog("TTS_DIRECTION", { reachedTag: reachedTagId, action: nextEdge.departureAction,
        isTurn: true, text: t, speechId: turnResult.speechId });
      // neu: nach einem echten Abbiegen beginnt ein NEUER Korridor — bisheriger
      // Fortschritt wird verworfen (die naechste Kante wurde ja gerade erst als
      // Abbiegen angesagt, ihre Distanz wird erst gutgeschrieben, wenn sie tatsaechlich
      // durchlaufen wurde, siehe oben beim naechsten reachPoint()-Aufruf).
      resetCorridorState("turn");
    } else {
      // Kein Abbiegen: ueber die gemeinsame Dedup-Logik ansagen — auf einem langen
      // geraden Korridor mit mehreren Zwischen-Tags wird dies nur beim ERSTEN
      // Zwischen-Tag nach dem letzten Abbiegen tatsaechlich gesprochen; jeder weitere
      // Zwischen-Tag auf DERSELBEN Geradeaus-Strecke wird als Duplikat unterdrueckt
      // (TTS_STRAIGHT_SUPPRESSED_DUPLICATE) — genau EINE Ansage pro Korridor.
      var straightResult = speakDirectionIfNew(t, ttsOpts({interrupt:true, source:"nav.reachPointStraight",
        category:"NAVIGATION_CONTEXT"}), "TTS_STRAIGHT",
        { reachedTag: reachedTagId, action: nextEdge.departureAction, trigger: "reached-tag" });
      if(straightResult.accepted){
        corridorLastReassuranceAtM = corridorProgressM;
      }
      // neu: falls die obige Ansage (korrekt) als Duplikat unterdrueckt wurde, ABER
      // inzwischen genug Korridor-Distanz aufgelaufen ist, sorgt dies fuer die
      // gelegentliche Rueckversicherung auf langen, sonst stillen Geradeausstrecken —
      // no-op, falls straightResult.accepted true war (sinceLast dann 0) oder die
      // 15-Meter-Schwelle noch nicht erreicht ist.
      maybeTriggerCorridorReassurance();
    }
    segIndex++;
    // beginSegment() setzt expectedNextTagId SOFORT auf den naechsten Tag und
    // wechselt in SEARCHING_NEXT_TAG — ab dem naechsten Frame wird er erkannt.
    // WICHTIG: erst NACH beginSegment() aufrufen, damit resetSegmentState() (das
    // beginSegment() intern aufruft) NICHT versehentlich diesen Zustand ueberschreibt —
    // resetSegmentState() ruehrt postTurnPending bewusst NICHT an (siehe dort).
    beginSegment();
    if(isTurn){
      setPostTurnPending(reachedTagId, expectedNextTagId);
    }
    navLog("REACHED -> next segment", { reachedTag: reachedTagId,
      reason: reason || "distance-threshold", newExpectedTag: expectedNextTagId,
      state: navState });
  }

  function arriveAtDestination(){
    destinationReached = true;
    navigationActive = false;
    expectedNextTagId = null;
    resetActiveDirectionState();
    clearPostTurnPending("destination-arrival");
    resetCorridorState("destination-arrival");
    var t = ARRIVALS[destinationId] || ("Ziel erreicht. Sie sind bei " + markerName(destinationId) + ".");
    lastRouteInstruction = t;
    setNavState(NavState.DESTINATION_REACHED);
    var destResult = say(t, ttsOpts({interrupt:true, source:"nav.destinationArrival",
      category:"ACTION_REQUIRED"}));
    updatePanel(null);
    renderNavigationUi();
    // ---- Instrumentierung (neu) ----
    navLog("ROUTE_END", { destinationId: destinationId, reason: "arrived" });
    navLog("TTS_DESTINATION", { destinationId: destinationId, text: t, speechId: destResult.speechId });
  }

  // ---- TRACKING: laufende Distanzmessung zum Tag voraus ----
  // v13: rawDist = frische Roh-Messung dieses Frames (oder null).
  function handleTracking(now, visible, rawDist){
    // neu (Bugfix): einziger "spaeterer, kontrollierter" Aufrufpunkt fuer die
    // Nach-Abbiege-Bestaetigungs-Wiederholung — handleTracking() laeuft bereits jeden
    // Tick waehrend TRACKING (main-loop.js, unveraendert), tryPostTurnConfirmation()
    // selbst drosselt auf hoechstens einen Versuch pro POST_TURN_RETRY_INTERVAL_MS und
    // ist ein sofortiger No-Op, sobald kein Zustand mehr aussteht — beruehrt keine der
    // folgenden Distanz-/EMA-/REACHED-/Verlust-Berechnungen.
    tryPostTurnConfirmation();

    var edge = currentEdge();
    // neu (Tag-1-Sonderbehandlung): waehrend der TRACKING_START_TAG-Phase gilt die
    // EIGENE, engere Ankunfts-Schwelle SETTINGS.startTagReachedM statt der normalen
    // edge/SETTINGS.reachedM-Ableitung — einzige Aenderung gegenueber gewoehnlichem
    // Tracking; alles ANDERE unterhalb (raw/EMA, trackingConfirmed, arrivalConfirmFrames,
    // Near-Loss-Fallback) bleibt fuer Tag 1 exakt dieselbe Berechnung wie fuer jeden
    // anderen Tag, nur mit diesem anderen Schwellenwert verglichen.
    var reachedM = trackingStartTagActive ? SETTINGS.startTagReachedM :
      ((edge && edge.reachedM != null) ? edge.reachedM : SETTINGS.reachedM);

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
          // neu (Tag-1-Sonderbehandlung): identische Ankunfts-Pruefung, NUR die
          // Ziel-Funktion unterscheidet sich -- keine Duplizierung der Distanz-/EMA-/
          // Rahmen-Logik oben.
          if(trackingStartTagActive) reachStartTag("distance-threshold");
          else reachPoint("distance-threshold");
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

      // neu (Fehlalarm-Fix): Away-Baseline-Pflege — siehe Deklaration von
      // minAwayEmaDist oben fuer die Begruendung. Etablierung UND Zaehlung laufen
      // ausschliesslich HIER, ausschliesslich waehrend trackingConfirmed bereits
      // true ist; der Frame, der die Baseline zum ERSTEN MAL setzt, erhoeht
      // awayPostConfirmSamples NICHT (kein "else"-Zweig fuer diesen Fall) —
      // dieser Zaehler beginnt erst ab dem naechsten Frame zu laufen.
      if(trackingConfirmed){
        if(minAwayEmaDist == null){
          minAwayEmaDist = emaDist;
          awayPostConfirmSamples = 0;
          navLog("AWAY_BASELINE_READY", { expectedTag: expectedNextTagId,
            ema: r1(emaDist), postConfirmSamples: awayPostConfirmSamples, state: navState });
        } else {
          awayPostConfirmSamples++;
          if(emaDist < minAwayEmaDist){
            minAwayEmaDist = emaDist;
            awayWarned = false;
          }
        }
      }

      // Distanz steigt deutlich über das Minimum -> Nutzer entfernt sich
      // neu: nur NACH Bestaetigung, nur gegen die dedizierte Away-Baseline (NICHT
      // mehr minTrackDist), und erst nach mindestens AWAY_BASELINE_MIN_SAMPLES
      // weiteren gueltigen Messungen NACH deren Etablierung (siehe oben).
      if(trackingConfirmed && !awayWarned && minAwayEmaDist != null &&
         awayPostConfirmSamples >= AWAY_BASELINE_MIN_SAMPLES &&
         emaDist - minAwayEmaDist >= SETTINGS.awayDeltaM && !speaking()){
        var awayResult = say("Sie entfernen sich von der Markierung. Bleiben Sie stehen.",
          ttsOpts({source:"nav.awayWarning", category:"ACTION_REQUIRED"}));
        if(awayResult.accepted){
          awayWarned = true;
          navLog("AWAY_WARNING_TRIGGERED", { expectedTag: expectedNextTagId,
            ema: r1(emaDist), minAwayEma: r1(minAwayEmaDist),
            delta: r1(emaDist - minAwayEmaDist), postConfirmSamples: awayPostConfirmSamples,
            awayDeltaM: SETTINGS.awayDeltaM });
        }
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
      // neu (Tag-1-Sonderbehandlung): siehe Kommentar beim anderen reachPoint()-Aufruf
      // oben -- gleiche Weiche, gleiche Begruendung.
      if(trackingStartTagActive) reachStartTag("near-loss-fallback");
      else reachPoint("near-loss-fallback");
      return;
    }

    // Sonst: Verlust gilt NICHT als "erreicht". Der Nutzer könnte das Telefon
    // weggedreht, die Kamera verdeckt oder zu früh abgebogen haben.
    // WICHTIG (TTS-Aufraeumung): der interne Zustandsuebergang zu LOST_STOPPED bleibt
    // HIER unveraendert (weiterhin nach trackLostStopMs, unveraendert) — NUR die
    // gesprochene Stopp-Ansage wird jetzt zusaetzlich um SETTINGS.lostSpeechDelayMs
    // verzoegert (siehe handleLostStopped()), damit der erwartete Tag oder ein
    // gueltiger Vorgriffs-Kandidat noch Zeit hat, sich zu bestaetigen, bevor "Stopp"
    // tatsaechlich gesprochen wird.
    setNavState(NavState.LOST_STOPPED);
    // ---- Instrumentierung (neu) ----
    segLostCount++;
    segLostSince = now;
    navLog("LOST_STOPPED", { expectedTag: expectedNextTagId, lastEma: r1(emaDist),
      lastRaw: r1(lastRawDist) });
    lostSpeechPending = true;
    lostSpeechPendingSince = now;
    navLog("TTS_LOST_PENDING", buildLostDecisionLogData(now, null));
  }

  // ---- LOST_STOPPED: warten, bis derselbe Tag wieder im Bild ist ODER ein gueltiger
  // Vorgriffs-Kandidat bestaetigt wird (updateSkipCandidate() laeuft parallel weiter,
  // siehe main-loop.js) ----
  function handleLostStopped(now, det){
    if(det){
      // Wieder gefunden: Messung geht weiter.
      // neu (Tag-1-Sonderbehandlung): war der Verlust WAEHREND der Tag-1-Verfolgung
      // entstanden (trackingStartTagActive, siehe oben -- bleibt waehrend eines
      // LOST_STOPPED innerhalb dieser Phase unveraendert true), muss auch die
      // Wiederaufnahme in TRACKING_START_TAG zurueckkehren, NICHT in das normale
      // TRACKING -- sonst wuerde main-loop.js ab dem naechsten Frame faelschlich
      // updateSkipCandidate() fuer Tag 2 zulassen, obwohl Tag 1 noch nicht erreicht ist.
      setNavState(trackingStartTagActive ? NavState.TRACKING_START_TAG : NavState.TRACKING);
      var d = (det.dist != null) ? det.dist : emaDist;
      if(d != null) emaDist = d;
      var wasStopSpoken = lostInstructionSpoken;
      if(lostSpeechPending){
        lostSpeechPending = false;
        navLog("TTS_LOST_CANCELLED_EXPECTED_FOUND", buildLostDecisionLogData(now, "expected-tag-found"));
      }
      // ---- Instrumentierung (neu) ----
      segReacquireCount++;
      if(segLostSince != null){ segLostMs += (now - segLostSince); segLostSince = null; }
      navLog("REACQUIRED", { expectedTag: expectedNextTagId, dist: r1(emaDist) });
      navLog("TTS_REACQUIRED_CONTINUE", { expectedTag: expectedNextTagId,
        dist: r1(emaDist), wasLostInstructionSpoken: wasStopSpoken });
      lostInstructionSpoken = false;
      // neu: KEINE technische "Markierung wieder gefunden"-Ansage. Nur wenn zuvor
      // TATSAECHLICH ein Stopp gesprochen wurde, wird die Wiederaufnahme einmal
      // ueber die gemeinsame Dedup-Logik bestaetigt — war zuvor kein Stopp
      // gesprochen, bleibt die Wiederaufnahme bewusst STUMM (der Nutzer wusste ja
      // nicht, dass die Kamera den Tag kurz verloren hatte).
      if(wasStopSpoken){
        var edge = currentEdge();
        var isTurnNext = !!(edge && isTurnAction(edge));
        var recoveryText = isTurnNext ? departureActionSpeech(edge) : "Gehen Sie weiter geradeaus.";
        speakDirectionIfNew(recoveryText, ttsOpts({interrupt:true, source:"nav.reacquired",
          category:"NAVIGATION_CONTEXT"}), "TTS_RECOVERY_STRAIGHT",
          { expectedTag: expectedNextTagId, trigger: "recovery-after-stop", isTurn: isTurnNext });
      }
      return;
    }

    // Noch verloren.
    if(lostSpeechPending){
      var elapsed = now - lostSpeechPendingSince;
      var forwardCandidateProgressing = skipCandTagId != null && skipCandCount > 0;
      if(elapsed < SETTINGS.lostSpeechDelayMs){
        return;   // weiter abwarten, keine Ansage, keine Erinnerung
      }
      if(forwardCandidateProgressing){
        // Anforderung 4: solange ein gueltiger Vorgriffs-Kandidat gerade
        // Bestaetigung sammelt, wird die Stopp-Ansage weiter zurueckgehalten (nicht
        // endgueltig storniert — nur diese Pruef-Gelegenheit).
        navLog("TTS_LOST_CANCELLED_FORWARD_CANDIDATE",
          buildLostDecisionLogData(now, "forward-candidate-progressing"));
        return;
      }
      if(speaking()) return;   // keine wichtigere Ansage unterbrechen
      var lostText;
      if(emaDist != null && emaDist <= SETTINGS.nearLostM){
        // Sehr nah verloren: vorsichtig weiter, Marke erneut suchen (kein volles "Stopp").
        lostText = "Der Orientierungspunkt ist sehr nah. Gehen Sie langsam weiter " +
                   "und suchen Sie die Markierung erneut.";
      } else {
        lostText = "Stopp. Suchen Sie die Markierung. Bewegen Sie die Kamera langsam " +
                   "nach links und rechts.";
      }
      var lostResult = say(lostText, ttsOpts({interrupt:true, source:"nav.lostInstruction",
        category:"SAFETY_CRITICAL"}));
      lostInstructionSpoken = true;
      lostSpeechPending = false;
      resetActiveDirectionState();   // Vertrauensbasis zuruecksetzen -> Wiederaufnahme spricht frisch
      stopSaidAt = now;
      navLog("TTS_LOST_INSTRUCTION", { expectedTag: expectedNextTagId,
        variant: (emaDist != null && emaDist <= SETTINGS.nearLostM) ? "near" : "stop",
        text: lostText, lostForMs: Math.round(elapsed), speechId: lostResult.speechId });
      return;
    }

    // Stopp wurde bereits gesprochen: NUR noch ein kurzer, seltener Hinweis — NICHT
    // die volle Verlust-Ansage wiederholen. Deutlich seltener als vorher
    // (SETTINGS.lostReminderRepeatMs statt scanHintRepeatMs).
    if(lostInstructionSpoken && now - stopSaidAt >= SETTINGS.lostReminderRepeatMs && !speaking()){
      stopSaidAt = now;
      var reminderResult = say("Suchen Sie weiter.",
        ttsOpts({source:"nav.lostReminder", category:"STATUS"}));
      navLog("TTS_LOST_REMINDER", { expectedTag: expectedNextTagId, speechId: reminderResult.speechId });
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

  // Generischer Helfer (siehe Anforderung): sind ALLE Kanten zwischen fromIdx und
  // toIdx auf dem gegebenen aktiven Pfad ohne ein noch nicht angesagtes Abbiegen
  // passierbar? Einzige heute im Graphen vorhandene "Manöver"-Kategorie ist
  // turn-left/turn-right (siehe DEPARTURE_ACTIONS in graph.js); es gibt in den
  // aktuellen Routendaten KEINE separate Kodierung fuer Tuer-/Treppen-/Aufzug-
  // Uebergaenge oder Pflicht-Stopps (recherchiert, nicht geraten) — sollten solche
  // Kanten spaeter ergaenzt werden, muessen sie als neuer departureAction-Wert mit
  // isTurn:true (oder einer verallgemeinerten "blocksForwardSkip"-Markierung) im
  // Graphen erscheinen; dieser Helfer wuerde sie dann automatisch beruecksichtigen,
  // ohne Code-Aenderung hier.
  function isForwardTagReachableWithoutManeuver(activePath, fromIdx, toIdx){
    if(!activePath || fromIdx < 0 || toIdx <= fromIdx || toIdx >= activePath.length) return false;
    for(var i = fromIdx; i < toIdx; i++){
      var e = EDGE_MAP[activePath[i] + "->" + activePath[i + 1]];
      if(!e || isTurnAction(e)) return false;
    }
    return true;
  }

  // Durchsucht ALLE diesmal decodierten Tags (nicht nur bestKnown) nach dem BESTEN
  // gueltigen Vorgriffs-Kandidaten auf dem aktiven Pfad: muss (1) ueberhaupt auf
  // pathTagIds liegen, (2) echt VOR dem erwarteten Tag liegen (weiter vorne, nicht
  // dahinter/schon passiert), (3) ohne ein noch nicht angesagtes Abbiegen erreichbar
  // sein (isForwardTagReachableWithoutManeuver()). "Bester" = der FRUEHESTE gueltige
  // sichtbare Tag (staerkster zuverlaessiger Beleg fuer Fortschritt: ein gleichzeitig
  // sichtbarer WEITERER entfernter Tag koennte durch eine andere Tuer/einen anderen
  // Korridor/Glaswand sichtbar sein, siehe Sicherheitsanforderung) — niemals der
  // geometrisch naechste. Gibt auch alle abgelehnten Sichtungen mit Grund zurueck,
  // fuer die FORWARD_CANDIDATE_REJECTED-Protokollierung.
  function findVisibleForwardCandidate(detectedList){
    var result = { candidate: null, rejections: [] };
    if(!pathTagIds || expectedNextTagId == null) return result;
    var expectedIdx = pathTagIds.indexOf(expectedNextTagId);
    if(expectedIdx < 0) return result;

    for(var d = 0; d < detectedList.length; d++){
      var tagId = detectedList[d].id;
      var idx = pathTagIds.indexOf(tagId);
      if(idx < 0){
        result.rejections.push({ tagId: tagId, pathIndex: null, reason: "NOT_ON_ACTIVE_PATH" });
        continue;
      }
      if(idx <= expectedIdx){
        // idx === expectedIdx kann hier strukturell nicht vorkommen: main-loop.js
        // ruft diese Pruefung nur auf, wenn expectedNextTagId selbst diesmal NICHT
        // erkannt wurde (siehe updateSkipCandidate()-Kommentar). idx < expectedIdx
        // ist ein bereits passierter Tag.
        result.rejections.push({ tagId: tagId, pathIndex: idx, reason: "BEHIND_CURRENT_POSITION" });
        continue;
      }
      if(!isForwardTagReachableWithoutManeuver(pathTagIds, expectedIdx, idx)){
        result.rejections.push({ tagId: tagId, pathIndex: idx, reason: "MANEUVER_BETWEEN" });
        continue;
      }
      if(result.candidate == null || idx < result.candidate.targetIdx){
        result.candidate = { tagId: tagId, targetIdx: idx, expectedIdx: expectedIdx,
          dist: detectedList[d].dist };
      }
    }
    return result;
  }

  // Pro Frame von main-loop.js aufgerufen — WAEHREND SEARCHING_NEXT_TAG, TAG_CANDIDATE,
  // TRACKING UND LOST_STOPPED, aber NIE in einem Frame, in dem der erwartete Tag selbst
  // diesmal erkannt wird (siehe main-loop.js: Aufruf nur bei !expectedDet) — das gibt
  // dem normalen erwarteten Tag in JEDEM Zustand Vorrang. Haelt eine EIGENSTAENDIGE,
  // "klebrige" Bestaetigungsserie: da findVisibleForwardCandidate() IMMER den
  // fruehesten gueltigen sichtbaren Tag liefert, kann ein gleichzeitig sichtbarer
  // weiter entfernter Tag einen bereits aktiven, naeheren Kandidaten strukturell nie
  // verdraengen; ein kurzzeitiges Verschwinden des aktiven Kandidaten wird bis
  // SETTINGS.candMemoryMs toleriert, bevor die Serie verworfen wird.
  function updateSkipCandidate(detectedList, now){
    if(navState !== NavState.SEARCHING_NEXT_TAG && navState !== NavState.TAG_CANDIDATE &&
       navState !== NavState.TRACKING && navState !== NavState.LOST_STOPPED) return;
    if(!pathTagIds || expectedNextTagId == null) return;

    var detectedTagIds = detectedList.map(function(d){ return d.id; });
    var scan = findVisibleForwardCandidate(detectedList);
    var best = scan.candidate;
    var expectedIdx = pathTagIds.indexOf(expectedNextTagId);

    navLog("FORWARD_SCAN", { destinationTag: destinationId, activePath: pathTagIds,
      state: navState, expectedTag: expectedNextTagId,
      forwardCandidateTag: best ? best.tagId : null, expectedPathIndex: expectedIdx,
      candidatePathIndex: best ? best.targetIdx : null, detectedTagIds: detectedTagIds });

    for(var r = 0; r < scan.rejections.length; r++){
      var rej = scan.rejections[r];
      navLog("FORWARD_CANDIDATE_REJECTED", { state: navState, expectedTag: expectedNextTagId,
        expectedPathIndex: expectedIdx, forwardCandidateTag: rej.tagId,
        candidatePathIndex: rej.pathIndex, detectedTagIds: detectedTagIds,
        blockingReason: rej.reason });
    }

    if(best && best.tagId === skipCandTagId){
      skipCandCount++;
      skipCandTargetIdx = best.targetIdx;
      skipCandDist = best.dist;
      skipCandLastSeenAt = now;
      navLog("FORWARD_CANDIDATE_PROGRESS", { state: navState, expectedTag: expectedNextTagId,
        forwardCandidateTag: skipCandTagId, expectedPathIndex: best.expectedIdx,
        candidatePathIndex: best.targetIdx, detectedTagIds: detectedTagIds,
        count: skipCandCount, neededFrames: SETTINGS.otherTagFrames });
    } else if(skipCandTagId != null && (now - skipCandLastSeenAt) <= SETTINGS.candMemoryMs){
      // Aktiver Kandidat diesmal nicht die fruehste gueltige sichtbare Wahl (abwesend,
      // oder ein weiter entfernter Tag ist sichtbar) — aber noch innerhalb der
      // Toleranz. NICHTS aendern: kein Reset, kein Wechsel.
    } else if(best){
      if(skipCandTagId != null){
        navLog("FORWARD_CANDIDATE_REJECTED", { state: navState, expectedTag: expectedNextTagId,
          expectedPathIndex: expectedIdx, forwardCandidateTag: skipCandTagId,
          candidatePathIndex: skipCandTargetIdx, detectedTagIds: detectedTagIds,
          blockingReason: "INSUFFICIENT_CONFIRMATION", countAtRejection: skipCandCount });
      }
      skipCandTagId = best.tagId;
      skipCandTargetIdx = best.targetIdx;
      skipCandDist = best.dist;
      skipCandCount = 1;
      skipCandLastSeenAt = now;
      navLog("FORWARD_CANDIDATE_STARTED", { state: navState, expectedTag: expectedNextTagId,
        forwardCandidateTag: best.tagId, expectedPathIndex: best.expectedIdx,
        candidatePathIndex: best.targetIdx, detectedTagIds: detectedTagIds });
    } else if(skipCandTagId != null){
      navLog("FORWARD_CANDIDATE_REJECTED", { state: navState, expectedTag: expectedNextTagId,
        expectedPathIndex: expectedIdx, forwardCandidateTag: skipCandTagId,
        candidatePathIndex: skipCandTargetIdx, detectedTagIds: detectedTagIds,
        blockingReason: "INSUFFICIENT_CONFIRMATION", countAtRejection: skipCandCount });
      resetSkipCandidate();
    }

    if(skipCandTagId != null && skipCandCount >= SETTINGS.otherTagFrames){
      var tagId = skipCandTagId, targetIdx = skipCandTargetIdx, dist = skipCandDist;
      var previousExpectedTag = expectedNextTagId, previousExpectedIdx = expectedIdx,
          previousSegIndex = segIndex, previousState = navState;
      var skippedTagIds = pathTagIds.slice(previousExpectedIdx, targetIdx);
      resetSkipCandidate();
      navLog("FORWARD_PROGRESS_CONFIRMED", { destinationTag: destinationId,
        activePath: pathTagIds, state: previousState, expectedTag: previousExpectedTag,
        forwardCandidateTag: tagId, expectedPathIndex: previousExpectedIdx,
        candidatePathIndex: targetIdx, skippedTagIds: skippedTagIds,
        confirmationFrames: SETTINGS.otherTagFrames });
      beginTrackingForwardCandidate(targetIdx, tagId, dist, now);
      navLog("TRACKING_RETARGETED", { destinationTag: destinationId, activePath: pathTagIds,
        state: previousState, expectedTag: previousExpectedTag, forwardCandidateTag: tagId,
        expectedPathIndex: previousExpectedIdx, candidatePathIndex: targetIdx,
        previousPathIndex: previousSegIndex, newPathIndex: segIndex,
        skippedTagIds: skippedTagIds, newExpectedTag: expectedNextTagId,
        reason: "forward-progress-confirmed" });
    }
  }

  // Bestaetigte Kandidatur -> NUR Umschalten des verfolgten Tags (wie ein normales
  // "gefunden", siehe onNextTagFound()) — KEINE Ankunft, KEIN reachPoint(), KEIN
  // REACHED (Anforderung 8: unveraendert). Alle uebersprungenen Zwischen-Tags werden
  // aus der aktiven Verfolgung entfernt, OHNE als "erreicht" gezaehlt zu werden
  // (currentTagId bleibt unveraendert); currentEdge() zeigt danach auf die Kante ZUM
  // Kandidaten, deren Distanz spaeter — bei TATSAECHLICHER Ankunft — ganz normal von
  // reachPoint() addiert wird, wie im nicht uebersprungenen Fall (auch wenn der
  // Kandidat das gewaehlte Ziel ist — Anforderung 7: keine Ankunfts-Ansage hier,
  // ausschliesslich "Gehen Sie weiter geradeaus."). Einzige Sprachausgabe hier laeuft
  // ueber die gemeinsame Dedup-Logik (speakDirectionIfNew()) — bei gewoehnlichem
  // Retarget waehrend fluessigen Gehens fast immer ein Duplikat der bereits aktiven
  // Ansage und bleibt daher stumm (Anforderung 2: "nicht bei jedem Vorgriffs-
  // Retarget"); war der Retarget waehrend eines anstehenden Verlusts, wird die
  // Stopp-Ansage storniert und die aktive Richtung zurueckgesetzt, sodass HIER
  // frisch bestaetigt wird (Anforderung 3).
  function beginTrackingForwardCandidate(targetIdx, confirmedTagId, dist, now){
    var routeIndexBefore = segIndex;
    var wasLostPending = lostSpeechPending;
    var bypassedTags = pathTagIds.slice(routeIndexBefore + 1, targetIdx);

    // neu: ein Vorgriffs-Retarget ueberspringt IMMER den Tag, auf den eine eventuell
    // anstehende Nach-Abbiege-Bestaetigung wartet (findVisibleForwardCandidate() liefert
    // nur Kandidaten ECHT VOR dem erwarteten Tag, siehe dort) — die eigene "Gehen Sie
    // weiter geradeaus."-Bestaetigung weiter unten in dieser Funktion uebernimmt bereits
    // die Rolle "Bestaetigung, dass es geradeaus weitergeht", daher wird hier storniert
    // statt eine zweite, nie erreichbare Bestaetigung offen zu lassen.
    clearPostTurnPending("forward-skip-retarget");

    var bypassedDistanceM = 0;
    for(var i = routeIndexBefore; i < targetIdx - 1; i++){
      var e = EDGE_MAP[pathTagIds[i] + "->" + pathTagIds[i + 1]];
      bypassedDistanceM += (e && e.distanceM != null) ? e.distanceM : 0;
    }
    // neu: die uebersprungenen Kanten sind bereits zurueckgelegte Strecke, und
    // isForwardTagReachableWithoutManeuver() (siehe updateSkipCandidate()) garantiert,
    // dass JEDE Kante zwischen dem erwarteten Tag und dem Kandidaten "continue-straight"
    // ist — ein Vorgriffs-Ziel mit einem Abbiegen dazwischen waere gar nicht erst als
    // Kandidat zugelassen worden. Daher hier IMMER gutschreiben, ohne erneute Abbiege-
    // Pruefung. Die letzte Kante INS Ziel (targetIdx-1 -> targetIdx) ist bewusst NICHT
    // enthalten (wie bei bypassedDistanceM oben) — sie wird erst bei TATSAECHLICHER
    // Ankunft ueber den normalen reachPoint()-Pfad gutgeschrieben.
    creditCorridorProgress(bypassedDistanceM);

    if(wasLostPending){
      navLog("TTS_LOST_CANCELLED_RETARGET", buildLostDecisionLogData(now, "forward-retarget-confirmed"));
      lostSpeechPending = false;
    }

    navLog("SKIPPED_FORWARD", { previousTag: pathTagIds[routeIndexBefore],
      bypassedTags: bypassedTags, confirmedTag: confirmedTagId,
      routeIndexBefore: routeIndexBefore, routeIndexAfter: targetIdx - 1,
      confirmationFrames: SETTINGS.otherTagFrames, bypassedDistanceM: r1(bypassedDistanceM),
      reason: "forward-tag-confirmed" });

    segIndex = targetIdx - 1;
    expectedNextTagId = confirmedTagId;
    resetSegmentState();     // frische EMA/Tracking-Zustaende — keine Reste vom
                              // abgebrochenen Verfolgen des uebersprungenen Tags
    onNextTagFound(dist);    // identischer Uebergang wie bei normalem Fund: TRACKING
                              // beginnt, optionale Vibration, KEINE Ankunftsansage hier

    if(wasLostPending) resetActiveDirectionState();
    // Audit-Korrektur (F-1/Ziel 4): dies war der EINZIGE Richtungs-Bestaetigungs-Aufruf
    // ohne interrupt:true — konnte dadurch bei belegtem TTS-Kanal spurlos verworfen
    // werden UND den Dedup-Zustand fuer die naechste Ansage verfaelschen. Jetzt wie
    // alle anderen Richtungs-Bestaetigungen konsistent interrupt:true; der gesprochene
    // Text ("Gehen Sie weiter geradeaus.") bleibt UNVERAENDERT.
    // neu: Ergebnis erfassen — bei tatsaechlicher Ansage uebernimmt diese Bestaetigung
    // die Rolle der Korridor-Rueckversicherung fuer diese Strecke (Anforderung: "die
    // Skip-Ansage soll denselben 'letzte Geradeaus-Anweisung'-Zustand aktualisieren") —
    // verhindert, dass kurz nach einem hoerbaren Vorgriffs-Retarget zusaetzlich noch
    // die 15-Meter-Rueckversicherung ausgeloest wird, obwohl der Nutzer gerade erst
    // eine gleichwertige Bestaetigung gehoert hat.
    var skipResult = speakDirectionIfNew("Gehen Sie weiter geradeaus.",
      ttsOpts({interrupt:true, source:"nav.forwardSkipConfirmation", category:"NAVIGATION_CONTEXT"}),
      "TTS_STRAIGHT",
      { confirmedTag: confirmedTagId,
        trigger: wasLostPending ? "forward-retarget-after-lost" : "forward-retarget" });
    if(skipResult.accepted){
      corridorLastReassuranceAtM = corridorProgressM;
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
    var p, source;
    var passedIdx = pathTagIds ? pathTagIds.indexOf(tagId) : -1;
    if(passedIdx >= 0 && passedIdx <= segIndex){
      p = "Sie gehen möglicherweise zurück. Sie sind wieder bei " + markerName(tagId) +
          ". Bitte folgen Sie der letzten Anweisung.";
      source = "nav.backTagWarning";
    } else {
      p = (OFF_ROUTE_HINTS[tagId] || ("Erkannt: " + markerName(tagId) + ".")) +
          " Diese Markierung liegt nicht auf dem Weg. Bitte folgen Sie der letzten Anweisung.";
      source = "nav.offRouteWarning";
    }
    var result = say(p, ttsOpts({source: source, category:"ACTION_REQUIRED"}));
    if(result.accepted){
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

    // neu: "Markierung mittig." entfernt — Zentrierung ist keine Handlungsanweisung
    // (der Nutzer muss nichts mehr tun, im Gegensatz zu links/rechts/hoeher/tiefer).
    // zone/lastAimZone/lastAimAt werden TROTZDEM aktualisiert (wie zuvor bei
    // erfolgreicher Ansage), damit die bestehende Cooldown-/Uebergangs-Logik fuer die
    // verbleibenden, echten Korrektur-Hinweise unveraendert weiterlaeuft — kein zweiter
    // Log-Eintrag pro Frame: die obige zone===lastAimZone-Pruefung sorgt dafuer, dass
    // dies nur EINMAL beim UEBERGANG in die Mitte protokolliert wird, nicht bei jedem
    // weiteren Frame, in dem der Tag mittig bleibt.
    if(zone === "center"){
      lastAimZone = zone;
      lastAimAt = now;
      navLog("TTS_AIM_CENTER_SUPPRESSED", { expectedTag: expectedNextTagId, state: navState });
      return;
    }

    // neu: horizontale Ausricht-Ansagen ("Markierung links."/"Markierung rechts.")
    // ebenfalls unterdrueckt (Anforderung) — NUR links/rechts; die vertikalen
    // Hinweise (hoeher/tiefer) bleiben unveraendert und erreichen weiterhin say()
    // unten. Gleiches Muster wie bei "center" oben: zone/lastAimZone/lastAimAt
    // werden TROTZDEM aktualisiert, damit Cooldown-/Uebergangs-Logik unveraendert
    // bleibt und dies nur EINMAL pro Uebergang protokolliert wird. say() wird fuer
    // diese Zonen gar nicht mehr aufgerufen — kein TTS_REQUESTED fuer die
    // unterdrueckte Phrase.
    if(zone === "left" || zone === "right"){
      lastAimZone = zone;
      lastAimAt = now;
      navLog("TTS_AIM_HORIZONTAL_SUPPRESSED", { expectedTag: expectedNextTagId,
        direction: zone, state: navState });
      return;
    }

    if(speaking()) return;
    var msg = { up:"Smartphone etwas höher.", down:"Smartphone etwas tiefer." }[zone];
    var result = say(msg, ttsOpts({source:"nav.aimGuidance", category:"ACTION_REQUIRED"}));
    if(result.accepted){ lastAimZone = zone; lastAimAt = now; }
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
    var result = say(msg, ttsOpts({source:"nav.scanHint", category:"ACTION_REQUIRED"}));
    if(result.accepted){
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
  trackingStartTagActive,
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
