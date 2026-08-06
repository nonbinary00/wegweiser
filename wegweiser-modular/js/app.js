// ==================== App-Einstiegspunkt (Bedienung, Bootstrap) ====================
// Verbatim aus wegweiser-v13.html (Abschnitte "---- Bedienung ----",
// "---- Zielauswahl aus NODES ----" und die Detector-Instanziierung am Ende des IIFE),
// MIT genau 4 mechanischen Ersetzungen (facing/soundOn/candId+candCount+emaDist/detector
// -Zuweisungen -> die genehmigten Setter/toggle-Funktionen). Die abschliessende IIFE-
// Klammer "})();" entfaellt, da ES-Module bereits ein eigenes Modul-Scope besitzen.
// Dieses Modul importiert nichts, das main-loop.js oder camera.js zurueck importiert,
// bildet also keinen weiteren Zirkelbezug (app.js ist Einstiegspunkt, wird von nichts
// importiert).

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

  // ---- TTS-Observability (neu): gemeinsame Metadaten fuer app.js-Ansagen, analog zu
  // nav.js' ttsOpts() — dieses Modul hat keinen eigenen navState-Zaehler, liest den
  // aktuellen Wert aber live aus dem (bereits importierten) nav.js-Export.
  function appTtsOpts(extra){
    var o = { state: navState, expectedTag: expectedNextTagId, routeRunId: routeRunId };
    if(extra) for(var k in extra) o[k] = extra[k];
    return o;
  }

  // ---- Bedienung ----
  // neu (TTS-Startup-Fix): unlockSpeech() MUSS synchron, ganz am Anfang des
  // direkten Klick-Handlers stehen, VOR jeglicher asynchron await-ender Arbeit
  // (startCamera() awaited getUserMedia()) — siehe Begruendung in speech.js. Reiner
  // Selbstschutz-Aufruf (idempotent, feuert nur beim allerersten Aufruf ueberhaupt);
  // aendert nichts an running/startCamera()-Ablauf.
  gate.addEventListener("click", function(){ unlockSpeech(); if(!running) startCamera(); });
  retryBtn.addEventListener("click", startCamera);

  navStartBtn.addEventListener("click", function(){
    // neu (TTS-Startup-Fix): zweite, gleichwertige Freischalt-Geste (siehe
    // speech.js) — in der Praxis bereits durch den vorherigen Gate-Tap erledigt
    // (Navigation starten ist ohne laufende Kamera nicht erreichbar), aber
    // ausdruecklich als zusaetzliche, unabhaengige Absicherung erlaubt und
    // wirkungslos, falls bereits entsperrt (unlockAttempted-Flag).
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
    // neu: cancelSpeech() statt direktem speechSynthesis.cancel() — protokolliert die
    // dadurch verdraengte Anfrage korrekt als TTS_CANCELLED, statt spurlos zu
    // verschwinden (Audit-Befund F-10).
    if(!soundOn) cancelSpeech("app.muteToggleOff");
    else say("Ton eingeschaltet", appTtsOpts({interrupt:true, source:"app.muteToggleOn", category:"STATUS"}));
  });

  // ---- Logging-Panel (neu, Feldtest-Instrumentierung) ----
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
  // neu (VoiceOver-Fix, Ziel 7): destSel ist ein natives <select> — VoiceOver kuendigt
  // die gewaehlte Option bereits selbst an. Die bisherigen say()-Aufrufe hier haben
  // dieselbe Information ein zweites Mal ueber die Anwendungs-TTS gesprochen (Ziel 1-3:
  // dieselbe Ansage darf nicht doppelt erfolgen). Stattdessen steuert dieser Handler
  // jetzt ausschliesslich den aktivierten/deaktivierten Zustand von "Navigation
  // starten" (Ziel 5/6) — ein rein nativer Zustand, den VoiceOver ohnehin selbst
  // ("deaktiviert"/"aktiviert") ankuendigt, keine zusaetzliche Sprachausgabe noetig.
  destSel.addEventListener("change", function(){
    var v = destSel.value ? parseInt(destSel.value, 10) : null;
    var hasDestination = v != null && NODES[v] && NODES[v].destination;
    navStartBtn.disabled = !hasDestination;
  });

  try{
    setDetector(new AR.Detector({ dictionaryName: "APRILTAG_36h11" }));
  }catch(e){
    // neu: kurzer, unverfaenglicher gesprochener Hinweis statt der rohen Exception —
    // die technische Detailmeldung ("Interner Fehler beim Laden der Erkennung: " + e)
    // bleibt UNVERAENDERT im visuellen Fehler-Feld (errMsg), wird aber NICHT mehr
    // woertlich gesprochen (Audit-Anforderung: "avoid exposing raw technical exception
    // text through TTS").
    showError("Interner Fehler beim Laden der Erkennung: " + e, {
      source: "camera.detectorLoadError",
      spokenText: "Ein interner Fehler ist beim Starten der Erkennung aufgetreten. " +
        "Bitte laden Sie die Seite neu."
    });
  }

  // ---- Initiale Bedienelement-Sichtbarkeit (neu, UX-Schritt: State-Rendering) ----
  // Einmaliger Aufruf beim Anwendungsstart (navigationActive/destinationReached sind
  // zu diesem Zeitpunkt beide false, siehe nav.js) -- setzt #navEndBtn/#whereBtn auf
  // den vor dieser Aenderung bereits statisch im HTML vorhandenen sichtbaren Zustand
  // NICHT laenger fest sichtbar, sondern korrekt eingeklappt/ausgeblendet, bevor die
  // erste Navigation gestartet wird.
  renderNavigationUi();
