// Tests for the circular-statistics fix to the orientation classifier's rolling
// heading-error window (LOGGING ONLY -- see nav.js's "Orientation-guidance
// diagnostics" block, circularMeanDeg(), and the field-log evidence that
// motivated this fix).
//
// Bug: the heading-error window can straddle the +-180 wrap boundary (e.g. a
// user standing still, facing near-opposite the route direction, with samples
// like +170/-172 that are only ~18deg apart on the circle). Ordinary linear
// mean/min/max/stddev treat those as ~340deg apart, producing a nonsense mean
// near 0 and a huge stddev -> spurious UNSTABLE_WINDOW even though the
// orientation is physically rock-stable. Several of the exact windows below
// are taken directly from field logs captured 2026-08-25 (fromTag/toTag 3->15
// and 7->4) that exhibited this.
//
// Fix: circularMeanDeg() (sin/cos-averaged mean) plus wrap-safe deviations
// (normalizeSignedDeg(sample - mean)) for min/max/spread/stddev. When a window
// never crosses +-180 this is numerically identical to the old linear stats
// (see the "genuinely noisy, non-wraparound" tests below, which reproduce
// real field values and must still classify UNSTABLE_WINDOW -- proving the
// 10deg stddev threshold was not loosened, only the math was fixed).
//
// Also: classification now uses the window's circular mean, not the latest
// instantaneous headingErrorDeg -- a field log showed a stable ~+165deg window
// (OPPOSITE) flip to LEFT for one frame merely because that frame's
// instantaneous sample dipped to 153.74deg, just under the 155deg threshold.

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

function makePoseResult(yawDeg, distanceM){
  return {
    distanceM: distanceM == null ? 1.0 : distanceM,
    rotation: makeRotation(yawDeg),
    translation: [0, 0, distanceM == null ? 1.0 : distanceM],
    poseError: 0
  };
}

var SOME_CORNERS = [{ x: 100, y: 100 }, { x: 140, y: 100 }, { x: 140, y: 140 }, { x: 100, y: 140 }];

// Drives a route from startTag toward destinationId so a specific sequence of
// target headingErrorDeg values can be fed in via yaw, for whatever the
// ACTIVE first segment turns out to be (pathTagIds[segIndex] -> expectedNextTagId
// -- not necessarily startTag->destinationId directly, e.g. 3->4 routes through
// 3->6 first, matching orientation-poc.test.js's Tag-6-is-not-a-destination note).
// headingErrorDeg = yaw - yawForAlignment (see orientation-poc.test.js's Test
// A/B derivation), so yaw = yawForAlignment + h reproduces an exact target
// heading error h for this segment's geometry.
function enterRoute(startTag, destinationId){
  resetState();
  selectDestination(destinationId);
  nav.startNavigation();
  nav.onStartTagConfirmed(startTag);
  var fromTag = nav.pathTagIds[nav.segIndex];
  var toTag = nav.expectedNextTagId;
  assert.equal(fromTag, startTag);
  var fromMarker = MARKERS[fromTag];
  var toMarker = MARKERS[toTag];
  var desired = nav.bearingDeg(fromMarker, toMarker);
  var yawForAlignment = (fromMarker.dir_deg + 180) - desired;
  return { fromTag: fromTag, yawForAlignment: yawForAlignment };
}

// Feeds a sequence of target headingErrorDeg values through
// maybeLogOrientationDiagnostics for the given segment, returning the final result.
function feedWindow(seg, headingErrorDegs, distanceM){
  var result;
  for(var i = 0; i < headingErrorDegs.length; i++){
    var yaw = seg.yawForAlignment + headingErrorDegs[i];
    result = nav.maybeLogOrientationDiagnostics(seg.fromTag, makePoseResult(yaw, distanceM), SOME_CORNERS, 1000 + i);
  }
  return result;
}

// ==================== circularMeanDeg() ====================

test('circularMeanDeg([179,-179]) is near +-180, not 0', () => {
  var mean = nav.circularMeanDeg([179, -179]);
  assert.ok(Math.abs(Math.abs(mean) - 180) < 1, `expected mean near +-180, got ${mean}`);
});

test('circularMeanDeg([175,178,-177,-174]) stays near +-180 with small deviations (not collapsed toward 0)', () => {
  var samples = [175, 178, -177, -174];
  var mean = nav.circularMeanDeg(samples);
  assert.ok(Math.abs(Math.abs(mean) - 180) < 5, `expected mean near +-180, got ${mean}`);
  for(var i = 0; i < samples.length; i++){
    var deviation = Math.abs(nav.normalizeSignedDeg(samples[i] - mean));
    assert.ok(deviation < 10, `sample ${samples[i]} deviates ${deviation}deg from mean ${mean}, expected a small circular deviation`);
  }
});

test('circularMeanDeg([-179,179,176]) is near +-180 (classifies OPPOSITE)', () => {
  var mean = nav.circularMeanDeg([-179, 179, 176]);
  assert.equal(nav.classifyHeadingZone(mean), 'OPPOSITE', `expected OPPOSITE for mean ${mean}`);
});

test('circularMeanDeg([10,12,8]) is about 10 (no wrap involved, matches ordinary mean)', () => {
  assert.ok(Math.abs(nav.circularMeanDeg([10, 12, 8]) - 10) < 0.5);
});

test('circularMeanDeg([-25,-22,-24]) is about -24 (no wrap involved, matches ordinary mean)', () => {
  assert.ok(Math.abs(nav.circularMeanDeg([-25, -22, -24]) - (-24)) < 1);
});

// ==================== Integration: wrap-safe classification ====================

test('a stable near-opposite window straddling +-180 classifies OPPOSITE (field log 2026-08-25 094435, seg 3->15)', () => {
  var seg = enterRoute(3, 16); // findPath(3,16)=[3,15,16] (Tag 15 is a waypoint, not itself a selectable destination); first segment is 3->15
  // Exact headingErrorDeg sequence from the field log: physically stable
  // facing-backwards, one sample flips sign across the wrap boundary.
  var result = feedWindow(seg, [162.7, 164.52, 165.09, 169.99, 169.52, 160.72, 165.1, -172.38], 0.85);
  assert.ok(result && result.ok, `expected ok result, got ${JSON.stringify(result)}`);
  assert.ok(result.stability.stdDevDeg <= 10,
    `circular stdDev should stay within the stability threshold, got ${result.stability.stdDevDeg}`);
  assert.ok(result.stability.spreadDeg < 50,
    `circular spread should be small (physically stable), got ${result.stability.spreadDeg}`);
  assert.equal(result.classification, 'OPPOSITE');
});

test('classification uses the window circular mean, not a latest frame that briefly dips under the OPPOSITE threshold (field log 2026-08-25 094932, seg 7->4)', () => {
  var seg = enterRoute(7, 4);
  // Exact headingErrorDeg sequence from the field log: the window is stable
  // near +165deg (OPPOSITE), but the LAST sample is 153.74 -- just under the
  // 155deg OPPOSITE cutoff. Old code classified this single frame using only
  // the instantaneous value and produced LEFT; the fix must not.
  var result = feedWindow(seg, [173.05, 172.05, 171.32, 169.68, 166.14, 162.67, 156.08, 153.74], 1.0);
  assert.ok(result && result.ok);
  assert.ok(Math.abs(result.headingErrorDeg - 153.74) < 0.5,
    `sanity check: instantaneous headingErrorDeg should still be the latest frame, got ${result.headingErrorDeg}`);
  assert.equal(result.classification, 'OPPOSITE',
    `expected the stable window mean (~165deg) to win over the single dipping frame (153.74deg)`);
});

test('a genuinely noisy, non-wraparound window still classifies UNSTABLE_WINDOW (field log 2026-08-25 094542, seg 3->6) -- threshold not loosened', () => {
  var seg = enterRoute(3, 4); // findPath(3,4)=[3,6,4]; first segment is 3->6
  // Exact headingErrorDeg sequence from the field log: 7 samples clustered
  // near -20deg, one genuine outlier at +8.28deg -- real noise, no wraparound.
  var result = feedWindow(seg, [-20.87, -23.43, -21.15, -20.12, -20.55, -24.38, -23.67, 8.28], 1.0);
  assert.ok(result && result.ok);
  assert.equal(result.classification, 'UNSTABLE_WINDOW');
  assert.equal(result.classificationReason, 'high-stddev');
  assert.ok(result.stability.stdDevDeg > 10, `expected the circular stddev to match the old linear stddev here (no wrap), got ${result.stability.stdDevDeg}`);
});

test('an aligned window around 0 classifies ALIGNED', () => {
  var seg = enterRoute(6, 4);
  var result = feedWindow(seg, [1, -1, 2, 0, -2, 1, 0, -1], 1.0);
  assert.ok(result && result.ok);
  assert.equal(result.classification, 'ALIGNED');
});

test('a stable left window classifies LEFT', () => {
  var seg = enterRoute(6, 4);
  var result = feedWindow(seg, [88, 90, 92, 89, 91, 90, 88, 90], 1.0);
  assert.ok(result && result.ok);
  assert.equal(result.classification, 'LEFT');
});

test('a stable right window classifies RIGHT', () => {
  var seg = enterRoute(6, 4);
  var result = feedWindow(seg, [-88, -90, -92, -89, -91, -90, -88, -90], 1.0);
  assert.ok(result && result.ok);
  assert.equal(result.classification, 'RIGHT');
});

test('no regression for an arbitrary route edge not involved in the bug (8->10)', () => {
  var seg = enterRoute(8, 10);
  var result = feedWindow(seg, [3, -2, 1, 0, -1, 2, -3, 1], 1.0);
  assert.ok(result && result.ok);
  assert.equal(result.classification, 'ALIGNED');
});

test('ORIENTATION_CLASSIFICATION diagnostics never alter navigation state or spoken text across a wrap-crossing sequence', () => {
  var seg = enterRoute(7, 4);
  spokenTexts.length = 0;
  var before = {
    pathTagIds: nav.pathTagIds.slice(),
    segIndex: nav.segIndex,
    currentTagId: nav.currentTagId,
    expectedNextTagId: nav.expectedNextTagId,
    navState: nav.navState,
    destinationReached: nav.destinationReached
  };

  feedWindow(seg, [146.95, 138.26, 135.2, 142.23, 145.63, 153.34, 157.73, -141.77, -131.09, -128.38], 1.0);

  assert.deepEqual(nav.pathTagIds, before.pathTagIds);
  assert.equal(nav.segIndex, before.segIndex);
  assert.equal(nav.currentTagId, before.currentTagId);
  assert.equal(nav.expectedNextTagId, before.expectedNextTagId);
  assert.equal(nav.navState, before.navState);
  assert.equal(nav.destinationReached, before.destinationReached);
  assert.deepEqual(spokenTexts, [], `must never speak anything, got: ${JSON.stringify(spokenTexts)}`);
});
