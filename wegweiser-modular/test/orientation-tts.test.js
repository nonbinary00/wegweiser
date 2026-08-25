// Tests for the start-of-route orientation TTS gate in nav.js's
// maybeLogOrientationDiagnostics() (see the block below the change-based
// ORIENTATION_CLASSIFICATION logging). This is a thin confirmation/speech
// layer on top of the existing, unchanged diagnostic classifier -- it does
// NOT alter orientation math, thresholds, routing, or distance/reached logic.
//
// Design (see accompanying analysis):
// - Eligible ONLY on the route's first segment (segIndex===0) while
//   navState===SEARCHING_NEXT_TAG. navState is set to SEARCHING_NEXT_TAG
//   exclusively by beginSegment() and never reverts to it within the same
//   segment, so this check alone permanently disables guidance the instant
//   normal tracking begins -- no separate "disabled" flag exists or is needed.
// - LEFT/RIGHT require 3 consecutive identical classifications with
//   selectedYawJumped===false and bothPoseCandidatesFarFromHistory===false on
//   every one of those frames; speaks once per confirmed classification, never
//   repeats while the same state persists.
// - ALIGNED is confirmed the same way but never spoken ("no correction
//   needed" is silence itself).
// - OPPOSITE is confirmed and logged (ORIENTATION_TTS_CONFIRMED) exactly like
//   LEFT/RIGHT, but deliberately never spoken yet -- no controlled field data
//   validates OPPOSITE under the current pipeline.

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

function poseWith(bestYaw, altYaw, bestErr, altErr){
  var p = { distanceM: 1.0, rotation: makeRotation(bestYaw), translation: [0, 0, 1.0], poseError: bestErr == null ? 6 : bestErr };
  if(altYaw != null){
    p.alternativeRotation = makeRotation(altYaw);
    p.alternativePoseError = altErr == null ? 6 : altErr;
    p.poseErrorGap = Math.abs((altErr == null ? 6 : altErr) - (bestErr == null ? 6 : bestErr));
  }
  return p;
}

var SOME_CORNERS = [{ x: 100, y: 100 }, { x: 140, y: 100 }, { x: 140, y: 140 }, { x: 100, y: 140 }];

// findPath(6,4) = [6,4] -- same arbitrary, non-hardcoded pair used by
// orientation-classifier.test.js/orientation-far-from-history.test.js.
function enterRoute(){
  resetState();
  selectDestination(4);
  nav.startNavigation();
  nav.onStartTagConfirmed(6);
  assert.equal(nav.pathTagIds[nav.segIndex], 6);
  assert.equal(nav.expectedNextTagId, 4);
  assert.equal(nav.segIndex, 0);
  assert.equal(nav.navState, nav.NavState.SEARCHING_NEXT_TAG);
  // onStartTagConfirmed() speaks its own route-start announcement -- clear it
  // so every test's spokenTexts assertions are scoped to orientation TTS only.
  spokenTexts.length = 0;
  return { fromTag: 6 };
}

// yawForAlignment is the single-branch yaw that makes headingErrorDeg===0 for
// this segment (same derivation as orientation-classifier.test.js). Since
// headingErrorDeg moves 1:1 with the fed yaw (see nav.js's
// cameraHeadingWorldDeg/headingErrorDeg derivation), a fixed offset from this
// anchor reliably lands in a known classification zone regardless of the
// segment's real-world geometry.
function alignmentYaw(){
  var desired = nav.bearingDeg(MARKERS[6], MARKERS[4]);
  return (MARKERS[6].dir_deg + 180) - desired;
}

// Feeds `yawDeg` (no alternative branch -- bothPoseCandidatesFarFromHistory is
// therefore always false) for `count` frames starting at `startTs`, returning
// the last result. With no alternative branch, selectOrientationBranch()
// always returns the raw yaw unchanged post-bootstrap ("no-alternative"), so
// the fed yaw IS the selected yaw every frame.
function feedStable(fromTag, yawDeg, count, startTs){
  var result;
  for(var i = 0; i < count; i++){
    result = nav.maybeLogOrientationDiagnostics(fromTag, poseWith(yawDeg, null), SOME_CORNERS, startTs + i);
  }
  return result;
}

test('LEFT: confirms after 3 consecutive clean frames and speaks exactly once, no repeat while it persists', () => {
  var seg = enterRoute();
  var leftYaw = alignmentYaw() + 40; // headingErrorDeg ~= +40 -> LEFT zone (20 < 40 < 155)

  // Frames 1-8 fill the rolling window (bootstrap=6 + 2 more) -- classification
  // is UNSTABLE_WINDOW until the 8th frame, so no confirmation progress yet.
  var r = feedStable(seg.fromTag, leftYaw, 8, 1000);
  assert.equal(r.classification, 'LEFT');
  assert.deepEqual(spokenTexts, []);

  // Frame 9: 2nd consecutive clean LEFT -- still not confirmed (needs 3).
  r = feedStable(seg.fromTag, leftYaw, 1, 1008);
  assert.equal(r.classification, 'LEFT');
  assert.deepEqual(spokenTexts, []);

  // Frame 10: 3rd consecutive clean LEFT -- confirmed, speaks once.
  r = feedStable(seg.fromTag, leftYaw, 1, 1009);
  assert.equal(r.classification, 'LEFT');
  assert.deepEqual(spokenTexts, ['Drehen Sie sich nach links.']);

  // Further identical frames must not repeat the instruction.
  feedStable(seg.fromTag, leftYaw, 5, 1010);
  assert.deepEqual(spokenTexts, ['Drehen Sie sich nach links.']);
});

test('RIGHT: confirms after 3 consecutive clean frames and speaks exactly once', () => {
  var seg = enterRoute();
  var rightYaw = alignmentYaw() - 40; // headingErrorDeg ~= -40 -> RIGHT zone

  feedStable(seg.fromTag, rightYaw, 9, 1000); // window fill (8) + 1 confirming frame = count 2
  assert.deepEqual(spokenTexts, []);

  var r = feedStable(seg.fromTag, rightYaw, 1, 1009); // 3rd consecutive clean frame
  assert.equal(r.classification, 'RIGHT');
  assert.deepEqual(spokenTexts, ['Drehen Sie sich nach rechts.']);
});

test('ALIGNED: confirmed silently -- never spoken, even well past the confirmation threshold', () => {
  var seg = enterRoute();
  var alignedYaw = alignmentYaw();

  var r = feedStable(seg.fromTag, alignedYaw, 20, 1000);
  assert.equal(r.classification, 'ALIGNED');
  assert.deepEqual(spokenTexts, [], `ALIGNED must never be spoken, got: ${JSON.stringify(spokenTexts)}`);
});

test('OPPOSITE: confirmed like LEFT/RIGHT but never spoken -- no field validation yet', () => {
  var seg = enterRoute();
  var oppositeYaw = alignmentYaw() + 180; // camera facing squarely backwards

  var r = feedStable(seg.fromTag, oppositeYaw, 20, 1000);
  assert.equal(r.classification, 'OPPOSITE');
  assert.deepEqual(spokenTexts, [], `OPPOSITE must not be spoken yet, got: ${JSON.stringify(spokenTexts)}`);

  // The dedup/confirmation mechanism itself must still work normally
  // afterward -- an unspoken OPPOSITE confirmation must not permanently
  // consume the "already spoken" slot for a later, different classification.
  // Switching from OPPOSITE (~180deg offset) to LEFT (~40deg offset) is
  // itself a large jump, so the same window-flush dynamics as the jump/
  // bothFar reset tests apply: 9 recovery frames are not yet 3 fresh
  // consecutive clean LEFT frames.
  var leftYaw = alignmentYaw() + 40;
  feedStable(seg.fromTag, leftYaw, 9, 2000);
  assert.deepEqual(spokenTexts, []);
  var r2 = feedStable(seg.fromTag, leftYaw, 1, 2009); // 10th recovery frame confirms
  assert.equal(r2.classification, 'LEFT');
  assert.deepEqual(spokenTexts, ['Drehen Sie sich nach links.']);
});

test('a >20deg selected-yaw jump resets an in-progress confirmation streak', () => {
  var seg = enterRoute();
  var anchorYaw = alignmentYaw() + 40; // LEFT

  feedStable(seg.fromTag, anchorYaw, 9, 1000); // window fill (8) + 1 confirming frame = count 2
  assert.deepEqual(spokenTexts, []);

  // Jump 40deg away (still LEFT-zone, offset +80) -- selectedYawJumped becomes
  // true on this frame, which must reset the streak regardless of
  // classification. The rolling 8-sample window still holds mostly
  // pre-jump samples too, so classification itself reads UNSTABLE_WINDOW
  // (high-stddev) for several frames afterward, independent of the
  // confirmation-count reset being asserted here.
  var jumpedYaw = anchorYaw + 40;
  var jumped = nav.maybeLogOrientationDiagnostics(seg.fromTag, poseWith(jumpedYaw, null), SOME_CORNERS, 1009);
  assert.equal(jumped.selectedYawJumped, true);
  assert.deepEqual(spokenTexts, []);

  // 8 more clean frames at the new, now-stable yaw: enough for the rolling
  // window to fully flush the pre-jump samples and classification to settle
  // back on LEFT, but only 2 of those are consecutive-clean-LEFT confirmation
  // frames (the window needs 6 frames to flush before LEFT reappears at all,
  // see the diagnostic trace) -- still not the 3 consecutive frames required.
  feedStable(seg.fromTag, jumpedYaw, 8, 1010);
  assert.deepEqual(spokenTexts, [], 'must not confirm before 3 fresh consecutive clean LEFT frames');

  // 9th recovery frame: 3rd consecutive clean LEFT since the window
  // resettled -- now confirms and speaks.
  var r = feedStable(seg.fromTag, jumpedYaw, 1, 1018);
  assert.equal(r.classification, 'LEFT');
  assert.deepEqual(spokenTexts, ['Drehen Sie sich nach links.']);
});

test('a bothPoseCandidatesFarFromHistory frame resets an in-progress confirmation streak (field-log Case-B shape)', () => {
  var seg = enterRoute();
  var anchorYaw = alignmentYaw() + 40; // LEFT

  feedStable(seg.fromTag, anchorYaw, 9, 1000); // window fill (8) + 1 confirming frame = count 2
  assert.deepEqual(spokenTexts, []);

  // Both candidates land ~34/34.5deg from the anchor (mirrors the exact
  // Case-B shape from orientation-far-from-history.test.js) -- structurally,
  // whichever candidate continuity selects is also >20deg from history, so
  // this frame carries both bothPoseCandidatesFarFromHistory===true and
  // selectedYawJumped===true, matching the real degenerate pattern observed
  // in field log 12 ("6-4_still_back").
  var farYaw = anchorYaw + 34;
  var degenerate = nav.maybeLogOrientationDiagnostics(seg.fromTag,
    poseWith(farYaw, anchorYaw + 34.5, 6, 6), SOME_CORNERS, 1009);
  assert.equal(degenerate.bothPoseCandidatesFarFromHistory, true);
  assert.deepEqual(spokenTexts, []);

  // Recovery: same window-flush dynamics as the pure-jump test above -- 8
  // more clean frames are not yet 3 fresh consecutive clean LEFT frames.
  feedStable(seg.fromTag, farYaw, 8, 1010);
  assert.deepEqual(spokenTexts, [], 'must not confirm before 3 fresh consecutive clean LEFT frames');

  // 9th recovery frame confirms and speaks.
  var r = feedStable(seg.fromTag, farYaw, 1, 1018);
  assert.equal(r.classification, 'LEFT');
  assert.deepEqual(spokenTexts, ['Drehen Sie sich nach links.']);
});

test('orientation TTS is permanently disabled once navState leaves SEARCHING_NEXT_TAG (normal tracking begins)', () => {
  var seg = enterRoute();
  var leftYaw = alignmentYaw() + 40;

  feedStable(seg.fromTag, leftYaw, 9, 1000); // window fill (8) + 1 confirming frame = count 2
  assert.deepEqual(spokenTexts, []);

  // Normal tracking begins for this segment.
  nav.setNavState(nav.NavState.TRACKING);

  // What would have been the 3rd consecutive clean frame must not speak --
  // eligibility is gated on navState every frame, with no separate
  // "disabled" flag, so leaving SEARCHING_NEXT_TAG suppresses this
  // unconditionally.
  var r = nav.maybeLogOrientationDiagnostics(seg.fromTag, poseWith(leftYaw, null), SOME_CORNERS, 1009);
  assert.equal(r.classification, 'LEFT');
  assert.deepEqual(spokenTexts, [], 'must never speak once tracking has begun');

  // Further identical frames stay silent too.
  feedStable(seg.fromTag, leftYaw, 5, 1010);
  assert.deepEqual(spokenTexts, []);
});

test('a confirmed+spoken LEFT instruction never touches navState/pathTagIds/segIndex or any other nav fields', () => {
  var seg = enterRoute();
  var leftYaw = alignmentYaw() + 40;
  var before = {
    pathTagIds: nav.pathTagIds.slice(),
    segIndex: nav.segIndex,
    currentTagId: nav.currentTagId,
    expectedNextTagId: nav.expectedNextTagId,
    navState: nav.navState,
    destinationReached: nav.destinationReached
  };

  feedStable(seg.fromTag, leftYaw, 10, 1000); // confirms and speaks on the 10th frame
  assert.deepEqual(spokenTexts, ['Drehen Sie sich nach links.']);

  assert.deepEqual(nav.pathTagIds, before.pathTagIds);
  assert.equal(nav.segIndex, before.segIndex);
  assert.equal(nav.currentTagId, before.currentTagId);
  assert.equal(nav.expectedNextTagId, before.expectedNextTagId);
  assert.equal(nav.navState, before.navState);
  assert.equal(nav.destinationReached, before.destinationReached);
});
