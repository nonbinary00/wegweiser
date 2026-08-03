// ==================== Kamera ====================
// Verbatim aus wegweiser-v13.html (Abschnitt "---- Kamera ----").
// Relozierungen aus dem urspruenglichen "---- Laufzeit (Kamera/Erkennung) ----"-Block
// (Zeilen 2551/2557/2560/2563), da diese vier Variablen ausschliesslich hier
// geschrieben/gelesen werden (genehmigte Abhaengigkeitskarte, Entscheidung 3):
//   - stream        (Zeile 2551, Teil von "var detector, positCache = {}, stream = null;")
//   - facing        (Zeile 2557)
//   - running       (Zeile 2560)
//   - safetyGiven   (Zeile 2563)
// scheduleNext() aus main-loop.js wird hier aufgerufen; main-loop.js liest running von
// hier -> genehmigter Zirkelbezug camera.js <-> main-loop.js (Entscheidung 2).

import { video, gate, errBox, errMsg } from './dom.js';
import { SAFETY_SPEECH } from './config.js';
import { say } from './speech.js';
import { record } from './logger.js';
import { scheduleNext } from './main-loop.js';

  var stream = null;
  var facing = "environment";
  var running = false;
  var safetyGiven = false;
  // neu (Audit-Ziel 6): verhindert, dass DIESELBE Kamera-Fehlermeldung bei
  // wiederholten Versuchen (z.B. mehrfaches Druecken von "Erneut versuchen")
  // erneut gesprochen wird — die visuelle Anzeige (errMsg) wird davon NICHT
  // beeinflusst und aktualisiert sich weiterhin bei jedem Versuch.
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
    lastSpokenCameraError = null;   // neu: erfolgreicher Start -> naechster Fehler darf wieder gesprochen werden
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

  // neu (Audit-Ziel 6): opts.source identifiziert die Fehlerart fuer die Log-
  // Auswertung; opts.spokenText erlaubt eine kurze, unverfaengliche gesprochene
  // Alternative, falls `msg` selbst rohen technischen Text enthaelt (siehe app.js,
  // Detektor-Ladefehler) — msg (das visuelle Fehlerfeld) bleibt IMMER unveraendert.
  function showError(msg, opts){
    opts = opts || {};
    running = false;
    errMsg.textContent = msg;
    errBox.style.display = "flex";
    var spokenText = opts.spokenText || msg;
    if(spokenText !== lastSpokenCameraError){
      lastSpokenCameraError = spokenText;
      // neu (VoiceOver-Fix): dies ist eine Barrierefreiheits-Fehlermeldung (Kamera
      // nicht verfuegbar/Zugriff verweigert) — genau die Kategorie, die laut Audit
      // weiterhin ueber VoiceOver ANGEKUENDIGT werden soll, daher hier ausdruecklich
      // angefordert (siehe say() in speech.js).
      say(spokenText, { interrupt: true, source: opts.source || "camera.error",
        category: "SAFETY_CRITICAL", announceToVoiceOver: true });
    }
    record("CAMERA_ERROR", { message: msg, source: opts.source || "camera.error" });
  }

export { startCamera, stopStream, errText, showError, running };
