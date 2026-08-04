// ==================== Navigations-Zustandsmaschine ====================
// emaDist lives here, next to minTrackDist, because it is read/written/reset
// exclusively by this state machine (resetSegmentState, handleLostStopped), even
// though it conceptually describes tracking distance rather than navigation state.
// The circular dependency between nav.js and ui.js (updatePanel) is intentional.

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
    // Tag 1 (Eingang) is visually confirmed but not yet reached by distance -- see
    // beginStartTagTracking()/reachStartTag() below. Deliberately treated like
    // TRACKING by main-loop.js, but kept as its own state so that forward-candidate
    // logic and scan hints for Tag 2 are reliably suppressed during this phase
    // (trackingStartTagActive, see below).
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

  var emaDist = null;
  var minTrackDist = null;        // smallest measured distance (progress reference)
  var rawRecent = [];             // last N raw distances (window for "most recent minimum")
  var lastRawDist = null;         // last valid raw distance
  var lastRawAt = 0;              // timestamp of the last valid measurement
  var trackDetCount = 0;          // number of valid measurements in the current segment
  var trackingConfirmed = false;  // "lost" may only be reported once at least
                                   // SETTINGS.trackingConfirmDetections valid measurements exist
  // True exactly while Tag 1 is being physically tracked (NavState.TRACKING_START_TAG,
  // or a LOST_STOPPED that arose from this phase) -- independent of navState, because
  // navState temporarily becomes LOST_STOPPED during a loss (see handleTracking()).
  // Sole purpose: prevents updateSkipCandidate() (main-loop.js) from searching for a
  // forward candidate beyond Tag 2 before Tag 1 has actually been reached, and
  // controls, in handleTracking(), whether reachStartTag() is called instead of
  // reachPoint().
  var trackingStartTagActive = false;
  var arrivalBelowCount = 0;      // consecutive frames with arrivalDistance <= threshold
  var lastTrackDbgAt = 0;         // throttle for the debug log
  var awayWarned = false;
  // Dedicated EMA baseline, maintained only after trackingConfirmed, used for the
  // distance comparison in handleTracking() that decides the "you are moving away"
  // warning. main-loop.js already feeds emaDist during the candidate-confirmation
  // phase (before trackingConfirmed), while minTrackDist is set by onNextTagFound()
  // from a single raw value at confirmation time -- comparing emaDist against
  // minTrackDist therefore compared two different baselines and could wrongly
  // detect "moving away" in the first, unconfirmed frames even though the user was
  // approaching (raw distance was decreasing). minAwayEmaDist is never set from a
  // candidate-phase measurement, only from emaDist after confirmation, and does not
  // affect minTrackDist (REACHED/TAG-LOST/segment statistics). awayPostConfirmSamples
  // counts valid measurements after the baseline is established (the establishing
  // frame itself does not count), so a warning cannot fire in the same frame the
  // baseline was just set.
  var minAwayEmaDist = null;
  var awayPostConfirmSamples = 0;
  var AWAY_BASELINE_MIN_SAMPLES = 3;
  var stopSaidAt = 0;
  var offRouteSaid = {};          // fremde Tags: höchstens EINMAL pro Abschnitt melden
  var lostInstructionSpoken = false; // ob in der aktuellen Verlust-Episode bereits eine
                                      // TATSAECHLICH GESPROCHENE Stopp-Ansage erfolgt ist
                                      // (steuert, ob die Wiederfindung etwas ansagt)
  var lostSpeechPending = false;     // LOST_STOPPED has been reached, but the spoken
                                      // stop announcement is still being held back
                                      // (see SETTINGS.lostSpeechDelayMs) -- the internal
                                      // state transition (trackLostStopMs) is unchanged,
                                      // only the speech output is additionally delayed.
  var lostSpeechPendingSince = 0;    // performance.now() bei Eintritt in LOST_STOPPED

  // ---- Shared dedup state for the "active direction announcement" ----
  // One shared state for every place that might speak "Gehen Sie weiter geradeaus."
  // or a turn announcement (reachPoint(), resumption after a stop, forward-candidate
  // retarget) -- prevents multiple independent mechanisms from repeating the same
  // phrase. activeDirectionText holds the last direction phrase that was actually
  // spoken; a repeated attempt with the same text is suppressed until the active
  // direction changes (a turn sets it directly) or the state is deliberately reset
  // (route start/end, destination arrival, an actually spoken stop, or a
  // forward-candidate retarget during a pending loss).
  var activeDirectionText = null;

  function resetActiveDirectionState(){
    activeDirectionText = null;
  }

  // ---- "Straight ahead" confirmation after a real turn ----
  // Purely additive state: remembers that a real turn was just announced
  // (isTurn===true in reachPoint(), see there) and that the follow-up confirmation
  // "Gehen Sie geradeaus." is still pending, until the next expected tag is
  // confirmed for the first time via the existing onNextTagFound() path (normal
  // search or forward-candidate retarget -- for a forward-candidate retarget this
  // state is explicitly cancelled beforehand, see beginTrackingForwardCandidate(),
  // because that path already speaks its own "Gehen Sie weiter geradeaus."
  // confirmation). Bound to (routeRunId, expectedTag), so a tag arriving later or
  // elsewhere can never be wrongly treated as completing this specific turn. Affects
  // no detection, route, or turn logic -- only whether "Gehen Sie geradeaus." is
  // additionally spoken.
  // Limited, throttled retry if the TTS channel happens to be busy exactly at the
  // moment of the first attempt, without retrying on every single frame.
  // postTurnAttempts counts every speech attempt (including the first);
  // postTurnNextRetryAt throttles the earliest time the next attempt may occur.
  var POST_TURN_RETRY_INTERVAL_MS = 400;   // 300-500ms window
  var POST_TURN_MAX_ATTEMPTS = 3;          // total, including the first attempt

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

  // ---- Rueckversicherung auf langen geraden Korridoren ----
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
    // activeDirectionText may only be updated when say() has actually accepted the
    // request (result.accepted) -- treating any other outcome (muted/busy/failed) as
    // success would corrupt the dedup state.
    var result = say(text, opts);
    if(result.accepted){
      activeDirectionText = text;
      var spokenData = { text: text, speechId: result.speechId };
      for(var k2 in (logData || {})) spokenData[k2] = logData[k2];
      navLog(logEvent, spokenData);
    }
    return result;
  }

  // Gemeinsame Log-Nutzlast fuer alle Stopp-Entscheidungen: expectedTag, aktive Route,
  // Navigationszustand, Verlustdauer, aktiver Vorgriffs-Kandidat, Vorgriffs-
  // Bestaetigungszaehler, ob Stopp bereits gesprochen wurde, Abbruchgrund.
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

  // ---- Instrumentierung (nur fuer Feldtest-Logging) ----
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

  // ---- Cross-module mutators ----
  // main-loop.js (tick) needs to write expectedLastSeenAt, candLastSeenAt,
  // lastExpectedVis, wrongCandId/wrongCandCount, candId/candCount, and emaDist from
  // outside this module. ES modules only allow the declaring module to reassign its
  // own exported bindings; each function here is a plain 1:1 wrapper around the
  // corresponding assignment (no behavior change). Other modules continue to read
  // these variables directly through their (live-bound) exports.
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
    lostSpeechPending = false;       // defensive: in case a segment ends in the middle
    lostSpeechPendingSince = 0;      // of a pending stop announcement (see handleLostStopped())
    emaDist = null;
    rawRecent = [];
    lastRawDist = null; lastRawAt = 0;
    trackDetCount = 0;
    trackingConfirmed = false;
    arrivalBelowCount = 0;
    lastTrackDbgAt = 0;
    // ---- Instrumentierung: pro Abschnitt zuruecksetzen ----
    segLostCount = 0;
    segReacquireCount = 0;
    segLostMs = 0;
    segLostSince = null;
    segTrackingStartedAt = null;
    resetSkipCandidate();
  }


  // ---- Instrumentierung: plain ES5 copy of `data` with routeRunId appended, without
  // touching the existing call sites of navLog(). ----
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

  // ---- TTS-Observability ----
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
    // routeRunId is generated here (before any announcement) -- a pure
    // instrumentation id with no effect on navigation logic.
    routeRunId = generateRouteRunId();
    // No "Ziel gewählt..." announcement is spoken here: it would run in the same
    // click handler as VoiceOver's own double-tap activation announcement for
    // "Navigation starten" and talk over it. Guidance already follows automatically
    // without it: scanHint() (nav.js) speaks up on its own after
    // SETTINGS.scanHintAfterMs if no tag has been found yet, and onStartTagConfirmed()
    // speaks the actual first instruction as soon as the first tag is confirmed --
    // both already-existing, state-driven triggers, so no new timer is needed here.
    // lastRouteInstruction deliberately stays "" (see above) until
    // onStartTagConfirmed() sets it; repeatBtn already handles that intermediate
    // state ("Noch keine Anweisung vorhanden.", app.js).
    // ---- Instrumentierung ----
    navLog("ROUTE_START", { destinationId: destId, destination: markerName(destId),
      testName: getTestName() });
  }

  function endNavigation(announce, reason){
    // ---- Instrumentierung: capture, before any reset, which of three distinguishable
    // cases applies -- manual abort (route was still running, destination not
    // reached), ending after destination arrival (not an abort), or a future error
    // reset (reason==="error", not triggered by any call site today, but the
    // distinction is available from here on without redesigning error handling).
    // wasActive/wasReached must be read before any reset. ----
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
    // After a successful destination arrival, the arrival announcement
    // (arriveAtDestination(), "Ziel erreicht...") has already been spoken --
    // "Navigation beendet." would only redundantly repeat that information (and
    // could unnecessarily interrupt the arrival announcement if it were still
    // playing). wasReached was read above, before resetting destinationReached, and
    // describes exactly "did this end happen after an arrival that already
    // occurred" -- for a genuine manual abort before arrival (wasReached===false),
    // "Navigation beendet." is still spoken as before.
    if(announce && !wasReached){
      say("Navigation beendet.",
        ttsOpts({interrupt:true, source:"nav.navigationEnded", category:"STATUS"}));
    }
    // ---- Instrumentierung: one event always fires (independent of `announce`), so
    // the speech condition and the logging condition never diverge. The
    // actual arrival confirmation (ROUTE_END) continues to be logged exclusively in
    // arriveAtDestination() -- this is only about the ending/aborting itself, never
    // about treating a normally completed route as "aborted". ----
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
    // ---- Instrumentierung ----
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

    // Tag 1 (Eingang) is special-cased: it is a physically remote start point -- the
    // route is already computed at this point, but the first segment (1->2) may
    // only begin once Tag 1 has actually been reached by distance measurement (see
    // beginStartTagTracking()/reachStartTag() below). Every other start node
    // continues to behave the same way (immediate segment start, code below
    // unchanged) -- this branch is a plain early exit.
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
    // ---- Instrumentierung ----
    navLog("ROUTE_PATH", { startTag: tagId, path: p, pathText: pathToText(p) });
    beginSegment();
  }

  // ---- Tag 1 (Eingang) as a physically tracked start point ----
  // For Tag 1 only, this replaces the immediate transition into beginSegment() (see
  // onStartTagConfirmed() above) with an intermediate phase: Tag 1 remains the
  // tracked tag (expectedNextTagId stays 1, not 2), segIndex stays at 0 (still
  // pointing at edge 1->2 -- this means currentEdge() in handleTracking()
  // continues to return edge 1->2 for the reachedM threshold, exactly as for any
  // ordinary edge, without its own threshold). Once Tag 1 satisfies the existing
  // 1.8m arrival logic, handleTracking() calls reachStartTag() (see there and
  // trackingStartTagActive above) instead of reachPoint() -- from that point on,
  // segment 1->2 continues exactly like any other segment (beginSegment(),
  // unchanged).
  function beginStartTagTracking(tagId){
    navLog("START_TAG_CONFIRMED", { startTag: tagId });

    var entranceText = START_TEXTS[tagId] ||
      ("Sie sind bei " + markerName(tagId) + ". Halten Sie das Smartphone gerade vor " +
       "sich. Gehen Sie geradeaus.");
    lastRouteInstruction = entranceText;
    // No "Route berechnet." prefix here -- the route was already computed silently
    // (see ROUTE_PATH above); the user only needs the orientation and action
    // information right now, before starting to walk.
    var entranceResult = say(entranceText, ttsOpts({interrupt:true,
      source:"nav.startTagEntrance", category:"NAVIGATION_CONTEXT", expectedTag: tagId}));
    navLog("TTS_START_ENTRANCE", { startTag: tagId, text: entranceText,
      speechId: entranceResult.speechId });

    expectedNextTagId = tagId;
    resetSegmentState();
    trackingStartTagActive = true;
    setNavState(NavState.TRACKING_START_TAG);
    updatePanel(null);
    // ---- Instrumentierung ----
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
    // As with any real turn, a new corridor begins afterward (see reachPoint()) --
    // corridorProgressM is still 0 at this point anyway (no edge has been credited
    // before Tag 1), making this call a no-op, but it keeps the invariant "every real
    // turn resets the corridor" exactly intact.
    resetCorridorState("start-tag-turn");

    beginSegment();
    // Same post-turn confirmation infrastructure as for any other real turn (see
    // reachPoint()) -- once Tag 2 is found, "Gehen Sie geradeaus." is confirmed once.
    // Entirely independent of Tag 2's own, later turn confirmation (after its edge
    // 2->3), since this is bound to (routeRunId, turnTag=1, expectedTag=2) -- see
    // setPostTurnPending().
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
    // ---- Instrumentierung ----
    segTrackingStartedAt = performance.now();
    navLog("TTS_SUPPRESSED_MARKER_FOUND", { expectedTag: expectedNextTagId,
      isDestination: expectedNextTagId === destinationId,
      buzzed: expectedNextTagId !== destinationId });

    // Immediate first attempt at the pending post-turn confirmation (if one is
    // pending) -- retrying while "busy" is handled by tryPostTurnConfirmation()
    // itself (see there); from the next tick onward it is also re-checked from
    // handleTracking() (throttled, see there), not called again here.
    tryPostTurnConfirmation();
  }

  // Punkt erreicht (Distanz <= Schwelle, Near-Loss-Fallback oder kontrollierter Skip).
  function reachPoint(reason){
    var edge = currentEdge();
    var reachedTagId = pathTagIds[segIndex + 1];
    currentTagId = reachedTagId;

    // ---- Instrumentierung: summary of the segment just completed, built entirely
    // from already-existing nav.js variables, no duplication. reachPoint() is now
    // always called normally (even after a previously confirmed forward candidate,
    // see beginTrackingForwardCandidate() -- there, reachPoint() is not called; only
    // the tracked tag is switched). There is therefore no special case left that
    // would need to suppress this SEGMENT_SUMMARY. ----
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
    // Intermediate tag (not the destination) — speak only the short action
    // instruction, no more automatic place/door description (edge.reached is kept in
    // the dataset for documentation/fallback purposes, not read here). The action
    // belongs to the outgoing edge from reachedTagId (the next step of the chosen
    // route), not to the incoming edge "edge" just completed (= currentEdge(),
    // pathTagIds[segIndex]->reachedTagId). See the departureAction comment in
    // graph-data.js: an edge X->Y describes the action taken at X to continue toward
    // Y — here reachedTagId is the new X, pathTagIds[segIndex+2] is the new Y.
    // reachedTagId is guaranteed not to be the destination at this point (see the
    // check above), so the computed route always has a next tag after it.
    // The edge just completed ("edge") is already-covered, guaranteed-straight
    // distance (its own turn requirement, if any, was already decided and announced
    // at the previous reachPoint() call) — it is always credited to corridor
    // progress, regardless of whether a turn is now pending (for the next edge).
    creditCorridorProgress(edge ? edge.distanceM : null);

    var nextEdge = EDGE_MAP[reachedTagId + "->" + pathTagIds[segIndex + 2]];
    var isTurn = isTurnAction(nextEdge);
    // For a real turn, the text is derived generically from the existing
    // departureAction and prefixed with "Stopp. " — exactly one place in the code
    // does this, regardless of which tag/edge is involved (no Tag-2-specific special
    // case). No new stop distance, no new threshold: the trigger remains exactly the
    // existing reached point (arrival <= SETTINGS.reachedM, see handleTracking()).
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
      // After a real turn, a new corridor begins — prior progress is discarded (the
      // next edge was just announced as a turn; its distance is only credited once
      // it is actually walked, see above at the next reachPoint() call).
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
      // If the announcement above was (correctly) suppressed as a duplicate, but
      // enough corridor distance has accumulated in the meantime, this provides the
      // occasional reassurance on long, otherwise silent straight stretches — a
      // no-op if straightResult.accepted was true (sinceLast is then 0) or the
      // 15-meter threshold has not yet been reached.
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
    // ---- Instrumentierung ----
    navLog("ROUTE_END", { destinationId: destinationId, reason: "arrived" });
    navLog("TTS_DESTINATION", { destinationId: destinationId, text: t, speechId: destResult.speechId });
  }

  // ---- TRACKING: laufende Distanzmessung zum Tag voraus ----
  // rawDist = fresh raw measurement for this frame (or null).
  function handleTracking(now, visible, rawDist){
    // The controlled retry point for the post-turn confirmation: handleTracking()
    // already runs every tick during TRACKING (main-loop.js, unchanged), and
    // tryPostTurnConfirmation() itself throttles to at most one attempt per
    // POST_TURN_RETRY_INTERVAL_MS and is an immediate no-op once no confirmation is
    // pending — it does not touch any of the distance/EMA/REACHED/loss calculations
    // below.
    tryPostTurnConfirmation();

    var edge = currentEdge();
    // While in the TRACKING_START_TAG phase, its own, tighter arrival threshold
    // SETTINGS.startTagReachedM applies instead of the normal edge/SETTINGS.reachedM
    // derivation — the only change compared to ordinary tracking; everything else
    // below (raw/EMA, trackingConfirmed, arrivalConfirmFrames, near-loss fallback)
    // remains exactly the same calculation for Tag 1 as for any other tag, only
    // compared against this different threshold value.
    var reachedM = trackingStartTagActive ? SETTINGS.startTagReachedM :
      ((edge && edge.reachedM != null) ? edge.reachedM : SETTINGS.reachedM);

    // Log raw measurements (window of the last N)
    if(rawDist != null){
      lastRawDist = rawDist; lastRawAt = now;
      trackDetCount++;
      rawRecent.push(rawDist);
      if(rawRecent.length > SETTINGS.rawWindowN) rawRecent.shift();
      // Tracking counts as confirmed only once the expected tag has been validly
      // measured at least trackingConfirmDetections times. Before that, no loss
      // ("TAG LOST"/LOST_STOPPED/stop announcement/REACQUIRED) may be triggered.
      if(!trackingConfirmed && trackDetCount >= SETTINGS.trackingConfirmDetections){
        trackingConfirmed = true;
        navLog("TRACKING_CONFIRMED", { expectedTag: expectedNextTagId,
          detections: trackDetCount, raw: r1(rawDist), ema: r1(emaDist) });
      }
    }
    var recentMin = rawRecent.length ? Math.min.apply(null, rawRecent) : null;

    if(visible && emaDist != null){
      // Arrival distance = min(raw, EMA). The EMA lags behind on fast approach; the
      // raw measurement alone can be an outlier. Outlier protection: the threshold
      // must be undershot in arrivalConfirmFrames consecutive frames with a fresh
      // measurement.
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
          // Identical arrival check; only the target function differs -- no
          // duplication of the distance/EMA/frame logic above.
          if(trackingStartTagActive) reachStartTag("distance-threshold");
          else reachPoint("distance-threshold");
          return;
        }
      } else if(rawDist != null){
        arrivalBelowCount = 0;
      }
      // Progress (distance decreasing): maintain the reference minimum, using the
      // raw minimum too, not only the EMA
      if(minTrackDist == null || emaDist < minTrackDist){
        minTrackDist = emaDist;
        awayWarned = false;
      }
      if(rawDist != null && recentMin != null &&
         (minTrackDist == null || recentMin < minTrackDist)){
        minTrackDist = recentMin;
        awayWarned = false;
      }

      // Away-baseline maintenance — see the minAwayEmaDist declaration above for the
      // rationale. Establishment and counting happen exclusively here, only while
      // trackingConfirmed is already true; the frame that sets the baseline for the
      // first time does not increment awayPostConfirmSamples (no "else" branch for
      // that case) — this counter only starts running from the next frame on.
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

      // Distance rises significantly above the minimum -> user is moving away.
      // Only after confirmation, only against the dedicated away baseline (no
      // longer minTrackDist), and only after at least AWAY_BASELINE_MIN_SAMPLES
      // further valid measurements after it was established (see above).
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
    // Tracking not yet confirmed (< trackingConfirmDetections valid measurements) ->
    // no loss detection; the app effectively remains in the search state.
    if(!trackingConfirmed) return;
    var lostFor = now - expectedLastSeenAt;
    if(lostFor <= SETTINGS.trackLostStopMs) return;  // kurzes Flackern ignorieren

    navLog("TAG LOST before REACHED", { expectedTag: expectedNextTagId,
      lostForMs: Math.round(lostFor), lastRaw: r1(lastRawDist),
      recentMin: r1(recentMin), minSeg: r1(minTrackDist), ema: r1(emaDist),
      dets: trackDetCount, awayWarned: awayWarned });

    // Near-loss fallback. A loss alone still never counts as "reached" — but if the
    // tag was stably and closely approached immediately before and then lost
    // (typical: steep angle / screen edge right before the target), this counts as
    // arrival confirmation. All conditions combined:
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
      // See the comment at the other reachPoint() call above -- same branch, same
      // rationale.
      if(trackingStartTagActive) reachStartTag("near-loss-fallback");
      else reachPoint("near-loss-fallback");
      return;
    }

    // Sonst: Verlust gilt NICHT als "erreicht". Der Nutzer könnte das Telefon
    // weggedreht, die Kamera verdeckt oder zu früh abgebogen haben.
    // The internal state transition to LOST_STOPPED remains unchanged here (still
    // after trackLostStopMs, unchanged) — only the spoken stop announcement is now
    // additionally delayed by SETTINGS.lostSpeechDelayMs (see
    // handleLostStopped()), so the expected tag or a valid forward candidate still
    // has time to be confirmed before "Stopp" is actually spoken.
    setNavState(NavState.LOST_STOPPED);
    // ---- Instrumentierung ----
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
      // If the loss occurred while Tag 1 was being tracked (trackingStartTagActive,
      // see above -- stays unchanged true during a LOST_STOPPED within this phase),
      // resumption must also return to TRACKING_START_TAG, not to normal TRACKING --
      // otherwise main-loop.js would wrongly allow updateSkipCandidate() for Tag 2
      // from the next frame on, even though Tag 1 has not yet been reached.
      setNavState(trackingStartTagActive ? NavState.TRACKING_START_TAG : NavState.TRACKING);
      var d = (det.dist != null) ? det.dist : emaDist;
      if(d != null) emaDist = d;
      var wasStopSpoken = lostInstructionSpoken;
      if(lostSpeechPending){
        lostSpeechPending = false;
        navLog("TTS_LOST_CANCELLED_EXPECTED_FOUND", buildLostDecisionLogData(now, "expected-tag-found"));
      }
      // ---- Instrumentierung ----
      segReacquireCount++;
      if(segLostSince != null){ segLostMs += (now - segLostSince); segLostSince = null; }
      navLog("REACQUIRED", { expectedTag: expectedNextTagId, dist: r1(emaDist) });
      navLog("TTS_REACQUIRED_CONTINUE", { expectedTag: expectedNextTagId,
        dist: r1(emaDist), wasLostInstructionSpoken: wasStopSpoken });
      lostInstructionSpoken = false;
      // No technical "marker refound" announcement. Only if a stop was actually
      // spoken before is the resumption confirmed once, via the shared dedup logic
      // -- if no stop was spoken before, the resumption deliberately stays silent
      // (the user never knew the camera had briefly lost the tag).
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
        // While a valid forward candidate is currently gathering confirmation, the
        // stop announcement continues to be held back (not permanently cancelled —
        // only for this check).
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

  // ==================== Kontrollierter Routen-Skip (generisch) ====================
  // Not a general graph shortcut: only tags that already lie on the computed path
  // (pathTagIds) are considered at all, and only if every edge between the expected
  // tag and the candidate (inclusive) is "continue-straight" — i.e. no not-yet-
  // announced turn would be skipped over. Automatically valid for any future path,
  // with no tag-specific rule table. Graph/EDGE_MAP/findPath() remain unchanged.
  //
  // A confirmed candidacy means only "this tag is now the one being tracked" (like
  // a normal onNextTagFound()) — not a synthetic arrival. The actual arrival
  // announcement (a turn, or "Gehen Sie weiter geradeaus.") continues to happen
  // exclusively through the unchanged, distance-based reachPoint()/handleTracking()
  // chain, once the tag is actually reached.
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

  // Generic helper: are all edges between fromIdx and toIdx on the given active path
  // passable without an as-yet-unannounced turn? The only "maneuver" category
  // currently present in the graph is turn-left/turn-right (see DEPARTURE_ACTIONS in
  // graph.js); the current route data has no separate encoding for door/stair/
  // elevator transitions or mandatory stops. Should such edges be added later, they
  // must appear in the graph as a new departureAction value with isTurn:true (or a
  // generalized "blocksForwardSkip" marker); this helper would then automatically
  // take them into account, with no code change needed here.
  function isForwardTagReachableWithoutManeuver(activePath, fromIdx, toIdx){
    if(!activePath || fromIdx < 0 || toIdx <= fromIdx || toIdx >= activePath.length) return false;
    for(var i = fromIdx; i < toIdx; i++){
      var e = EDGE_MAP[activePath[i] + "->" + activePath[i + 1]];
      if(!e || isTurnAction(e)) return false;
    }
    return true;
  }

  // Searches all tags decoded this time (not just bestKnown) for the best valid
  // forward candidate on the active path: it must (1) lie on pathTagIds at all,
  // (2) lie genuinely ahead of the expected tag (further along, not behind/already
  // passed), (3) be reachable without an as-yet-unannounced turn
  // (isForwardTagReachableWithoutManeuver()). "Best" means the earliest valid
  // visible tag (the most reliable evidence of progress: a simultaneously visible, more
  // distant tag could be visible through a different door/corridor/glass wall,
  // which would make it an unsafe signal) — never the geometrically nearest one.
  // Also returns all rejected sightings with a reason, for FORWARD_CANDIDATE_REJECTED
  // logging.
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

  // Confirmed candidacy only switches which tag is being tracked (like a normal
  // "found", see onNextTagFound()) — no arrival, no reachPoint(), no REACHED.
  // Skipped intermediate tags are removed from active tracking without being
  // counted as "reached" (currentTagId stays unchanged); currentEdge() afterward
  // points at the edge to the candidate, whose distance is later credited normally
  // by reachPoint() upon actual arrival, even if the candidate is the chosen
  // destination (no arrival announcement happens here, only "Gehen Sie weiter
  // geradeaus."). Speech goes through the shared dedup logic
  // (speakDirectionIfNew()) — during a normal retarget while walking smoothly, this
  // is almost always a duplicate of the already-active announcement and stays
  // silent; if the retarget happened during a pending loss, the stop announcement
  // is cancelled and the active direction is reset, so a fresh confirmation is
  // spoken here.
  function beginTrackingForwardCandidate(targetIdx, confirmedTagId, dist, now){
    var routeIndexBefore = segIndex;
    var wasLostPending = lostSpeechPending;
    var bypassedTags = pathTagIds.slice(routeIndexBefore + 1, targetIdx);

    // A forward-candidate retarget always skips past the tag that any pending
    // post-turn confirmation is waiting for (findVisibleForwardCandidate() only
    // returns candidates genuinely ahead of the expected tag, see there) — the
    // retarget's own "Gehen Sie weiter geradeaus." confirmation further below in
    // this function already fills the role of "confirming that it continues
    // straight ahead", so the pending confirmation is cancelled here rather than
    // left open and never reachable.
    clearPostTurnPending("forward-skip-retarget");

    var bypassedDistanceM = 0;
    for(var i = routeIndexBefore; i < targetIdx - 1; i++){
      var e = EDGE_MAP[pathTagIds[i] + "->" + pathTagIds[i + 1]];
      bypassedDistanceM += (e && e.distanceM != null) ? e.distanceM : 0;
    }
    // The skipped edges are already-covered distance, and
    // isForwardTagReachableWithoutManeuver() (see updateSkipCandidate()) guarantees
    // that every edge between the expected tag and the candidate is
    // "continue-straight" — a forward target with a turn in between would never
    // have been accepted as a candidate in the first place. It is therefore always
    // credited here, with no repeated turn check. The last edge into the target
    // (targetIdx-1 -> targetIdx) is deliberately not included (as with
    // bypassedDistanceM above) — it is only credited upon actual arrival, via the
    // normal reachPoint() path.
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
    // Always passes interrupt:true, like every other direction confirmation --
    // otherwise a busy TTS channel could silently drop the request and corrupt the
    // dedup state for the next announcement. When actually spoken, this
    // confirmation also takes over the role of the corridor reassurance for this
    // stretch, updating the same "last straight-ahead instruction" state -- this
    // prevents the 15-meter reassurance from also firing shortly after an audible
    // forward retarget, even though the user just heard an equivalent confirmation.
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

    // "Markierung mittig." is not spoken — centering is not an action instruction
    // (the user has nothing left to do, unlike left/right/higher/lower).
    // zone/lastAimZone/lastAimAt are still updated (as they were for a successful
    // announcement), so the existing cooldown/transition logic for the remaining,
    // genuine correction hints keeps working unchanged — no duplicate log entry per
    // frame: the zone===lastAimZone check above ensures this is logged only once on
    // the transition into center, not on every further frame where the tag stays
    // centered.
    if(zone === "center"){
      lastAimZone = zone;
      lastAimAt = now;
      navLog("TTS_AIM_CENTER_SUPPRESSED", { expectedTag: expectedNextTagId, state: navState });
      return;
    }

    // Horizontal aim announcements ("Markierung links."/"Markierung rechts.") are
    // also not spoken — only left/right; the vertical hints (higher/lower) remain
    // unchanged and still reach say() below. Same pattern as "center" above:
    // zone/lastAimZone/lastAimAt are still updated, so the cooldown/transition
    // logic stays unchanged and this is logged only once per transition. say() is
    // not called at all for these zones — no TTS_REQUESTED for the unspoken phrase.
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
