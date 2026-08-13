// Tests for the experimental, diagnostics-only adaptive step detector
// (js/adaptive-step-detector.js). The rhythm-validation logic is exported as
// pure functions and tested with deterministic synthetic candidate peaks --
// no signal simulation needed for the timing rules. The signal path
// (gravity removal, smoothing, adaptive threshold, excursion peaks, sampling
// stats) is tested end-to-end via addSample() with synthetic x/y/z samples.
//
// Also guards the two hard project constraints: the PRODUCTION detector's
// fixed threshold stays exactly 1.5 and its counting is untouched, and the
// adaptive module is structurally incapable of touching navigation state
// (it imports nothing at all).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  DEFAULT_ADAPTIVE_STEP_CONFIG,
  createRhythmState,
  processCandidatePeak,
  checkWalkingTimeout,
  createAdaptiveStepDetector,
} from '../js/adaptive-step-detector.js';
import { DEFAULT_STEP_DETECTOR_CONFIG, createStepDetector } from '../js/step-detector.js';

const CFG = DEFAULT_ADAPTIVE_STEP_CONFIG;

function candidate(t, amplitude, threshold){
  return { t, amplitude: amplitude != null ? amplitude : 1.0, threshold: threshold != null ? threshold : 0.35 };
}

// Runs a list of candidates through the pure rhythm logic, collecting results.
function runCandidates(candidates, cfg){
  let state = createRhythmState();
  const steps = [];
  let started = 0, stopped = 0;
  const classifications = [];
  for(const c of candidates){
    const r = processCandidatePeak(state, c, cfg || CFG);
    state = r.state;
    steps.push(...r.steps);
    if(r.walkingStarted) started++;
    if(r.walkingStopped) stopped++;
    classifications.push(r.classification);
  }
  return { state, steps, started, stopped, classifications };
}

// ==================== 1. One isolated peak does not confirm walking ====================

test('a single isolated candidate peak never confirms walking or emits a step', () => {
  const r = runCandidates([candidate(1000)]);
  assert.equal(r.state.walking, false);
  assert.equal(r.steps.length, 0);
  assert.equal(r.started, 0);
  assert.deepEqual(r.classifications, ['sequence-start']);
});

// ==================== 2. Rhythmic peaks confirm walking ====================

test('three rhythmic peaks inside the allowed interval confirm walking exactly once', () => {
  const r = runCandidates([candidate(1000), candidate(1600), candidate(2200)]);
  assert.equal(r.state.walking, true);
  assert.equal(r.started, 1);
  assert.equal(r.steps.length, 3, 'all three sequence peaks become steps on confirmation');
});

// ==================== 3. Too-fast peaks are not valid consecutive peaks ====================

test('peaks faster than minStepIntervalMs are ignored, do not advance the sequence, and do not shift the reference time', () => {
  // 1000, then 1200 (200ms later: < 400 min) repeatedly -- never confirms.
  const r = runCandidates([candidate(1000), candidate(1200), candidate(1300), candidate(1399)]);
  assert.equal(r.state.walking, false);
  assert.equal(r.state.consecutive, 1, 'too-fast peaks must not increment the consecutive count');
  assert.deepEqual(r.classifications, ['sequence-start', 'too-fast', 'too-fast', 'too-fast']);
  // Reference time stays at 1000: a peak at 1450 is 450ms after 1000 -> valid.
  const next = processCandidatePeak(r.state, candidate(1450), CFG);
  assert.equal(next.classification, 'valid');
});

// ==================== 4. A gap above maxStepIntervalMs breaks the sequence ====================

test('a gap above maxStepIntervalMs resets the rhythmic sequence', () => {
  // Two valid peaks, then a 2000ms gap (> 1500), then two more -- the gap
  // peak starts a NEW sequence, so walking is never confirmed (2+3 < ...).
  const r = runCandidates([
    candidate(1000), candidate(1600),          // consecutive = 2
    candidate(3600),                            // gap 2000ms -> sequence-start, consecutive = 1
    candidate(4200),                            // consecutive = 2
  ]);
  assert.equal(r.state.walking, false);
  assert.equal(r.state.consecutive, 2);
  assert.equal(r.classifications[2], 'sequence-start');
});

test('a gap above maxStepIntervalMs while walking is confirmed stops walking (rhythm-break)', () => {
  const r = runCandidates([
    candidate(1000), candidate(1600), candidate(2200),   // confirms walking
    candidate(4000),                                      // 1800ms gap -> break
  ]);
  assert.equal(r.state.walking, false);
  assert.equal(r.stopped, 1);
  assert.equal(r.state.consecutive, 1, 'the breaking peak starts a fresh sequence');
});

// ==================== 5. minConsecutivePeaks boundary ====================

test('exactly minConsecutivePeaks (3) rhythmic peaks are required -- two are not enough', () => {
  const two = runCandidates([candidate(1000), candidate(1600)]);
  assert.equal(two.state.walking, false);
  assert.equal(two.steps.length, 0);

  const three = runCandidates([candidate(1000), candidate(1600), candidate(2200)]);
  assert.equal(three.state.walking, true);
  assert.equal(three.steps.length, 3);
});

// ==================== 6. Backfilled steps preserve ORIGINAL candidate data ====================

test('backfilled steps carry each candidate\'s own timestamp, amplitude, and threshold', () => {
  const c1 = candidate(1000, 0.71, 0.35);
  const c2 = candidate(1600, 0.92, 0.41);
  const c3 = candidate(2200, 1.13, 0.47);
  const r = runCandidates([c1, c2, c3]);
  assert.equal(r.steps.length, 3);
  assert.deepEqual(r.steps[0], { t: 1000, amplitude: 0.71, threshold: 0.35, backfilled: true });
  assert.deepEqual(r.steps[1], { t: 1600, amplitude: 0.92, threshold: 0.41, backfilled: true });
  assert.deepEqual(r.steps[2], { t: 2200, amplitude: 1.13, threshold: 0.47, backfilled: false });
});

// ==================== 7. The confirming peak is not counted twice ====================

test('the confirming peak appears exactly once among the emitted steps', () => {
  const r = runCandidates([candidate(1000), candidate(1600), candidate(2200), candidate(2800)]);
  // 3 backfill-phase steps + 1 live step after confirmation = 4 total.
  assert.equal(r.steps.length, 4);
  const stepsAt2200 = r.steps.filter((s) => s.t === 2200);
  assert.equal(stepsAt2200.length, 1, 'the confirming peak must not be emitted as both backfilled and live');
  assert.equal(stepsAt2200[0].backfilled, false);
  assert.equal(r.steps[3].backfilled, false, 'post-confirmation peaks are live steps');
});

// ==================== 8. Adaptive threshold respects thresholdFloor ====================

test('on a quiet signal the adaptive threshold stays at thresholdFloor', () => {
  const detector = createAdaptiveStepDetector();
  // Stationary phone: constant gravity-only samples, tiny mean/std.
  for(let t = 0; t <= 2000; t += 50){
    detector.addSample(0, 0, 9.81, t, null);
  }
  const summary = detector.getSummary();
  assert.equal(summary.lastThreshold, CFG.thresholdFloor,
    `quiet-signal threshold must clamp to the floor, got ${summary.lastThreshold}`);
  assert.equal(summary.peakCount, 0, 'a stationary phone must produce no candidate peaks');
});

// ==================== 9. Walking stops after the inactivity timeout ====================

test('walking transitions back to false after maxStepIntervalMs * walkingStopTimeoutFactor without peaks', () => {
  let state = createRhythmState();
  for(const c of [candidate(1000), candidate(1600), candidate(2200)]){
    state = processCandidatePeak(state, c, CFG).state;
  }
  assert.equal(state.walking, true);

  const before = checkWalkingTimeout(state, 2200 + CFG.maxStepIntervalMs * CFG.walkingStopTimeoutFactor, CFG);
  assert.equal(before.walkingStopped, false, 'exactly at the limit is still within the window');

  const after = checkWalkingTimeout(state, 2200 + CFG.maxStepIntervalMs * CFG.walkingStopTimeoutFactor + 1, CFG);
  assert.equal(after.walkingStopped, true);
  assert.equal(after.state.walking, false);
  assert.equal(after.state.consecutive, 0);
});

test('end-to-end: the detector emits ADAPTIVE_WALKING_STOPPED via the inactivity timeout on quiet samples', () => {
  const events = { started: 0, stopped: [], steps: [] };
  const detector = createAdaptiveStepDetector(null, {
    onStep: (s) => events.steps.push(s),
    onWalkingStart: () => events.started++,
    onWalkingStop: (w) => events.stopped.push(w.reason),
  });

  // Warm-up + settle on quiet signal, then three synthetic movement bursts
  // at a walking rhythm (~1000ms between peak maxima, inside [400, 1500]).
  // Each burst: two strong samples, then enough quiet samples (~850ms) for
  // the smoothed signal to decay below the excursion release level (the
  // per-axis gravity EMA absorbs a little of each burst, so the quiet-phase
  // dynamic magnitude does not return to exactly zero -- timings chosen via
  // simulation, not guessed).
  let t = 0;
  const quiet = (until) => { for(; t <= until; t += 50) detector.addSample(0, 0, 9.81, t, null); };
  const burst = () => {
    for(let i = 0; i < 2; i++){ detector.addSample(0, 3.5, 9.81, t, null); t += 50; }
  };
  quiet(1000);
  burst(); quiet(t + 850);   // peak ~1
  burst(); quiet(t + 850);   // peak ~2
  burst(); quiet(t + 850);   // peak ~3 -> walking confirmed
  assert.equal(events.started, 1, `expected walking confirmation, steps=${events.steps.length}`);
  assert.ok(detector.isWalking());

  // Now stay quiet well past the stop timeout.
  quiet(t + CFG.maxStepIntervalMs * CFG.walkingStopTimeoutFactor + 500);
  assert.equal(detector.isWalking(), false);
  assert.deepEqual(events.stopped, ['inactivity-timeout']);
});

// ==================== 10. Reset clears all adaptive state ====================

test('reset() clears counters, walking state, rhythm state, and sampling statistics', () => {
  const detector = createAdaptiveStepDetector(null, {});
  let t = 0;
  for(; t <= 1000; t += 50) detector.addSample(0, 0, 9.81, t, 16.7);
  for(let i = 0; i < 3; i++){ detector.addSample(0, 4, 9.81, t, 16.7); t += 50; }
  for(; t <= 3000; t += 50) detector.addSample(0, 0, 9.81, t, 16.7);
  assert.ok(detector.getSummary().sampleCount > 0);
  assert.ok(detector.getPeakCount() > 0, 'expected at least one candidate peak before reset');

  detector.reset();
  const summary = detector.getSummary();
  assert.equal(summary.sampleCount, 0);
  assert.equal(summary.adaptiveStepCount, 0);
  assert.equal(summary.peakCount, 0);
  assert.equal(summary.walking, false);
  assert.equal(summary.avgSampleIntervalMs, null);
  assert.equal(summary.minSampleIntervalMs, null);
  assert.equal(summary.reportedEventIntervalMs, null);
  assert.equal(summary.lastThreshold, CFG.thresholdFloor);
});

// ==================== 11. Production detector remains unchanged ====================

test('production motionThreshold is still exactly 1.5 and production counting is unaffected by the adaptive experiment', () => {
  assert.equal(DEFAULT_STEP_DETECTOR_CONFIG.motionThreshold, 1.5);
  assert.equal(DEFAULT_STEP_DETECTOR_CONFIG.releaseRatio, 0.5);
  assert.equal(DEFAULT_STEP_DETECTOR_CONFIG.minStepIntervalMs, 250);
  assert.equal(DEFAULT_STEP_DETECTOR_CONFIG.baselineAlpha, 0.05);

  // Production detector with the adaptive detector attached via the sample
  // tap: production counting must behave exactly as without the tap.
  const fakeWindow = {
    DeviceMotionEvent: function(){},
    addEventListener(){}, removeEventListener(){},
  };
  const adaptive = createAdaptiveStepDetector(null, {});
  const production = createStepDetector({ warmupMs: 0 }, { window: fakeWindow, now: () => 0 });
  production.start(null, null, null, (x, y, z, t, interval) => adaptive.addSample(x, y, z, t, interval));

  production.feedSample(0, 0, 9.8, 0);            // baseline init
  production.feedSample(0, 0, 9.8 + 3, 300);      // deviation ~2.85 -> production step
  production.feedSample(0, 0, 9.8, 350);
  assert.equal(production.getStepCount(), 1, 'production step counting must be unchanged with the tap attached');
  assert.equal(adaptive.getSummary().sampleCount, 3, 'the adaptive detector must observe the same three samples');
});

test('the sample tap forwards raw x/y/z, the shared time base, and event.interval when available', () => {
  const seen = [];
  const fakeWindow = {
    DeviceMotionEvent: function(){},
    addEventListener(type, cb){ this._cb = cb; },
    removeEventListener(){},
  };
  const production = createStepDetector({ warmupMs: 0 }, { window: fakeWindow, now: () => 1234 });
  production.start(null, null, null, (x, y, z, t, interval) => seen.push({ x, y, z, t, interval }));

  fakeWindow._cb({ accelerationIncludingGravity: { x: 1, y: 2, z: 9.5 }, interval: 16.7 });
  assert.deepEqual(seen, [{ x: 1, y: 2, z: 9.5, t: 1234, interval: 16.7 }]);
});

// ==================== 12. Diagnostics cannot touch navigation state ====================

test('the adaptive module is fully standalone -- it imports nothing (structurally cannot reach nav/graph/speech state)', () => {
  const source = readFileSync(new URL('../js/adaptive-step-detector.js', import.meta.url), 'utf8');
  assert.ok(!/^\s*import\s/m.test(source), 'adaptive-step-detector.js must not import any module');
  assert.ok(!/require\s*\(/.test(source), 'adaptive-step-detector.js must not require any module');
});

// ==================== Sampling diagnostics ====================

test('getSummary() reports sample count, average/min/max interval, and the reported event.interval', () => {
  const detector = createAdaptiveStepDetector(null, {});
  detector.addSample(0, 0, 9.81, 0, 16.7);
  detector.addSample(0, 0, 9.81, 20, 16.7);   // 20ms
  detector.addSample(0, 0, 9.81, 70, 16.7);   // 50ms
  detector.addSample(0, 0, 9.81, 100, 33.3);  // 30ms
  const s = detector.getSummary();
  assert.equal(s.sampleCount, 4);
  assert.ok(Math.abs(s.avgSampleIntervalMs - 100 / 3) < 1e-9);
  assert.equal(s.minSampleIntervalMs, 20);
  assert.equal(s.maxSampleIntervalMs, 50);
  assert.equal(s.reportedEventIntervalMs, 33.3, 'the most recent non-null event.interval is kept');
});

// ==================== Excursion merging fix (field-test correction) ====================
// Field evidence: during normal walking the old release rule (signal must
// fall below exStartThreshold * 0.5, with the threshold frozen at excursion
// START) merged several physical steps into one excursion, producing
// apparent candidate intervals of 3-5s at a real ~0.5-1s cadence -- so the
// rhythm validator saw nothing but "sequence-start" resets. The corrected
// rule closes relative to the RUNNING local maximum (smoothed < exMax *
// peakReleaseRatio) and only opens a new excursion on a RISING sample.
//
// Deterministic setup: gravityAlpha 0 freezes gravity at the first sample
// (0,0,0), smoothingAlpha 1 disables smoothing (smoothed === fed magnitude),
// thresholdK 0 clamps the threshold to the 0.35 floor for constant-threshold
// cases. Peaks/valleys are then exact, not approximations.

function makeDeterministicDetector(overrides, peaks){
  return createAdaptiveStepDetector(
    Object.assign({ gravityAlpha: 0, smoothingAlpha: 1, thresholdK: 0 }, overrides || {}),
    { onPeak: (p) => peaks.push(p) }
  );
}

// Feeds: warm-up quiet, then `n` peak/valley cycles (~600ms cadence), then a
// final collapse so any open excursion terminates.
function walkPattern(detector, n, peakAmp, valleyAmp){
  let t = 0;
  detector.addSample(0, 0, 0, t, null); t += 50;             // gravity init
  for(; t <= 500; t += 50) detector.addSample(0, 0.05, 0, t, null);
  for(let s = 0; s < n; s++){
    detector.addSample(0, peakAmp, 0, t, null); t += 50;
    for(let k = 0; k < 11; k++){ detector.addSample(0, valleyAmp, 0, t, null); t += 50; }
  }
  for(let k = 0; k < 10; k++){ detector.addSample(0, 0.02, 0, t, null); t += 50; }
}

test('Case A: full release between peaks yields one candidate per physical peak', () => {
  const peaks = [];
  walkPattern(makeDeterministicDetector(null, peaks), 3, 1.0, 0.05);
  assert.equal(peaks.length, 3);
});

test('Case B regression: valleys below the threshold but above the OLD frozen release no longer merge steps', () => {
  // Valley 0.25 = 25% of peak: below the 0.35 threshold, but above the old
  // frozen release boundary (0.35 * 0.5 = 0.175). The old rule produced ONE
  // candidate here (confirmed before the fix); the corrected rule separates
  // all three steps.
  const peaks = [];
  walkPattern(makeDeterministicDetector(null, peaks), 3, 1.0, 0.25);
  assert.equal(peaks.length, 3, 'physically separate steps must not merge into one excursion');
});

test('release-boundary documentation: valleys at 40% of the local peak separate; at/above 50% they still merge', () => {
  // Documents the actual robustness boundary of the unchanged
  // peakReleaseRatio = 0.5 (strictly-below comparison): this is expected
  // current behavior to evaluate against field data, not a hidden defect.
  const at40 = [];
  walkPattern(makeDeterministicDetector(null, at40), 3, 1.0, 0.4);
  assert.equal(at40.length, 3);

  const at50 = [];
  walkPattern(makeDeterministicDetector(null, at50), 3, 1.0, 0.5);
  assert.equal(at50.length, 1, 'a valley exactly AT 50% of the peak does not release (strict <)');

  const at60 = [];
  walkPattern(makeDeterministicDetector(null, at60), 3, 1.0, 0.6);
  assert.equal(at60.length, 1);
});

test('the falling tail of one physical peak cannot reopen an excursion and duplicate the candidate', () => {
  // Rise to 3.0, then a gradual decay: the release fires while the tail
  // (1.2 -> 0.45) is still above the 0.35 threshold -- but every tail sample
  // is FALLING, so no second excursion may open.
  const peaks = [];
  const detector = makeDeterministicDetector(null, peaks);
  let t = 0;
  detector.addSample(0, 0, 0, t, null); t += 50;
  for(; t <= 500; t += 50) detector.addSample(0, 0.05, 0, t, null);
  for(const v of [3.0, 2.4, 1.9, 1.2, 0.9, 0.6, 0.45, 0.05, 0.05]){
    detector.addSample(0, v, 0, t, null); t += 50;
  }
  assert.equal(peaks.length, 1, 'one physical peak must yield exactly one candidate');
  assert.equal(Math.round(peaks[0].amplitude * 10) / 10, 3.0, 'the candidate must carry the true local maximum');
});

test('Case C: an inflated adaptive threshold does not delay excursion close (release is exMax-relative)', () => {
  // Default thresholdK (1.2): strong peaks inflate mean/std so the threshold
  // rises well above the floor while excursions are open. Valleys at 40% of
  // the peak must still separate every step, because the close rule
  // references only the excursion's own local maximum, never the threshold.
  const peaks = [];
  const detector = createAdaptiveStepDetector(
    { gravityAlpha: 0, smoothingAlpha: 1 },   // default thresholdK stays active
    { onPeak: (p) => peaks.push(p) }
  );
  walkPattern(detector, 5, 3.0, 1.2);          // valley = 40% of 3.0
  assert.equal(peaks.length, 5);
  const lastPeak = peaks[peaks.length - 1];
  assert.ok(lastPeak.threshold > DEFAULT_ADAPTIVE_STEP_CONFIG.thresholdFloor,
    `expected an inflated threshold by the last step, got ${lastPeak.threshold}`);
});

test('candidate peaks carry a peakDurationMs diagnostic covering the whole excursion', () => {
  const peaks = [];
  walkPattern(makeDeterministicDetector(null, peaks), 1, 1.0, 0.05);
  assert.equal(peaks.length, 1);
  assert.equal(typeof peaks[0].peakDurationMs, 'number');
  assert.ok(peaks[0].peakDurationMs >= 0 && peaks[0].peakDurationMs < 1000,
    `a single clean step must produce a short excursion, got ${peaks[0].peakDurationMs}ms`);
});

// ==================== Peak diagnostics content ====================

test('every candidate peak reports amplitude, threshold, mean, std, interval, consecutive count, and classification', () => {
  const peaks = [];
  const detector = createAdaptiveStepDetector(null, { onPeak: (p) => peaks.push(p) });
  let t = 0;
  for(; t <= 1000; t += 50) detector.addSample(0, 0, 9.81, t, null);
  for(let i = 0; i < 3; i++){ detector.addSample(0, 3.5, 9.81, t, null); t += 50; }
  for(; t <= 2500; t += 50) detector.addSample(0, 0, 9.81, t, null);

  assert.equal(peaks.length, 1, 'one movement burst must produce exactly one candidate peak');
  const p = peaks[0];
  assert.ok(p.amplitude > 0);
  assert.ok(p.threshold >= CFG.thresholdFloor);
  assert.equal(typeof p.mean, 'number');
  assert.equal(typeof p.std, 'number');
  assert.equal(p.intervalFromPreviousPeak, null, 'first-ever peak has no previous interval');
  assert.equal(p.consecutivePeaks, 1);
  assert.equal(p.classification, 'sequence-start');
});

// ==================== Walking vs. left-right scanning diagnostics ====================
// Field evidence after the excursion fix: normal/shuffling walking improved
// sharply, but standing still while scanning the phone left-right (normal
// AprilTag-search behavior) produces rhythmic magnitude peaks that the
// current magnitude+rhythm classifier cannot distinguish from real steps.
//
// These tests answer Step 2's question directly with deterministic signals:
// can walking and left-right scanning produce similar scalar peak sequences?
// -- and validate the new, NON-classifying diagnostic features (verticalRatio,
// rotationRateMean) that a future field round needs to set an evidence-based
// boundary. No classification change is made here: both A and B are still
// expected to confirm "walking" under the UNCHANGED rhythm/magnitude rule --
// that is the documented insufficiency, not a bug in these tests.
//
// Deterministic setup: gravityAlpha 0 freezes gravity at the very first fed
// sample, smoothingAlpha 1 disables smoothing, thresholdK 0 clamps the
// threshold to the 0.35 floor -- isolates the new direction math from the
// unrelated adaptive-threshold behavior already covered above.

function makeDirectionalDetector(peaks, walkingEvents){
  return createAdaptiveStepDetector(
    { gravityAlpha: 0, smoothingAlpha: 1, thresholdK: 0 },
    {
      onPeak: (p) => peaks.push(p),
      onWalkingStart: () => walkingEvents.push('started'),
    }
  );
}

test('A. walking-like vertical pulses: high verticalRatio, rhythm confirms walking', () => {
  const peaks = [];
  const walkingEvents = [];
  const detector = makeDirectionalDetector(peaks, walkingEvents);
  let t = 0;
  // Gravity settles along z (0,0,9.81); each pulse is ALONG that axis --
  // a vertical, gravity-aligned impulse, as a real footfall jolt is.
  detector.addSample(0, 0, 9.81, t, null); t += 50;
  for(; t <= 500; t += 50) detector.addSample(0, 0, 9.81 + 0.05, t, null);
  for(let s = 0; s < 4; s++){
    detector.addSample(0, 0, 9.81 + 1.0, t, null); t += 50;
    for(let k = 0; k < 11; k++){ detector.addSample(0, 0, 9.81 + 0.02, t, null); t += 50; }
  }
  assert.equal(peaks.length, 4);
  for(const p of peaks) assert.equal(p.verticalRatio, 1, 'a purely gravity-aligned pulse must be 100% vertical');
  assert.ok(walkingEvents.length > 0, 'rhythmic vertical pulses must still confirm walking (unchanged classification)');
});

test('B. left-right scan oscillation produces a similar rhythmic peak sequence and is (still) misclassified as walking -- the documented insufficiency', () => {
  const peaks = [];
  const walkingEvents = [];
  const detector = makeDirectionalDetector(peaks, walkingEvents);
  let t = 0;
  const rotation = { alpha: 40, beta: 5, gamma: 5 }; // device rotating while scanning
  // Alternating swings on x, perpendicular to gravity (still along z) -- a
  // lateral, non-gravity-aligned oscillation, as a hand scanning the phone
  // left-right produces.
  detector.addSample(0, 0, 9.81, t, null, rotation); t += 50;
  for(; t <= 500; t += 50) detector.addSample(0.02, 0, 9.81, t, null, rotation);
  let sign = 1;
  for(let s = 0; s < 4; s++){
    detector.addSample(sign * 1.0, 0, 9.81, t, null, rotation); t += 50; sign = -sign;
    for(let k = 0; k < 11; k++){ detector.addSample(0.02, 0, 9.81, t, null, rotation); t += 50; }
  }
  assert.equal(peaks.length, 4);
  for(const p of peaks) assert.equal(p.verticalRatio, 0, 'a purely lateral swing must be 0% vertical');
  assert.ok(peaks.every((p) => p.rotationRateMean != null && p.rotationRateMean > 0),
    'rotation data present on the same event must be reflected in rotationRateMean');
  // This is the key evidence for Step 2: magnitude + rhythm ALONE cannot
  // separate this from case A above -- both confirm "walking" today.
  assert.ok(walkingEvents.length > 0,
    'documents that the CURRENT unchanged classifier still confirms walking for scan-like input');
});

test('C. irregular phone repositioning remains rejected by the unchanged rhythm rule', () => {
  const peaks = [];
  const walkingEvents = [];
  const detector = makeDirectionalDetector(peaks, walkingEvents);
  let t = 0;
  detector.addSample(0, 0, 9.81, t, null); t += 50;
  for(; t <= 500; t += 50) detector.addSample(0, 0, 9.81, t, null);
  // Aperiodic jolts (mixed vertical/lateral), gaps deliberately irregular
  // and mostly outside the [minStepIntervalMs, maxStepIntervalMs] window.
  const gaps = [200, 2600, 350, 1900, 250];
  for(const gap of gaps){
    detector.addSample(0.5, 0, 9.81 + 0.6, t, null); t += 50;
    const quietUntil = t + gap;
    for(; t <= quietUntil; t += 50) detector.addSample(0.02, 0, 9.81, t, null);
  }
  assert.equal(walkingEvents.length, 0, 'irregular, non-rhythmic movement must not confirm walking');
});

test('rotationRateMean stays null throughout when the device never reports rotation data', () => {
  const peaks = [];
  const walkingEvents = [];
  const detector = makeDirectionalDetector(peaks, walkingEvents);
  let t = 0;
  detector.addSample(0, 0, 9.81, t, null); t += 50; // no rotation argument at all
  for(; t <= 500; t += 50) detector.addSample(0, 0, 9.81 + 0.05, t, null);
  for(let s = 0; s < 2; s++){
    detector.addSample(0, 0, 9.81 + 1.0, t, null); t += 50;
    for(let k = 0; k < 11; k++){ detector.addSample(0, 0, 9.81 + 0.02, t, null); t += 50; }
  }
  assert.equal(peaks.length, 2);
  for(const p of peaks) assert.equal(p.rotationRateMean, null);
});

test('reset() clears the directional/rotation accumulators -- no leakage into the next excursion', () => {
  const peaks = [];
  const walkingEvents = [];
  const detector = makeDirectionalDetector(peaks, walkingEvents);
  let t = 0;
  const rotation = { alpha: 90, beta: 0, gamma: 0 };
  // First: a lateral, rotating excursion (verticalRatio 0, rotation present).
  detector.addSample(0, 0, 9.81, t, null, rotation); t += 50;
  for(; t <= 500; t += 50) detector.addSample(0.02, 0, 9.81, t, null, rotation);
  detector.addSample(1.0, 0, 9.81, t, null, rotation); t += 50;
  for(let k = 0; k < 11; k++){ detector.addSample(0.02, 0, 9.81, t, null, rotation); t += 50; }
  assert.equal(peaks.length, 1);
  assert.equal(peaks[0].verticalRatio, 0);
  assert.ok(peaks[0].rotationRateMean > 0);

  detector.reset();

  // Second: a vertical, non-rotating excursion, fed immediately after reset.
  peaks.length = 0;
  detector.addSample(0, 0, 9.81, t, null); t += 50;
  const settleUntil = t + 500;
  for(; t <= settleUntil; t += 50) detector.addSample(0, 0, 9.81 + 0.05, t, null);
  detector.addSample(0, 0, 9.81 + 1.0, t, null); t += 50;
  for(let k = 0; k < 11; k++){ detector.addSample(0, 0, 9.81 + 0.02, t, null); t += 50; }
  assert.equal(peaks.length, 1);
  assert.equal(peaks[0].verticalRatio, 1,
    'the post-reset excursion must be scored purely on its own samples, not blended with the pre-reset lateral/rotation state');
  assert.equal(peaks[0].rotationRateMean, null,
    'post-reset rotation accumulator must not carry over the pre-reset rotating excursion');
});

test('the onStep (backfill/live) payload shape is unaffected by the new directional fields', () => {
  // Guards against the new candidate.verticalRatio/rotationRateMean fields
  // silently leaking into the ADAPTIVE_STEP_DETECTED shape, which the
  // pre-existing backfill-exactness tests above assert with assert.deepEqual
  // against a fixed 4-key object.
  const r = runCandidates([candidate(1000), candidate(1600), candidate(2200)]);
  for(const s of r.steps){
    assert.deepEqual(Object.keys(s).sort(), ['amplitude', 'backfilled', 't', 'threshold']);
  }
});
