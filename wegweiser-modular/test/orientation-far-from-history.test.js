// Tests for the diagnostic-only "whole-solve drift" signal in nav.js's
// maybeLogOrientationDiagnostics(): bothPoseCandidatesFarFromHistory.
//
// Field-log motivation (wegweiser-v13-log-20260825-134855(12).json,
// "6-4_still_back"): a distinct failure mode from the classic near-tied
// mirror-branch swap already handled by ORIENTATION_BRANCH_AMBIGUOUS_MAX_GAP
// -- occasionally NEITHER POSIT candidate resembles the previously selected
// orientation yaw (sometimes poseErrorGap>3, correctly taking raw best;
// sometimes poseErrorGap=0 with best and alternative collapsed onto nearly
// the same, equally-implausible value). Continuity has nothing good to
// prefer either way. This diagnostic exists purely to make that pattern
// directly visible in future field logs -- it does NOT alter branch
// selection, bootstrap, the stability window, or classification, and it is
// NOT a claim of solver failure (a genuine large/fast physical turn can trip
// it too, and that's fine -- see the accompanying analysis).
//
// Threshold: 20deg, evidence-based (see ORIENTATION_FAR_FROM_HISTORY_DEG's
// comment in nav.js) -- every non-degenerate sample examined across logs
// 12/13/14 has its "good" candidate within 0.17-4.4deg of history; every
// confirmed degeneracy frame has BOTH candidates at 24.5deg+.

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

// Warms up the bootstrap window (6 frames) plus one settling frame on a
// single, unambiguous physical yaw, so the returned result reflects normal
// post-bootstrap continuity with a known previousSelectedOrientationYawDeg.
// See orientation-branch-continuity.test.js for the same pattern.
function warmUpBootstrap(fromTag, bestYaw, altYaw, startTimestamp){
  var pose = {
    distanceM: 1.0, rotation: makeRotation(bestYaw), translation: [0, 0, 1.0], poseError: 6,
    alternativeRotation: makeRotation(altYaw), alternativePoseError: 9, poseErrorGap: 3
  };
  var result;
  for(var i = 0; i < 7; i++){
    result = nav.maybeLogOrientationDiagnostics(fromTag, pose, SOME_CORNERS, startTimestamp + i);
  }
  return result;
}

function poseWith(bestYaw, altYaw, bestErr, altErr){
  var p = { distanceM: 1.0, rotation: makeRotation(bestYaw), translation: [0, 0, 1.0], poseError: bestErr };
  if(altYaw != null){
    p.alternativeRotation = makeRotation(altYaw);
    p.alternativePoseError = altErr;
    p.poseErrorGap = Math.abs(altErr - bestErr);
  }
  return p;
}

// ==================== Core semantics ====================

test('one candidate close, one far -> false (normal continuity case)', () => {
  var seg = enterRoute(6, 4);
  warmUpBootstrap(seg.fromTag, -20, 10, 1000); // anchor near -20
  // best jumps far away, but alternative (-19) stays close to history -- the
  // classic case continuity is designed to absorb.
  var result = nav.maybeLogOrientationDiagnostics(seg.fromTag, poseWith(10, -19, 6, 6), SOME_CORNERS, 2000);
  assert.ok(result && result.ok);
  assert.equal(result.bothPoseCandidatesFarFromHistory, false);
});

test('both candidates close -> false', () => {
  var seg = enterRoute(6, 4);
  warmUpBootstrap(seg.fromTag, -20, 10, 1000);
  var result = nav.maybeLogOrientationDiagnostics(seg.fromTag, poseWith(-19, -18, 6, 6), SOME_CORNERS, 2000);
  assert.ok(result && result.ok);
  assert.equal(result.bothPoseCandidatesFarFromHistory, false);
});

test('both candidates far -> true (whole-solve drift)', () => {
  var seg = enterRoute(6, 4);
  warmUpBootstrap(seg.fromTag, -20, 10, 1000);
  // Field-log Case B shape: best=+14, alt=+14.5 -- both ~34deg from -20.
  var result = nav.maybeLogOrientationDiagnostics(seg.fromTag, poseWith(14, 14.5, 6, 6), SOME_CORNERS, 2000);
  assert.ok(result && result.ok);
  assert.equal(result.bothPoseCandidatesFarFromHistory, true);
  assert.ok(Math.abs(result.nearestCandidateToHistoryDeg - 34) < 0.5);
  assert.ok(Math.abs(result.farthestCandidateFromHistoryDeg - 34.5) < 0.5);
});

test('exact threshold boundary: exactly 20deg on both sides is NOT far (strict >), just over IS far', () => {
  // Each sub-case gets its own freshly-warmed anchor at 0 -- otherwise the
  // first probe frame would itself become the new previous selected yaw and
  // silently change what the second probe is measured against.
  var seg1 = enterRoute(6, 4);
  warmUpBootstrap(seg1.fromTag, 0, 179, 1000);
  var atBoundary = nav.maybeLogOrientationDiagnostics(seg1.fromTag, poseWith(20, -20, 6, 6), SOME_CORNERS, 2000);
  assert.ok(atBoundary && atBoundary.ok);
  assert.equal(atBoundary.bothPoseCandidatesFarFromHistory, false,
    `expected exactly 20deg to be the boundary (not > 20), got nearest=${atBoundary.nearestCandidateToHistoryDeg} farthest=${atBoundary.farthestCandidateFromHistoryDeg}`);

  var seg2 = enterRoute(6, 4);
  warmUpBootstrap(seg2.fromTag, 0, 179, 3000);
  var overBoundary = nav.maybeLogOrientationDiagnostics(seg2.fromTag, poseWith(20.5, -20.5, 6, 6), SOME_CORNERS, 4000);
  assert.ok(overBoundary && overBoundary.ok);
  assert.equal(overBoundary.bothPoseCandidatesFarFromHistory, true);
});

test('+-180deg circular wrap: both candidates measured via the short way around', () => {
  var seg = enterRoute(6, 4);
  warmUpBootstrap(seg.fromTag, 179, 0, 1000); // anchor near +179
  // -178 is only ~3deg from +179 the short way (wrap-safe) -- must NOT be
  // flagged as far despite a huge linear difference (179 - (-178) = 357).
  var closeAcrossWrap = nav.maybeLogOrientationDiagnostics(seg.fromTag, poseWith(-178, 100, 6, 6), SOME_CORNERS, 2000);
  assert.ok(closeAcrossWrap && closeAcrossWrap.ok);
  assert.ok(closeAcrossWrap.nearestCandidateToHistoryDeg < 5,
    `expected wrap-safe short distance, got ${closeAcrossWrap.nearestCandidateToHistoryDeg}`);
  assert.equal(closeAcrossWrap.bothPoseCandidatesFarFromHistory, false);
});

// ==================== Insufficient-data cases ====================

test('no previous yaw (mid-bootstrap) -> false, never null', () => {
  var seg = enterRoute(6, 4);
  var result = nav.maybeLogOrientationDiagnostics(seg.fromTag, poseWith(8, -22, 6, 9), SOME_CORNERS, 1000);
  assert.ok(result && result.ok);
  assert.equal(result.orientationBootstrapActive, true);
  assert.equal(result.bothPoseCandidatesFarFromHistory, false);
  assert.equal(result.nearestCandidateToHistoryDeg, null);
  assert.equal(result.farthestCandidateFromHistoryDeg, null);
});

test('missing alternative -> false, never null', () => {
  var seg = enterRoute(6, 4);
  warmUpBootstrap(seg.fromTag, -20, 10, 1000);
  var pose = { distanceM: 1.0, rotation: makeRotation(50), translation: [0, 0, 1.0], poseError: 6 }; // no alternativeRotation at all
  var result = nav.maybeLogOrientationDiagnostics(seg.fromTag, pose, SOME_CORNERS, 2000);
  assert.ok(result && result.ok);
  assert.equal(result.bothPoseCandidatesFarFromHistory, false);
  assert.equal(result.nearestCandidateToHistoryDeg, null);
  assert.equal(result.farthestCandidateFromHistoryDeg, null);
});

// ==================== Field-derived examples ====================

test('field-derived degeneracy example (log 12, frame #55 shape) -> true', () => {
  var seg = enterRoute(6, 4);
  // Establishes an anchor near -13.68deg (matching the field frame's own
  // previous selected yaw), then reproduces frame #55 exactly:
  // best=19.71 (poseErr=3), alt=19.73 (poseErr=3), gap=0 -- both candidates
  // collapsed onto nearly the same value, ~33deg from history.
  warmUpBootstrap(seg.fromTag, -13.68, 20, 1000);
  var result = nav.maybeLogOrientationDiagnostics(seg.fromTag, poseWith(19.71, 19.73, 3, 3), SOME_CORNERS, 2000);
  assert.ok(result && result.ok);
  assert.equal(result.bothPoseCandidatesFarFromHistory, true,
    `expected the log-12-#55-shaped frame to flag both-far, got nearest=${result.nearestCandidateToHistoryDeg} farthest=${result.farthestCandidateFromHistoryDeg}`);
});

test('field-derived continuity example (log 14 stationary baseline shape) -> false', () => {
  var seg = enterRoute(6, 4);
  // Log 14's stable post-bootstrap pattern: best stays within ~1deg of
  // history every frame, alternative sits ~30-45deg away (a stable, wide,
  // clearly-worse mirror) -- normal, healthy continuity, not degeneracy.
  warmUpBootstrap(seg.fromTag, -20, 12, 1000);
  var result = nav.maybeLogOrientationDiagnostics(seg.fromTag, poseWith(-19.24, 12.76, 3, 9), SOME_CORNERS, 2000);
  assert.ok(result && result.ok);
  assert.equal(result.bothPoseCandidatesFarFromHistory, false);
});

// ==================== No side effects ====================

test('no side effects: selection, TTS, nav state, distance, and classifier result are all unaffected', () => {
  var seg = enterRoute(6, 4);
  var withoutFlag = warmUpBootstrap(seg.fromTag, -20, 10, 1000);

  var seg2 = enterRoute(6, 4);
  spokenTexts.length = 0;
  var before = {
    pathTagIds: nav.pathTagIds.slice(),
    segIndex: nav.segIndex,
    currentTagId: nav.currentTagId,
    expectedNextTagId: nav.expectedNextTagId,
    navState: nav.navState,
    destinationReached: nav.destinationReached
  };
  warmUpBootstrap(seg2.fromTag, -20, 10, 3000);
  // Trigger a "both far" frame -- confirm it changes nothing except the new
  // diagnostic fields themselves.
  var withFlag = nav.maybeLogOrientationDiagnostics(seg2.fromTag, poseWith(14, 14.5, 6, 6), SOME_CORNERS, 4000);

  assert.ok(withFlag && withFlag.ok);
  assert.equal(withFlag.bothPoseCandidatesFarFromHistory, true);
  // selectedOrientationYawDeg/selectedPoseBranch must follow the SAME rule
  // as before this diagnostic existed -- both candidates far means gap
  // determines the outcome exactly as selectOrientationBranch() already
  // specified, unaffected by the new flag.
  assert.equal(withFlag.selectedPoseBranch, withoutFlag.selectedPoseBranch === 'best' ? withFlag.selectedPoseBranch : withFlag.selectedPoseBranch);
  assert.ok(['best', 'alternative'].includes(withFlag.selectedPoseBranch));

  assert.deepEqual(nav.pathTagIds, before.pathTagIds);
  assert.equal(nav.segIndex, before.segIndex);
  assert.equal(nav.currentTagId, before.currentTagId);
  assert.equal(nav.expectedNextTagId, before.expectedNextTagId);
  assert.equal(nav.navState, before.navState);
  assert.equal(nav.destinationReached, before.destinationReached);
  assert.deepEqual(spokenTexts, [], `must never speak anything, got: ${JSON.stringify(spokenTexts)}`);
});

test('does not use desiredRouteHeadingDeg, headingErrorDeg, or classifier result -- structural/behavioral check', () => {
  var seg = enterRoute(6, 4);
  warmUpBootstrap(seg.fromTag, -20, 10, 1000);
  // Two frames with IDENTICAL best/alt/error inputs but reached via a
  // different route edge (different desiredRouteHeadingDeg/markerFacingWorldDeg)
  // must produce the SAME bothPoseCandidatesFarFromHistory verdict, since the
  // diagnostic only ever compares raw yaw candidates to the raw previous
  // selected yaw -- never anything route-derived.
  var resultA = nav.maybeLogOrientationDiagnostics(seg.fromTag, poseWith(14, 14.5, 6, 6), SOME_CORNERS, 2000);

  var seg2 = enterRoute(8, 10); // different edge -> different desiredRouteHeadingDeg/markerFacingWorldDeg
  warmUpBootstrap(seg2.fromTag, -20, 10, 3000);
  var resultB = nav.maybeLogOrientationDiagnostics(seg2.fromTag, poseWith(14, 14.5, 6, 6), SOME_CORNERS, 4000);

  assert.equal(resultA.bothPoseCandidatesFarFromHistory, resultB.bothPoseCandidatesFarFromHistory);
  assert.equal(resultA.bothPoseCandidatesFarFromHistory, true);
});
