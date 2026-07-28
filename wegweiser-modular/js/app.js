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
  gate, retryBtn, navStartBtn, navEndBtn, repeatBtn, whereBtn, flipBtn, muteBtn, destSel
} from './dom.js';
import { NODES } from './graph-data.js';
import { markerName, metersDE } from './graph.js';
import {
  startNavigation, endNavigation, lastRouteInstruction, destinationReached, currentTagId,
  navigationActive, expectedNextTagId, navState, NavState, emaDist, pathTagIds, segIndex,
  destinationId, setCandidate, setEmaDist
} from './nav.js';
import { startCamera, showError, running, toggleFacing } from './camera.js';
import { say, toggleSound, soundOn } from './speech.js';
import { setDetector } from './detector-state.js';

  // ---- Bedienung ----
  gate.addEventListener("click", function(){ if(!running) startCamera(); });
  retryBtn.addEventListener("click", startCamera);

  navStartBtn.addEventListener("click", function(){
    if(!running){ say("Bitte zuerst die Kamera starten.", {interrupt:true}); return; }
    startNavigation();
  });
  navEndBtn.addEventListener("click", function(){ endNavigation(true); });

  repeatBtn.addEventListener("click", function(){
    if(lastRouteInstruction) say(lastRouteInstruction, {interrupt:true});
    else say("Noch keine Anweisung vorhanden.", {interrupt:true});
  });

  whereBtn.addEventListener("click", function(){
    var p;
    if(destinationReached){
      p = "Sie sind am Ziel: " + markerName(destinationId || currentTagId) + ".";
    } else if(currentTagId != null && navigationActive){
      p = "Zuletzt erreicht: Tag " + currentTagId + " bei " + markerName(currentTagId) + ".";
      if(expectedNextTagId != null){
        p += " Voraus liegt Tag " + expectedNextTagId + " bei " + markerName(expectedNextTagId) + ".";
        if(navState === NavState.TRACKING && emaDist != null)
          p += " Entfernung ungefähr " + metersDE(emaDist) + ".";
      }
      if(pathTagIds && destinationId != null){
        var remaining = pathTagIds.length - 1 - segIndex;
        if(remaining > 0) p += " Bis zum Ziel " + markerName(destinationId) + " " +
          (remaining === 1 ? "ist es noch ein Abschnitt." : "sind es noch " + remaining + " Abschnitte.");
      }
    } else if(navigationActive){
      p = "Noch keine Markierung bestätigt. Richten Sie das Smartphone auf die nächste " +
          "Markierung in Ihrer Nähe. Von dort wird die Route zum Ziel " +
          markerName(destinationId) + " berechnet.";
    } else {
      p = "Keine Navigation aktiv. Bitte wählen Sie ein Ziel und starten Sie die Navigation.";
    }
    say(p, {interrupt:true});
  });

  flipBtn.addEventListener("click", function(){
    toggleFacing();
    setCandidate(null, 0); setEmaDist(null);
    if(running) startCamera();
  });
  muteBtn.addEventListener("click", function(){
    toggleSound();
    muteBtn.firstChild.textContent = soundOn ? "Ton an" : "Ton aus";
    if(!soundOn && "speechSynthesis" in window) speechSynthesis.cancel();
    else say("Ton eingeschaltet", {interrupt:true});
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
      say("Ziel gewählt: " + NODES[v].name + ". Drücken Sie Navigation starten.", {interrupt:true});
    else
      say("Kein Ziel gewählt.", {interrupt:true});
  });

  try{
    setDetector(new AR.Detector({ dictionaryName: "APRILTAG_36h11" }));
  }catch(e){
    showError("Interner Fehler beim Laden der Erkennung: " + e);
  }
