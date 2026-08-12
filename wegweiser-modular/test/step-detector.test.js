// Behavioral tests for the standalone, hardware-free step-detection module
// (js/step-detector.js). Uses only node:test / node:assert/strict -- no real
// DeviceMotion events, no npm packages. The pure math (computeMagnitude/
// createStepDetectorState/processSample) is tested directly with synthetic
// values; createStepDetector() is tested via its feedSample() seam and via
// injected window/now/setTimeout/clearTimeout test doubles.
//
// Does not test AprilTag detection, routing, TTS, or REACHED logic -- this
// module knows nothing about any of that (see step-detector.js header).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_STEP_DETECTOR_CONFIG,
  computeMagnitude,
  createStepDetectorState,
  processSample,
  isMotionApiSupported,
  requestMotionPermission,
  createStepDetector,
} from '../js/step-detector.js';

// Minimal fake `window` with a real-enough DeviceMotionEvent presence and a
// working addEventListener/removeEventListener pair -- lets start()/stop()
// take their real code path (including isMotionApiSupported() succeeding)
// without any actual browser. Node has no global `window`, so any test that
// needs start() to actually begin listening (not just no-op unavailable)
// must inject one of these.
function makeFakeWindow(){
  const listeners = {};
  return {
    DeviceMotionEvent: function(){},
    addEventListener(type, cb){
      listeners[type] = listeners[type] || [];
      listeners[type].push(cb);
    },
    removeEventListener(type, cb){
      if(!listeners[type]) return;
      const idx = listeners[type].indexOf(cb);
      if(idx >= 0) listeners[type].splice(idx, 1);
    },
    _listenerCount(type){
      return (listeners[type] || []).length;
    },
  };
}

// ==================== 1. Magnitude calculation ====================

test('computeMagnitude: 3-4-0 right triangle resolves to exactly 5', () => {
  assert.equal(computeMagnitude(3, 4, 0), 5);
});

test('computeMagnitude: all zeros is zero', () => {
  assert.equal(computeMagnitude(0, 0, 0), 0);
});

test('computeMagnitude: rotation-independent -- same length regardless of which axis carries it', () => {
  assert.equal(computeMagnitude(9.8, 0, 0), computeMagnitude(0, 9.8, 0));
  assert.equal(computeMagnitude(0, 9.8, 0), computeMagnitude(0, 0, 9.8));
});

test('computeMagnitude: negative components contribute their absolute magnitude (squared)', () => {
  assert.equal(computeMagnitude(-3, -4, 0), 5);
});

// ==================== 2. Detector initialization ====================

test('createStepDetectorState returns the documented fresh defaults', () => {
  const state = createStepDetectorState();
  assert.equal(state.baseline, 0);
  assert.equal(state.initialized, false);
  assert.equal(state.armed, true);
  assert.equal(state.lastStepAt, -Infinity);
});

test('processSample: the very first sample only initializes the baseline, never a step', () => {
  const state = createStepDetectorState();
  const result = processSample(state, 9.8, 0, DEFAULT_STEP_DETECTOR_CONFIG);
  assert.equal(result.stepDetected, false);
  assert.equal(result.state.initialized, true);
  assert.equal(result.state.baseline, 9.8);
});

// ==================== 3-5. Synthetic step sequences ====================
// A "step" is simulated as: resting magnitude (~9.8, gravity only) -> a sharp
// peak (baseline + motionThreshold + margin) -> back to resting, each pair
// spaced comfortably beyond minStepIntervalMs.

function walk(nSteps, cfg){
  const config = cfg || DEFAULT_STEP_DETECTOR_CONFIG;
  let state = createStepDetectorState();
  let t = 0;
  let stepsDetected = 0;
  // Establish the baseline at rest first.
  state = processSample(state, 9.8, t, config).state;
  for(let i = 0; i < nSteps; i++){
    t += config.minStepIntervalMs + 100; // comfortably beyond the interval floor
    const peak = processSample(state, 9.8 + config.motionThreshold + 1, t, config);
    state = peak.state;
    if(peak.stepDetected) stepsDetected++;
    t += 50;
    const rest = processSample(state, 9.8, t, config); // drop back below release threshold
    state = rest.state;
  }
  return stepsDetected;
}

test('one synthetic step is detected exactly once', () => {
  assert.equal(walk(1), 1);
});

test('two synthetic steps are detected exactly twice', () => {
  assert.equal(walk(2), 2);
});

test('three synthetic steps are detected exactly three times (the priority case for Tag 4 -> Tag 9)', () => {
  assert.equal(walk(3), 3);
});

// ==================== 6. Minimum interval rejection ====================

test('a second peak arriving before minStepIntervalMs is rejected even if re-armed', () => {
  const cfg = DEFAULT_STEP_DETECTOR_CONFIG;
  let state = createStepDetectorState();
  state = processSample(state, 9.8, 0, cfg).state; // init baseline

  const first = processSample(state, 9.8 + cfg.motionThreshold + 1, 10, cfg);
  assert.equal(first.stepDetected, true, 'first peak must be accepted');
  state = first.state;

  // Drop back below the release threshold (re-arms), but stay WITHIN
  // minStepIntervalMs of the first accepted step.
  const released = processSample(state, 9.8, 20, cfg);
  state = released.state;

  const tooSoon = processSample(state, 9.8 + cfg.motionThreshold + 1, 20 + cfg.minStepIntervalMs / 2, cfg);
  assert.equal(tooSoon.stepDetected, false, 'a peak inside the minimum interval must be rejected');
});

// ==================== 7. Armed/release behavior ====================

test('a single sustained peak (never releasing) counts as only one step', () => {
  const cfg = DEFAULT_STEP_DETECTOR_CONFIG;
  let state = createStepDetectorState();
  state = processSample(state, 9.8, 0, cfg).state;

  let detected = 0;
  let t = 0;
  for(let i = 0; i < 10; i++){
    t += 30;
    const result = processSample(state, 9.8 + cfg.motionThreshold + 1, t, cfg);
    state = result.state;
    if(result.stepDetected) detected++;
  }
  assert.equal(detected, 1, 'a signal that never drops back below the release threshold must not be re-counted');
});

test('after releasing below releaseRatio and waiting past minStepIntervalMs, a genuine second peak is counted', () => {
  const cfg = DEFAULT_STEP_DETECTOR_CONFIG;
  let state = createStepDetectorState();
  state = processSample(state, 9.8, 0, cfg).state;

  const first = processSample(state, 9.8 + cfg.motionThreshold + 1, 10, cfg);
  state = first.state;
  assert.equal(first.stepDetected, true);

  const released = processSample(state, 9.8, 20, cfg); // well below releaseRatio * threshold
  state = released.state;

  const second = processSample(state, 9.8 + cfg.motionThreshold + 1, 20 + cfg.minStepIntervalMs + 50, cfg);
  assert.equal(second.stepDetected, true, 'a genuinely separate second peak, released and spaced out, must be counted');
});

// ==================== createStepDetector() wrapper (feedSample seam) ====================

test('createStepDetector via feedSample: counts three well-separated synthetic steps', () => {
  // warmupMs disabled here -- this test is about counting logic, not
  // warm-up interaction (covered separately below).
  const detector = createStepDetector({ warmupMs: 0 }, { window: makeFakeWindow(), now: () => 0 });
  const steps = [];
  detector.start((count, deviation) => steps.push({ count, deviation }));
  const cfg = DEFAULT_STEP_DETECTOR_CONFIG;

  detector.feedSample(0, 0, 9.8, 0); // baseline init
  let t = 0;
  for(let i = 0; i < 3; i++){
    t += cfg.minStepIntervalMs + 100;
    detector.feedSample(0, 0, 9.8 + cfg.motionThreshold + 1, t);
    t += 50;
    detector.feedSample(0, 0, 9.8, t);
  }

  assert.equal(detector.getStepCount(), 3);
  assert.equal(steps.length, 3);
  assert.deepEqual(steps.map((s) => s.count), [1, 2, 3]);
});

// ==================== 8. Reset behavior ====================

test('reset() clears the step count and re-arms fresh initialization', () => {
  const detector = createStepDetector({ warmupMs: 0 }, { window: makeFakeWindow(), now: () => 0 });
  detector.start();
  const cfg = DEFAULT_STEP_DETECTOR_CONFIG;

  detector.feedSample(0, 0, 9.8, 0);
  detector.feedSample(0, 0, 9.8 + cfg.motionThreshold + 1, cfg.minStepIntervalMs + 100);
  assert.equal(detector.getStepCount(), 1);

  detector.reset();
  assert.equal(detector.getStepCount(), 0);

  // Immediately after reset, the internal state is uninitialized again --
  // even a spike-valued first sample must only initialize the baseline, not
  // register as a step (mirrors "detector initialization" behavior above).
  const stillZero = detector.feedSample(0, 0, 9.8 + cfg.motionThreshold + 1, 0);
  assert.equal(stillZero, false);
  assert.equal(detector.getStepCount(), 0);
});

// ==================== 9. stop() removes the listener ====================

test('start() registers exactly one devicemotion listener; stop() removes it', () => {
  const fakeWindow = makeFakeWindow();
  const detector = createStepDetector({}, { window: fakeWindow, now: () => 0 });

  assert.equal(fakeWindow._listenerCount('devicemotion'), 0);
  const started = detector.start();
  assert.equal(started, true);
  assert.equal(detector.isListening(), true);
  assert.equal(fakeWindow._listenerCount('devicemotion'), 1);

  detector.stop();
  assert.equal(detector.isListening(), false);
  assert.equal(fakeWindow._listenerCount('devicemotion'), 0);
});

test('start() is idempotent -- calling it twice while already listening does not add a second listener', () => {
  const fakeWindow = makeFakeWindow();
  const detector = createStepDetector({}, { window: fakeWindow, now: () => 0 });
  detector.start();
  detector.start();
  assert.equal(fakeWindow._listenerCount('devicemotion'), 1);
});

// ==================== 10. Unsupported sensor behavior ====================

test('isMotionApiSupported: false when window has no DeviceMotionEvent', () => {
  assert.equal(isMotionApiSupported({}), false);
});

test('isMotionApiSupported: true when window declares DeviceMotionEvent', () => {
  assert.equal(isMotionApiSupported({ DeviceMotionEvent: function(){} }), true);
});

test('createStepDetector: start() returns false (not a crash) when the API is unavailable', () => {
  const detector = createStepDetector({}, { window: {}, now: () => 0 });
  assert.equal(detector.isAvailable(), false);
  const started = detector.start();
  assert.equal(started, false);
  assert.equal(detector.isListening(), false);
});

// ==================== 11. Permission denial behavior ====================

test('requestMotionPermission: resolves "unsupported" when DeviceMotionEvent does not exist', async () => {
  const state = await requestMotionPermission({});
  assert.equal(state, 'unsupported');
});

test('requestMotionPermission: resolves "granted" on non-iOS (no requestPermission method)', async () => {
  const state = await requestMotionPermission({ DeviceMotionEvent: function(){} });
  assert.equal(state, 'granted');
});

test('requestMotionPermission: resolves "granted" when DeviceMotionEvent.requestPermission grants', async () => {
  const DME = function(){};
  DME.requestPermission = () => Promise.resolve('granted');
  const state = await requestMotionPermission({ DeviceMotionEvent: DME });
  assert.equal(state, 'granted');
});

test('requestMotionPermission: resolves "denied" when DeviceMotionEvent.requestPermission denies', async () => {
  const DME = function(){};
  DME.requestPermission = () => Promise.resolve('denied');
  const state = await requestMotionPermission({ DeviceMotionEvent: DME });
  assert.equal(state, 'denied');
});

test('requestMotionPermission: a rejected/throwing requestPermission resolves as "denied", never rejects', async () => {
  const DME = function(){};
  DME.requestPermission = () => Promise.reject(new Error('user dismissed'));
  const state = await requestMotionPermission({ DeviceMotionEvent: DME });
  assert.equal(state, 'denied');
});

// ==================== Warm-up window (initialization-miss protection) ====================
// The short warmupMs window (see step-detector.js) exists so the very first
// physical step right after pressing Start isn't undercounted while the
// baseline is still settling. Tested via feedSample()'s explicit atTime
// parameter (no real timers needed) plus injected setTimeout/clearTimeout
// for the onReady callback itself.

test('a peak occurring during the warm-up window is not counted and does not fire onStep', () => {
  const cfg = { warmupMs: 400 };
  const detector = createStepDetector(cfg, { window: makeFakeWindow(), now: () => 0 });
  const stepsSeen = [];
  detector.start((count) => stepsSeen.push(count));

  detector.feedSample(0, 0, 9.8, 0); // baseline init, t=0
  const duringWarmup = detector.feedSample(
    0, 0, 9.8 + DEFAULT_STEP_DETECTOR_CONFIG.motionThreshold + 1, 100
  ); // t=100ms, still inside the 400ms warm-up window
  assert.equal(duringWarmup, false);
  assert.equal(detector.getStepCount(), 0);
  assert.equal(stepsSeen.length, 0);
});

test('a peak occurring after the warm-up window elapses is counted normally', () => {
  const cfg = { warmupMs: 400 };
  const detector = createStepDetector(cfg, { window: makeFakeWindow(), now: () => 0 });
  detector.start();

  detector.feedSample(0, 0, 9.8, 0);
  const afterWarmup = detector.feedSample(
    0, 0, 9.8 + DEFAULT_STEP_DETECTOR_CONFIG.motionThreshold + 1, 450
  ); // t=450ms, past the 400ms warm-up window
  assert.equal(afterWarmup, true);
  assert.equal(detector.getStepCount(), 1);
});

test('isWarmingUp() reflects the warm-up window relative to the injected clock', () => {
  let currentTime = 0;
  const detector = createStepDetector({ warmupMs: 400 }, { window: makeFakeWindow(), now: () => currentTime });
  detector.start();
  assert.equal(detector.isWarmingUp(), true);
  currentTime = 500;
  assert.equal(detector.isWarmingUp(), false);
});

test('start() schedules onReady via the injected setTimeout using warmupMs as the delay', () => {
  const scheduled = [];
  const cleared = [];
  let nextId = 1;
  const deps = {
    window: makeFakeWindow(),
    now: () => 0,
    setTimeout: (cb, ms) => { const id = nextId++; scheduled.push({ id, cb, ms }); return id; },
    clearTimeout: (id) => cleared.push(id),
  };
  const detector = createStepDetector({ warmupMs: 400 }, deps);
  let readyFired = false;
  detector.start(null, () => { readyFired = true; });

  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].ms, 400);
  assert.equal(readyFired, false, 'onReady must not fire synchronously, only once the timer callback runs');

  scheduled[0].cb();
  assert.equal(readyFired, true);
});

test('stop() clears any pending warm-up timer via the injected clearTimeout', () => {
  let nextId = 1;
  const cleared = [];
  const deps = {
    window: makeFakeWindow(),
    now: () => 0,
    setTimeout: (cb, ms) => nextId++,
    clearTimeout: (id) => cleared.push(id),
  };
  const detector = createStepDetector({ warmupMs: 400 }, deps);
  detector.start(null, () => {});
  detector.stop();
  assert.equal(cleared.length, 1);
});
