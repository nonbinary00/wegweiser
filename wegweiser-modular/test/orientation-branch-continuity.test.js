// Tests for the diagnostic/orientation-only temporal branch-continuity fix
// (see nav.js's selectOrientationBranch()/circularDistanceDeg() and the field
// evidence in wegweiser-v13-log-20260825-113344(9).json): POSIT recomputes
// both candidate rotations fresh every frame with no memory of the previous
// frame's choice, so when the two branches are near-tied in reprojection
// error (poseErrorGap small), ordinary sub-pixel jitter can flip which one
// wins even though the observed marker barely moved. This fix prefers
// whichever candidate is temporally closer to the previously SELECTED
// orientation yaw, but ONLY when the branches are near-tied -- it never
// touches estimatePose()'s own selection (distance/arrival/routing), never
// uses desiredRouteHeadingDeg to choose, and never loosens the classifier's
// existing thresholds.

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
  var toTag = nav.expectedNextTagId;
  assert.equal(fromTag, startTag);
  return { fromTag: fromTag, toTag: toTag };
}

// ==================== circularDistanceDeg() ====================

test('circularDistanceDeg: wrap-around case -- 179 and -178 are close (3deg), not 357deg apart', () => {
  assert.ok(Math.abs(nav.circularDistanceDeg(179, -178) - 3) < 1e-9);
});

test('circularDistanceDeg: ordinary non-wrapping case', () => {
  assert.equal(nav.circularDistanceDeg(10, -5), 15);
});

// ==================== selectOrientationBranch() -- pure unit tests ====================

test('selectOrientationBranch: no previous yaw -> always POSIT best (bootstrap)', () => {
  var choice = nav.selectOrientationBranch(13, -17, 0, null);
  assert.equal(choice.branch, 'best');
  assert.equal(choice.yawDeg, 13);
  assert.equal(choice.reason, 'initial-best');
});

test('selectOrientationBranch: near-tied errors, previous yaw near best -> keeps best', () => {
  var choice = nav.selectOrientationBranch(/*best*/ 10, /*alt*/ -170, /*gap*/ 0, /*prev*/ 12);
  assert.equal(choice.branch, 'best');
  assert.equal(choice.yawDeg, 10);
  assert.equal(choice.reason, 'continuity-best');
});

test('selectOrientationBranch: near-tied errors, previous yaw near alternative -> selects alternative', () => {
  var choice = nav.selectOrientationBranch(/*best*/ 13, /*alt*/ -17, /*gap*/ 0, /*prev*/ -16);
  assert.equal(choice.branch, 'alternative');
  assert.equal(choice.yawDeg, -17);
  assert.equal(choice.reason, 'continuity-alternative');
});

test('selectOrientationBranch: exact tie (poseErrorGap=0) is treated as ambiguous', () => {
  var choice = nav.selectOrientationBranch(20, -160, 0, -158);
  assert.equal(choice.branch, 'alternative');
});

test('selectOrientationBranch: small gap matching field data (poseErrorGap=1) is still treated as ambiguous', () => {
  // Field log 2026-08-25 113344(9): best=+12.54, alt=-15.06, poseErrorGap=1,
  // immediately following a selected yaw near -18.68.
  var choice = nav.selectOrientationBranch(12.54, -15.06, 1, -18.68);
  assert.equal(choice.branch, 'alternative');
  assert.equal(choice.yawDeg, -15.06);
});

test('selectOrientationBranch: large error gap -> best wins even if alternative is temporally closer', () => {
  // gap=5 is well beyond ORIENTATION_BRANCH_AMBIGUOUS_MAX_GAP -- POSIT's own
  // pick must never be second-guessed here, regardless of continuity.
  var choice = nav.selectOrientationBranch(/*best*/ 30, /*alt*/ -16, /*gap*/ 5, /*prev*/ -15);
  assert.equal(choice.branch, 'best');
  assert.equal(choice.yawDeg, 30);
  assert.equal(choice.reason, 'best-clear-error');
});

test('selectOrientationBranch: wrap-around continuity -- previous 179, best -178, alternative 150 -> best is correctly considered close', () => {
  var choice = nav.selectOrientationBranch(/*best*/ -178, /*alt*/ 150, /*gap*/ 0, /*prev*/ 179);
  assert.equal(choice.branch, 'best',
    'best (-178) is only 3deg from previous (179) the short way around; alternative (150) is 29deg away -- plain subtraction across +-180 would get this backwards');
});

test('selectOrientationBranch: real branch-swap fixture -- previous near -16, best near +13, alternative near -17 -> selects alternative', () => {
  var choice = nav.selectOrientationBranch(13, -17, 0, -16);
  assert.equal(choice.branch, 'alternative');
  assert.equal(choice.yawDeg, -17);
});

test('selectOrientationBranch: route heading is never a parameter -- selection is based only on reprojection quality and continuity', () => {
  // Structural check: the function takes exactly 4 parameters (bestYawDeg,
  // alternativeYawDeg, poseErrorGap, previousYawDeg) -- desiredRouteHeadingDeg
  // has no way to influence it.
  assert.equal(nav.selectOrientationBranch.length, 4);
});

// ==================== Integration: maybeLogOrientationDiagnostics() ====================

// Feeds the same pose repeatedly to run the multi-frame bootstrap (6 frames,
// see ORIENTATION_BOOTSTRAP_MAX_FRAMES) to completion on a single, unambiguous
// physical yaw, PLUS one more identical frame so the returned result reflects
// NORMAL post-bootstrap continuity (orientationBootstrapActive===false) --
// the 6th bootstrap frame itself is still correctly reported as active=true,
// since ITS OWN output came from bootstrap logic. See
// orientation-bootstrap.test.js for bootstrap mechanics themselves.
function warmUpBootstrap(fromTag, pose, cornersArg, startTimestamp){
  var result;
  for(var i = 0; i < 7; i++){
    result = nav.maybeLogOrientationDiagnostics(fromTag, pose, cornersArg, startTimestamp + i);
  }
  return result;
}

test('integration: the first qualifying frame starts the multi-frame bootstrap, not an immediate raw-best anchor', () => {
  var seg = enterRoute(6, 4);
  var pose = {
    distanceM: 1.0, rotation: makeRotation(13), translation: [0, 0, 1.0], poseError: 6,
    alternativeRotation: makeRotation(-17), alternativePoseError: 6, poseErrorGap: 0
  };
  var result = nav.maybeLogOrientationDiagnostics(seg.fromTag, pose, SOME_CORNERS, 1000);

  assert.ok(result && result.ok);
  assert.equal(result.orientationBootstrapActive, true);
  assert.equal(result.orientationBootstrapSampleCount, 1);
  assert.equal(result.selectedPoseBranch, 'bootstrap');
});

test('integration: post-bootstrap, a confirmed field-log branch swap is absorbed -- the orientation path keeps the previously selected physical branch', () => {
  var seg = enterRoute(6, 4);
  // Establishes a selected yaw near -16 across the bootstrap window (no
  // ambiguity to resolve yet -- both candidates tie on error every frame, so
  // bootstrap deterministically settles on whichever absorbed sample 0's own
  // "best", exactly like the pre-bootstrap anchor would have).
  var pose1 = {
    distanceM: 1.0, rotation: makeRotation(-16.44), translation: [0, 0, 1.0], poseError: 6,
    alternativeRotation: makeRotation(13.63), alternativePoseError: 6, poseErrorGap: 0
  };
  var result1 = warmUpBootstrap(seg.fromTag, pose1, SOME_CORNERS, 1000);
  assert.ok(result1 && result1.ok);
  assert.equal(result1.orientationBootstrapActive, false);
  assert.ok(Math.abs(result1.selectedOrientationYawDeg - (-16.44)) < 0.01);

  // Next frame: POSIT's OWN "best" swaps to the physically-same-orientation's
  // other branch (+12.54), with the true continuation (-15.06) now demoted
  // to "alternative" -- exactly the field log's confirmed swap pattern.
  var pose2 = {
    distanceM: 1.0, rotation: makeRotation(12.54), translation: [0, 0, 1.0], poseError: 6,
    alternativeRotation: makeRotation(-15.06), alternativePoseError: 7, poseErrorGap: 1
  };
  var result2 = nav.maybeLogOrientationDiagnostics(seg.fromTag, pose2, SOME_CORNERS, 1010);

  assert.ok(result2 && result2.ok);
  assert.equal(result2.selectedPoseBranch, 'alternative');
  assert.ok(Math.abs(result2.selectedOrientationYawDeg - (-15.06)) < 0.01,
    `expected the orientation path to stay near -16deg (continuity), got ${result2.selectedOrientationYawDeg}`);
  assert.equal(result2.selectedSolverLabelChanged, true,
    'selectedPoseBranch changed from "best" (previous frame) to "alternative" (this frame) -- a real solver-label transition, correctly flagged');
  assert.equal(result2.selectedYawJumped, false,
    'the ACTUAL selected yaw stayed continuous -- this is the field-relevant diagnostic, unlike the old label-based flag');
  // Crucially: the RAW POSIT best yaw did jump by ~29deg (unchanged, still
  // exposed for comparison) even though the orientation-path output did not.
  assert.ok(Math.abs(result2.relativeCameraYawDeg - 12.54) < 0.01);
  assert.ok(Math.abs(result2.relativeCameraYawDeg - result1.relativeCameraYawDeg) > 15);
  assert.ok(Math.abs(result2.selectedOrientationYawDeg - result1.selectedOrientationYawDeg) < 5,
    'the SELECTED orientation yaw should stay temporally consistent, unlike the raw best yaw');
});

test('integration: temporal continuity stabilizes the heading window and classifier output across a synthetic repeated branch-swap sequence', () => {
  var seg = enterRoute(6, 4);
  // Simulates a physically STATIC observation where POSIT's own best/
  // alternative labels swap every single frame between two near-tied
  // branches ~30deg apart (matching the field-log cluster separation),
  // poseErrorGap=0 throughout -- the exact pathological pattern from the
  // field logs.
  var bestSeq = [8, -22, 8, -22, 8, -22, 8, -22];
  var altSeq =  [-22, 8, -22, 8, -22, 8, -22, 8];
  var result;
  for(var i = 0; i < bestSeq.length; i++){
    var pose = {
      distanceM: 1.0, rotation: makeRotation(bestSeq[i]), translation: [0, 0, 1.0], poseError: 9,
      alternativeRotation: makeRotation(altSeq[i]), alternativePoseError: 9, poseErrorGap: 0
    };
    result = nav.maybeLogOrientationDiagnostics(seg.fromTag, pose, SOME_CORNERS, 1000 + i);
  }

  assert.ok(result && result.ok);
  // Without the continuity fix this window would mix headingErrorDeg samples
  // ~30deg apart every frame and blow well past the (unchanged) 10deg stddev
  // stability threshold -- see ORIENTATION_MAX_STABLE_STDDEV_DEG.
  assert.ok(result.stability.stdDevDeg < 10,
    `expected a low, branch-consistent stddev, got ${result.stability.stdDevDeg}`);
  assert.notEqual(result.classification, 'UNSTABLE_WINDOW',
    `expected a real directional classification once the branch is held steady, got ${result.classification} (${result.classificationReason})`);
});

test('integration: generic across an arbitrary route edge (8->10) -- no tag-specific behavior', () => {
  var seg = enterRoute(8, 10);
  var pose1 = {
    distanceM: 1.0, rotation: makeRotation(5), translation: [0, 0, 1.0], poseError: 6,
    alternativeRotation: makeRotation(-25), alternativePoseError: 6, poseErrorGap: 0
  };
  var result1 = warmUpBootstrap(seg.fromTag, pose1, SOME_CORNERS, 1000);
  assert.ok(result1 && result1.ok);
  assert.equal(result1.orientationBootstrapActive, false);
  assert.ok(Math.abs(result1.selectedOrientationYawDeg - 5) < 0.01);

  var pose2 = {
    distanceM: 1.0, rotation: makeRotation(-25), translation: [0, 0, 1.0], poseError: 6,
    alternativeRotation: makeRotation(5), alternativePoseError: 6, poseErrorGap: 0
  };
  var result2 = nav.maybeLogOrientationDiagnostics(seg.fromTag, pose2, SOME_CORNERS, 1010);
  assert.ok(result2 && result2.ok);
  assert.equal(result2.selectedPoseBranch, 'alternative');
  assert.ok(Math.abs(result2.selectedOrientationYawDeg - 5) < 0.01, 'continuity should hold the same physical branch (yaw ~5deg)');
});

test('reset: a new segment bootstraps fresh (no leaked continuity state)', () => {
  var seg1 = enterRoute(6, 4);
  warmUpBootstrap(seg1.fromTag, {
    distanceM: 1.0, rotation: makeRotation(-16), translation: [0, 0, 1.0], poseError: 6,
    alternativeRotation: makeRotation(13), alternativePoseError: 6, poseErrorGap: 0
  }, SOME_CORNERS, 1000);

  // A fresh route/segment (even the same edge again) must not remember the
  // previous approach's selected yaw, nor its bootstrap sample count --
  // resetSegmentState() clears both.
  var seg2 = enterRoute(6, 4);
  var result = nav.maybeLogOrientationDiagnostics(seg2.fromTag, {
    distanceM: 1.0, rotation: makeRotation(13), translation: [0, 0, 1.0], poseError: 6,
    alternativeRotation: makeRotation(-16), alternativePoseError: 6, poseErrorGap: 0
  }, SOME_CORNERS, 2000);

  assert.ok(result && result.ok);
  assert.equal(result.orientationBootstrapActive, true, 'expected a fresh bootstrap, not continuity with the previous approach');
  assert.equal(result.orientationBootstrapSampleCount, 1, 'bootstrap sample count must not carry over from the previous segment');
});

// ==================== Isolation / non-regression ====================

test('distance/arrival-relevant fields (poseError, distanceM) are untouched by the orientation continuity fix', () => {
  var seg = enterRoute(6, 4);
  var pose = {
    distanceM: 1.23, rotation: makeRotation(-16), translation: [0, 0, 1.23], poseError: 7,
    alternativeRotation: makeRotation(13), alternativePoseError: 7, poseErrorGap: 0
  };
  var result = nav.maybeLogOrientationDiagnostics(seg.fromTag, pose, SOME_CORNERS, 1000);
  assert.ok(result && result.ok);
  assert.equal(result.distanceM, 1.23);
  assert.equal(result.poseError, 7);
});

test('no TTS or navigation-state side effects across a branch-swap sequence', () => {
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
  for(var i = 0; i < bestSeq.length; i++){
    nav.maybeLogOrientationDiagnostics(seg.fromTag, {
      distanceM: 1.0, rotation: makeRotation(bestSeq[i]), translation: [0, 0, 1.0], poseError: 9,
      alternativeRotation: makeRotation(altSeq[i]), alternativePoseError: 9, poseErrorGap: 0
    }, SOME_CORNERS, 1000 + i);
  }

  assert.deepEqual(nav.pathTagIds, before.pathTagIds);
  assert.equal(nav.segIndex, before.segIndex);
  assert.equal(nav.currentTagId, before.currentTagId);
  assert.equal(nav.expectedNextTagId, before.expectedNextTagId);
  assert.equal(nav.navState, before.navState);
  assert.equal(nav.destinationReached, before.destinationReached);
  assert.deepEqual(spokenTexts, [], `must never speak anything, got: ${JSON.stringify(spokenTexts)}`);
});
