// Tests for the diagnostic-only exposure of the POSIT alternative pose branch
// inside nav.js's maybeLogOrientationDiagnostics() -- see distance.js's
// estimatePose() (which now additionally returns alternativeRotation/
// alternativePoseError/poseErrorGap/poseErrorGapRatio, all diagnostic-only)
// and test/distance-alternative-pose.test.js (which proves those fields are
// wired correctly against the real POSIT solver).
//
// This file proves the nav.js side: alternativeRelativeCameraYawDeg is derived
// with the IDENTICAL formula/convention as relativeCameraYawDeg, poseErrorGap
// passes through correctly, none of it is used by the classifier, and
// classification/navState/TTS are completely unaffected -- both when the
// alternative branch IS present and when it's absent (as in every prior
// orientation test file's mocks, none of which set these fields).

import test from 'node:test';
import assert from 'node:assert/strict';
import { spokenTexts } from './browser-stubs.js';
import { destSel } from '../js/dom.js';
import { MARKERS } from '../js/graph.js';
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

// extra: {alternativeRotationYawDeg, alternativePoseError, poseError, poseErrorGap, poseErrorGapRatio}
function makePoseResult(yawDeg, distanceM, extra){
  var base = {
    distanceM: distanceM == null ? 1.0 : distanceM,
    rotation: makeRotation(yawDeg),
    translation: [0, 0, distanceM == null ? 1.0 : distanceM],
    poseError: 9
  };
  if(extra){
    if(extra.alternativeYawDeg != null){
      base.alternativeRotation = makeRotation(extra.alternativeYawDeg);
    }
    if(extra.alternativePoseError != null) base.alternativePoseError = extra.alternativePoseError;
    if(extra.poseError != null) base.poseError = extra.poseError;
    if(extra.poseErrorGap != null) base.poseErrorGap = extra.poseErrorGap;
    if(extra.poseErrorGapRatio != null) base.poseErrorGapRatio = extra.poseErrorGapRatio;
  }
  return base;
}

var SOME_CORNERS = [{ x: 100, y: 100 }, { x: 140, y: 100 }, { x: 140, y: 140 }, { x: 100, y: 140 }];

// Arbitrary route edge (6->4), same pattern as orientation-classifier.test.js/
// orientation-circular.test.js -- not the historical 3->6 pair, and no
// tag-specific logic is exercised here either way.
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

test('alternativeRelativeCameraYawDeg uses the identical atan2 formula/convention as relativeCameraYawDeg', () => {
  var seg = enterRoute(6, 4);
  var pose = makePoseResult(12.5, 1.0, { alternativeYawDeg: -37.8, alternativePoseError: 10, poseError: 9 });
  var result = nav.maybeLogOrientationDiagnostics(seg.fromTag, pose, SOME_CORNERS, 1000);

  assert.ok(result && result.ok);
  // Ground truth: the exact same formula applied directly to the mock's
  // alternativeRotation, independent of nav.js's implementation.
  var altR = pose.alternativeRotation;
  var expectedAltYaw = Math.atan2(altR[2][0], altR[2][2]) * 180 / Math.PI;
  assert.ok(Math.abs(result.alternativeRelativeCameraYawDeg - expectedAltYaw) < 0.01,
    `expected ${expectedAltYaw}, got ${result.alternativeRelativeCameraYawDeg}`);
  // And it must be a DIFFERENT convention/value from the best yaw for a
  // genuinely different alternative rotation -- proving it isn't accidentally
  // just echoing relativeCameraYawDeg back.
  assert.notEqual(result.alternativeRelativeCameraYawDeg, result.relativeCameraYawDeg);
});

test('poseErrorGap passes through from the poseResult (computed once, upstream in distance.js, as abs(alternativePoseError - poseError))', () => {
  var seg = enterRoute(6, 4);
  var pose = makePoseResult(0, 1.0, { alternativeYawDeg: 25, alternativePoseError: 14, poseError: 9, poseErrorGap: 5 });
  var result = nav.maybeLogOrientationDiagnostics(seg.fromTag, pose, SOME_CORNERS, 1000);

  assert.ok(result && result.ok);
  assert.equal(result.poseErrorGap, 5);
  assert.equal(result.alternativePoseError, 14);
});

test('poseErrorGapRatio passes through from the poseResult (guarded upstream in distance.js)', () => {
  var seg = enterRoute(6, 4);
  var pose = makePoseResult(0, 1.0, { alternativeYawDeg: 25, alternativePoseError: 14, poseError: 9, poseErrorGapRatio: 5 / 9 });
  var result = nav.maybeLogOrientationDiagnostics(seg.fromTag, pose, SOME_CORNERS, 1000);

  assert.ok(result && result.ok);
  assert.ok(Math.abs(result.poseErrorGapRatio - 5 / 9) < 0.01);
});

test('when the alternative branch is absent (no alternativeRotation on poseResult), the new fields are all null -- never crashes, never fabricates data', () => {
  var seg = enterRoute(6, 4);
  var pose = makePoseResult(3, 1.0); // no `extra` -- matches every prior orientation test file's mocks
  var result = nav.maybeLogOrientationDiagnostics(seg.fromTag, pose, SOME_CORNERS, 1000);

  assert.ok(result && result.ok);
  assert.equal(result.alternativeRelativeCameraYawDeg, null);
  assert.equal(result.alternativePoseError, null);
  assert.equal(result.poseErrorGap, null);
  assert.equal(result.poseErrorGapRatio, null);
});

test('existing classifier output is unchanged for the same best-pose input, regardless of whether alternative-branch diagnostics are attached', () => {
  var seg1 = enterRoute(6, 4);
  var withoutAlt;
  for(var i = 0; i < 8; i++){
    withoutAlt = nav.maybeLogOrientationDiagnostics(seg1.fromTag, makePoseResult(2, 1.0), SOME_CORNERS, 1000 + i);
  }

  var seg2 = enterRoute(6, 4);
  var withAlt;
  for(var j = 0; j < 8; j++){
    withAlt = nav.maybeLogOrientationDiagnostics(
      seg2.fromTag,
      makePoseResult(2, 1.0, { alternativeYawDeg: -160, alternativePoseError: 40, poseError: 9 }),
      SOME_CORNERS, 2000 + j);
  }

  assert.equal(withoutAlt.classification, withAlt.classification);
  assert.equal(withoutAlt.headingErrorDeg, withAlt.headingErrorDeg);
  assert.equal(withoutAlt.relativeCameraYawDeg, withAlt.relativeCameraYawDeg);
  assert.deepEqual(withoutAlt.stability, withAlt.stability);
});

test('no TTS or navigation-state side effects, including when alternative-branch data is present', () => {
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

  for(var i = 0; i < 8; i++){
    nav.maybeLogOrientationDiagnostics(
      seg.fromTag,
      makePoseResult(i * 5 - 15, 1.0, { alternativeYawDeg: 170 - i, alternativePoseError: 20 + i, poseError: 9 }),
      SOME_CORNERS, 1000 + i);
  }

  assert.deepEqual(nav.pathTagIds, before.pathTagIds);
  assert.equal(nav.segIndex, before.segIndex);
  assert.equal(nav.currentTagId, before.currentTagId);
  assert.equal(nav.expectedNextTagId, before.expectedNextTagId);
  assert.equal(nav.navState, before.navState);
  assert.equal(nav.destinationReached, before.destinationReached);
  assert.deepEqual(spokenTexts, [], `must never speak anything, got: ${JSON.stringify(spokenTexts)}`);
});
