// ==================== Sprachausgabe / Sprachassistent ====================
// Verbatim aus wegweiser-v13.html (Abschnitt "---- Sprache ----").
// soundOn war dort bei den Laufzeit-Variablen deklariert (Zeile 2558) und wird
// nur im muteBtn-Handler umgeschaltet und hier in say() gelesen -> hierher
// verschoben (genehmigte Abhaengigkeitskarte, Entscheidung 3). toggleSound() ist
// neu: mechanischer Wrapper um genau die Original-Anweisung "soundOn = !soundOn;",
// damit der muteBtn-Handler (app.js) den Wert nicht direkt umschreiben muss.
//
// ---- TTS-Observability (neu, Phase 1 der Audit-Nachbereitung) ----
// say() bekommt hier eine vollstaendige Lebenszyklus-Instrumentierung (TTS_REQUESTED/
// TTS_STARTED/TTS_ENDED/TTS_CANCELLED/TTS_SUPPRESSED/TTS_FAILED) UND einen expliziten
// Rueckgabewert (Objekt statt Bool), der "angenommen"/"unterdrueckt (stumm)"/
// "abgelehnt (beschaeftigt)"/"fehlgeschlagen" unterscheidet — der alte Rueckgabewert
// (true fuer "stumm ODER erfolgreich ODER Exception", false fuer "beschaeftigt") war
// nicht mehr eindeutig genug, um z.B. die Richtungs-Dedup-Logik in nav.js korrekt nur
// bei TATSAECHLICHER Annahme zu aktualisieren (Audit-Befund F-1/F-3). KEINE Aenderung
// an WELCHER Text gesprochen wird, WANN interrupt gesetzt wird (ausser den beiden
// explizit angeforderten Korrekturen in nav.js) oder WIE die Browser-API aufgerufen
// wird — nur zusaetzliche Beobachtbarkeit um denselben Kernaufruf herum.
// record() (logger.js) ist unabhaengig von nav.js/routeRunId — die aufrufende Stelle
// liefert state/expectedTag/routeRunId optional über opts, speech.js kennt deren
// Bedeutung nicht (kein Zirkelbezug zu nav.js nötig).

import { liveEl } from './dom.js';
import { record } from './logger.js';

  var soundOn = true;
  var germanVoice = null;
  var speechSeq = 0;
  var activeEntry = null;   // zuletzt tatsaechlich an die Browser-API uebergebene Anfrage

  // ---- iOS-Sprachausgabe-Freischaltung (neu, TTS-Startup-Fix) ----
  // Feldtest-Befund: auf iOS Safari nimmt speechSynthesis.speak() eine Anfrage OHNE
  // Fehler an (kein Exception, kein onerror), feuert aber NIEMALS ein 'start'-Ereignis,
  // wenn der ALLERERSTE speak()-Aufruf einer Seiten-Session nicht SYNCHRON innerhalb
  // einer echten Nutzer-Geste (Klick/Touch) erfolgte -- ein await/eine Promise-
  // Fortsetzung oder ein requestAnimationFrame-Callback zaehlt dafuer NICHT, selbst
  // wenn die urspruengliche Funktion aus einem Klick-Handler heraus aufgerufen wurde
  // (genau das betraf camera.readyFirstTime, aufgerufen NACH "await getUserMedia()"
  // in camera.js, sowie nav.startTagEntrance, aufgerufen aus main-loop.js/tick()
  // heraus -- beide TTS_REQUESTED ohne TTS_STARTED im Log). unlockSpeech() spricht
  // EINMALIG eine unhoerbare (volume:0) Utterance SYNCHRON im allerersten echten
  // Klick-Handler (Gate-Tap "Kamera starten", siehe app.js) -- das entsperrt die
  // Engine erfahrungsgemaess fuer den Rest der Sitzung, auch fuer spaetere,
  // asynchron ausgeloeste Ansagen. Laeuft ABSICHTLICH NICHT durch say() (keine
  // TTS_REQUESTED/TTS_STARTED/TTS_ENDED-Ereignisse fuer eine Nicht-Ansage, sondern
  // eigene, dediziert benannte TTS_UNLOCK_*-Ereignisse), damit das Sprach-Log
  // ausschliesslich TATSAECHLICH gesprochene Inhalte als TTS_REQUESTED/STARTED/ENDED
  // zeigt. Ruft bewusst KEIN speechSynthesis.cancel() auf und fasst activeEntry
  // NICHT an -- kann daher nie eine echte Ansage stornieren oder verdraengen
  // (Sicherheitsreview: kein genereller Wachhund/Retry mehr, siehe say() unten,
  // das unveraendert der urspruenglichen Implementierung entspricht).
  var unlockAttempted = false;

  function unlockSpeech(){
    if(unlockAttempted) return;
    unlockAttempted = true;
    if(!("speechSynthesis" in window)) return;
    try{
      record("TTS_UNLOCK_REQUESTED", { requestedAt: performance.now() });
      var u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      u.lang = "de-DE";
      u.onstart = function(){ record("TTS_UNLOCK_COMPLETED", { startedAt: performance.now() }); };
      u.onerror = function(e){
        record("TTS_UNLOCK_FAILED", { error: (e && e.error) || "error" });
      };
      speechSynthesis.speak(u);
    }catch(e){
      record("TTS_UNLOCK_FAILED", { error: (e && e.message) || String(e) });
    }
  }

  // ---- Sprache ----
  function pickVoice(){
    if(!("speechSynthesis" in window)) return;
    var vs = speechSynthesis.getVoices() || [];
    germanVoice = vs.find(function(v){ return /de(-|_|$)/i.test(v.lang); })
              || vs.find(function(v){ return /deutsch|german/i.test(v.name); })
              || null;
  }
  if("speechSynthesis" in window){
    pickVoice();
    speechSynthesis.onvoiceschanged = pickVoice;
  }
  function buzz(ms){ if(navigator.vibrate){ try{ navigator.vibrate(ms); }catch(e){} } }

  function nextSpeechId(){
    speechSeq++;
    return "sp" + speechSeq;
  }

  function withBase(base, extra){
    var d = {};
    for(var k in base) d[k] = base[k];
    if(extra) for(var k2 in extra) d[k2] = extra[k2];
    return d;
  }

  // Beendet `entry` (falls noch nicht bereits beendet) mit genau EINEM Terminal-Ereignis
  // (TTS_ENDED/TTS_CANCELLED/TTS_FAILED). `entry.terminalLogged` ist PRO ANFRAGE (nicht
  // global) gesetzt, damit ein verspaetet feuerndes Callback einer bereits ersetzten/
  // stornierten Anfrage NIEMALS den Zustand einer neueren Anfrage ueberschreiben kann
  // (Anforderung: "Do not allow callbacks from an old utterance to overwrite the state
  // of a newer utterance").
  function finishEntry(entry, event, extra){
    if(!entry || entry.terminalLogged) return;
    entry.terminalLogged = true;
    record(event, withBase(entry.base, extra));
  }

  function say(text, opts){
    opts = opts || {};
    var speechId = nextSpeechId();
    var requestedAt = performance.now();
    // neu (VoiceOver-Fix, Ziel 1-3): #live ist ein aria-live="assertive"-Element und
    // wird daher von VoiceOver UNABHAENGIG von speechSynthesis vorgelesen — jede
    // bisherige, unbedingte Zuweisung hier hat JEDEN gesprochenen Satz doppelt
    // angekuendigt (einmal ueber VoiceOver, einmal ueber speechSynthesis). Ab jetzt
    // wird #live NUR noch aktualisiert, wenn die Aufrufstelle das ausdruecklich per
    // opts.announceToVoiceOver anfordert (bisher nur camera.js fuer Barrierefreiheits-
    // Fehler) — Navigations-Ansagen (nav.js) fordern dies nicht an und erreichen
    // VoiceOver damit nicht mehr doppelt.
    if(opts.announceToVoiceOver){
      liveEl.textContent = ""; liveEl.textContent = text;
    }

    var base = {
      speechId: speechId,
      text: text,
      source: opts.source || null,
      category: opts.category || null,
      interrupt: !!opts.interrupt,
      state: (opts.state !== undefined) ? opts.state : null,
      expectedTag: (opts.expectedTag !== undefined) ? opts.expectedTag : null,
      routeRunId: (opts.routeRunId !== undefined) ? opts.routeRunId : null
    };
    record("TTS_REQUESTED", withBase(base, { requestedAt: requestedAt }));

    function suppress(reason){
      record("TTS_SUPPRESSED", withBase(base, { suppressionReason: reason }));
      return { speechId: speechId, accepted: false, spoken: false, failed: false,
               suppressionReason: reason, error: null };
    }

    if(!soundOn) return suppress("muted");
    if(!("speechSynthesis" in window)) return suppress("unsupported");
    if(!opts.interrupt && (speechSynthesis.speaking || speechSynthesis.pending)) return suppress("busy");

    var entry = { base: base, terminalLogged: false };
    try{
      if(opts.interrupt){
        // Verdraengt eine noch laufende/anstehende Anfrage: SOFORT als storniert
        // protokollieren, BEVOR cancel() aufgerufen wird — verlaesst sich NICHT darauf,
        // dass der Browser onerror/onend fuer die alte Utterance zuverlaessig (oder
        // ueberhaupt) feuert (bekannte Web-Speech-API-Inkonsistenz zwischen Browsern).
        finishEntry(activeEntry, "TTS_CANCELLED", { endedAt: performance.now() });
        speechSynthesis.cancel();
      }
      var u = new SpeechSynthesisUtterance(text);
      u.lang = "de-DE"; if(germanVoice) u.voice = germanVoice;
      u.rate = opts.slow ? 0.85 : 1.0; u.pitch = 1.0;

      activeEntry = entry;

      u.onstart = function(){
        if(activeEntry !== entry) return;   // veraltetes Callback einer verdraengten Anfrage
        record("TTS_STARTED", withBase(base, { startedAt: performance.now() }));
      };
      u.onend = function(){
        finishEntry(entry, "TTS_ENDED", { endedAt: performance.now() });
      };
      u.onerror = function(e){
        var reason = (e && e.error) || "error";
        if(reason === "canceled" || reason === "interrupted"){
          finishEntry(entry, "TTS_CANCELLED", { endedAt: performance.now(), error: reason });
        } else {
          finishEntry(entry, "TTS_FAILED", { endedAt: performance.now(), error: reason });
        }
      };

      speechSynthesis.speak(u);
      buzz(50);
      return { speechId: speechId, accepted: true, spoken: true, failed: false,
               suppressionReason: null, error: null };
    }catch(e){
      entry.terminalLogged = true;   // verhindert ein spaeteres Terminal-Ereignis fuer
                                      // dieselbe (nie wirklich gestarteten) Anfrage
      var msg = (e && e.message) || String(e);
      record("TTS_FAILED", withBase(base, { error: msg }));
      return { speechId: speechId, accepted: false, spoken: false, failed: true,
               suppressionReason: null, error: msg };
    }
  }

  // Fuer Aufrufstellen, die frueher DIREKT speechSynthesis.cancel() aufgerufen haben
  // (z.B. muteBtn) — stellt sicher, dass die dadurch verdraengte Anfrage korrekt als
  // TTS_CANCELLED protokolliert wird, statt spurlos zu verschwinden.
  function cancelSpeech(source){
    finishEntry(activeEntry, "TTS_CANCELLED", { endedAt: performance.now(), cancelSource: source || null });
    if("speechSynthesis" in window) speechSynthesis.cancel();
  }

  function speaking(){
    return ("speechSynthesis" in window) && (speechSynthesis.speaking || speechSynthesis.pending);
  }

  function toggleSound(){
    soundOn = !soundOn;
    return soundOn;
  }

export { say, speaking, buzz, toggleSound, soundOn, cancelSpeech, unlockSpeech };
