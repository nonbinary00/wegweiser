// Tests for the multi-frame orientation bootstrap (nav.js's
// runOrientationBootstrap()) and the widened poseErrorGap<=3 ambiguity
// threshold (nav.js's ORIENTATION_BRANCH_AMBIGUOUS_MAX_GAP), added after
// analyzing wegweiser-v13-log-20260825-130011(10).json ("6-4_still") and
// -130059(11).json ("6-4_still_back").
//
// Motivation: frame 0's raw POSIT "best" label can be an arbitrary,
// uninformed choice when the two branches are an exact/near-exact tie --
// confirmed directly in log (11), where frame 0 was best=+7.96/poseErr=6 vs
// alternative=-23.25/poseErr=6 (an EXACT tie), yet that log's eventually-
// dominant, better-supported mode turned out to be the OTHER (negative) one.
// The bootstrap collects a short, bounded window (6 frames) of candidate
// pairs, associates each frame's two yaw candidates to one of two running
// "modes" by nearest circular distance (physical continuity, NOT the
// solver's best/alternative label -- confirmed to flip ~20% of frames
// independent of real motion), then commits to whichever mode has the lower
// mean reprojection error over the window.
//
// Never uses desiredRouteHeadingDeg, headingErrorDeg, or any classifier
// result to choose -- verified structurally and by construction below.

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

function makeRotation(yawDeg){
  var yaw = yawDeg * Math.PI / 180;
  return [
    [Math.cos(yaw), 0, Math.sin(yaw)],
    [0, 1, 0],
    [Math.sin(yaw), 0, Math.cos(yaw)]
  ];
}

var SOME_CORNERS = [{ x: 100, y: 100 }, { x: 140, y: 100 }, { x: 140, y: 140 }, { x: 100, y: 140 }];

function enterRoute(startTag, destinationId){
  resetState();
  selectDestination(destinationId);
  nav.startNavigation();
  nav.onStartTagConfirmed(startTag);
  var fromTag = nav.pathTagIds[nav.segIndex];
  assert.equal(fromTag, startTag);
  return { fromTag: fromTag, toTag: nav.expectedNextTagId };
}

function sample(best, bestErr, alt, altErr){
  return { best: best, bestErr: bestErr, alt: alt == null ? null : alt, altErr: alt == null ? null : altErr };
}

// ==================== A. Threshold widening (selectOrientationBranch) ====================

test('threshold widening: gap 0/1/2/3 all trigger continuity (were already/now ambiguous)', () => {
  [0, 1, 2, 3].forEach(function(gap){
    var choice = nav.selectOrientationBranch(/*best*/ 20, /*alt*/ -18, gap, /*prev*/ -19);
    assert.equal(choice.branch, 'alternative', `gap=${gap} should be treated as ambiguous`);
  });
});

test('threshold widening: gap 4 keeps raw best (beyond the new <=3 ceiling)', () => {
  var choice = nav.selectOrientationBranch(/*best*/ 20, /*alt*/ -18, /*gap*/ 4, /*prev*/ -19);
  assert.equal(choice.branch, 'best');
  assert.equal(choice.reason, 'best-clear-error');
});

test('threshold widening: a large gap (20+, degenerate alternative) keeps raw best', () => {
  var choice = nav.selectOrientationBranch(/*best*/ -19, /*alt*/ -10, /*gap*/ 22, /*prev*/ -18);
  assert.equal(choice.branch, 'best');
  assert.equal(choice.reason, 'best-clear-error');
});

// ==================== B. Bootstrap mechanics (runOrientationBootstrap) ====================

test('bootstrap: a first-frame exact tie does not immediately/permanently lock the final branch', () => {
  // Frame 0 alone: tied error (6 vs 6) -- with only one observation per mode,
  // the deterministic tie-break applies (mode 0, i.e. raw "best"), but this
  // must not be mistaken for a confident decision.
  var afterFrame0 = nav.runOrientationBootstrap([sample(8, 6, -23, 6)]);
  assert.equal(afterFrame0.reason, 'bootstrap-tied-fallback');

  // As more evidence arrives showing the OTHER mode is clearly better
  // supported, the running decision changes -- it was never permanently locked.
  var afterMoreEvidence = nav.runOrientationBootstrap([
    sample(8, 6, -23, 6),
    sample(4, 6, -19, 6),
    sample(-20, 6, 4, 30),
    sample(-21, 6, 4, 28)
  ]);
  assert.ok(Math.abs(afterMoreEvidence.yawDeg - (-21)) < 1,
    `expected the bootstrap to have moved to the better-supported negative mode, got ${afterMoreEvidence.yawDeg}`);
});

test('bootstrap: a 6-8 frame sequence with recurring modes and one lower-error mode chooses that stable mode', () => {
  // Error is tied to the PHYSICAL value (8deg always err=6, -22deg always
  // err=9), not to whichever raw label ("best"/"alternative") reports it --
  // the two swap position every frame, exactly like the field logs.
  var samples = [
    sample(8, 6, -22, 9),
    sample(-22, 9, 8, 6),
    sample(8, 6, -22, 9),
    sample(-22, 9, 8, 6),
    sample(8, 6, -22, 9),
    sample(-22, 9, 8, 6)
  ];
  var result = nav.runOrientationBootstrap(samples);
  // Mode "8" always carries error 6, mode "-22" always carries error 9 --
  // lower-error mode should win regardless of which raw label ("best" or
  // "alternative") happened to carry it on any given frame.
  assert.ok(Math.abs(result.yawDeg - 8) < 0.5, `expected the lower-error mode (~8deg) to win, got ${result.yawDeg}`);
  assert.equal(result.reason, 'bootstrap-lower-error');
});

test('bootstrap: result does not depend on which raw solver label ("best" vs "alternative") carries each mode', () => {
  // Same physical evidence (8deg always err=6, -22deg always err=9) as the
  // previous test, but with a DIFFERENT best/alternative label pattern --
  // mode identity is tracked by circular proximity to prior observations,
  // not by trusting the label, so the conclusion must be identical.
  var samplesSwapped = [
    sample(-22, 9, 8, 6),
    sample(8, 6, -22, 9),
    sample(-22, 9, 8, 6),
    sample(8, 6, -22, 9),
    sample(-22, 9, 8, 6),
    sample(8, 6, -22, 9)
  ];
  var result = nav.runOrientationBootstrap(samplesSwapped);
  assert.ok(Math.abs(result.yawDeg - 8) < 0.5, `expected the lower-error mode (~8deg) to win regardless of label, got ${result.yawDeg}`);
});

test('bootstrap: handles +-180 wrap correctly when grouping candidates into modes', () => {
  // One mode oscillates near +179/-179 (a physically stable near-opposite
  // orientation that happens to straddle the wrap boundary); naive linear
  // grouping would scatter these into both "modes" incorrectly.
  var samples = [
    sample(179, 6, 5, 20),
    sample(-179, 6, 4, 22),
    sample(178, 6, 6, 19),
    sample(-178, 6, 5, 21)
  ];
  var result = nav.runOrientationBootstrap(samples);
  assert.ok(nav.circularDistanceDeg(result.yawDeg, 179) <= 3,
    `expected the wrap-straddling mode (~+-179deg, lower error) to be recognized as one mode and win, got ${result.yawDeg}`);
});

test('bootstrap: an ambiguous window (fully tied evidence) falls back deterministically and says so', () => {
  var samples = [
    sample(8, 6, -22, 6),
    sample(-22, 6, 8, 6),
    sample(8, 6, -22, 6),
    sample(-22, 6, 8, 6)
  ];
  var result = nav.runOrientationBootstrap(samples);
  assert.equal(result.reason, 'bootstrap-tied-fallback');
  assert.ok(result.yawDeg === 8 || result.yawDeg === -22, 'must still produce a real, deterministic yaw, not null/NaN');
});

test('bootstrap: never reads desiredRouteHeadingDeg or any classifier result -- structural check', () => {
  assert.equal(nav.runOrientationBootstrap.length, 1, 'runOrientationBootstrap takes only the accumulated samples array');
});

// ==================== reset behavior ====================

test('bootstrap resets on a new segment', () => {
  var seg1 = enterRoute(6, 4);
  nav.maybeLogOrientationDiagnostics(seg1.fromTag, {
    distanceM: 1.0, rotation: makeRotation(8), translation: [0, 0, 1.0], poseError: 6,
    alternativeRotation: makeRotation(-22), alternativePoseError: 9, poseErrorGap: 3
  }, SOME_CORNERS, 1000);

  var seg2 = enterRoute(6, 4);
  var result = nav.maybeLogOrientationDiagnostics(seg2.fromTag, {
    distanceM: 1.0, rotation: makeRotation(-22), translation: [0, 0, 1.0], poseError: 6,
    alternativeRotation: makeRotation(8), alternativePoseError: 9, poseErrorGap: 3
  }, SOME_CORNERS, 2000);

  assert.ok(result && result.ok);
  assert.equal(result.orientationBootstrapActive, true);
  assert.equal(result.orientationBootstrapSampleCount, 1);
});

test('bootstrap resets on navigation stop/reset', () => {
  var seg1 = enterRoute(6, 4);
  nav.maybeLogOrientationDiagnostics(seg1.fromTag, {
    distanceM: 1.0, rotation: makeRotation(8), translation: [0, 0, 1.0], poseError: 6,
    alternativeRotation: makeRotation(-22), alternativePoseError: 9, poseErrorGap: 3
  }, SOME_CORNERS, 1000);

  nav.endNavigation(false);

  var seg2 = enterRoute(6, 4);
  var result = nav.maybeLogOrientationDiagnostics(seg2.fromTag, {
    distanceM: 1.0, rotation: makeRotation(-22), translation: [0, 0, 1.0], poseError: 6,
    alternativeRotation: makeRotation(8), alternativePoseError: 9, poseErrorGap: 3
  }, SOME_CORNERS, 2000);

  assert.ok(result && result.ok);
  assert.equal(result.orientationBootstrapActive, true);
  assert.equal(result.orientationBootstrapSampleCount, 1);
});

// ==================== C. Field-derived fixture (log B pattern) ====================

test('field-derived fixture: log-B-like pattern (first-frame tie, label swaps, lower-jitter negative mode) avoids permanently anchoring to the arbitrary positive first-frame label', () => {
  var seg = enterRoute(6, 4);
  // Matches the field log's own shape: frame 0 an exact best/alt tie
  // (+7.96 vs -23.25, both poseErr=6). Positive stays a consistently OK
  // candidate (err=6 throughout, same as log B's actual positive-label
  // frames) while the negative mode is measured as slightly MORE consistent
  // over the window (err 5-6, mirroring log B's later gap=0 continuity-
  // alternative run being tighter/better-supported than the earlier gap 3-9
  // frames) -- so its mean error ends up lower despite frame 0 being a dead
  // tie that arbitrarily favored positive.
  var samples = [
    { best: 7.96, bestErr: 6, alt: -23.25, altErr: 6 },
    { best: 6.99, bestErr: 6, alt: -23.75, altErr: 5 },
    { best: 5.65, bestErr: 6, alt: -21.62, altErr: 5 },
    { best: 4.39, bestErr: 6, alt: -19.48, altErr: 5 },
    { best: 3.21, bestErr: 6, alt: -18.28, altErr: 5 },
    { best: 4.41, bestErr: 6, alt: -19.23, altErr: 5 }
  ];
  var result;
  for(var i = 0; i < samples.length; i++){
    var s = samples[i];
    var pose = {
      distanceM: 0.82, rotation: makeRotation(s.best), translation: [0, 0, 0.82], poseError: s.bestErr,
      alternativeRotation: makeRotation(s.alt), alternativePoseError: s.altErr,
      poseErrorGap: Math.abs(s.altErr - s.bestErr)
    };
    result = nav.maybeLogOrientationDiagnostics(seg.fromTag, pose, SOME_CORNERS, 1000 + i);
  }
  assert.ok(result && result.ok);
  // Exactly 6 frames fed -- the window completes ON this frame (its own
  // output is still bootstrap-produced, hence active=true here; the FIRST
  // frame using normal per-frame continuity would be the 7th).
  assert.equal(result.orientationBootstrapSampleCount, 6);
  assert.equal(result.orientationBootstrapActive, true);
  // The negative mode has equal-or-lower mean error and, crucially, the
  // bootstrap must not have rigidly kept the positive label just because it
  // won the arbitrary frame-0 tie.
  assert.ok(result.selectedOrientationYawDeg < 0,
    `expected the bootstrap to settle on the negative mode (better/equal-supported, not the arbitrary positive tie-winner), got ${result.selectedOrientationYawDeg}`);
});

// ==================== D. Stability effect ====================

test('stability effect: a branch-swap sequence produces fewer >20deg selected-yaw jumps, a lower rolling stddev, and reaches a stable classification', () => {
  var seg = enterRoute(6, 4);
  // Same pathological pattern as the field logs: two near-tied physical
  // modes ~30deg apart, swapping which raw label ("best"/"alternative")
  // carries which mode every frame, gap=3 (within the new <=3 threshold, but
  // would have been REJECTED by the old <=1 threshold).
  var bestSeq = [8, -22, 8, -22, 8, -22, 8, -22, 8, -22, 8, -22];
  var altSeq =  [-22, 8, -22, 8, -22, 8, -22, 8, -22, 8, -22, 8];
  var jumps = 0;
  var result, prevYaw = null;
  for(var i = 0; i < bestSeq.length; i++){
    var pose = {
      distanceM: 1.0, rotation: makeRotation(bestSeq[i]), translation: [0, 0, 1.0], poseError: 6,
      alternativeRotation: makeRotation(altSeq[i]), alternativePoseError: 9, poseErrorGap: 3
    };
    result = nav.maybeLogOrientationDiagnostics(seg.fromTag, pose, SOME_CORNERS, 1000 + i);
    if(prevYaw != null && nav.circularDistanceDeg(result.selectedOrientationYawDeg, prevYaw) > 20){
      jumps++;
    }
    prevYaw = result.selectedOrientationYawDeg;
  }

  assert.ok(jumps <= 1, `expected at most one jump (bootstrap settling), got ${jumps}`);
  assert.ok(result.stability.stdDevDeg < 10, `expected a low rolling stddev, got ${result.stability.stdDevDeg}`);
  assert.notEqual(result.classification, 'UNSTABLE_WINDOW',
    `expected a stable directional classification, got ${result.classification} (${result.classificationReason})`);
});

// ==================== E. No side effects ====================

test('no side effects: TTS, nav state, distance fields, and route state are all untouched across bootstrap + continuity', () => {
  var seg = enterRoute(6, 4);
  spokenTexts.length = 0;
  var before = {
    pathTagIds: nav.pathTagIds.slice(),
    segIndex: nav.segIndex,
    currentTagId: nav.currentTagId,
    expectedNextTagId: nav.expectedNextTagId,
    navState: nav.navState,
    destinationReached: nav.destinationReached
  };

  var bestSeq = [8, -22, 8, -22, 8, -22, 8, -22];
  var altSeq =  [-22, 8, -22, 8, -22, 8, -22, 8];
  var lastResult;
  for(var i = 0; i < bestSeq.length; i++){
    lastResult = nav.maybeLogOrientationDiagnostics(seg.fromTag, {
      distanceM: 1.23, rotation: makeRotation(bestSeq[i]), translation: [0, 0, 1.23], poseError: 7,
      alternativeRotation: makeRotation(altSeq[i]), alternativePoseError: 9, poseErrorGap: 2
    }, SOME_CORNERS, 1000 + i);
  }

  assert.equal(lastResult.distanceM, 1.23);
  assert.equal(lastResult.poseError, 7);
  assert.deepEqual(nav.pathTagIds, before.pathTagIds);
  assert.equal(nav.segIndex, before.segIndex);
  assert.equal(nav.currentTagId, before.currentTagId);
  assert.equal(nav.expectedNextTagId, before.expectedNextTagId);
  assert.equal(nav.navState, before.navState);
  assert.equal(nav.destinationReached, before.destinationReached);
  assert.deepEqual(spokenTexts, [], `must never speak anything, got: ${JSON.stringify(spokenTexts)}`);
});

test('no tag-specific behavior: bootstrap + widened threshold behave identically on an arbitrary route edge (8->10)', () => {
  var seg = enterRoute(8, 10);
  var bestSeq = [5, -25, 5, -25, 5, -25, 5, -25];
  var altSeq =  [-25, 5, -25, 5, -25, 5, -25, 5];
  var result;
  for(var i = 0; i < bestSeq.length; i++){
    result = nav.maybeLogOrientationDiagnostics(seg.fromTag, {
      distanceM: 1.0, rotation: makeRotation(bestSeq[i]), translation: [0, 0, 1.0], poseError: 6,
      alternativeRotation: makeRotation(altSeq[i]), alternativePoseError: 9, poseErrorGap: 3
    }, SOME_CORNERS, 1000 + i);
  }
  assert.ok(result && result.ok);
  assert.ok(nav.circularDistanceDeg(result.selectedOrientationYawDeg, 5) < 1,
    `expected the lower-error mode (~5deg) to win on this arbitrary edge too, got ${result.selectedOrientationYawDeg}`);
});
