// ==================== Frame-Groesse (neu, kein Original-Aequivalent) ====================
// Im Original (wegweiser-v13.html, Zeile 2559) war dies eine einzelne Deklaration
// "var W = PROC_WIDTH, H = 480;" im selben Closure-Scope wie tick()/distanceMeters()/
// drawMarker()/aimGuidance(). main-loop.js (tick) ist der EINZIGE Schreiber (setzt neue
// Masse, sobald sich die Video-Dimensionen aendern); distance.js, ui.js und nav.js lesen
// nur. Ausgelagert in ein eigenes kleines Modul, damit main-loop.js <-> distance.js keinen
// Kreis bilden muessen (siehe genehmigte Abhaengigkeitskarte, Entscheidung 4).
import { PROC_WIDTH } from './config.js';

var W = PROC_WIDTH, H = 480;

function setFrameSize(w, h){
  W = w;
  H = h;
}

export { W, H, setFrameSize };
