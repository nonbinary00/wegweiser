// ==================== Detector-Instanz (neu, kein Original-Aequivalent) ====================
// Im Original (wegweiser-v13.html, Zeile 2551) war dies Teil von
// "var detector, positCache = {}, stream = null;" im selben Closure-Scope.
// detector wird EINMALIG am Ende des IIFE erzeugt (versuchsweise, mit try/catch) und
// in tick() gelesen. Ausgelagert in ein eigenes kleines Modul, damit app.js (Erzeuger)
// und main-loop.js (Leser) keinen Import-Kreis bilden muessen (siehe genehmigte
// Abhaengigkeitskarte, Entscheidung 4). positCache und stream bleiben, wo sie im Original
// tatsaechlich benutzt werden (distance.js bzw. camera.js), nicht hier.
var detector;

function setDetector(d){
  detector = d;
}

export { detector, setDetector };
