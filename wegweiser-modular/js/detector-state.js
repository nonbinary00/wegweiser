// ==================== Detector-Instanz ====================
// Holds the single detector instance, created once by app.js (with try/catch, since
// construction can fail) and read every frame by main-loop.js. Kept in its own small
// module so app.js (writer) and main-loop.js (reader) do not need to import each other.
var detector;

function setDetector(d){
  detector = d;
}

export { detector, setDetector };
