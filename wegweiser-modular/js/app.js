// GitHub Pages redeploy trigger — no functional changes.
// ==================== App-Einstiegspunkt (Bedienung, Bootstrap) ====================
// This module imports nothing that imports main-loop.js or camera.js back, so it
// forms no additional circular dependency -- app.js is the entry point and is
// imported by nothing else.

import {
  gate, retryBtn, navStartBtn, navEndBtn, whereBtn, muteBtn, destSel,
  logExportBtn, logClearBtn
} from './dom.js';
import { NODES } from './graph-data.js';
import { markerName } from './graph.js';
import {
  startNavigation, endNavigation, destinationReached, currentTagId,
  navigationActive, expectedNextTagId,
  destinationId, routeRunId, navState, whereAmIResponse,
  notifyTag9FlowAdaptiveStep, setAdaptiveDetectorActive, setTag9DetectorHooks
} from './nav.js';
import { startCamera, showError, running } from './camera.js';
import { say, toggleSound, soundOn, cancelSpeech, unlockSpeech } from './speech.js';
import { setDetector } from './detector-state.js';
import { exportJson, clear, record } from './logger.js';
import { renderNavigationUi } from './ui.js';
import { createStepDetector, requestMotionPermission } from './step-detector.js';
import { createAdaptiveStepDetector } from './adaptive-step-detector.js';

  // ---- TTS-Observability ----: shared metadata for app.js's own announcements,
  // mirroring nav.js's ttsOpts() -- this module holds no navState of its own, but
  // reads the current value live from the already-imported nav.js export.
  function appTtsOpts(extra){
    var o = { state: navState, expectedTag: expectedNextTagId, routeRunId: routeRunId };
    if(extra) for(var k in extra) o[k] = extra[k];
    return o;
  }

  // ---- Bewegungsberechtigung (Routenstart) / Detektor-Besitzer ----
  // Drei bewusst GETRENNTE Zustaende (siehe Aufgabenstellung "Architectural
  // rule"), keiner davon steuert einen anderen implizit mit:
  //   motionPermissionState -- "unknown"/"granted"/"denied"/"unsupported":
  //     Ergebnis von requestMotionPermission(), gesetzt beim
  //     Routenstart-Klick (navStartBtn) -- der einzige verbleibende Aufrufer,
  //     seit die manuelle Schritt-Kalibrierungs-UI entfernt wurde (siehe
  //     unten).
  //   detectorOwner -- "none"/"manual"/"navigation": WER den (einzigen,
  //     geteilten) stepDetector/adaptiveDetector gerade betreibt. "manual"
  //     wird aktuell von keiner UI mehr gesetzt (die Test-und-Diagnose-
  //     Kalibrierungsknoepfe existieren nicht mehr), bleibt aber als
  //     Schutzmechanismus bestehen, falls ein spaeterer Entwickler-Zugang den
  //     Detektor je wieder manuell startet -- verhindert dann, dass die
  //     automatische Tag4->9-Logik eine solche Sitzung uebernimmt/stoppt.
  //   nav.js's adaptiveDetectorActive (siehe dort) bleibt unveraendert die
  //     einzige Groesse, die den Tag4->9-Fluss tatsaechlich gated -- sowohl
  //     manuelles ALS AUCH automatisches Starten setzen sie am Ende gleich.
  var motionPermissionState = "unknown";
  var detectorOwner = "none";

  // ---- Bedienung ----
  // unlockSpeech() must be called synchronously, right at the start of the direct
  // click handler, before any asynchronously awaited work (startCamera() awaits
  // getUserMedia()) — see the rationale in speech.js. This is a self-contained,
  // idempotent call that only has an effect on the very first invocation; it does
  // not change the running/startCamera() flow.
  gate.addEventListener("click", function(){ unlockSpeech(); if(!running) startCamera(); });
  retryBtn.addEventListener("click", startCamera);

  navStartBtn.addEventListener("click", function(){
    // A second, equally valid unlock gesture (see speech.js) -- in practice already
    // completed by the earlier gate tap (starting navigation is unreachable without
    // a running camera), but deliberately allowed here too as an additional,
    // independent safeguard; a no-op if already unlocked (unlockAttempted flag).
    unlockSpeech();
    if(!running){
      say("Bitte zuerst die Kamera starten.",
        appTtsOpts({interrupt:true, source:"app.cameraNotRunning", category:"STATUS"}));
      return;
    }
    // Motion permission is requested HERE -- directly inside this click handler,
    // synchronously with the user gesture (see requestMotionPermission()'s own
    // comment in step-detector.js: iOS 13+ Safari requires this) -- never later
    // from a Tag-detection callback, timer, or animation frame. navigation still
    // starts afterward regardless of the outcome (granted or denied/unavailable):
    // this only determines whether the experimental Tag4->9 3+2 flow can later
    // auto-activate (see ensureTag9DetectorActive() below) -- it never blocks
    // normal navigation. No new spoken message is added here deliberately (see
    // motionPermissionState comment) -- keeps this route-start gesture minimal.
    record("MOTION_PERMISSION_REQUESTED", { source: "route-start" });
    requestMotionPermission().then(function(state){
      motionPermissionState = state; // "granted" | "denied" | "unsupported"
      record(state === "granted" ? "MOTION_PERMISSION_GRANTED" : "MOTION_PERMISSION_DENIED",
        { source: "route-start", state: state });
      startNavigation();
    });
  });
  navEndBtn.addEventListener("click", function(){ endNavigation(true); });

  whereBtn.addEventListener("click", function(){
    var p;
    if(destinationReached){
      p = "Sie sind am Ziel: " + markerName(destinationId || currentTagId) + ".";
    } else if(currentTagId != null && navigationActive){
      // neu: die frueher hier gebaute "zwischen Markierung X und Y"-Formulierung
      // sprach AprilTag-Nummern direkt aus. Ersetzt durch whereAmIResponse()
      // (nav.js), die ausschliesslich die menschenlesbare locationDescription
      // je Kante verwendet (siehe graph-data.js) und zusaetzlich entscheidet,
      // ob "Die Richtung stimmt. Gehen Sie weiter geradeaus." sicher ergaenzt
      // werden darf, statt hier eine zweite Entscheidungslogik zu duplizieren.
      // app.js spricht das Ergebnis weiterhin selbst, wie bisher.
      var whereAmI = whereAmIResponse();
      p = whereAmI ? whereAmI.text : ("Sie befinden sich bei " + markerName(currentTagId) + ".");
    } else if(navigationActive){
      p = "Noch keine Markierung bestätigt. Richten Sie das Smartphone auf die nächste " +
          "Markierung in Ihrer Nähe. Von dort wird die Route zum Ziel " +
          markerName(destinationId) + " berechnet.";
    } else {
      p = "Keine Navigation aktiv. Bitte wählen Sie ein Ziel und starten Sie die Navigation.";
    }
    say(p, appTtsOpts({interrupt:true, source:"app.whereAmI", category:"NAVIGATION_CONTEXT"}));
    record("TTS_WHERE_AM_I", { text: p, routeRunId: routeRunId });
  });

  muteBtn.addEventListener("click", function(){
    toggleSound();
    muteBtn.firstChild.textContent = soundOn ? "Ton an" : "Ton aus";
    // Uses cancelSpeech() rather than calling speechSynthesis.cancel() directly --
    // logs the preempted request correctly as TTS_CANCELLED instead of it silently
    // disappearing.
    if(!soundOn) cancelSpeech("app.muteToggleOff");
    else say("Ton eingeschaltet", appTtsOpts({interrupt:true, source:"app.muteToggleOn", category:"STATUS"}));
  });

  // ---- Logging-Panel (Feldtest-Instrumentierung) ----
  logExportBtn.addEventListener("click", function(){
    exportJson();
    say("Log exportiert.", appTtsOpts({interrupt:true, source:"app.logExported", category:"STATUS"}));
  });
  logClearBtn.addEventListener("click", function(){
    clear();
    say("Log gelöscht.", appTtsOpts({interrupt:true, source:"app.logCleared", category:"STATUS"}));
  });

  // ---- Produktions-Schritt-Detektor (siehe step-detector.js) ----
  // Feste Schwelle (motionThreshold), einziges geteiltes Detektor-Objekt --
  // frueher nur ueber eine manuelle Test-und-Diagnose-Kalibrierung nutzbar,
  // jetzt ausschliesslich automatisch fuer den Tag4->9-Fluss verdrahtet
  // (siehe ensureTag9DetectorActive()/onTag9FlowEnded() weiter unten). Sein
  // Sample-Tap (4. start()-Parameter) speist weiterhin den experimentellen
  // adaptiven Detektor darunter.
  var stepDetector = createStepDetector();

  function onStepDetected(stepCount, deviation){
    var roundedDeviation = Math.round(deviation * 100) / 100;
    record("STEP_DETECTED", {
      stepCount: stepCount,
      deviation: roundedDeviation,
      timestamp: Date.now()
    });
  }

  // Kalibrierungs-Diagnostik (siehe diagnosticPeakThreshold in
  // step-detector.js): bedeutsame Bewegungs-Peaks, die KEINEN gezaehlten
  // Schritt ausgeloest haben -- Feldtest-Beleg dafuer, ob vorsichtige/
  // schlurfende Schritte an der aktuellen motionThreshold scheitern. Der
  // Callback wird nur uebergeben, waehrend der Detektor tatsaechlich laeuft
  // (automatisch fuer Tag4->9, siehe ensureTag9DetectorActive() weiter
  // unten) -- ausserhalb dessen entsteht kein Diagnose-Rauschen im
  // Navigations-Log. Genau EIN Ereignis pro Bewegungs-Exkursion
  // (Peak-Verfolgung im Detektor-Modul), NIE pro Sensor-Rohwert.
  function onMotionPeak(peak){
    record("STEP_MOTION_PEAK", {
      deviation: Math.round(peak.deviation * 100) / 100,
      motionThreshold: peak.motionThreshold,
      diagnosticPeakThreshold: peak.diagnosticPeakThreshold,
      crossedStepThreshold: peak.crossedStepThreshold,
      timestamp: Date.now()
    });
  }

  // ---- Experimenteller adaptiver Detektor (NUR Diagnose, siehe
  // adaptive-step-detector.js) ----
  // Laeuft parallel am SELBEN Sensorstrom (Sample-Tap des Produktions-
  // Detektors, 4. start()-Parameter unten) -- der Produktions-Detektor mit
  // seiner festen Schwelle bleibt die einzige Quelle fuer STEP_DETECTED;
  // saemtliche ADAPTIVE_*-Ereignisse sind reine Vergleichsdaten fuer die
  // Feldauswertung (fest 1,5 vs. adaptiv) und beeinflussen weder Zaehlung
  // noch Navigation. Rundung nur hier (Log-Kompaktheit), nie im Modul.
  function r2(v){ return v == null ? null : Math.round(v * 100) / 100; }

  var adaptiveDetector = createAdaptiveStepDetector(null, {
    onPeak: function(p){
      record("ADAPTIVE_STEP_PEAK", {
        amplitude: r2(p.amplitude), threshold: r2(p.threshold),
        mean: r2(p.mean), std: r2(p.std),
        intervalFromPreviousPeak: p.intervalFromPreviousPeak != null ? Math.round(p.intervalFromPreviousPeak) : null,
        consecutivePeaks: p.consecutivePeaks, classification: p.classification,
        peakDurationMs: p.peakDurationMs != null ? Math.round(p.peakDurationMs) : null,
        // Richtungs-Diagnose (Scan-vs-Gehen, siehe adaptive-step-detector.js):
        // Antwortdaten fuer die naechste Feldrunde, KEINE Klassifikation.
        verticalRatio: r2(p.verticalRatio),
        rotationRateMean: r2(p.rotationRateMean),
        timestamp: Date.now()
      });
    },
    onStep: function(s){
      record("ADAPTIVE_STEP_DETECTED", {
        timestamp: Date.now(), t: Math.round(s.t),
        amplitude: r2(s.amplitude), threshold: r2(s.threshold),
        backfilled: s.backfilled
      });
      // Tag 4 -> Tag 9 lokaler Schritt-Fluss (siehe nav.js): s.t ist die
      // ORIGINALE Kandidaten-Zeit (live und nachgemeldet gleichermassen), nie
      // der Zeitpunkt dieses Callback-Aufrufs -- nav.js filtert selbst gegen
      // seinen eigenen Phasen-Beginn. Ohne Wirkung auf jeder anderen Kante.
      notifyTag9FlowAdaptiveStep(s.t);
    },
    onWalkingStart: function(w){
      record("ADAPTIVE_WALKING_STARTED", { consecutivePeaks: w.consecutivePeaks, timestamp: Date.now() });
    },
    onWalkingStop: function(w){
      record("ADAPTIVE_WALKING_STOPPED", { reason: w.reason,
        adaptiveStepCount: w.adaptiveStepCount, timestamp: Date.now() });
    }
  });

  function onMotionSample(x, y, z, atTime, reportedIntervalMs, rotation){
    adaptiveDetector.addSample(x, y, z, atTime, reportedIntervalMs, rotation);
  }

  // Deliberately SILENT (no TTS) warmup-ready callback for the
  // navigation-auto-started detector below -- a spoken "Bereit. Gehen Sie
  // jetzt." would be correct for an explicit calibration session but wrong
  // mid-navigation. onStepDetected/onMotionPeak are reused as-is (they only
  // call record(), no speech), keeping STEP_DETECTED/STEP_MOTION_PEAK
  // diagnostics available during real navigation too.
  function silentOnWarmupReady(){}

  // ---- Tag 4 -> Tag 9: automatischer Detektor-Lebenszyklus (naechste Ausbaustufe) ----
  // Registriert bei nav.js (siehe setTag9DetectorHooks()) -- nav.js kennt
  // weiterhin nichts vom Detektor selbst, ruft nur diese beiden Funktionen
  // synchron auf. ensureActive() wird AUSSCHLIESSLICH beim Betreten von GENAU
  // der Kante 4->9 aufgerufen (siehe beginSegment() in nav.js) -- nie fuer
  // irgendeine andere Kante.
  function ensureTag9DetectorActive(){
    if(detectorOwner === "manual" || detectorOwner === "navigation"){
      // Bereits eine laufende Sitzung (manuell ODER schon automatisch
      // gestartet) -- adaptiveDetectorActive spiegelt deren echten Zustand
      // bereits korrekt wider. NIEMALS eine manuelle Entwickler-Sitzung hier
      // anfassen/zuruecksetzen.
      return;
    }
    if(motionPermissionState !== "granted"){
      record("ADAPTIVE_NAV_AUTO_START_FAILED", { reason: "permission-not-granted", state: motionPermissionState });
      return;
    }
    stepDetector.stop();
    stepDetector.reset();
    adaptiveDetector.reset();
    var started = stepDetector.start(onStepDetected, silentOnWarmupReady, onMotionPeak, onMotionSample);
    if(!started){
      record("ADAPTIVE_NAV_AUTO_START_FAILED", { reason: "start-failed" });
      return;
    }
    detectorOwner = "navigation";
    setAdaptiveDetectorActive(true);
    record("ADAPTIVE_NAV_AUTO_START", { reason: "edge-4-9" });
  }

  // Aufgerufen von nav.js, sobald der Tag4->9-Fluss (aus JEDEM Grund: Ankunft,
  // Routen-Abbruch/-Neustart, Kanten-Wechsel) wieder INACTIVE wird. Stoppt NUR
  // eine selbst automatisch gestartete Sitzung -- eine zwischenzeitlich vom
  // Entwickler manuell uebernommene Sitzung (detectorOwner "manual") bleibt
  // unangetastet.
  function onTag9FlowEnded(reason){
    if(detectorOwner !== "navigation") return;
    var finalCount = stepDetector.getStepCount();
    stepDetector.stop();
    // GENAU EIN kompaktes Pro-Lauf-Ereignis statt Dauerprotokollierung
    // einzelner Sensor-Samples: echte Abtastrate (gemessen + vom Browser
    // gemeldet), adaptive Zaehler und letzte adaptive Statistik -- direkt
    // "fest 1,5 vs. adaptiv" vergleichbar. Frueher nur beim manuellen
    // Kalibrierungs-Stopp erreichbar; jetzt bei jedem automatischen
    // Tag4->9-Stopp, seit die manuelle UI entfernt wurde (siehe UI-Bereinigung).
    var adaptiveSummary = adaptiveDetector.getSummary();
    record("ADAPTIVE_RUN_SUMMARY", {
      sampleCount: adaptiveSummary.sampleCount,
      avgSampleIntervalMs: r2(adaptiveSummary.avgSampleIntervalMs),
      minSampleIntervalMs: r2(adaptiveSummary.minSampleIntervalMs),
      maxSampleIntervalMs: r2(adaptiveSummary.maxSampleIntervalMs),
      reportedEventIntervalMs: r2(adaptiveSummary.reportedEventIntervalMs),
      adaptiveStepCount: adaptiveSummary.adaptiveStepCount,
      peakCount: adaptiveSummary.peakCount,
      walking: adaptiveSummary.walking,
      lastThreshold: r2(adaptiveSummary.lastThreshold),
      lastMean: r2(adaptiveSummary.lastMean),
      lastStd: r2(adaptiveSummary.lastStd),
      productionStepCount: finalCount
    });
    detectorOwner = "none";
    setAdaptiveDetectorActive(false);
    record("ADAPTIVE_NAV_AUTO_STOP", { reason: reason });
  }

  setTag9DetectorHooks({ ensureActive: ensureTag9DetectorActive, notifyFlowEnded: onTag9FlowEnded });

  // ---- Zielauswahl aus NODES (destination:true) ----
  Object.keys(NODES).map(Number).sort(function(a,b){ return a - b; }).forEach(function(id){
    if(!NODES[id].destination) return;
    var o = document.createElement("option");
    o.value = String(id);
    o.textContent = NODES[id].name + " (Tag " + id + ")";
    destSel.appendChild(o);
  });
  // destSel is a native <select> — VoiceOver already announces the selected option
  // on its own. Speaking the same information a second time via the application's
  // TTS would announce it twice, which must be avoided. This handler therefore
  // controls only the enabled/disabled state of "Navigation starten" — a purely
  // native state that VoiceOver already announces itself ("disabled"/"enabled"),
  // so no additional speech output is needed here.
  destSel.addEventListener("change", function(){
    var v = destSel.value ? parseInt(destSel.value, 10) : null;
    var hasDestination = v != null && NODES[v] && NODES[v].destination;
    navStartBtn.disabled = !hasDestination;
  });

  try{
    setDetector(new AR.Detector({ dictionaryName: "APRILTAG_36h11" }));
  }catch(e){
    // Speaks a short, non-technical hint instead of the raw exception — the
    // technical detail message ("Interner Fehler beim Laden der Erkennung: " + e)
    // stays unchanged in the visual error field (errMsg), but is never spoken
    // verbatim, to avoid exposing raw technical exception text through TTS.
    showError("Interner Fehler beim Laden der Erkennung: " + e, {
      source: "camera.detectorLoadError",
      spokenText: "Ein interner Fehler ist beim Starten der Erkennung aufgetreten. " +
        "Bitte laden Sie die Seite neu."
    });
  }

  // ---- Initiale Bedienelement-Sichtbarkeit ----
  // Called once at application start (navigationActive/destinationReached are both
  // false at this point, see nav.js) -- ensures #navEndBtn/#whereBtn, which are
  // statically visible in the HTML markup, are correctly collapsed/hidden before the
  // first navigation is started, rather than staying permanently visible.
  renderNavigationUi();
