// Minimal, dependency-free browser-global stubs so nav.js's module graph
// (dom.js/speech.js/logger.js/ui.js) can be imported under plain Node for
// automated testing, without a real browser or any npm package (jsdom etc.).
// Side-effect only: must be imported BEFORE any nav.js-dependent module, so
// its globals exist by the time those modules run their module-load-time
// document.getElementById()/window.addEventListener() calls.
//
// Only supports what nav.js's own dependency chain actually touches at
// import time or during the specific functions exercised by nav.test.js --
// not a general-purpose DOM shim.

export const spokenTexts = [];

// logger.js starts a real setInterval() at module-load time to periodically
// flush its buffer to localStorage. That's correct production behavior, but
// an un-unref'd interval keeps the Node process (and `node --test`) alive
// forever in a test run. Auto-unref any interval created from here on so the
// test process can exit normally -- doesn't change logger.js itself or what
// it does while the process is alive, only whether it blocks process exit.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = function(...args){
  const timer = realSetInterval(...args);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return timer;
};

function makeElement(){
  return {
    textContent: '',
    value: '',
    hidden: false,
    disabled: false,
    className: '',
    firstChild: { textContent: '' },
    classList: { add(){}, remove(){}, toggle(){} },
    addEventListener(){},
    appendChild(child){ return child; },
    getContext(){ return {}; },
  };
}

const elementIds = [
  'cam', 'view', 'room', 'meta', 'live', 'gate', 'err', 'errMsg', 'startBtn',
  'retryBtn', 'whereBtn', 'muteBtn', 'navStartBtn', 'navEndBtn', 'destSel',
  'uiDest', 'uiCur', 'uiNext', 'uiDist', 'navState', 'uiInstr', 'stepSource',
  'testNameInput', 'logCounter', 'logExportBtn', 'logClearBtn',
];

const elementsById = {};
for (const id of elementIds) elementsById[id] = makeElement();

globalThis.document = {
  getElementById(id){ return elementsById[id] || makeElement(); },
  createElement(){ return makeElement(); },
  addEventListener(){},
  body: { appendChild(){} },
};

// window === globalThis lets `"speechSynthesis" in window` and similar checks
// resolve against the very same speechSynthesis stub set below. Node's global
// object isn't an EventTarget, so logger.js's module-load-time
// window.addEventListener("pagehide", ...) needs a no-op stub too.
globalThis.window = globalThis;
if (typeof globalThis.addEventListener !== 'function') {
  globalThis.addEventListener = function(){};
}

// Node 21+ already defines a read-only global `navigator` getter; override it
// rather than plain-assign (which throws against a getter-only property).
Object.defineProperty(globalThis, 'navigator', {
  value: { vibrate(){} },
  configurable: true,
});

globalThis.localStorage = {
  getItem(){ return null; },
  setItem(){},
  removeItem(){},
};

globalThis.SpeechSynthesisUtterance = function(text){
  this.text = text;
  this.lang = null;
  this.voice = null;
  this.rate = 1;
  this.pitch = 1;
  this.volume = 1;
  this.onstart = null;
  this.onend = null;
  this.onerror = null;
};

globalThis.speechSynthesis = {
  speaking: false,
  pending: false,
  getVoices(){ return []; },
  onvoiceschanged: null,
  speak(utterance){
    spokenTexts.push(utterance.text);
    // Simulates an utterance that starts and completes instantly -- keeps
    // `speaking`/`pending` meaningfully false-after-completion (not merely
    // "always false regardless"), so finishEntry()/TTS_ENDED resolves and
    // nothing depends on a callback this stub never fires.
    if (typeof utterance.onstart === 'function') utterance.onstart();
    if (typeof utterance.onend === 'function') utterance.onend();
  },
  cancel(){},
};

// Opt-in, test-scoped override: while `run` executes, speak() starts an
// utterance but does NOT complete it immediately -- it stays "active/pending"
// (speech.js's isSpeechActive() sees it as not yet terminal) until the test
// explicitly calls the `completeSpeech()` function handed to `run`. Needed
// only for tests proving lifecycle-based behavior (a speech still in
// progress vs. one that has already ended) -- every other test keeps the
// default instant-completion stub above, restored here in `finally`.
export function withManualSpeechCompletion(run){
  var realSpeak = globalThis.speechSynthesis.speak;
  var pending = null;
  function completeSpeech(){
    if (!pending) return;
    var u = pending;
    pending = null;
    if (typeof u.onend === 'function') u.onend();
  }
  globalThis.speechSynthesis.speak = function(utterance){
    spokenTexts.push(utterance.text);
    if (typeof utterance.onstart === 'function') utterance.onstart();
    pending = utterance;
  };
  try {
    return run(completeSpeech);
  } finally {
    globalThis.speechSynthesis.speak = realSpeak;
  }
}
