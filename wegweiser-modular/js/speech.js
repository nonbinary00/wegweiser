// ==================== Sprachausgabe / Sprachassistent ====================
// soundOn lives here because it is only toggled by the muteBtn handler and read here
// in say(); toggleSound() is a mechanical wrapper around that flag so the muteBtn
// handler (app.js) does not need to reassign the exported binding directly.
//
// ---- TTS-Observability ----
// say() logs its full lifecycle (TTS_REQUESTED/STARTED/ENDED/CANCELLED/SUPPRESSED/
// FAILED) and returns an object, not a bool, distinguishing accepted/suppressed
// (muted)/rejected (busy)/failed -- callers such as nav.js's direction-dedup logic
// need that distinction to update their own state only on true acceptance. This adds
// observability only; it changes nothing about which text is spoken, when interrupt
// is set, or how the browser API is called.
// record() (logger.js) is independent of nav.js/routeRunId -- callers optionally pass
// state/expectedTag/routeRunId via opts; speech.js does not need to import nav.js.

import { liveEl } from './dom.js';
import { record } from './logger.js';

  var soundOn = true;
  var germanVoice = null;
  var speechSeq = 0;
  var activeEntry = null;   // zuletzt tatsaechlich an die Browser-API uebergebene Anfrage

  // ---- iOS speech-unlock ----
  // On iOS Safari, speechSynthesis.speak() accepts a request without error but never
  // fires a 'start' event unless the very first speak() call of a page session runs
  // synchronously inside a real user gesture (click/touch) -- an await, a promise
  // continuation, or a requestAnimationFrame callback does not count, even if the
  // enclosing function was originally invoked from a click handler (this affected
  // camera.readyFirstTime, called after "await getUserMedia()", and
  // nav.startTagEntrance, called from main-loop.js/tick()). unlockSpeech() speaks a
  // single inaudible (volume:0) utterance synchronously inside the very first real
  // click handler (the gate tap "Kamera starten", see app.js), which reliably unlocks
  // the engine for the rest of the session, including later async announcements. It
  // bypasses say() on purpose -- using its own TTS_UNLOCK_* events instead of
  // TTS_REQUESTED/STARTED/ENDED -- so the speech log only shows actually-spoken
  // content, and it never calls speechSynthesis.cancel() or touches activeEntry, so
  // it can never cancel or preempt a real announcement.
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

  // Ends `entry` (if not already ended) with exactly one terminal event
  // (TTS_ENDED/TTS_CANCELLED/TTS_FAILED). `entry.terminalLogged` is tracked per
  // request (not globally), so that a late-firing callback from an already
  // superseded/cancelled request can never overwrite the state of a newer request.
  function finishEntry(entry, event, extra){
    if(!entry || entry.terminalLogged) return;
    entry.terminalLogged = true;
    record(event, withBase(entry.base, extra));
  }

  function say(text, opts){
    opts = opts || {};
    var speechId = nextSpeechId();
    var requestedAt = performance.now();
    // #live is an aria-live="assertive" element and is therefore read by VoiceOver
    // independently of speechSynthesis. Updating it unconditionally would announce
    // every spoken sentence twice (once via VoiceOver, once via speechSynthesis).
    // #live is only updated when the caller explicitly requests it via
    // opts.announceToVoiceOver (currently only camera.js, for accessibility-critical
    // errors) -- navigation announcements (nav.js) do not request this and therefore
    // reach VoiceOver only once.
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

  // Use instead of calling speechSynthesis.cancel() directly (e.g. from muteBtn) --
  // ensures the preempted request is logged correctly as TTS_CANCELLED instead of
  // silently disappearing.
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
