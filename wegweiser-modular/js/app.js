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
  gate, retryBtn, navStartBtn, navEndBtn, repeatBtn, whereBtn, flipBtn, muteBtn, destSel,
  logExportBtn, logClearBtn
} from './dom.js';
import { NODES } from './graph-data.js';
import { markerName, metersDE, EDGE_MAP } from './graph.js';
import {
  startNavigation, endNavigation, lastRouteInstruction, destinationReached, currentTagId,
  navigationActive, expectedNextTagId, pathTagIds, segIndex,
  destinationId, routeRunId, navState, setCandidate, setEmaDist
} from './nav.js';
import { startCamera, showError, running, toggleFacing } from './camera.js';
import { say, toggleSound, soundOn, cancelSpeech } from './speech.js';
import { setDetector } from './detector-state.js';
import { exportJson, clear, record } from './logger.js';

  // ---- TTS-Observability (neu): gemeinsame Metadaten fuer app.js-Ansagen, analog zu
  // nav.js' ttsOpts() — dieses Modul hat keinen eigenen navState-Zaehler, liest den
  // aktuellen Wert aber live aus dem (bereits importierten) nav.js-Export.
  function appTtsOpts(extra){
    var o = { state: navState, expectedTag: expectedNextTagId, routeRunId: routeRunId };
    if(extra) for(var k in extra) o[k] = extra[k];
    return o;
  }

  // ---- Bedienung ----
  gate.addEventListener("click", function(){ if(!running) startCamera(); });
  retryBtn.addEventListener("click", startCamera);

  navStartBtn.addEventListener("click", function(){
    if(!running){
      say("Bitte zuerst die Kamera starten.",
        appTtsOpts({interrupt:true, source:"app.cameraNotRunning", category:"STATUS"}));
      return;
    }
    startNavigation();
  });
  navEndBtn.addEventListener("click", function(){ endNavigation(true); });

  repeatBtn.addEventListener("click", function(){
    var opts = appTtsOpts({interrupt:true, source:"app.repeatInstruction", category:"NAVIGATION_CONTEXT"});
    if(lastRouteInstruction) say(lastRouteInstruction, opts);
    else say("Noch keine Anweisung vorhanden.", opts);
  });

  // neu: verbleibende Strecke ausschliesslich aus den bereits bekannten Kanten-Distanzen
  // (FLOOR_GEOMETRY, ueber EDGE_MAP) summieren — NIE aus der Kamera-zu-Tag-Distanz, die
  // nur die aktuelle Naeherung an den NAECHSTEN Tag beschreibt, nicht die Restroute.
  function remainingRouteMeters(){
    if(!pathTagIds || destinationId == null || segIndex < 0) return null;
    var total = 0, any = false;
    for(var i = segIndex; i < pathTagIds.length - 1; i++){
      var e = EDGE_MAP[pathTagIds[i] + "->" + pathTagIds[i + 1]];
      if(e && e.distanceM != null){ total += e.distanceM; any = true; }
    }
    return any ? total : null;
  }

  whereBtn.addEventListener("click", function(){
    var p;
    if(destinationReached){
      p = "Sie sind am Ziel: " + markerName(destinationId || currentTagId) + ".";
    } else if(currentTagId != null && navigationActive){
      // "Zwischen A und B", solange schon ein naechster Tag verfolgt wird — sonst nur
      // "bei A" (letzte ZUVERLAESSIG bestaetigte Position, keine Behauptung genauer
      // Zwischenposition ohne Grundlage).
      if(expectedNextTagId != null){
        p = "Sie befinden sich zwischen Markierung " + currentTagId + " (" + markerName(currentTagId) +
            ") und Markierung " + expectedNextTagId + " (" + markerName(expectedNextTagId) + ").";
      } else {
        p = "Sie befinden sich bei Markierung " + currentTagId + " (" + markerName(currentTagId) + ").";
      }
      var remM = remainingRouteMeters();
      if(remM != null) p += " Bis zu Ihrem Ziel " + markerName(destinationId) +
        " sind es noch ungefähr " + metersDE(remM) + ".";
      if(lastRouteInstruction) p += " " + lastRouteInstruction;
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

  flipBtn.addEventListener("click", function(){
    toggleFacing();
    setCandidate(null, 0); setEmaDist(null);
    if(running) startCamera();
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
  destSel.addEventListener("change", function(){
    var v = destSel.value ? parseInt(destSel.value, 10) : null;
    if(v != null && NODES[v] && NODES[v].destination)
      say("Ziel gewählt: " + NODES[v].name + ". Drücken Sie Navigation starten.",
        appTtsOpts({interrupt:true, source:"app.destinationSelected", category:"STATUS"}));
    else
      say("Kein Ziel gewählt.", appTtsOpts({interrupt:true, source:"app.destinationCleared", category:"STATUS"}));
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
