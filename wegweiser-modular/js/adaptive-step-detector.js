// ==================== Experimenteller ADAPTIVER Schritt-Detektor (NUR Diagnose) ====================
// Zweiter, rein experimenteller Erkennungspfad NEBEN dem Produktions-Detektor
// (step-detector.js, feste motionThreshold 1,5 -- bleibt unveraendert die einzige
// Quelle fuer STEP_DETECTED). Dieses Modul erhaelt exakt dieselben Sensorwerte
// ueber den Sample-Tap des Produktions-Detektors (siehe onSample in
// step-detector.js/app.js), besitzt KEINE eigene devicemotion-Subscription,
// KEINE Berechtigungslogik, KEIN window/DOM -- ausschliesslich addSample().
//
// Hintergrund (Feldtest, 9 Laeufe a 5 Schritte): normale Schritte 14/15 erkannt,
// vorsichtige 6/15, schlurfende 3/15 -- schlurfende Peaks lagen meist bei
// ~0,65-0,95, vorsichtige teils bei ~1,3-1,48, also unterhalb der festen 1,5.
// Statt die Produktionsschwelle auf Verdacht zu senken, liefert dieser Detektor
// VERGLEICHSDATEN: adaptive Schwelle aus rollender Statistik + Rhythmus-
// Validierung, protokolliert parallel zum Produktionspfad am selben Signal.
//
// Verarbeitungskette (bewusst einfach, KEIN strenger Bandpass, kein ML):
//   accelerationIncludingGravity (x,y,z)
//   -> Schwerkraft-Schaetzung je Achse (langsame EMA) und Abzug
//   -> Betrag des dynamischen Rest-Vektors (lageunabhaengig)
//   -> Glaettung (kurze EMA)
//   -> adaptive Schwelle: max(thresholdFloor, mean + thresholdK * std)
//      ueber ein rollendes Statistikfenster
//   -> Exkursions-/Lokalmaximum-Erkennung -> Kandidaten-Peak
//   -> Rhythmus-Validierung (min/max-Intervall, minConsecutivePeaks)
//   -> experimentelle Geh-/Schritt-Ereignisse (Callbacks)
//
// KEINE Kopplung an Navigation: dieses Modul importiert nichts und kennt keine
// Tags/Routen/TTS/NavState -- es kann Navigationszustand strukturell weder
// lesen noch veraendern (von test/adaptive-step-detector.test.js abgesichert).

// ---- Experimentelle Konfiguration. AUSDRUECKLICH KEINE validierten
// Produktionskonstanten -- Startwerte fuer die Feld-Datensammlung, danach
// anhand der exportierten Logs nachzujustieren. ----
export var DEFAULT_ADAPTIVE_STEP_CONFIG = {
  // Langsame Je-Achse-EMA als Schwerkraft-/Orientierungs-Schaetzung. Der
  // Abzug VOR der Betragsbildung (anders als im Produktionspfad, der erst
  // den Betrag bildet) haelt den dynamischen Anteil auch bei langsamen
  // Orientierungsaenderungen sauberer getrennt.
  gravityAlpha: 0.02,
  // Kurze EMA ueber den dynamischen Betrag -- Glaettung gegen Einzelsample-
  // Ausreisser. Bewusst als einfache Glaettung dokumentiert, NICHT als
  // Bandpass (das ist sie mathematisch nicht).
  smoothingAlpha: 0.3,
  // Rollendes Fenster fuer mean/std des geglaetteten Signals. ACHTUNG
  // (dokumentierte Einschraenkung, bewusst NICHT in dieser Aufgabe
  // umgestaltet): das Fenster enthaelt die Gehbewegung selbst -- energisches
  // Gehen hebt mean/std und damit die Schwelle mit an. Deshalb werden
  // mean/std/threshold in jedem Peak-Ereignis mitprotokolliert, damit genau
  // dieses Verhalten aus echten Logs bewertet werden kann.
  statsWindowMs: 3000,
  // threshold = max(thresholdFloor, mean + thresholdK * std)
  thresholdK: 1.2,
  thresholdFloor: 0.35,
  // Lokalmaximum-Abschluss: eine laufende Peak-Exkursion endet, sobald das
  // Signal um diesen Anteil unter ihr LAUFENDES lokales Maximum faellt
  // (smoothed < exMax * peakReleaseRatio). Feldtest-Korrektur: die fruehere
  // Referenz auf die beim Exkursions-START eingefrorene Schwelle
  // (exStartThreshold * ratio) verschmolz bei normalem Gehen mehrere
  // physische Schritte zu EINER Exkursion, weil das Signal zwischen
  // Schritten zwar deutlich einbricht, aber nicht bis unter 50% der
  // niedrigen Startschwelle kollabiert -- deterministisch reproduziert in
  // test/adaptive-step-detector.test.js (Fall B) und sichtbar in den
  // Feldlogs als scheinbare Kandidaten-Intervalle von 3-5s bei realer
  // Kadenz von ~0,5-1s. Der Abfall relativ zum lokalen Maximum skaliert
  // dagegen mit der tatsaechlichen Schritthoehe. Wert (0,5) unveraendert.
  peakReleaseRatio: 0.5,
  // Rhythmus-Validierung: plausibles Schrittintervall-Fenster und Anzahl
  // aufeinanderfolgender rhythmischer Peaks, bevor "Gehen" als bestaetigt
  // gilt. Experimentelle Startwerte, keine physiologischen Endwerte.
  minStepIntervalMs: 400,
  maxStepIntervalMs: 1500,
  minConsecutivePeaks: 3,
  // Gehen gilt als beendet, wenn nach Bestaetigung ca. so lange kein
  // gueltiger rhythmischer Peak mehr kam: maxStepIntervalMs * dieser Faktor.
  walkingStopTimeoutFactor: 2,
  // Kurze Einschwingphase nach reset()/Erstsample: Schwerkraft-EMA und
  // Statistikfenster sind anfangs leer/unzuverlaessig -- in dieser Zeit
  // werden keine Kandidaten-Peaks erzeugt (gleiche Idee wie warmupMs im
  // Produktionspfad).
  warmupMs: 400,
  // ---- Experimentelle Scan-Unterdrueckung (Tag4->9-Feldbefund) ----
  // NUR aktiv, wenn scanSuppressionEnabled true ist -- auf false setzen
  // schaltet exakt das vorige (rein diagnostische) Verhalten wieder frei.
  // Herleitung/Belege: naechster Feldlog-Analysebericht (verticalRatio +
  // rotationRateMean ueber 9 kontrollierte Laeufe je Gangart plus 3
  // Scan-Laeufe). Scan-Peaks lagen bei verticalRatio 0,11-0,55 (ueberlappt
  // mit schlurfendem/vorsichtigem Gehen -- verticalRatio ALLEIN daher NICHT
  // sicher) aber rotationRateMean meist 40-136 (deutlich ueber dem Maximum
  // 32,72, das irgendein bestaetigter Gehen-Peak in diesem Log erreichte).
  // Ein EINZELNER Kandidat, der beide Bedingungen erfuellt, wird bewusst
  // NICHT unterdrueckt (im Log kam genau ein isolierter schlurfender Peak
  // mit rotationRateMean 41,89 vor, der nie zu einer Gehen-Bestaetigung
  // beitrug) -- erst ZWEI SOLCHER Kandidaten IN FOLGE loesen aus. Absichtlich
  // konservativ: ein einzelner Scan-Ausschlag darf durchrutschen, siehe
  // scanConsecutivePeaksToSuppress.
  scanSuppressionEnabled: true,
  scanVerticalRatioMax: 0.30,
  scanRotationRateMin: 45,
  scanConsecutivePeaksToSuppress: 2
};

// ==================== Reine Rhythmus-Validierung ====================
// Bewusst als reine Funktionen ausgelagert (deterministisch mit synthetischen
// Kandidaten testbar, ohne Signal-Simulation). Ein Kandidat ist IMMER das
// vollstaendige Objekt { t, amplitude, threshold } -- NIE nur ein Zeitstempel:
// beim Backfill (Gehen wird erst ab dem N-ten Peak bestaetigt) behaelt jeder
// nachgemeldete Schritt seine EIGENEN Originalwerte, statt Zeit/Amplitude/
// Schwelle des letzten Peaks zu duplizieren.

export function createRhythmState(){
  return {
    walking: false,
    consecutive: 0,
    sequence: [],          // Kandidaten { t, amplitude, threshold } der aktuellen, noch unbestaetigten Serie
    lastValidPeakT: null
  };
}

// (Zustand, Kandidat, Konfiguration) -> { state, classification, steps,
// walkingStarted, walkingStopped }. steps enthaelt 0..n experimentelle
// Schritte; beim Bestaetigungs-Backfill traegt jeder Eintrag die Werte
// SEINES urspruenglichen Kandidaten, der bestaetigende Peak selbst genau
// einmal (backfilled:false) -- keine Doppelzaehlung.
export function processCandidatePeak(state, candidate, config){
  var cfg = config || DEFAULT_ADAPTIVE_STEP_CONFIG;
  var next = {
    walking: state.walking,
    consecutive: state.consecutive,
    sequence: state.sequence.slice(),
    lastValidPeakT: state.lastValidPeakT
  };
  var steps = [];
  var walkingStarted = false;
  var walkingStopped = false;
  var interval = next.lastValidPeakT == null ? null : candidate.t - next.lastValidPeakT;
  var classification;

  if(interval != null && interval < cfg.minStepIntervalMs){
    // Zu schnell (z.B. Doppel-Ausschlag innerhalb EINES physischen Schritts,
    // Haendezittern): wird ignoriert, zerstoert aber die laufende Serie NICHT
    // und verschiebt auch die Referenzzeit nicht.
    classification = "too-fast";
  } else if(interval == null || interval > cfg.maxStepIntervalMs){
    // Erster Kandidat ueberhaupt ODER Luecke oberhalb des plausiblen
    // Schrittintervalls: Serie bricht, dieser Kandidat beginnt eine neue.
    // War Gehen bereits bestaetigt, endet es hiermit (Rhythmus gebrochen).
    if(next.walking){
      next.walking = false;
      walkingStopped = true;
    }
    next.sequence = [candidate];
    next.consecutive = 1;
    next.lastValidPeakT = candidate.t;
    classification = "sequence-start";
  } else {
    // Gueltiger rhythmischer Peak.
    classification = "valid";
    next.consecutive++;
    next.lastValidPeakT = candidate.t;
    if(next.walking){
      steps.push({ t: candidate.t, amplitude: candidate.amplitude,
        threshold: candidate.threshold, backfilled: false });
    } else {
      next.sequence.push(candidate);
      if(next.consecutive >= cfg.minConsecutivePeaks){
        next.walking = true;
        walkingStarted = true;
        // Backfill: JEDER Kandidat der Serie wird genau einmal als
        // experimenteller Schritt gemeldet, mit seinen eigenen Werten;
        // nur der bestaetigende (letzte) gilt als nicht-backfilled.
        for(var i = 0; i < next.sequence.length; i++){
          var c = next.sequence[i];
          steps.push({ t: c.t, amplitude: c.amplitude, threshold: c.threshold,
            backfilled: c !== candidate });
        }
        next.sequence = [];
      }
    }
  }

  return { state: next, classification: classification, steps: steps,
    walkingStarted: walkingStarted, walkingStopped: walkingStopped,
    intervalFromPreviousPeak: interval };
}

// Inaktivitaets-Pruefung (Sicherheitsnetz fuer den Fall, dass gar keine
// Kandidaten mehr eintreffen -- der Rhythmusbruch ueber einen zu spaeten
// Kandidaten wird bereits in processCandidatePeak() behandelt).
export function checkWalkingTimeout(state, t, config){
  var cfg = config || DEFAULT_ADAPTIVE_STEP_CONFIG;
  if(!state.walking || state.lastValidPeakT == null) return { state: state, walkingStopped: false };
  if(t - state.lastValidPeakT <= cfg.maxStepIntervalMs * cfg.walkingStopTimeoutFactor){
    return { state: state, walkingStopped: false };
  }
  return {
    state: { walking: false, consecutive: 0, sequence: [], lastValidPeakT: state.lastValidPeakT },
    walkingStopped: true
  };
}

// ==================== Detektor-Objekt ====================
// callbacks (alle optional):
//   onPeak({ t, amplitude, threshold, mean, std, intervalFromPreviousPeak,
//            consecutivePeaks, classification })      -- jeder Kandidaten-Peak.
//            classification kann jetzt auch "scan-suppressed" sein (siehe
//            scanSuppressionEnabled) -- consecutivePeaks/intervalFromPreviousPeak
//            sind fuer diese Klassifikation ohne Bedeutung (immer 0/null), der
//            Kandidat wurde bewusst NICHT an processCandidatePeak() weitergegeben.
//   onStep({ t, amplitude, threshold, backfilled })   -- experimenteller Schritt
//   onWalkingStart({ t, consecutivePeaks })
//   onWalkingStop({ t, reason, adaptiveStepCount })   -- reason kann jetzt auch
//            "scan-suppressed" sein (zwei aufeinanderfolgende Scan-verdaechtige
//            Kandidaten waehrend bereits bestaetigtem Gehen), zusaetzlich zu den
//            bestehenden "rhythm-break"/"inactivity-timeout".
export function createAdaptiveStepDetector(config, callbacks){
  var cfg = Object.assign({}, DEFAULT_ADAPTIVE_STEP_CONFIG, config || {});
  var cb = callbacks || {};

  // Signal-Zustand
  var gravity = null;              // {x,y,z} EMA-Schwerkraftschaetzung
  var smoothed = null;             // geglaetteter dynamischer Betrag
  var windowSamples = [];          // { t, v } fuer mean/std
  var firstSampleT = null;

  // Exkursions-Zustand (lokale Peak-Erkennung)
  var exActive = false;
  var exStartT = 0;                // Beginn der Exkursion (fuer peakDurationMs-Diagnose)
  var exMax = 0, exMaxT = 0, exThresholdAtMax = 0, exMeanAtMax = 0, exStdAtMax = 0;
  // Richtungs-Diagnose je Exkursion (NUR Protokoll, KEINE Klassifikation --
  // Feldtest-Befund: Links-Rechts-Scannen im Stand erzeugt rhythmische
  // Magnituden-Peaks, die von echten Schritten skalar nicht unterscheidbar
  // sind. Der dynamische Beschleunigungsvektor wird deshalb VOR der
  // Betragsbildung auf den bereits geschaetzten Schwerkraftvektor projiziert:
  // Schritt-Impulse liegen ueberwiegend ENTLANG der Schwerkraft (vertikal),
  // Scan-Schwuenge senkrecht dazu (lateral) -- lageunabhaengig, da die
  // Referenz der gemessene Schwerkraftvektor selbst ist, nicht eine feste
  // Geraeteachse. Zusaetzlich wird, falls das Geraet rotationRate liefert,
  // die mittlere Rotationsrate der Exkursion erfasst (Drehen des Telefons
  // beim Scannen; dort ist die traege Schwerkraft-EMA am unzuverlaessigsten).
  // Ein Feldlog (9 kontrollierte Gang-Laeufe + 3 Scan-Laeufe) belegt inzwischen
  // eine mit Sicherheitsabstand getrennte Grenze auf rotationRateMean, siehe
  // scanRotationRateMin/scanVerticalRatioMax weiter oben -- die eigentliche
  // Unterdrueckungs-Entscheidung bleibt unten in processCandidate() isoliert
  // und ueber scanSuppressionEnabled abschaltbar.
  var exVertSum = 0;               // Summe |vertikaler Anteil| waehrend der Exkursion
  var exLatSum = 0;                // Summe lateraler Anteil waehrend der Exkursion
  var exRotSum = 0;                // Summe |rotationRate| (deg/s), falls geliefert
  var exRotCount = 0;              // Anzahl Samples mit Rotationsdaten

  // Rhythmus-/Zaehl-Zustand
  var rhythm = createRhythmState();
  var adaptiveStepCount = 0;
  var peakCount = 0;
  // Anzahl AUFEINANDERFOLGENDER Scan-verdaechtiger Kandidaten (siehe
  // scanSuppressionEnabled), NICHT dasselbe wie rhythm.consecutive.
  var scanStreak = 0;

  // Abtast-Diagnostik (Feld-Beleg der echten Sensorrate -- NICHT pro Sample
  // protokolliert, sondern nur aggregiert per getSummary() abfragbar)
  var sampleCount = 0;
  var lastSampleT = null;
  var minSampleIntervalMs = null;
  var maxSampleIntervalMs = null;
  var reportedEventIntervalMs = null;   // letztes non-null event.interval

  // zuletzt berechnete Statistik (fuer Diagnose/Summary)
  var lastMean = 0, lastStd = 0, lastThreshold = cfg.thresholdFloor;

  function emitStep(step){
    adaptiveStepCount++;
    if(cb.onStep) cb.onStep(step);
  }

  function handleRhythmResult(result){
    rhythm = result.state;
    if(result.walkingStopped && cb.onWalkingStop){
      cb.onWalkingStop({ t: result.state.lastValidPeakT, reason: "rhythm-break",
        adaptiveStepCount: adaptiveStepCount });
    }
    for(var i = 0; i < result.steps.length; i++) emitStep(result.steps[i]);
    if(result.walkingStarted && cb.onWalkingStart){
      cb.onWalkingStart({ t: result.state.lastValidPeakT,
        consecutivePeaks: rhythm.consecutive });
    }
  }

  function processCandidate(candidate){
    peakCount++;

    // Scan-Unterdrueckung (siehe scanSuppressionEnabled-Kommentar bei der
    // Konfiguration): bewusst VOR processCandidatePeak() und bewusst auf
    // Basis eines eigenen Streak-Zaehlers (NICHT rhythm.consecutive) --
    // ein einzelner Scan-verdaechtiger Kandidat durchlaeuft die normale
    // Rhythmus-Verarbeitung unveraendert (darf also z.B. noch eine
    // Gehen-Bestaetigung ausloesen, falls er zufaellig der dritte
    // rhythmische Peak ist); erst der ZWEITE Scan-verdaechtige Kandidat IN
    // FOLGE greift ein -- entweder er verhindert eine noch unbestaetigte
    // Serie (Reset auf leeren Rhythmus-Zustand) oder er beendet ein
    // bereits bestaetigtes Gehen sofort (wie ein Rhythmusbruch), statt auf
    // den naechsten inactivity-timeout zu warten.
    var isScanLike = cfg.scanSuppressionEnabled &&
      candidate.verticalRatio != null && candidate.rotationRateMean != null &&
      candidate.verticalRatio < cfg.scanVerticalRatioMax &&
      candidate.rotationRateMean > cfg.scanRotationRateMin;
    scanStreak = isScanLike ? scanStreak + 1 : 0;

    if(scanStreak >= cfg.scanConsecutivePeaksToSuppress){
      var wasWalking = rhythm.walking;
      if(wasWalking){
        rhythm = { walking: false, consecutive: 0, sequence: [],
          lastValidPeakT: rhythm.lastValidPeakT };
        if(cb.onWalkingStop){
          cb.onWalkingStop({ t: candidate.t, reason: "scan-suppressed",
            adaptiveStepCount: adaptiveStepCount });
        }
      } else {
        rhythm = createRhythmState();
      }
      if(cb.onPeak){
        cb.onPeak({ t: candidate.t, amplitude: candidate.amplitude,
          threshold: candidate.threshold, mean: candidate.mean, std: candidate.std,
          intervalFromPreviousPeak: null, consecutivePeaks: 0,
          classification: "scan-suppressed", peakDurationMs: candidate.peakDurationMs,
          verticalRatio: candidate.verticalRatio,
          rotationRateMean: candidate.rotationRateMean });
      }
      return;
    }

    var result = processCandidatePeak(rhythm, candidate, cfg);
    var consecutiveAfter = result.state.consecutive;
    handleRhythmResult(result);
    if(cb.onPeak){
      cb.onPeak({ t: candidate.t, amplitude: candidate.amplitude,
        threshold: candidate.threshold, mean: candidate.mean, std: candidate.std,
        intervalFromPreviousPeak: result.intervalFromPreviousPeak,
        consecutivePeaks: consecutiveAfter, classification: result.classification,
        peakDurationMs: candidate.peakDurationMs,
        verticalRatio: candidate.verticalRatio,
        rotationRateMean: candidate.rotationRateMean });
    }
  }

  return {
    // Erhaelt jedes Sensor-Sample vom Produktions-Detektor-Tap. reportedIntervalMs
    // ist event.interval (falls der Browser es liefert), atTime die gleiche
    // Zeitbasis wie im Produktionspfad (performance.now()).
    // rotation (optional): { alpha, beta, gamma } aus event.rotationRate des
    // SELBEN devicemotion-Ereignisses (deg/s), oder null falls das Geraet
    // keine Rotationsdaten liefert.
    addSample: function(x, y, z, atTime, reportedIntervalMs, rotation){
      // -- Abtast-Diagnostik --
      sampleCount++;
      if(firstSampleT == null) firstSampleT = atTime;
      if(lastSampleT != null){
        var dt = atTime - lastSampleT;
        if(minSampleIntervalMs == null || dt < minSampleIntervalMs) minSampleIntervalMs = dt;
        if(maxSampleIntervalMs == null || dt > maxSampleIntervalMs) maxSampleIntervalMs = dt;
      }
      lastSampleT = atTime;
      if(reportedIntervalMs != null) reportedEventIntervalMs = reportedIntervalMs;

      // -- Schwerkraft-Schaetzung / dynamischer Betrag --
      if(gravity == null){
        gravity = { x: x, y: y, z: z };   // Erstsample: direkt uebernehmen (keine Sprungantwort)
        return;
      }
      gravity.x += cfg.gravityAlpha * (x - gravity.x);
      gravity.y += cfg.gravityAlpha * (y - gravity.y);
      gravity.z += cfg.gravityAlpha * (z - gravity.z);
      var dx = x - gravity.x, dy = y - gravity.y, dz = z - gravity.z;
      var dynMag = Math.sqrt(dx * dx + dy * dy + dz * dz);
      // Richtungs-Zerlegung (siehe Kommentar am Exkursions-Zustand oben):
      // Anteil des dynamischen Vektors ENTLANG der Schwerkraft (vertikal)
      // vs. senkrecht dazu (lateral). gMag ~9,81 bei realen Sensordaten;
      // der Schutz gegen ~0 greift nur bei degenerierten (synthetischen)
      // Eingaben ohne Schwerkraftanteil.
      var gMag = Math.sqrt(gravity.x * gravity.x + gravity.y * gravity.y + gravity.z * gravity.z);
      var vertComp = 0, latComp = dynMag;
      if(gMag > 1e-6){
        vertComp = (dx * gravity.x + dy * gravity.y + dz * gravity.z) / gMag;
        latComp = Math.sqrt(Math.max(0, dynMag * dynMag - vertComp * vertComp));
      }
      var rotMag = null;
      if(rotation && rotation.alpha != null && rotation.beta != null && rotation.gamma != null){
        rotMag = Math.sqrt(rotation.alpha * rotation.alpha +
          rotation.beta * rotation.beta + rotation.gamma * rotation.gamma);
      }
      // rising = das geglaettete Signal ist mit DIESEM Sample gestiegen --
      // Voraussetzung fuer einen Exkursions-START (siehe unten): die
      // abfallende Flanke eines gerade abgeschlossenen Peaks liegt zwar noch
      // ueber der Schwelle, faellt aber und darf keine zweite Exkursion
      // desselben physischen Schritts eroeffnen (Doppelzaehlungs-Schutz).
      var rising = false;
      if(smoothed == null){
        smoothed = dynMag;               // erster Glaettungswert: keine Richtung bestimmbar
      } else {
        var nextSmoothed = smoothed + cfg.smoothingAlpha * (dynMag - smoothed);
        rising = nextSmoothed > smoothed;
        smoothed = nextSmoothed;
      }

      // -- rollende Statistik + adaptive Schwelle --
      windowSamples.push({ t: atTime, v: smoothed });
      var cutoff = atTime - cfg.statsWindowMs;
      while(windowSamples.length && windowSamples[0].t < cutoff) windowSamples.shift();
      var sum = 0, sumSq = 0;
      for(var i = 0; i < windowSamples.length; i++){
        sum += windowSamples[i].v;
        sumSq += windowSamples[i].v * windowSamples[i].v;
      }
      var n = windowSamples.length;
      var mean = n ? sum / n : 0;
      var variance = n ? Math.max(0, sumSq / n - mean * mean) : 0;
      var std = Math.sqrt(variance);
      var threshold = Math.max(cfg.thresholdFloor, mean + cfg.thresholdK * std);
      lastMean = mean; lastStd = std; lastThreshold = threshold;

      // -- Geh-Inaktivitaets-Timeout (Sicherheitsnetz) --
      var timeoutResult = checkWalkingTimeout(rhythm, atTime, cfg);
      if(timeoutResult.walkingStopped){
        rhythm = timeoutResult.state;
        if(cb.onWalkingStop){
          cb.onWalkingStop({ t: atTime, reason: "inactivity-timeout",
            adaptiveStepCount: adaptiveStepCount });
        }
      }

      // -- Einschwingphase: keine Kandidaten-Erzeugung --
      if(atTime - firstSampleT < cfg.warmupMs){
        exActive = false;
        return;
      }

      // -- Exkursions-/Lokalmaximum-Erkennung --
      // Feldtest-Korrektur (Details am peakReleaseRatio-Kommentar oben):
      // START zusaetzlich nur bei STEIGENDEM Signal (rising) -- die noch ueber
      // der Schwelle liegende, aber fallende Flanke eines soeben
      // abgeschlossenen Peaks darf keine zweite Exkursion desselben
      // physischen Schritts eroeffnen. ABSCHLUSS relativ zum LAUFENDEN
      // lokalen Maximum (exMax) statt zur eingefrorenen Startschwelle --
      // dadurch trennen sich aufeinanderfolgende Schritte, deren Taeler
      // deutlich einbrechen, ohne bis unter 50% der (niedrigen)
      // Startschwelle kollabieren zu muessen.
      if(!exActive){
        if(rising && smoothed >= threshold){
          exActive = true;
          exStartT = atTime;
          exMax = smoothed; exMaxT = atTime;
          exThresholdAtMax = threshold; exMeanAtMax = mean; exStdAtMax = std;
          exVertSum = Math.abs(vertComp); exLatSum = latComp;
          exRotSum = rotMag != null ? rotMag : 0;
          exRotCount = rotMag != null ? 1 : 0;
        }
        return;
      }
      // Richtungs-/Rotationsanteile ueber die GESAMTE Exkursion aufsummieren
      // (robuster als der Einzelwert am Maximum-Sample).
      exVertSum += Math.abs(vertComp);
      exLatSum += latComp;
      if(rotMag != null){ exRotSum += rotMag; exRotCount++; }
      if(smoothed > exMax){
        exMax = smoothed; exMaxT = atTime;
        exThresholdAtMax = threshold; exMeanAtMax = mean; exStdAtMax = std;
      }
      if(smoothed < exMax * cfg.peakReleaseRatio){
        var energySum = exVertSum + exLatSum;
        var candidate = { t: exMaxT, amplitude: exMax, threshold: exThresholdAtMax,
          mean: exMeanAtMax, std: exStdAtMax,
          // Diagnose: Dauer der gesamten Exkursion -- im Feldlog direkt
          // pruefbar, ob Exkursionen jetzt schrittkurz (<1s) sind statt der
          // frueheren 3-5s-Verschmelzungen.
          peakDurationMs: atTime - exStartT,
          // Richtungs-Diagnose (siehe Kommentar am Exkursions-Zustand):
          // Anteil (0..1) der vertikalen (schwerkraft-parallelen) Energie an
          // der Gesamtenergie der Exkursion -- Gehen erwartungsgemaess hoch,
          // Links-Rechts-Scannen niedrig. null bei degeneriertem
          // Schwerkraftvektor (nur synthetisch moeglich).
          verticalRatio: energySum > 0 ? exVertSum / energySum : null,
          // Mittlere |rotationRate| (deg/s) waehrend der Exkursion, null wenn
          // das Geraet keine Rotationsdaten liefert.
          rotationRateMean: exRotCount > 0 ? exRotSum / exRotCount : null };
        exActive = false;
        processCandidate(candidate);
      }
    },

    reset: function(){
      gravity = null;
      smoothed = null;
      windowSamples = [];
      firstSampleT = null;
      exActive = false;
      exStartT = 0; exMax = 0; exMaxT = 0;
      exThresholdAtMax = 0; exMeanAtMax = 0; exStdAtMax = 0;
      exVertSum = 0; exLatSum = 0; exRotSum = 0; exRotCount = 0;
      rhythm = createRhythmState();
      adaptiveStepCount = 0;
      peakCount = 0;
      scanStreak = 0;
      sampleCount = 0;
      lastSampleT = null;
      minSampleIntervalMs = null;
      maxSampleIntervalMs = null;
      reportedEventIntervalMs = null;
      lastMean = 0; lastStd = 0; lastThreshold = cfg.thresholdFloor;
    },

    isWalking: function(){ return rhythm.walking; },
    getAdaptiveStepCount: function(){ return adaptiveStepCount; },
    getPeakCount: function(){ return peakCount; },

    // Kompakte Pro-Lauf-Zusammenfassung (Abtastrate + Zaehler + letzte
    // Statistik) -- gedacht fuer GENAU EIN Log-Ereignis beim Kalibrierungs-
    // Stopp, statt Dauerprotokollierung einzelner Samples.
    getSummary: function(){
      var elapsed = (firstSampleT != null && lastSampleT != null) ? (lastSampleT - firstSampleT) : 0;
      return {
        sampleCount: sampleCount,
        avgSampleIntervalMs: sampleCount > 1 ? elapsed / (sampleCount - 1) : null,
        minSampleIntervalMs: minSampleIntervalMs,
        maxSampleIntervalMs: maxSampleIntervalMs,
        reportedEventIntervalMs: reportedEventIntervalMs,
        adaptiveStepCount: adaptiveStepCount,
        peakCount: peakCount,
        walking: rhythm.walking,
        lastThreshold: lastThreshold,
        lastMean: lastMean,
        lastStd: lastStd
      };
    }
  };
}
