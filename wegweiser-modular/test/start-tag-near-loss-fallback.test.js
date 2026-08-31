// Regression tests for the Tag-1/start-approach-specific near-loss-fallback
// guard in nav.js's handleTracking() (see the startApproachEvidenceOk block
// just above the near-loss-fallback condition).
//
// Field evidence (see the accompanying analysis):
//   - wegweiser-v13-log-20260831-134027(49).json / -134136(51).json: genuine,
//     continuous approach all the way to ~0.93-0.94m, reached via the normal
//     distance-threshold path -- Tag 1 IS reliably detectable that close.
//   - wegweiser-v13-log-20260831-134108(50).json: stationary at ~1.56m
//     (~0.01m net movement), tag lost, near-loss-fallback INCORRECTLY accepted
//     this as arrival.
//   - wegweiser-v13-log-20260831-134227(52).json: stationary at ~1.68-1.71m
//     (~0.02-0.03m net movement), same incorrect acceptance.
//   - wegweiser-v13-log-20260825-151856(17).json: shallow/ambiguous drift
//     (~1.93m -> ~1.77m, ~0.12-0.16m), also incorrectly accepted, ~0.77m short
//     of startTagReachedM (1.0m).
//
// Fix under test: for TRACKING_START_TAG only, near-loss-fallback additionally
// requires BOTH (a) meaningful progress from a fixed start-of-approach
// baseline, and (b) that the closest distance reached was actually close to
// SETTINGS.startTagReachedM (not the global, much looser nearLossFallbackM).
// Ordinary edges (including 4->9's reachedM=3.0 override) are unaffected,
// since the guard is gated on trackingStartTagActive.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spokenTexts } from './browser-stubs.js';
import { destSel } from '../js/dom.js';
import * as nav from '../js/nav.js';

function resetState(){
  nav.endNavigation(false);
  spokenTexts.length = 0;
  nav.setTag9DetectorHooks(null);
  nav.setAdaptiveDetectorActive(false);
}

function selectDestination(id){
  destSel.value = String(id);
}

// Enters Tag 1's own dedicated TRACKING_START_TAG approach (path [1,2,3,6,4,7],
// same start tag and first segment as field log 17/49-52's Test1-4 sessions).
function enterTag1Approach(){
  resetState();
  selectDestination(7);
  nav.startNavigation();
  nav.onStartTagConfirmed(1, 1.9);
  assert.equal(nav.navState, nav.NavState.TRACKING_START_TAG);
  assert.equal(nav.expectedNextTagId, 1);
  spokenTexts.length = 0;
}

// Feeds a sequence of raw/EMA distances as consecutive visible frames, spaced
// stepMs apart, touching expectedLastSeenAt exactly as main-loop.js would on
// every visible frame. Returns the timestamp of the last fed frame.
function feedSequence(distances, startNow, stepMs){
  var now = startNow;
  for(var i = 0; i < distances.length; i++){
    now = startNow + i * stepMs;
    nav.setEmaDist(distances[i]);
    nav.touchExpectedSeen(now);
    nav.handleTracking(now, true, distances[i]);
  }
  return now;
}

// Simulates the tag disappearing for longer than SETTINGS.trackLostStopMs
// (1800ms) after the last visible frame at `lastSeenAt`.
function loseTag(lastSeenAt, lostForMs){
  return nav.handleTracking(lastSeenAt + (lostForMs || 1850), false, null);
}

test('start approach: stationary baseline ~1.56m (field log 50 shape), essentially no progress, then lost -> must NOT reach Tag 1', () => {
  enterTag1Approach();
  var lastSeenAt = feedSequence([1.57, 1.57, 1.58, 1.58, 1.59, 1.56], performance.now(), 180);
  loseTag(lastSeenAt, 1850);

  // currentTagId is already set to the start tag itself as soon as the route
  // is computed (js/nav.js commitStartTag(), before any physical reach), so it
  // is not a useful "was this reached" signal for Tag 1's own approach --
  // navState/expectedNextTagId (only changed by reachStartTag()->beginSegment())
  // are the correct discriminators here.
  assert.equal(nav.navState, nav.NavState.LOST_STOPPED, 'falls through to the ordinary lost-tag handling, no new speech path');
  assert.equal(nav.expectedNextTagId, 1, 'still approaching Tag 1, target unchanged (not advanced to segment 1->2)');
});

test('start approach: stationary baseline ~1.70m (field log 52 shape), essentially no progress, then lost -> must NOT reach Tag 1', () => {
  enterTag1Approach();
  var lastSeenAt = feedSequence([1.70, 1.68, 1.68, 1.71, 1.69, 1.70], performance.now(), 180);
  loseTag(lastSeenAt, 1850);

  assert.equal(nav.navState, nav.NavState.LOST_STOPPED);
  assert.equal(nav.expectedNextTagId, 1);
});

test('start approach: shallow ~0.12m drift, ~1.89m -> ~1.77m (field log 17 shape), then lost -> must NOT reach Tag 1', () => {
  enterTag1Approach();
  var lastSeenAt = feedSequence([1.89, 1.90, 1.85, 1.84, 1.81, 1.83, 1.79, 1.77], performance.now(), 180);
  loseTag(lastSeenAt, 1850);

  // Rejected on BOTH grounds independently: progress (1.89-1.77=0.12m) is
  // below the minimum-progress bar, AND the closest distance reached
  // (1.77m) is still well outside startTagReachedM(1.0)+margin(0.4)=1.4m --
  // exactly the "even if progress were interpreted as real, proximity alone
  // still rejects it" case.
  assert.equal(nav.navState, nav.NavState.LOST_STOPPED);
  assert.equal(nav.expectedNextTagId, 1);
});

test('start approach: genuine ~0.4m progress (1.9m -> 1.5m) but still too far from startTagReachedM, then lost -> must NOT reach Tag 1 (proximity fails)', () => {
  enterTag1Approach();
  var lastSeenAt = feedSequence([1.90, 1.85, 1.78, 1.70, 1.62, 1.55, 1.50], performance.now(), 180);
  loseTag(lastSeenAt, 1850);

  // Progress (1.90-1.50=0.40m) clears the minimum-progress bar on its own --
  // this specifically isolates proximity as the rejecting condition, per the
  // exact example in the accompanying analysis (genuine movement is not
  // sufficient by itself).
  assert.equal(nav.navState, nav.NavState.LOST_STOPPED, 'progress alone must not be sufficient -- 1.5m is still too far from startTagReachedM');
  assert.equal(nav.expectedNextTagId, 1);
});

test('start approach: genuine approach close enough (1.9m -> ~1.3m), lost right before normal confirmation -> near-loss-fallback MAY reach Tag 1', () => {
  enterTag1Approach();
  var lastSeenAt = feedSequence([1.90, 1.80, 1.65, 1.50, 1.40, 1.35, 1.30], performance.now(), 180);
  loseTag(lastSeenAt, 1850);

  // Progress (1.90-1.30=0.60m) and proximity (1.30 <= 1.0+0.4=1.4m) both hold
  // -- the intended positive case the fallback exists for.
  assert.equal(nav.navState, nav.NavState.SEARCHING_NEXT_TAG, 'reachStartTag() must have begun the real first segment');
  assert.equal(nav.expectedNextTagId, 2, 'segment 1->2 has begun');
});

test('start approach: continuous detection down to <=1.0m -> normal distance-threshold arrival still works unchanged', () => {
  enterTag1Approach();
  feedSequence([1.90, 1.60, 1.30, 1.00, 0.95], performance.now(), 180);

  assert.equal(nav.navState, nav.NavState.SEARCHING_NEXT_TAG);
  assert.equal(nav.expectedNextTagId, 2);
});

test('start approach: baseline is captured once from the first tracked frame, not overwritten by later closer readings, and resets cleanly for a new approach', () => {
  // Phase A: if the baseline were incorrectly re-captured at a later, closer
  // reading instead of staying fixed at the approach's very first frame, this
  // exact sequence would compute insufficient progress (1.50->1.35 = 0.15m,
  // measured from the second frame) and incorrectly reject. Correct behavior
  // -- using the TRUE first-frame baseline of 1.90m -- computes
  // 1.90-1.35=0.55m of progress, comfortably passing both conditions, so a
  // "reached" outcome here specifically proves the baseline was captured once
  // from frame 1 and never overwritten by the closer frame 2 reading.
  enterTag1Approach();
  var lastSeenAt = feedSequence([1.90, 1.70, 1.50, 1.45, 1.40, 1.35], performance.now(), 180);
  loseTag(lastSeenAt, 1850);
  assert.equal(nav.navState, nav.NavState.SEARCHING_NEXT_TAG,
    'baseline must still reflect the first frame (1.90m), not a later, closer one');
  assert.equal(nav.expectedNextTagId, 2);

  // Phase B: a completely new approach (new route, via resetSegmentState()'s
  // existing per-approach reset lifecycle) must not inherit the previous
  // approach's baseline/progress state.
  enterTag1Approach();
  var lastSeenAt2 = feedSequence([1.56, 1.57, 1.58, 1.58, 1.59, 1.56], performance.now(), 180);
  loseTag(lastSeenAt2, 1850);
  assert.equal(nav.navState, nav.NavState.LOST_STOPPED,
    'a fresh, stationary approach must be rejected -- no leftover baseline from the previous route');
  assert.equal(nav.expectedNextTagId, 1);
});

test('ordinary (non-start-tag) near-loss fallback is completely unaffected -- a stationary loss that would be rejected during start approach still succeeds on a normal segment', () => {
  enterTag1Approach();
  feedSequence([1.50, 1.20, 1.00, 0.95], performance.now(), 180); // reach Tag 1 normally
  assert.equal(nav.navState, nav.NavState.SEARCHING_NEXT_TAG);
  assert.equal(nav.expectedNextTagId, 2);
  spokenTexts.length = 0;

  // Track Tag 2 (ordinary edge, default reachedM=1.8) with a STATIONARY
  // distance (~2.0m, ~0.01m net movement) -- the same shape that was rejected
  // for the start approach above, but trackingStartTagActive is false here, so
  // the original, unmodified nearLossFallbackM(2.2) condition alone governs.
  var lastSeenAt = feedSequence([2.00, 2.01, 1.99, 2.00, 2.00, 2.00], performance.now(), 180);
  loseTag(lastSeenAt, 1850);

  assert.equal(nav.currentTagId, 2, 'ordinary near-loss-fallback must still accept a stationary-but-close-enough loss, unchanged');
});

test('edge 4->9 (reachedM=3.0 override) arrival threshold is unaffected by the start-approach guard', () => {
  // Note: near-loss-fallback can never be the EXCLUSIVE path to arrival on
  // this specific edge, since its reachedM (3.0) is already looser than the
  // global nearLossFallbackM (2.2) -- any loss close enough to satisfy the
  // fallback ceiling would already have satisfied the normal distance-
  // threshold path first. This test therefore verifies the behavior that IS
  // live for this edge: the edge-specific reachedM override itself, proving
  // reachedM selection (unrelated to trackingStartTagActive) is untouched.
  resetState();
  selectDestination(9);
  nav.startNavigation();
  nav.onStartTagConfirmed(4, 0.5); // within startTagReachedM -> commits immediately, no approach phase
  assert.equal(nav.navState, nav.NavState.SEARCHING_NEXT_TAG);
  assert.deepEqual(nav.pathTagIds, [4, 9]);
  spokenTexts.length = 0;

  // 2.6-2.8m is within this edge's 3.0m override but would fail the default
  // 1.8m threshold -- confirms the override, not the default, still governs.
  feedSequence([2.8, 2.6, 2.5], performance.now(), 180);
  assert.equal(nav.currentTagId, 9, 'edge-specific reachedM=3.0 must still govern arrival, unaffected by the new start-approach guard');
});
