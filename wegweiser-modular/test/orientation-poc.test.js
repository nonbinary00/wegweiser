// Behavioral tests for the Tag 3 -> Tag 6 orientation-guidance proof-of-concept
// (LOGGING ONLY -- see the accompanying feasibility audit and PoC design).
//
// maybeLogOrientationDiagnostics() reuses distance.js's existing POSIT pose solve
// (never re-runs it) purely to log diagnostic heading-alignment data for exactly
// one segment (3 -> 6). It must never change navigation state or speech, and must
// never fire for any other segment. logger.js has no data-accessor for its
// internal buffer (exportJson() is a browser download/share side effect, not a
// return value -- see distance.js/nav.js comments), so these tests assert on
// maybeLogOrientationDiagnostics()'s own return value instead of the log itself;
// that return value mirrors exactly what gets logged.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spokenTexts } from './browser-stubs.js';
import { destSel } from '../js/dom.js';
import { MARKERS } from '../js/graph.js';
import * as nav from '../js/nav.js';

function selectDestination(id){
  destSel.value = String(id);
}

function resetState(){
  nav.endNavigation(false);
  spokenTexts.length = 0;
  nav.setTag9DetectorHooks(null);
  nav.setAdaptiveDetectorActive(false);
}

// A rotation matrix with R[2][0]=sin(yaw), R[2][2]=cos(yaw), matching exactly what
// maybeLogOrientationDiagnostics() reads (atan2(R[2][0], R[2][2])) -- the other
// entries are never read by the function, so they are filled with a plausible
// identity-like placeholder only for shape realism.
function makeRotation(yawDeg){
  var yaw = yawDeg * Math.PI / 180;
  return [
    [Math.cos(yaw), 0, Math.sin(yaw)],
    [0, 1, 0],
    [Math.sin(yaw), 0, Math.cos(yaw)]
  ];
}

function makePoseResult(yawDeg, extra){
  var base = { distanceM: 2.0, rotation: makeRotation(yawDeg), translation: [0, 0, 2.0], poseError: 0 };
  if(extra) for(var k in extra) base[k] = extra[k];
  return base;
}

var SOME_CORNERS = [{ x: 100, y: 100 }, { x: 140, y: 100 }, { x: 140, y: 140 }, { x: 100, y: 140 }];

// Drives a real route so pathTagIds[segIndex] === 3 && expectedNextTagId === 6,
// exactly matching the PoC's qualifying condition (covers both the "start
// orientation from Tag 3 toward Tag 6" and "current segment is 3->6" cases, since
// they are structurally the same check -- see nav.js). Tag 6 ("Korridor") is not
// itself a valid destination (NODES[6].destination === false, a pure waypoint --
// see graph-data.js), so this routes THROUGH 3->6 to Tag 4 instead
// (findPath(3,4) = [3,6,4]) -- the first segment of that route is still exactly 3->6.
function enterTag3To6Segment(){
  resetState();
  selectDestination(4);
  nav.startNavigation();
  nav.onStartTagConfirmed(3); // findPath(3,4) = [3,6,4]
  assert.deepEqual(nav.pathTagIds, [3, 6, 4]);
  assert.equal(nav.pathTagIds[nav.segIndex], 3);
  assert.equal(nav.expectedNextTagId, 6);
}

// ==================== Test A: heading math ====================

test('Test A: a yaw that aligns the camera with the real 3->6 route heading produces near-zero heading error', () => {
  enterTag3To6Segment();
  var desired = nav.bearingDeg(MARKERS[3], MARKERS[6]);
  assert.ok(Math.abs(desired - 176.46) < 0.1,
    `sanity check on the known geometry, got desiredRouteHeadingDeg=${desired}`);

  // cameraHeadingWorldDeg = dir_deg + 180 - yaw; solving for yaw so that
  // cameraHeadingWorldDeg == desired exactly.
  var yawForAlignment = (MARKERS[3].dir_deg + 180) - desired;
  var result = nav.maybeLogOrientationDiagnostics(3, makePoseResult(yawForAlignment), SOME_CORNERS, 1000);

  assert.ok(result && result.ok, `expected a successful diagnostic result, got: ${JSON.stringify(result)}`);
  assert.ok(Math.abs(result.desiredRouteHeadingDeg - 176.46) < 0.1,
    `expected desiredRouteHeadingDeg near 176.46, got ${result.desiredRouteHeadingDeg}`);
  assert.ok(Math.abs(result.headingErrorDeg) < 0.01,
    `expected near-zero heading error when aligned, got ${result.headingErrorDeg}`);
});

// ==================== Test B: left/right sign ====================

test('Test B: opposite yaw directions produce opposite-signed heading error, matching the left/right convention', () => {
  enterTag3To6Segment();
  var desired = nav.bearingDeg(MARKERS[3], MARKERS[6]);
  var yawForAlignment = (MARKERS[3].dir_deg + 180) - desired;

  var turnedLeft = nav.maybeLogOrientationDiagnostics(
    3, makePoseResult(yawForAlignment - 25), SOME_CORNERS, 1000); // camera yawed left of aligned
  var turnedRight = nav.maybeLogOrientationDiagnostics(
    3, makePoseResult(yawForAlignment + 25), SOME_CORNERS, 1000); // camera yawed right of aligned

  assert.ok(turnedLeft.ok && turnedRight.ok);
  assert.ok(turnedLeft.headingErrorDeg < 0,
    `camera turned left of the desired heading should read as a NEGATIVE (turn-right-to-correct) error, got ${turnedLeft.headingErrorDeg}`);
  assert.ok(turnedRight.headingErrorDeg > 0,
    `camera turned right of the desired heading should read as a POSITIVE (turn-left-to-correct) error, got ${turnedRight.headingErrorDeg}`);
  // Intended interpretation, stated explicitly (logging only -- no instruction is
  // spoken from this yet):
  //   positive headingErrorDeg -> desired direction is to the LEFT of current heading
  //   negative headingErrorDeg -> desired direction is to the RIGHT of current heading
  assert.ok(Math.sign(turnedLeft.headingErrorDeg) !== Math.sign(turnedRight.headingErrorDeg));
});

// ==================== Test C: normalization ====================

test('Test C: normalizeDeg wraps into [0, 360)', () => {
  assert.equal(nav.normalizeDeg(370), 10);
  assert.equal(nav.normalizeDeg(-10), 350);
  assert.equal(nav.normalizeDeg(0), 0);
  assert.equal(nav.normalizeDeg(360), 0);
  assert.equal(nav.normalizeDeg(720 + 45), 45);
});

test('Test C: normalizeSignedDeg wraps into [-180, 180)', () => {
  assert.equal(nav.normalizeSignedDeg(190), -170);
  assert.equal(nav.normalizeSignedDeg(-190), 170);
  assert.equal(nav.normalizeSignedDeg(180), -180);
  assert.equal(nav.normalizeSignedDeg(-180), -180);
  assert.ok(Math.abs(nav.normalizeSignedDeg(179.9) - 179.9) < 1e-9);
  assert.ok(Math.abs(nav.normalizeSignedDeg(-179.9) - (-179.9)) < 1e-9);
});

// ==================== Test D: isolation ====================

test('Test D: orientation diagnostics never alter navigation state or spoken text', () => {
  enterTag3To6Segment();
  spokenTexts.length = 0;
  var before = {
    pathTagIds: nav.pathTagIds.slice(),
    segIndex: nav.segIndex,
    currentTagId: nav.currentTagId,
    expectedNextTagId: nav.expectedNextTagId,
    navState: nav.navState,
    destinationReached: nav.destinationReached
  };

  for(var i = 0; i < 5; i++){
    nav.maybeLogOrientationDiagnostics(3, makePoseResult(i * 7 - 15), SOME_CORNERS, 1000 + i);
  }
  // Also exercise the quality-failure paths -- these must be equally inert.
  nav.maybeLogOrientationDiagnostics(3, null, SOME_CORNERS, 2000);
  nav.maybeLogOrientationDiagnostics(3, makePoseResult(5), null, 2001);

  assert.deepEqual(nav.pathTagIds, before.pathTagIds);
  assert.equal(nav.segIndex, before.segIndex);
  assert.equal(nav.currentTagId, before.currentTagId);
  assert.equal(nav.expectedNextTagId, before.expectedNextTagId);
  assert.equal(nav.navState, before.navState);
  assert.equal(nav.destinationReached, before.destinationReached);
  assert.deepEqual(spokenTexts, [], `must never speak anything, got: ${JSON.stringify(spokenTexts)}`);
});

// ==================== Test E: isolation across an unrelated route ====================

test('Test E: does not emit orientation diagnostics for a route whose current segment is not 3->6', () => {
  resetState();
  selectDestination(4);
  nav.startNavigation();
  nav.onStartTagConfirmed(6); // findPath(6,4) = [6,4] -- current segment is 6->4, not 3->6
  assert.deepEqual(nav.pathTagIds, [6, 4]);

  var result = nav.maybeLogOrientationDiagnostics(3, makePoseResult(0), SOME_CORNERS, 1000);
  assert.equal(result, null, `expected no diagnostic for an unrelated route, got: ${JSON.stringify(result)}`);
});

test('Test E: a Tag 3 sighting mid-route, when the CURRENT segment is not 3->6, produces no diagnostic', () => {
  // Route [1,2,3,6,4,...] passes through Tag 3, but the qualifying condition is
  // scoped to the ACTIVE segment (pathTagIds[segIndex] -> expectedNextTagId),
  // not merely "does Tag 3 appear anywhere in the path".
  resetState();
  selectDestination(11);
  nav.startNavigation();
  nav.onStartTagConfirmed(1);
  var dist = 0.1;
  nav.setEmaDist(dist);
  nav.handleTracking(performance.now(), true, dist);
  nav.handleTracking(performance.now(), true, dist); // Tag 1 reached -> beginSegment() for 1->2
  nav.onNextTagFound(dist);
  nav.setEmaDist(dist);
  nav.handleTracking(performance.now(), true, dist);
  nav.handleTracking(performance.now(), true, dist); // Tag 2 reached -> now tracking 2->3
  assert.equal(nav.expectedNextTagId, 3);

  var result = nav.maybeLogOrientationDiagnostics(3, makePoseResult(0), SOME_CORNERS, 1000);
  assert.equal(result, null,
    `expected no diagnostic while approaching Tag 3 (not yet reached, segment is 2->3), got: ${JSON.stringify(result)}`);
});

// ==================== Failure/quality logging ====================

test('quality failures are reported with a reason and never throw', () => {
  enterTag3To6Segment();

  var missingRotation = nav.maybeLogOrientationDiagnostics(3, null, SOME_CORNERS, 1000);
  assert.deepEqual(missingRotation, { ok: false, reason: 'missing-rotation' });

  var invalidCorners = nav.maybeLogOrientationDiagnostics(3, makePoseResult(0), [{ x: 1, y: 1 }], 1000);
  assert.deepEqual(invalidCorners, { ok: false, reason: 'invalid-corners' });

  var noRotationField = nav.maybeLogOrientationDiagnostics(
    3, { distanceM: 2.0, translation: [0, 0, 2], poseError: 0 }, SOME_CORNERS, 1000);
  assert.deepEqual(noRotationField, { ok: false, reason: 'missing-rotation' });
});
