// ==================== Kamera ====================
// Verbatim aus wegweiser-v13.html (Abschnitt "---- Kamera ----").
// Relozierungen aus dem urspruenglichen "---- Laufzeit (Kamera/Erkennung) ----"-Block
// (Zeilen 2551/2557/2560/2563), da diese vier Variablen ausschliesslich hier
// geschrieben/gelesen werden (genehmigte Abhaengigkeitskarte, Entscheidung 3):
//   - stream        (Zeile 2551, Teil von "var detector, positCache = {}, stream = null;")
//   - facing        (Zeile 2557)
//   - running       (Zeile 2560)
//   - safetyGiven   (Zeile 2563)
// toggleFacing() ist neu: mechanischer Wrapper um genau die Original-Anweisung aus dem
// flipBtn-Handler ("facing = (facing === 'environment') ? 'user' : 'environment';").
// scheduleNext() aus main-loop.js wird hier aufgerufen; main-loop.js liest running von
// hier -> genehmigter Zirkelbezug camera.js <-> main-loop.js (Entscheidung 2).

import { video, gate, errBox, errMsg } from './dom.js';
import { SAFETY_SPEECH } from './config.js';
import { say } from './speech.js';
import { scheduleNext } from './main-loop.js';

  var stream = null;
  var facing = "environment";
  var running = false;
  var safetyGiven = false;

  // ---- Kamera ----
  function stopStream(){ if(stream){ stream.getTracks().forEach(function(t){ t.stop(); }); stream = null; } }

  async function startCamera(){
    errBox.style.display = "none";
    if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
      return showError("Dieser Browser unterstützt keinen Kamera-Zugriff. Bitte Safari oder Chrome verwenden und die Seite über HTTPS öffnen.");
    }
    stopStream();
    try{
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } }
      });
    }catch(e){
      try{ stream = await navigator.mediaDevices.getUserMedia({ audio:false, video:true }); }
      catch(e2){ return showError(errText(e2)); }
    }
    video.srcObject = stream;
    try{ await video.play(); }catch(e){}
    gate.style.display = "none";
    running = true;
    if(!safetyGiven){
      say("Wegweiser bereit. " + SAFETY_SPEECH, {interrupt:true});
      safetyGiven = true;
    } else {
      say("Wegweiser bereit.", {interrupt:true});
    }
    scheduleNext();
  }
  function errText(e){
    var n = (e && e.name) || "";
    if(n === "NotAllowedError" || n === "SecurityError") return "Kamera-Zugriff wurde abgelehnt. Bitte in den Browser-Einstellungen erlauben. Auf dem Handy muss die Seite über HTTPS geöffnet sein.";
    if(n === "NotFoundError" || n === "OverconstrainedError") return "Keine passende Kamera gefunden. Versuche die andere Kamera.";
    return "Kamera konnte nicht gestartet werden (" + (n || "Fehler") + ").";
  }
  function showError(msg){ running = false; errMsg.textContent = msg; errBox.style.display = "flex"; }

  function toggleFacing(){
    facing = (facing === "environment") ? "user" : "environment";
  }

export { startCamera, stopStream, errText, showError, running, toggleFacing };
