// Behavioral tests for the confirmed TRACKING_START_TAG -> LOST_STOPPED recovery
// gap (see field logs wegweiser-v13-log-20260831-152926(58)/153056(59).json,
// destination 14 from Tag 7): once trackingStartTagActive stays true into
// LOST_STOPPED (the selected start tag was lost before ever being reached, see
// beginStartApproach()/reachStartTag()), main-loop.js's ordinary
// updateSkipCandidate() forward-candidate mechanism never runs (pathTagIds is
// still only the single-element start-approach placeholder, not a real route),
// leaving the app permanently stuck unless the exact original tag reappears.
//
// nav.js's fix adds a second, narrower recovery path (noteStartLossRecoveryCandidate()
// / attemptStartLossRecovery()) that lets a DIFFERENT, reliably confirmed known
// graph tag become a fresh recovery anchor -- reusing the existing
// wrongCandId/wrongCandCount stable-sighting counter and SETTINGS.otherTagFrames
// threshold (same mechanism as onOtherTagConfirmed()'s off-route warning) and the
// existing route-calculation infrastructure (findPathToDestination()/
// commitStartTag()) -- while leaving Case A (the original expected tag
// reappearing, already handled by handleLostStopped()) completely unchanged.
//
// Drives nav.js's exported functions directly, bypassing camera/detector and
// main-loop.js's per-frame loop -- consistent with test/start-tag-approach.test.js
// and test/nav.test.js's own conventions (including forcing LOST_STOPPED directly
// via setNavState(), exactly as the existing "a long loss during approach resumes
// TRACKING_START_TAG" test in start-tag-approach.test.js already does).
//
// Graph fixture used throughout (see js/graph-data.js): start Tag 7 ("Leonie"),
// destination 14 ("Ende des Büros") -- the exact field-log scenario. Recovery
// candidate Tag 8 ("Ecke") has a real path to destination 14 (8 -> 10 -> 11 -> 12
// -> 13 -> 14, via the existing edges); Tag 5 ("Tischtennis") has no outgoing
// edges at all and therefore no path to destination 14, used as the "no valid
// path" case.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spokenTexts } from './browser-stubs.js';
import { destSel } from '../js/dom.js';
import { SETTINGS } from '../js/config.js';
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

// Same small fake-clock helper already used by test/nav.test.js -- keeps
// SETTINGS.wrongTagCooldownMs timing deterministic and lets each test pick a
// starting offset far enough from every other test's that the shared, never-reset
// lastWrongTagAt module state can never accidentally leak a cooldown across tests.
function withFakeClock(startMs, run){
  var real = performance.now;
  var t = startMs;
  performance.now = function(){ return t; };
  try{
    return run(function advance(ms){ t += ms; });
  } finally {
    performance.now = real;
  }
}

// Starts navigation toward `destinationId`, selects `startTagId` as the start
// candidate from well beyond startTagReachedM (so it enters the deferred
// TRACKING_START_TAG approach, never reached), then forces the loss --
// mirrors start-tag-approach.test.js's own "a long loss during approach..." test.
function driveToStartTagLoss(startTagId, destinationId){
  resetState();
  selectDestination(destinationId);
  nav.startNavigation();
  nav.onStartTagConfirmed(startTagId, 4.5); // winnerDist well beyond startTagReachedM (1.0m)
  assert.equal(nav.navState, nav.NavState.TRACKING_START_TAG, 'setup: must be approaching, not yet reached');
  assert.equal(nav.trackingStartTagActive, true, 'setup: trackingStartTagActive must be true during the approach');
  assert.deepEqual(nav.pathTagIds, [startTagId], 'setup: no real route yet -- only the placeholder');
  nav.setNavState(nav.NavState.LOST_STOPPED);
  spokenTexts.length = 0;
}

// ==================== Test 1 -- expected start tag reacquired (Case A, unchanged) ====================

test('Test 1: the original start tag reappearing still reacquires normally, with no reroute', () => {
  withFakeClock(1000000, (advance) => {
    driveToStartTagLoss(7, 14);

    // A different tag briefly interrupts first (below the recovery threshold) --
    // must not interfere with the original tag reappearing afterward.
    nav.noteStartLossRecoveryCandidate(8);
    advance(100);
    nav.noteStartLossRecoveryCandidate(8);
    advance(100);

    nav.handleLostStopped(performance.now(), { dist: 2.0, corners: [] }); // Tag 7 seen again

    assert.equal(nav.navState, nav.NavState.TRACKING_START_TAG,
      'must resume the ORIGINAL start-approach state, not plain TRACKING');
    assert.equal(nav.trackingStartTagActive, true, 'must still be approaching Tag 7');
    assert.equal(nav.expectedNextTagId, 7, 'must still be waiting for Tag 7 itself');
    assert.equal(nav.destinationId, 14, 'destination must remain unchanged');
    assert.deepEqual(nav.pathTagIds, [7], 'no reroute -- still only the placeholder, no real route computed');
    assert.equal(nav.currentTagId, null, 'must not be marked reached merely by reacquisition');
    assert.ok(
      !spokenTexts.some((t) => t.includes('neu berechnet') || t.includes('wiedergefunden')),
      `must not speak any recovery/reroute text for a normal reacquisition, got: ${JSON.stringify(spokenTexts)}`
    );
  });
});

// ==================== Test 2 -- different known tag becomes a recovery anchor (Case B) ====================

test('Test 2: a different, reliably confirmed known tag becomes a recovery anchor and reroutes to the existing destination', () => {
  withFakeClock(1100000, (advance) => {
    driveToStartTagLoss(7, 14);

    for(var i = 0; i < SETTINGS.otherTagFrames; i++){
      nav.noteStartLossRecoveryCandidate(8);
      advance(100);
    }

    assert.deepEqual(nav.pathTagIds, [8, 10, 11, 12, 13, 14],
      `expected a fresh route computed from Tag 8 to the existing destination, got: ${JSON.stringify(nav.pathTagIds)}`);
    assert.equal(nav.currentTagId, 8, 'Tag 8 must become the current position');
    assert.equal(nav.expectedNextTagId, 10, 'must now be tracking toward the real route successor');
    assert.equal(nav.destinationId, 14, 'the originally selected destination must be preserved unchanged');
    assert.equal(nav.trackingStartTagActive, false, 'the abandoned start-approach flag must be cleared');
    assert.equal(nav.navState, nav.NavState.SEARCHING_NEXT_TAG, 'must resume normal route navigation');

    assert.ok(
      spokenTexts.some((t) => t.includes('wiedergefunden') && t.includes('neu berechnet')),
      `expected an explicit recovery/off-route message before continuing, got: ${JSON.stringify(spokenTexts)}`
    );
  });
});

// ==================== Test 3 -- noisy one-frame sighting must never reroute ====================

test('Test 3: a single-frame sighting of a different tag does not trigger any recovery', () => {
  withFakeClock(1200000, (advance) => {
    driveToStartTagLoss(7, 14);

    nav.noteStartLossRecoveryCandidate(8);
    advance(100);

    assert.deepEqual(nav.pathTagIds, [7], 'no reroute from a single noisy frame');
    assert.equal(nav.trackingStartTagActive, true, 'must still be in the original start approach');
    assert.equal(nav.navState, nav.NavState.LOST_STOPPED, 'must remain in the safe recovery state');
    assert.equal(nav.currentTagId, null);
    assert.deepEqual(spokenTexts, [], `must stay completely silent for sub-threshold noise, got: ${JSON.stringify(spokenTexts)}`);
  });
});

test('Test 3b: an interrupted series of sightings (different tags alternating) never accumulates toward recovery', () => {
  withFakeClock(1300000, (advance) => {
    driveToStartTagLoss(7, 14);

    for(var i = 0; i < SETTINGS.otherTagFrames - 1; i++){
      nav.noteStartLossRecoveryCandidate(8);
      advance(100);
    }
    nav.noteStartLossRecoveryCandidate(9); // a different tag interrupts the series
    advance(100);
    for(var j = 0; j < SETTINGS.otherTagFrames - 1; j++){
      nav.noteStartLossRecoveryCandidate(8);
      advance(100);
    }

    assert.deepEqual(nav.pathTagIds, [7], 'an interrupted series must never accumulate across the switch');
    assert.equal(nav.trackingStartTagActive, true);
    assert.equal(nav.navState, nav.NavState.LOST_STOPPED);
  });
});

// ==================== Test 4 -- known tag with no valid path to the destination ====================

test('Test 4: a known tag with no path to the current destination is rejected, no invalid route is committed', () => {
  withFakeClock(1400000, (advance) => {
    driveToStartTagLoss(7, 14); // Tag 5 has no outgoing edges -- no path to 14 exists

    for(var i = 0; i < SETTINGS.otherTagFrames; i++){
      nav.noteStartLossRecoveryCandidate(5);
      advance(100);
    }

    assert.deepEqual(nav.pathTagIds, [7], 'must not replace the route with an invalid one');
    assert.equal(nav.trackingStartTagActive, true, 'must remain in the original safe recovery state');
    assert.equal(nav.navState, nav.NavState.LOST_STOPPED);
    assert.equal(nav.currentTagId, null);
    assert.equal(nav.destinationId, 14, 'destination must remain unchanged even on rejection');
    assert.ok(
      spokenTexts.some((t) => t.includes('kein Weg zum Ziel')),
      `expected the existing "no path" instruction to be reused, got: ${JSON.stringify(spokenTexts)}`
    );
    assert.ok(
      !spokenTexts.some((t) => t.includes('wiedergefunden') && t.includes('neu berechnet')),
      'must not speak the recovery-accepted message when no path was found'
    );
  });
});

// ==================== Cooldown / dedup: a rejected tag is not re-announced every frame ====================

test('a repeatedly-rejected no-path tag is only reported once (existing wrongTagCooldownMs/offRouteSaid reuse)', () => {
  withFakeClock(1500000, (advance) => {
    driveToStartTagLoss(7, 14);

    for(var i = 0; i < SETTINGS.otherTagFrames; i++){
      nav.noteStartLossRecoveryCandidate(5);
      advance(100);
    }
    var countAfterFirst = spokenTexts.filter((t) => t.includes('kein Weg zum Ziel')).length;
    assert.equal(countAfterFirst, 1);

    // Immediately re-confirm the same tag again (well within wrongTagCooldownMs).
    for(var j = 0; j < SETTINGS.otherTagFrames; j++){
      nav.noteStartLossRecoveryCandidate(5);
      advance(100);
    }
    var countAfterSecond = spokenTexts.filter((t) => t.includes('kein Weg zum Ziel')).length;
    assert.equal(countAfterSecond, 1, 'must not repeat the rejection message for the same tag every confirmation cycle');
  });
});
