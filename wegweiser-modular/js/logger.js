// ==================== Logger (unabhaengiges Instrumentierungs-Modul) ====================
// Reine Feldtest-Instrumentierung. Enthaelt KEINE Navigationslogik: nav.js entscheidet
// WANN und WAS geloggt wird (ueber navLog), dieses Modul entscheidet nur WIE Ereignisse
// gespeichert/exportiert werden (Puffer, localStorage, JSON-Export, Zaehler-Anzeige).
// Nichts hier beeinflusst NavState, Schwellwerte, Sprachausgabe oder die Kamera-/
// Erkennungs-Pipeline.
import { testNameInput, logCounter } from './dom.js';
import { SETTINGS } from './config.js';

var STORAGE_KEY = "wegweiser_v13_navlog_v1";
var MAX_EVENTS = 3000;
var SAVE_INTERVAL_MS = 1000;
var APP_VERSION = "wegweiser-v13-modular";

var buffer = [];
var dirty = false;

function getTestName(){
  return testNameInput ? (testNameInput.value || "") : "";
}

function updateCounter(){
  if(logCounter) logCounter.textContent = buffer.length + " Einträge";
}

function record(event, data){
  buffer.push({ t: Date.now(), event: event, data: data || null });
  if(buffer.length > MAX_EVENTS){
    buffer.splice(0, buffer.length - MAX_EVENTS);
  }
  dirty = true;
  updateCounter();
}

function writeToStorage(){
  try{
    localStorage.setItem(STORAGE_KEY, JSON.stringify(buffer));
    return true;
  }catch(e){
    return false;
  }
}

// Speicher voll: aeltere Haelfte verwerfen, GENAU EINMAL erneut versuchen, dann aufgeben
// (Navigation darf dadurch nie unterbrochen werden).
function save(){
  if(!dirty) return;
  if(writeToStorage()){
    dirty = false;
    return;
  }
  buffer.splice(0, Math.floor(buffer.length / 2));
  if(writeToStorage()){
    dirty = false;
  }else{
    try{ console.warn("[Logger] localStorage weiterhin voll, Log-Puffer bleibt nur im Speicher."); }catch(e){}
  }
  updateCounter();
}

function restore(){
  try{
    var raw = localStorage.getItem(STORAGE_KEY);
    if(raw){
      var parsed = JSON.parse(raw);
      if(Array.isArray(parsed)) buffer = parsed;
    }
  }catch(e){
    buffer = [];
  }
  updateCounter();
}

function clear(){
  buffer = [];
  dirty = false;
  try{ localStorage.removeItem(STORAGE_KEY); }catch(e){}
  updateCounter();
}

function pad2(n){ return (n < 10 ? "0" : "") + n; }

// Fallback for browsers without Web Share API file support.
function downloadJsonBlob(blob, filename){
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
}

function exportJson(){
  var payload = {
    metadata: {
      testName: getTestName(),
      applicationVersion: APP_VERSION,
      exportedAt: new Date().toISOString()
    },
    settings: SETTINGS,
    events: buffer
  };
  var json = JSON.stringify(payload, null, 2);
  var ts = new Date();
  var filename = "wegweiser-v13-log-" +
    ts.getFullYear() + pad2(ts.getMonth() + 1) + pad2(ts.getDate()) + "-" +
    pad2(ts.getHours()) + pad2(ts.getMinutes()) + pad2(ts.getSeconds()) + ".json";
  var blob = new Blob([json], { type: "application/json" });

  // iOS/Safari: blob: URLs oeffnen als Webseite statt Datei anzubieten, und die
  // Share Sheet zeigt "In Dateien sichern" nur bei einem echten File in navigator.share.
  // Deshalb bevorzugt: Web Share API mit echtem File-Objekt, Download nur als Fallback.
  var file;
  try{ file = new File([blob], filename, { type: "application/json" }); }catch(e){ file = null; }

  if (
    file &&
    navigator.share &&
    navigator.canShare &&
    navigator.canShare({ files: [file] })
  ) {
    navigator.share({
      files: [file],
      title: filename
    }).catch(function(e) {
      // The user intentionally closed the Share Sheet.
      if (e && e.name === "AbortError") return;

      // File sharing failed, so use the normal download fallback.
      downloadJsonBlob(blob, filename);
    });

    return;
  }

  downloadJsonBlob(blob, filename);
}

// ---- Selbst-Initialisierung beim Laden des Moduls (analog speech.js/pickVoice) ----
restore();
setInterval(function(){ if(dirty) save(); }, SAVE_INTERVAL_MS);
window.addEventListener("pagehide", function(){ save(); });
document.addEventListener("visibilitychange", function(){
  if(document.visibilityState === "hidden") save();
});

export { record, save, restore, clear, exportJson, updateCounter, getTestName };
