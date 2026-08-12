// ==================== Experimenteller Schritt-Zaehler (Kalibrierungs-Baustein) ====================
// Isoliertes, optionales Modul: erkennt eine ungefaehre Anzahl Gehschritte aus
// Bewegungssensordaten. Kein maschinelles Lernen, keine externen Abhaengigkeiten --
// reine Signalverarbeitung (Schwellenwert + Mindestabstand + gleitender Mittelwert
// als Basislinie).
//
// Kennt NICHTS von AprilTags, Routen, Zielen, Graph-Traversierung oder Sprachtext --
// liefert ausschliesslich "ein Schritt wurde erkannt" (ueber einen Callback). Aktuell
// NUR fuer die manuelle Feldkalibrierung verdrahtet (siehe app.js) -- NOCH NICHT an
// die Tag 4 -> Tag 9-Route oder irgendeine Navigationsentscheidung angebunden.
//
// Architektur: die eigentliche Erkennungs-Mathematik (computeMagnitude/
// createStepDetectorState/processSample) ist bewusst als reine, zustandslos
// aufgerufene Funktionen exportiert -- vollstaendig mit synthetischen Werten testbar,
// ohne echte Sensor-Hardware oder DOM/window. createStepDetector() ist nur eine
// duenne Verdrahtungsschicht darueber (devicemotion-Listener), die dieselbe
// Kernlogik verwendet; sie akzeptiert injizierbare deps (window/now) fuer Tests.

// ---- Konfiguration (bewusst benannt/dokumentiert, keine unbenannten "magischen"
// Konstanten). Alle Werte sind konservative Startwerte und MUESSEN im echten
// Feldtest (reales Geraet, reale Gehbewegung) nachjustiert werden. ----
export var DEFAULT_STEP_DETECTOR_CONFIG = {
  // Abweichung (m/s^2) der Beschleunigungs-Magnitude von ihrer langsam
  // nachgefuehrten Basislinie, ab der ein Ausschlag als moeglicher Schritt
  // gilt. Echtes Gehen erzeugt deutlich groessere Ausschlaege als normales
  // Zittern der Hand -- dieser Wert ist aber NICHT geraete-/trageposition-
  // unabhaengig kalibriert und muss vor Ort gemessen werden.
  motionThreshold: 1.5,
  // Anteil von motionThreshold, unter den das (basislinien-relative) Signal
  // wieder zurueckfallen muss, bevor der naechste Schritt ueberhaupt wieder
  // gezaehlt werden KANN ("armed"). Ohne dieses Nachladen koennte ein
  // einzelner, laenger ueber der Schwelle verharrender Ausschlag durch
  // Rauschen mehrfach gezaehlt werden.
  releaseRatio: 0.5,
  // Mindestabstand (ms) zwischen zwei akzeptierten Schritten. Verhindert,
  // dass schnelles Haendezittern als mehrere Schritte gezaehlt wird. 250ms
  // erlaubt noch eine sehr schnelle Gehkadenz (~4 Schritte/s); normales Gehen
  // liegt eher bei 1,5-2,5 Schritten/s (400-650ms Abstand).
  minStepIntervalMs: 250,
  // Glaettungsfaktor (0-1) fuer den gleitenden Mittelwert (EMA), der als
  // Basislinie Schwerkraft + langsame Orientierungsaenderungen approximiert.
  // Klein = traege Basislinie, die Orientierungsdrift folgt, aber nicht auf
  // einzelne, viel schnellere Schritt-Ausschlaege reagiert.
  baselineAlpha: 0.05,
  // Kurzes Zeitfenster (ms) direkt nach start(), in dem Messwerte NUR zur
  // Basislinien-Einschwingung verwendet werden, aber KEINE Schritte gezaehlt
  // werden (siehe createStepDetector() unten). processSample() setzt die
  // Basislinie bei der allerersten Messung direkt auf deren Wert -- geht der
  // Nutzer sofort nach dem Start-Tastendruck los, wuerde die Basislinie sonst
  // auf einen bereits IN BEWEGUNG befindlichen Wert einschwingen und den
  // allerersten echten Schritt moeglicherweise unterzaehlen. Bei sehr kurzen
  // Zielsequenzen (2-3 Schritte) faellt genau das unverhaeltnismaessig stark
  // ins Gewicht. 400ms ist kurz/praktikabel (keine willkuerliche lange
  // Verzoegerung), aber lang genug fuer mehrere devicemotion-Ereignisse, in
  // denen sich die EMA-Basislinie bei ruhig gehaltenem Telefon einschwingt.
  warmupMs: 400,
  // NUR Kalibrierungs-Diagnostik, KEINE zweite Schritt-Schwelle: Untergrenze
  // (m/s^2 Abweichung von der Basislinie), ab der eine Bewegungs-Exkursion
  // als "bedeutsamer lokaler Peak" verfolgt und -- falls sie KEINEN
  // gezaehlten Schritt ausloest -- einmalig als Diagnose-Peak gemeldet wird
  // (siehe onPeak in createStepDetector()). Zweck: Feldtest-Beleg, ob
  // vorsichtige/schlurfende Schritte Ausschlaege im Bereich ~0,7-1,4
  // erzeugen, die an der aktuellen motionThreshold (1,5) scheitern.
  // 0,6 gewaehlt, weil (a) die kleinste im Feldtest interessierende
  // Kandidaten-Abweichung ~0,7 betraegt (die Untergrenze muss darunter
  // liegen, sonst waeren genau diese Peaks unsichtbar) und (b) reines
  // Halte-Zittern nach denselben Feldtest-Logs deutlich darunter bleibt --
  // bewusst NICHT tiefer (z.B. 0,3), um kein Rausch-Geflacker zu
  // protokollieren. Wird zusammen mit den Schritt-Schwellen erst nach
  // Auswertung der neuen Kalibrierungs-Logs nachjustiert.
  diagnosticPeakThreshold: 0.6
};

// Betrags-Magnitude des 3D-Beschleunigungsvektors -- rotationsunabhaengig
// (die Vektorlaenge aendert sich nicht durch Drehung des Telefons), daher
// ohne zusaetzliche Orientierungslogik weitgehend lageunabhaengig nutzbar.
export function computeMagnitude(x, y, z){
  return Math.sqrt(x * x + y * y + z * z);
}

export function createStepDetectorState(){
  return {
    baseline: 0,
    initialized: false,
    armed: true,
    lastStepAt: -Infinity
  };
}

// Reine Funktion: (bisheriger Zustand, neue Magnitude, Zeitstempel, Konfiguration)
// -> (neuer Zustand, wurde-ein-Schritt-erkannt, Ausschlag ueber Basislinie).
// Kein Zugriff auf window/DOM/Zeit-APIs -- vollstaendig mit synthetischen Werten
// testbar (siehe test/step-detector.test.js).
export function processSample(state, magnitude, now, config){
  var cfg = config || DEFAULT_STEP_DETECTOR_CONFIG;
  var next = {
    baseline: state.baseline,
    initialized: state.initialized,
    armed: state.armed,
    lastStepAt: state.lastStepAt
  };

  if(!next.initialized){
    // Erste Messung: Basislinie direkt auf den Startwert setzen (keine
    // Sprungantwort durch eine willkuerliche Anfangsbasislinie von 0).
    next.baseline = magnitude;
    next.initialized = true;
    return { state: next, stepDetected: false, deviation: 0 };
  }

  next.baseline = next.baseline + cfg.baselineAlpha * (magnitude - next.baseline);
  var deviation = magnitude - next.baseline;

  var stepDetected = false;
  if(next.armed && deviation >= cfg.motionThreshold){
    var sinceLast = now - next.lastStepAt;
    if(sinceLast >= cfg.minStepIntervalMs){
      stepDetected = true;
      next.lastStepAt = now;
    }
    // "armed" wird unabhaengig davon, ob dieser Ausschlag akzeptiert wurde,
    // deaktiviert -- verhindert wiederholtes Antriggern durch Rauschen nahe
    // der Schwelle, bis das Signal erst wieder unter releaseRatio faellt.
    next.armed = false;
  } else if(!next.armed && deviation < cfg.motionThreshold * cfg.releaseRatio){
    next.armed = true;
  }

  return { state: next, stepDetected: stepDetected, deviation: deviation };
}

export function isMotionApiSupported(win){
  var w = win || (typeof window !== "undefined" ? window : undefined);
  return !!(w && typeof w.DeviceMotionEvent !== "undefined");
}

// Muss aus einem direkten Nutzer-Gesten-Handler heraus aufgerufen werden (iOS
// 13+ Safari verlangt DeviceMotionEvent.requestPermission() synchron/nah an
// einem Tap, sonst schlaegt die Anfrage fehl). Aufloesung: "granted" |
// "denied" | "unsupported". Wirft nie eine Ablehnung -- ein Fehlschlag wird
// als "denied" behandelt, damit der Aufrufer nie selbst try/catch benoetigt.
export function requestMotionPermission(win){
  var w = win || (typeof window !== "undefined" ? window : undefined);
  if(!isMotionApiSupported(w)) return Promise.resolve("unsupported");
  var DME = w.DeviceMotionEvent;
  if(typeof DME.requestPermission === "function"){
    return DME.requestPermission().then(function(state){
      return state === "granted" ? "granted" : "denied";
    }).catch(function(){ return "denied"; });
  }
  // Browser ohne explizite Berechtigungsanfrage (nicht-iOS): devicemotion
  // liefert Ereignisse ohne vorherige Nutzerfreigabe.
  return Promise.resolve("granted");
}

// Duenne Verdrahtungsschicht ueber processSample()/computeMagnitude(): meldet
// erkannte Schritte ueber einen Callback, kennt sonst nichts weiter. deps
// erlaubt das Einspeisen von Test-Doubles (window/now) ohne echte Hardware.
export function createStepDetector(config, deps){
  var cfg = Object.assign({}, DEFAULT_STEP_DETECTOR_CONFIG, config || {});
  var d = deps || {};
  var win = d.window || (typeof window !== "undefined" ? window : undefined);
  var now = d.now || function(){
    return (typeof performance !== "undefined") ? performance.now() : Date.now();
  };
  var setTimeoutFn = d.setTimeout || (typeof setTimeout !== "undefined" ? setTimeout : null);
  var clearTimeoutFn = d.clearTimeout || (typeof clearTimeout !== "undefined" ? clearTimeout : null);

  var state = createStepDetectorState();
  var stepCount = 0;
  var listening = false;
  var onStepCb = null;
  var startedAt = null;
  var warmupTimer = null;

  // ---- Diagnose-Peak-Zustand (NUR Kalibrierung, siehe diagnosticPeakThreshold
  // oben). Getrennt vom armed/release-Zustand in processSample(): der dortige
  // Zustand gehoert zur SCHRITT-Erkennung (Schwelle 1,5) und darf fuer die
  // Diagnose (Untergrenze 0,6) weder mitbenutzt noch veraendert werden --
  // kleinster eigener Zustand statt Umbau der reinen Kernfunktion. ----
  var onPeakCb = null;
  var peakActive = false;          // Exkursion >= diagnosticPeakThreshold laeuft
  var peakMaxDeviation = 0;        // groesster Ausschlag DIESER Exkursion
  var peakProducedStep = false;    // Exkursion hat bereits STEP_DETECTED erzeugt

  function resetPeakState(){
    peakActive = false;
    peakMaxDeviation = 0;
    peakProducedStep = false;
  }

  function inWarmup(atTime){
    return startedAt != null && (atTime - startedAt) < cfg.warmupMs;
  }

  // Ein Diagnose-Peak = EINE zusammenhaengende Exkursion der Abweichung ueber
  // diagnosticPeakThreshold: steigt -> lokales Maximum wird mitgefuehrt ->
  // faellt wieder unter die Ausloese-Untergrenze * releaseRatio (dieselbe
  // Hysterese-Idee wie beim armed/release der Schritt-Erkennung, gegen
  // Geflacker um die Untergrenze) -> GENAU EIN Ereignis. Eine Exkursion, die
  // einen gezaehlten Schritt erzeugt hat, wird NICHT zusaetzlich gemeldet
  // (STEP_DETECTED traegt die Information bereits); eine Exkursion, die die
  // Schritt-Schwelle zwar erreichte, aber verworfen wurde (Mindestabstand/
  // Warm-up), WIRD gemeldet, mit crossedStepThreshold:true -- genau diese
  // Faelle sind Kalibrierungs-Beleg. Waehrend des Warm-ups wird nichts
  // verfolgt (Basislinie noch nicht eingeschwungen, Werte unzuverlaessig).
  function trackDiagnosticPeak(deviation, stepAccepted, atTime){
    if(!onPeakCb) return;
    if(inWarmup(atTime)){ resetPeakState(); return; }
    if(!peakActive){
      if(deviation >= cfg.diagnosticPeakThreshold){
        peakActive = true;
        peakMaxDeviation = deviation;
        peakProducedStep = stepAccepted;
      }
      return;
    }
    if(deviation > peakMaxDeviation) peakMaxDeviation = deviation;
    if(stepAccepted) peakProducedStep = true;
    if(deviation < cfg.diagnosticPeakThreshold * cfg.releaseRatio){
      var finished = {
        deviation: peakMaxDeviation,
        crossedStepThreshold: peakMaxDeviation >= cfg.motionThreshold,
        motionThreshold: cfg.motionThreshold,
        diagnosticPeakThreshold: cfg.diagnosticPeakThreshold
      };
      var suppressed = peakProducedStep;
      resetPeakState();
      if(!suppressed) onPeakCb(finished);
    }
  }

  function acceptMagnitude(magnitude, atTime){
    var result = processSample(state, magnitude, atTime, cfg);
    state = result.state;
    // Waehrend des Einschwingfensters (siehe warmupMs oben) laeuft
    // processSample() ganz normal weiter (die Basislinie MUSS sich
    // einschwingen), aber ein erkannter Ausschlag wird bewusst NICHT
    // gezaehlt und NICHT an den Aufrufer gemeldet.
    var accepted = result.stepDetected && !inWarmup(atTime);
    if(accepted){
      stepCount++;
      if(onStepCb) onStepCb(stepCount, result.deviation);
    }
    trackDiagnosticPeak(result.deviation, accepted, atTime);
    return accepted;
  }

  function handleEvent(event){
    // accelerationIncludingGravity ist auf mehr Geraeten/Browsern zuverlaessig
    // gefuellt als das gravitationsfreie acceleration (das auf manchen
    // Android-Geraeten ohne eigenen Gyroskop-Sensor durchgehend null liefert).
    // Der langsame EMA-Basislinienabzug in processSample() entfernt den
    // (weitgehend konstanten) Schwerkraftanteil wieder.
    var a = event.accelerationIncludingGravity;
    if(!a || a.x == null || a.y == null || a.z == null) return; // unbrauchbare Messung: ignorieren, NICHT als Schritt werten
    acceptMagnitude(computeMagnitude(a.x, a.y, a.z), now());
  }

  function clearWarmupTimer(){
    if(warmupTimer != null && clearTimeoutFn){ clearTimeoutFn(warmupTimer); }
    warmupTimer = null;
  }

  return {
    isAvailable: function(){ return isMotionApiSupported(win); },
    // onStep(stepCount, deviation) fires per accepted step (after warm-up).
    // onReady() fires once, after warmupMs has elapsed, signalling that
    // walking may now begin -- optional, purely informational.
    // onPeak({deviation, crossedStepThreshold, motionThreshold,
    // diagnosticPeakThreshold}) -- optional, NUR Kalibrierungs-Diagnostik:
    // fires once per finished sub-threshold motion excursion (see
    // trackDiagnosticPeak() above). Without this callback, no diagnostic
    // state is ever emitted -- normal use stays diagnostics-free.
    start: function(onStep, onReady, onPeak){
      if(listening) return true;
      if(!isMotionApiSupported(win)) return false;
      onStepCb = onStep || null;
      onPeakCb = onPeak || null;
      resetPeakState();
      startedAt = now();
      win.addEventListener("devicemotion", handleEvent);
      listening = true;
      if(onReady){
        if(cfg.warmupMs > 0 && setTimeoutFn){
          warmupTimer = setTimeoutFn(onReady, cfg.warmupMs);
        } else {
          onReady();
        }
      }
      return true;
    },
    stop: function(){
      if(listening && win) win.removeEventListener("devicemotion", handleEvent);
      listening = false;
      startedAt = null;
      clearWarmupTimer();
      // Eine beim Stopp noch offene (nicht abgeklungene) Exkursion wird
      // verworfen, nicht nachtraeglich gemeldet -- ein Ereignis beschreibt
      // immer nur eine VOLLSTAENDIG beobachtete Exkursion. Praktisch kein
      // Datenverlust: vor dem Stopp-Tastendruck steht der Nutzer ohnehin
      // still, wodurch die letzte Exkursion natuerlich abklingt und meldet.
      resetPeakState();
    },
    reset: function(){
      stepCount = 0;
      state = createStepDetectorState();
      resetPeakState();
    },
    getStepCount: function(){ return stepCount; },
    isListening: function(){ return listening; },
    isWarmingUp: function(){ return listening && inWarmup(now()); },
    // Test-/Injektions-Nahtstelle: speist denselben processSample()-Pfad wie
    // der echte devicemotion-Handler oben, ohne ein echtes Ereignis zu
    // benoetigen -- fuer Integrationstests des gesamten Detektor-Objekts
    // (zusaetzlich zu den reinen Funktionstests von processSample() selbst).
    feedSample: function(x, y, z, atTime){
      return acceptMagnitude(computeMagnitude(x, y, z), atTime != null ? atTime : now());
    }
  };
}
