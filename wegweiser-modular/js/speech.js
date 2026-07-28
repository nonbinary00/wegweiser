// ==================== Sprachausgabe / Sprachassistent ====================
// Verbatim aus wegweiser-v13.html (Abschnitt "---- Sprache ----").
// soundOn war dort bei den Laufzeit-Variablen deklariert (Zeile 2558) und wird
// nur im muteBtn-Handler umgeschaltet und hier in say() gelesen -> hierher
// verschoben (genehmigte Abhaengigkeitskarte, Entscheidung 3). toggleSound() ist
// neu: mechanischer Wrapper um genau die Original-Anweisung "soundOn = !soundOn;",
// damit der muteBtn-Handler (app.js) den Wert nicht direkt umschreiben muss.

import { liveEl } from './dom.js';

  var soundOn = true;
  var germanVoice = null;

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

  function say(text, opts){
    opts = opts || {};
    liveEl.textContent = ""; liveEl.textContent = text;
    if(!soundOn || !("speechSynthesis" in window)) return true;
    if(!opts.interrupt && (speechSynthesis.speaking || speechSynthesis.pending)) return false;
    try{
      if(opts.interrupt) speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.lang = "de-DE"; if(germanVoice) u.voice = germanVoice;
      u.rate = opts.slow ? 0.85 : 1.0; u.pitch = 1.0;
      speechSynthesis.speak(u);
      buzz(50);
    }catch(e){}
    return true;
  }
  function speaking(){
    return ("speechSynthesis" in window) && (speechSynthesis.speaking || speechSynthesis.pending);
  }

  function toggleSound(){
    soundOn = !soundOn;
    return soundOn;
  }

export { say, speaking, buzz, toggleSound, soundOn };
