// ==================== Kamera ====================
// Holds stream, facing, running and safetyGiven, since these four variables are only
// read and written within this module.
// scheduleNext() (main-loop.js) is called from here, and main-loop.js reads `running`
// from here in turn -- an intentional circular dependency between camera.js and
// main-loop.js.

import { video, gate, errBox, errMsg } from './dom.js';
import { SAFETY_SPEECH } from './config.js';
import { say } from './speech.js';
import { record } from './logger.js';
import { scheduleNext } from './main-loop.js';

  var stream = null;
  var facing = "environment";
  var running = false;
  var safetyGiven = false;
  // Prevents the same camera error message from being spoken again on repeated
  // attempts (e.g. pressing "Erneut versuchen" multiple times); the visual display
  // (errMsg) is unaffected and keeps updating on every attempt.
  var lastSpokenCameraError = null;

  // ---- Kamera ----
  function stopStream(){ if(stream){ stream.getTracks().forEach(function(t){ t.stop(); }); stream = null; } }

  async function startCamera(){
    errBox.style.display = "none";
    if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
      return showError("Dieser Browser unterstützt keinen Kamera-Zugriff. Bitte Safari oder Chrome verwenden und die Seite über HTTPS öffnen.",
        { source: "camera.unsupported" });
    }
    stopStream();
    try{
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } }
      });
    }catch(e){
      try{ stream = await navigator.mediaDevices.getUserMedia({ audio:false, video:true }); }
      catch(e2){ return showError(errText(e2), { source: "camera.permissionError" }); }
    }
    video.srcObject = stream;
    try{ await video.play(); }catch(e){}
    gate.style.display = "none";
    running = true;
    lastSpokenCameraError = null;   // successful start -> the next error may be spoken again
    if(!safetyGiven){
      say("Wegweiser bereit. " + SAFETY_SPEECH,
        { interrupt:true, source:"camera.readyFirstTime", category:"STATUS" });
      safetyGiven = true;
    } else {
      say("Wegweiser bereit.", { interrupt:true, source:"camera.ready", category:"STATUS" });
    }
    scheduleNext();
  }
  function errText(e){
    var n = (e && e.name) || "";
    if(n === "NotAllowedError" || n === "SecurityError") return "Kamera-Zugriff wurde abgelehnt. Bitte in den Browser-Einstellungen erlauben. Auf dem Handy muss die Seite über HTTPS geöffnet sein.";
    if(n === "NotFoundError" || n === "OverconstrainedError") return "Keine passende Kamera gefunden. Versuche die andere Kamera.";
    return "Kamera konnte nicht gestartet werden (" + (n || "Fehler") + ").";
  }

  // opts.source identifies the error kind for log analysis; opts.spokenText allows a
  // short, non-technical spoken alternative when `msg` itself contains raw technical
  // text (see app.js's detector-load-error case) -- msg (the visual error field)
  // always keeps the original text.
  function showError(msg, opts){
    opts = opts || {};
    running = false;
    errMsg.textContent = msg;
    errBox.style.display = "flex";
    var spokenText = opts.spokenText || msg;
    if(spokenText !== lastSpokenCameraError){
      lastSpokenCameraError = spokenText;
      // This is an accessibility-critical error message (camera unavailable/access
      // denied) that must reach VoiceOver users even though navigation speech is
      // normally not mirrored to the live region -- announceToVoiceOver is requested
      // explicitly here for that reason (see say() in speech.js).
      say(spokenText, { interrupt: true, source: opts.source || "camera.error",
        category: "SAFETY_CRITICAL", announceToVoiceOver: true });
    }
    record("CAMERA_ERROR", { message: msg, source: opts.source || "camera.error" });
  }

export { startCamera, stopStream, errText, showError, running };
