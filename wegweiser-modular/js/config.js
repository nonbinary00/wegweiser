// ==================== Konfiguration ====================
// Verbatim aus wegweiser-v13.html (IIFE-Kommentarblock "---- Konfiguration ----").
// NAV_DEBUG war dort im Abschnitt "HAUPTSCHLEIFE"/navLog deklariert (Zeile 2673) und wurde
// hierher verschoben, da es ein Konfigurations-Flag ist, keine Laufzeit-Logik.

  var MARKER_SIZE_M = 0.12;
  var PROC_WIDTH    = 640;
  var PROC_MS       = 140;
  var DEBUG_SHOW_TAG_ID = true;
  var CONFIRM_FRAMES    = 2;

  var SETTINGS = {
    scanHintAfterMs: 8000,        // Ruhe, bevor der erste Suchhinweis kommt
    scanHintRepeatMs: 12000,      // Suchhinweise wiederholen sich
    candMemoryMs: 700,
    visualMemoryMs: 700,
    wrongTagCooldownMs: 10000,
    aimCooldownMs: 1500,
    reachedM: 1.8,                // Punkt erreicht bei GEMESSENER Distanz <= Schwelle.
                                  // v13: 1.2 -> 1.8, weil die Erkennung genau unter ~1.5 m
                                  // (steiler Winkel, Tag am Bildrand) unzuverlässig wird.
                                  // Pro Kante weiterhin per edge.reachedM übersteuerbar.
    startTagReachedM: 1.0,        // neu (Tag-1-Sonderbehandlung): EIGENE Ankunfts-Schwelle
                                  // NUR fuer die TRACKING_START_TAG-Phase (siehe nav.js
                                  // handleTracking()) — 1,8 m ist fuer den Stopp-und-
                                  // Rechtsabbiegen-Punkt bei Tag 1 zu weit. Beruehrt
                                  // NICHT reachedM (Tag 2 und alle spaeteren Tags bleiben
                                  // bei 1,8 m bzw. ihrer eigenen edge.reachedM).
    nearLostM: 2.5,               // Tag zwischen reachedM und 2,5 m verloren => "sehr nah"-Hinweis
    arrivalConfirmFrames: 2,      // v13: so viele Frames in Folge mit arrival <= Schwelle
                                  // noetig (schuetzt vor einzelnem Distanz-Ausreisser nach unten)
    nearLossFallbackM: 2.2,       // v13: Verlust zaehlt als Ankunft NUR, wenn kurz zuvor
                                  // stabil bis <= diese Distanz angenaehert wurde
    nearLossMinDets: 6,           // v13: ... und mindestens so viele Messungen im Abschnitt vorlagen
    rawWindowN: 5,                // v13: Fenster der letzten Roh-Distanzen (juengstes Minimum)
    trackingConfirmDetections: 3, // neu: so viele gueltige Messungen des erwarteten Tags
                                  // noetig, bevor "verloren" ueberhaupt gemeldet werden darf
    trackLostStopMs: 1800,        // Tag so lange weg (>= 1,8 s) => internes LOST_STOPPED
                                  // (Zustandsuebergang, UNVERAENDERT) — bestimmt NICHT mehr
                                  // direkt die gesprochene Stopp-Ansage, siehe lostSpeechDelayMs
    awayDeltaM: 1.2,              // Distanz steigt um so viel über Minimum => Warnung
    otherTagFrames: 6,            // fremder Tag: erst nach ~0,8 s stabiler Sicht melden
    backTagFrames: 9,             // "zurück"-Warnung erst bei sehr stabiler Sicht (~1,3 s)
    lostSpeechDelayMs: 4500,      // neu (TTS-Aufraeumung): zusaetzliche Verzoegerung NACH dem
                                  // Eintritt in LOST_STOPPED, bevor die gesprochene Stopp-
                                  // Ansage tatsaechlich erfolgt — gibt dem erwarteten Tag oder
                                  // einem gueltigen Vorgriffs-Tag Zeit, sich zu bestaetigen,
                                  // OHNE den bestehenden trackLostStopMs-Zustandsuebergang zu
                                  // veraendern oder umzudeuten (siehe handleLostStopped())
    lostReminderRepeatMs: 18000,   // neu: Abstand zwischen kurzen "Suchen Sie weiter."-
                                  // Erinnerungen waehrend LOST_STOPPED (deutlich seltener
                                  // als vorher; ersetzt die lange Wiederholung ueber
                                  // scanHintRepeatMs)
    longCorridorReassuranceM: 15   // neu: nach so vielen aufsummierten Metern OHNE
                                  // Abbiegen (siehe Korridor-Fortschritt in nav.js) darf
                                  // "Gehen Sie weiter geradeaus." erneut gesprochen
                                  // werden, auch wenn dieselbe Formulierung fuer diesen
                                  // Korridor bereits einmal aktiv war — rein
                                  // distanzbasiert, kein neuer Zeit-Timer
  };

  var SAFETY_SPEECH = "Der Wegweiser unterstützt die Orientierung anhand von Markierungen, " +
    "erkennt aber keine Hindernisse. Bitte verwenden Sie weiterhin Ihren Langstock " +
    "oder Ihre gewohnte Mobilitätshilfe.";

// v13: Debug-Logging fuer Feldtests (Konsole).
var NAV_DEBUG = true;

export {
  MARKER_SIZE_M,
  PROC_WIDTH,
  PROC_MS,
  DEBUG_SHOW_TAG_ID,
  CONFIRM_FRAMES,
  SETTINGS,
  SAFETY_SPEECH,
  NAV_DEBUG
};
