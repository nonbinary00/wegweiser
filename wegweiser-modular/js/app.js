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
  destinationId, routeRunId, navState, whereAmIResponse
} from './nav.js';
import { startCamera, showError, running } from './camera.js';
import { say, toggleSound, soundOn, cancelSpeech, unlockSpeech } from './speech.js';
import { setDetector } from './detector-state.js';
import { exportJson, clear, record } from './logger.js';
import { renderNavigationUi } from './ui.js';

  // ---- TTS-Observability ----: shared metadata for app.js's own announcements,
  // mirroring nav.js's ttsOpts() -- this module holds no navState of its own, but
  // reads the current value live from the already-imported nav.js export.
  function appTtsOpts(extra){
    var o = { state: navState, expectedTag: expectedNextTagId, routeRunId: routeRunId };
    if(extra) for(var k in extra) o[k] = extra[k];
    return o;
  }

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
    startNavigation();
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
