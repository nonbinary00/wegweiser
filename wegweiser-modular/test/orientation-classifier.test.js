// Tests for the generic diagnostic orientation classifier (LOGGING ONLY -- see
// nav.js's "Orientation-guidance diagnostics" block). This builds on the same
// heading math covered by orientation-poc.test.js (bearingDeg/normalizeSignedDeg/
// the 3->6 PoC), but proves the qualifying gate and the classification itself are
// generic across ANY route edge, not hardcoded to a specific tag pair.
//
// classifyHeadingZone()/classifyOrientation() are pure, stateless functions --
// exercised directly here without driving nav state. The integration tests below
// deliberately use the 6->4 segment (NOT 3->6) to prove there is no tag-specific
// logic left in maybeLogOrientationDiagnostics().

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

// Matches orientation-poc.test.js's makeRotation(): R[2][0]=sin(yaw), R[2][2]=cos(yaw).
function makeRotation(yawDeg){
  var yaw = yawDeg * Math.PI / 180;
  return [
    [Math.cos(yaw), 0, Math.sin(yaw)],
    [0, 1, 0],
    [Math.sin(yaw), 0, Math.cos(yaw)]
  ];
}

function makePoseResult(yawDeg, distanceM){
  return {
    distanceM: distanceM == null ? 1.0 : distanceM,
    rotation: makeRotation(yawDeg),
    translation: [0, 0, distanceM == null ? 1.0 : distanceM],
    poseError: 0
  };
}

var SOME_CORNERS = [{ x: 100, y: 100 }, { x: 140, y: 100 }, { x: 140, y: 140 }, { x: 100, y: 140 }];
var STABLE_STABILITY = { sampleCount: 8, meanHeadingErrorDeg: 0, minHeadingErrorDeg: 0, maxHeadingErrorDeg: 0, spreadDeg: 1, stdDevDeg: 1 };

// ==================== Pure angle-zone tests (classifyHeadingZone) ====================

test('classifyHeadingZone: near-zero error is ALIGNED', () => {
  assert.equal(nav.classifyHeadingZone(0), 'ALIGNED');
  assert.equal(nav.classifyHeadingZone(5), 'ALIGNED');
  assert.equal(nav.classifyHeadingZone(-5), 'ALIGNED');
});

test('classifyHeadingZone: a clear positive error is LEFT', () => {
  assert.equal(nav.classifyHeadingZone(45), 'LEFT');
  assert.equal(nav.classifyHeadingZone(90), 'LEFT');
});

test('classifyHeadingZone: a clear negative error is RIGHT', () => {
  assert.equal(nav.classifyHeadingZone(-45), 'RIGHT');
  assert.equal(nav.classifyHeadingZone(-90), 'RIGHT');
});

test('classifyHeadingZone: near +-180 is OPPOSITE, never LEFT/RIGHT', () => {
  assert.equal(nav.classifyHeadingZone(170), 'OPPOSITE');
  assert.equal(nav.classifyHeadingZone(-170), 'OPPOSITE');
  assert.equal(nav.classifyHeadingZone(180), 'OPPOSITE');
});

test('classifyHeadingZone: wraparound near 179/-179 both classify as OPPOSITE', () => {
  assert.equal(nav.classifyHeadingZone(179.9), 'OPPOSITE');
  assert.equal(nav.classifyHeadingZone(-179.9), 'OPPOSITE');
});

// ==================== Pure gate tests (classifyOrientation) ====================

test('classifyOrientation: distance beyond the trust threshold is UNSTABLE_DISTANCE regardless of angle/stability', () => {
  var result = nav.classifyOrientation(2.0, STABLE_STABILITY, 0);
  assert.equal(result.classification, 'UNSTABLE_DISTANCE');
});

test('classifyOrientation: an insufficient or noisy window is UNSTABLE_WINDOW even at a trusted distance', () => {
  var tooFewSamples = nav.classifyOrientation(1.0, { sampleCount: 2, stdDevDeg: 1 }, 0);
  assert.equal(tooFewSamples.classification, 'UNSTABLE_WINDOW');

  var tooNoisy = nav.classifyOrientation(1.0, { sampleCount: 8, stdDevDeg: 40 }, 0);
  assert.equal(tooNoisy.classification, 'UNSTABLE_WINDOW');
});

test('classifyOrientation: stable, close, aligned reading classifies as ALIGNED', () => {
  var result = nav.classifyOrientation(1.0, STABLE_STABILITY, 2);
  assert.equal(result.classification, 'ALIGNED');
});

// ==================== Generic route-edge integration (no tag-specific logic) ====================

// findPath(6,4) = [6,4] -- deliberately NOT the 3->6 PoC pair, to prove the
// classifier derives its desired heading from whatever the ACTIVE route segment
// is, not from a hardcoded tag pair.
function enterArbitrarySegment(){
  resetState();
  selectDestination(4);
  nav.startNavigation();
  nav.onStartTagConfirmed(6); // findPath(6,4) = [6,4]
  assert.deepEqual(nav.pathTagIds, [6, 4]);
  assert.equal(nav.pathTagIds[nav.segIndex], 6);
  assert.equal(nav.expectedNextTagId, 4);
}

test('generic: an arbitrary 6->4 segment is classified using its own geometry (no Tag-3/6-specific hardcoding left)', () => {
  enterArbitrarySegment();
  var desired = nav.bearingDeg(MARKERS[6], MARKERS[4]);
  var yawForAlignment = (MARKERS[6].dir_deg + 180) - desired;

  var result = nav.maybeLogOrientationDiagnostics(6, makePoseResult(yawForAlignment, 1.0), SOME_CORNERS, 1000);
  assert.ok(result && result.ok, `expected a successful diagnostic result, got: ${JSON.stringify(result)}`);
  assert.ok(Math.abs(result.headingErrorDeg) < 0.01);
  // Only 1 sample so far -- the stability gate applies uniformly regardless of
  // which tag pair is active, so this is UNSTABLE_WINDOW even though the angle
  // itself is already aligned.
  assert.equal(result.classification, 'UNSTABLE_WINDOW');
});

test('generic: classification reaches ALIGNED for an arbitrary segment once the window is full and stable', () => {
  enterArbitrarySegment();
  var desired = nav.bearingDeg(MARKERS[6], MARKERS[4]);
  var yawForAlignment = (MARKERS[6].dir_deg + 180) - desired;

  var result;
  for(var i = 0; i < 8; i++){
    result = nav.maybeLogOrientationDiagnostics(6, makePoseResult(yawForAlignment, 1.0), SOME_CORNERS, 1000 + i);
  }
  assert.ok(result && result.ok);
  assert.equal(result.classification, 'ALIGNED');
});

test('generic: classification is UNSTABLE_DISTANCE for an arbitrary segment when the tag is farther than the trust threshold', () => {
  enterArbitrarySegment();
  var desired = nav.bearingDeg(MARKERS[6], MARKERS[4]);
  var yawForAlignment = (MARKERS[6].dir_deg + 180) - desired;

  var result;
  for(var i = 0; i < 8; i++){
    result = nav.maybeLogOrientationDiagnostics(6, makePoseResult(yawForAlignment, 2.0), SOME_CORNERS, 1000 + i);
  }
  assert.ok(result && result.ok);
  assert.equal(result.classification, 'UNSTABLE_DISTANCE');
});

test('generic: classification transitions from OPPOSITE to ALIGNED as the user turns to face the route', () => {
  enterArbitrarySegment();
  var desired = nav.bearingDeg(MARKERS[6], MARKERS[4]);
  var yawForAlignment = (MARKERS[6].dir_deg + 180) - desired;
  var yawForOpposite = yawForAlignment + 180; // camera facing squarely backwards

  var oppositeResult;
  for(var i = 0; i < 8; i++){
    oppositeResult = nav.maybeLogOrientationDiagnostics(6, makePoseResult(yawForOpposite, 1.0), SOME_CORNERS, 1000 + i);
  }
  assert.ok(oppositeResult && oppositeResult.ok);
  assert.equal(oppositeResult.classification, 'OPPOSITE');

  var alignedResult;
  for(var j = 0; j < 8; j++){
    alignedResult = nav.maybeLogOrientationDiagnostics(6, makePoseResult(yawForAlignment, 1.0), SOME_CORNERS, 2000 + j);
  }
  assert.ok(alignedResult && alignedResult.ok);
  assert.equal(alignedResult.classification, 'ALIGNED');
});

test('generic: orientation classification never alters navigation state or spoken text', () => {
  enterArbitrarySegment();
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
    nav.maybeLogOrientationDiagnostics(6, makePoseResult(i * 11 - 30, 1.0), SOME_CORNERS, 1000 + i);
  }

  assert.deepEqual(nav.pathTagIds, before.pathTagIds);
  assert.equal(nav.segIndex, before.segIndex);
  assert.equal(nav.currentTagId, before.currentTagId);
  assert.equal(nav.expectedNextTagId, before.expectedNextTagId);
  assert.equal(nav.navState, before.navState);
  assert.equal(nav.destinationReached, before.destinationReached);
  assert.deepEqual(spokenTexts, [], `must never speak anything, got: ${JSON.stringify(spokenTexts)}`);
});
