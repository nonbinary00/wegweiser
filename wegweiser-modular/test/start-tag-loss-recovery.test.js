// Behavioral tests for the start-tag-loss recovery mechanism (see
// noteStartLossRecoveryCandidate()/attemptStartLossRecovery() in nav.js) and its
// "visible != reached" safety fix.
//
// Original gap (field logs wegweiser-v13-log-20260831-152926(58)/153056(59).json,
// destination 14 from Tag 7): once trackingStartTagActive stays true into
// LOST_STOPPED (the selected start tag was lost before ever being reached), the
// ordinary updateSkipCandidate() forward-candidate mechanism never runs (pathTagIds
// is still only the single-element start-approach placeholder, not a real route),
// leaving the app permanently stuck unless the exact original tag reappears.
//
// First fix attempt called commitStartTag(tagId) immediately once a different
// known tag was stably confirmed by SIGHT (SETTINGS.otherTagFrames) -- but a
// stable sighting from several meters away is not the same as physically being at
// that tag (exactly the field-log-46 "premature commit" bug this project already
// fixed once for the NORMAL start-tag flow, see start-tag-approach.test.js).
//
// Corrected design: a confirmed recovery candidate now goes through the exact
// same onStartTagConfirmed(tagId, dist) entry point a first-time start-tag
// selection uses -- deferring the actual commit via the existing
// beginStartApproach()/TRACKING_START_TAG/handleTracking()/reachStartTag() chain
// until SETTINGS.startTagReachedM is genuinely satisfied. No second distance/reach
// system; no new thresholds.
//
// Drives nav.js's exported functions directly, bypassing camera/detector and
// main-loop.js's per-frame loop -- consistent with test/start-tag-approach.test.js
// and test/nav.test.js's own conventions (including forcing LOST_STOPPED directly
// via setNavState()).
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

function reachViaTracking(dist){
  nav.setEmaDist(dist);
  nav.handleTracking(performance.now(), true, dist);
  nav.handleTracking(performance.now(), true, dist); // arrivalConfirmFrames = 2
}

// ==================== Test 1 -- recovery tag far away: no immediate commit ====================

test('Test 1: a recovery tag confirmed several meters away starts an approach, does not commit immediately', () => {
  withFakeClock(2000000, (advance) => {
    driveToStartTagLoss(7, 14);

    for(var i = 0; i < SETTINGS.otherTagFrames; i++){
      nav.noteStartLossRecoveryCandidate(8, 2.5); // ~2.5m -- well beyond startTagReachedM (1.0m)
      advance(100);
    }

    assert.equal(nav.navState, nav.NavState.TRACKING_START_TAG,
      'must enter the deferred approach, not commit immediately');
    assert.equal(nav.trackingStartTagActive, true);
    assert.equal(nav.expectedNextTagId, 8, 'Tag 8 is now the approach target');
    assert.deepEqual(nav.pathTagIds, [8], 'only the placeholder -- no real multi-hop route yet');
    assert.equal(nav.currentTagId, null, 'must NOT be marked reached merely by a stable sighting');
    assert.equal(nav.destinationId, 14, 'destination must remain unchanged');
    assert.ok(
      spokenTexts.some((t) => t.includes('wiedergefunden')),
      `expected the recovery-acceptance message, got: ${JSON.stringify(spokenTexts)}`
    );
    assert.ok(
      !spokenTexts.some((t) => t.includes('Sie sind bei') || t.includes('neu berechnet')),
      `must NOT imply arrival or describe the route before Tag 8 is physically reached, got: ${JSON.stringify(spokenTexts)}`
    );
  });
});

// ==================== Test 2 -- approach continues while still farther than the threshold ====================

test('Test 2: distance decreasing but still above startTagReachedM keeps the approach open, no commit', () => {
  withFakeClock(2100000, (advance) => {
    driveToStartTagLoss(7, 14);
    for(var i = 0; i < SETTINGS.otherTagFrames; i++){
      nav.noteStartLossRecoveryCandidate(8, 2.5);
      advance(100);
    }
    spokenTexts.length = 0;

    [2.0, 1.5, 1.2].forEach((d) => {
      nav.setEmaDist(d);
      nav.handleTracking(performance.now(), true, d);
      advance(100);
    });

    assert.equal(nav.navState, nav.NavState.TRACKING_START_TAG, 'still approaching -- 1.2m is still above startTagReachedM (1.0m)');
    assert.equal(nav.expectedNextTagId, 8);
    assert.equal(nav.currentTagId, null, 'must not be marked reached yet');
    assert.deepEqual(nav.pathTagIds, [8], 'no route committed yet');
  });
});

// ==================== Test 3 -- recovery tag physically reached: only then commit ====================

test('Test 3: only once Tag 8 is physically reached does the app commit and start the real route to the destination', () => {
  withFakeClock(2200000, (advance) => {
    driveToStartTagLoss(7, 14);
    for(var i = 0; i < SETTINGS.otherTagFrames; i++){
      nav.noteStartLossRecoveryCandidate(8, 2.5);
      advance(100);
    }
    spokenTexts.length = 0;

    reachViaTracking(0.5); // well within startTagReachedM (1.0m)

    assert.deepEqual(nav.pathTagIds, [8, 10, 11, 12, 13, 14],
      `expected the real route computed from Tag 8 to the existing destination, got: ${JSON.stringify(nav.pathTagIds)}`);
    assert.equal(nav.currentTagId, 8, 'Tag 8 must become the current position only now');
    assert.equal(nav.expectedNextTagId, 10, 'must now be tracking toward the real route successor');
    assert.equal(nav.destinationId, 14, 'the originally selected destination must be preserved unchanged');
    assert.equal(nav.trackingStartTagActive, false, 'the start-approach flag must be cleared on commit');
    assert.equal(nav.navState, nav.NavState.SEARCHING_NEXT_TAG, 'must resume normal route navigation');
  });
});

// ==================== Test 4 -- one-frame/noisy recovery tag: no approach starts ====================

test('Test 4: a single-frame sighting of a different tag does not start a recovery approach', () => {
  withFakeClock(2300000, (advance) => {
    driveToStartTagLoss(7, 14);

    nav.noteStartLossRecoveryCandidate(8, 2.5);
    advance(100);

    assert.equal(nav.navState, nav.NavState.LOST_STOPPED, 'must remain in the original safe recovery state');
    assert.equal(nav.trackingStartTagActive, true, 'must still be tied to the original Tag 7 approach');
    assert.equal(nav.expectedNextTagId, 7, 'must not retarget from a single noisy frame');
    assert.deepEqual(nav.pathTagIds, [7]);
    assert.equal(nav.currentTagId, null);
    assert.deepEqual(spokenTexts, [], `must stay completely silent for sub-threshold noise, got: ${JSON.stringify(spokenTexts)}`);
  });
});

// ==================== Test 5 -- recovery tag itself lost during its own approach ====================

test('Test 5: losing the recovery tag during its own approach uses the existing lost/reacquire logic, no premature commit', () => {
  withFakeClock(2400000, (advance) => {
    driveToStartTagLoss(7, 14);
    for(var i = 0; i < SETTINGS.otherTagFrames; i++){
      nav.noteStartLossRecoveryCandidate(8, 2.5);
      advance(100);
    }
    assert.equal(nav.navState, nav.NavState.TRACKING_START_TAG);
    assert.equal(nav.expectedNextTagId, 8);

    // Force the recovery tag's OWN approach to be lost (mirrors start-tag-approach.test.js's
    // "a long loss during approach resumes TRACKING_START_TAG" test).
    nav.setNavState(nav.NavState.LOST_STOPPED);
    assert.equal(nav.trackingStartTagActive, true, 'still tied to the (now Tag 8) approach');
    assert.equal(nav.currentTagId, null, 'a loss during approach must never count as reached');

    // Tag 8 reappears -- ordinary Case A reacquisition, unmodified.
    nav.handleLostStopped(performance.now(), { dist: 2.0, corners: [] });

    assert.equal(nav.navState, nav.NavState.TRACKING_START_TAG, 'must resume the Tag 8 approach, not plain TRACKING');
    assert.equal(nav.expectedNextTagId, 8);
    assert.equal(nav.currentTagId, null, 'still not reached -- resumption itself is not arrival');
    assert.deepEqual(nav.pathTagIds, [8], 'still no real route -- only the placeholder');
  });
});

// ==================== Test 6 -- original start tag reacquired (Case A, unchanged) ====================

test('Test 6: the original start tag reappearing still reacquires normally, with no recovery-approach interference', () => {
  withFakeClock(2500000, (advance) => {
    driveToStartTagLoss(7, 14);

    // A different tag briefly interrupts first (below the recovery threshold) --
    // must not interfere with the original tag reappearing afterward.
    nav.noteStartLossRecoveryCandidate(8, 2.5);
    advance(100);
    nav.noteStartLossRecoveryCandidate(8, 2.5);
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
      !spokenTexts.some((t) => t.includes('wiedergefunden')),
      `must not speak any recovery text for a normal reacquisition, got: ${JSON.stringify(spokenTexts)}`
    );
  });
});

// ==================== Known tag with no valid path: still rejected before any approach starts ====================

test('a known tag with no path to the current destination is rejected before any approach starts', () => {
  withFakeClock(2600000, (advance) => {
    driveToStartTagLoss(7, 14); // Tag 5 has no outgoing edges -- no path to 14 exists

    for(var i = 0; i < SETTINGS.otherTagFrames; i++){
      nav.noteStartLossRecoveryCandidate(5, 2.5);
      advance(100);
    }

    assert.equal(nav.navState, nav.NavState.LOST_STOPPED, 'must not start an approach toward an unroutable tag');
    assert.equal(nav.trackingStartTagActive, true, 'must remain tied to the original Tag 7 approach');
    assert.deepEqual(nav.pathTagIds, [7]);
    assert.equal(nav.currentTagId, null);
    assert.equal(nav.destinationId, 14, 'destination must remain unchanged even on rejection');
    assert.ok(
      spokenTexts.some((t) => t.includes('kein Weg zum Ziel')),
      `expected the existing "no path" instruction to be reused, got: ${JSON.stringify(spokenTexts)}`
    );
  });
});

// ==================== Interrupted series never accumulates ====================

test('an interrupted series of sightings (different tags alternating) never accumulates toward a recovery approach', () => {
  withFakeClock(2700000, (advance) => {
    driveToStartTagLoss(7, 14);

    for(var i = 0; i < SETTINGS.otherTagFrames - 1; i++){
      nav.noteStartLossRecoveryCandidate(8, 2.5);
      advance(100);
    }
    nav.noteStartLossRecoveryCandidate(9, 3.0); // a different tag interrupts the series
    advance(100);
    for(var j = 0; j < SETTINGS.otherTagFrames - 1; j++){
      nav.noteStartLossRecoveryCandidate(8, 2.5);
      advance(100);
    }

    assert.equal(nav.navState, nav.NavState.LOST_STOPPED, 'an interrupted series must never accumulate across the switch');
    assert.equal(nav.trackingStartTagActive, true);
    assert.deepEqual(nav.pathTagIds, [7]);
  });
});

// ==================== Cooldown / dedup: a rejected tag is not re-announced every frame ====================

test('a repeatedly-rejected no-path tag is only reported once (existing wrongTagCooldownMs/offRouteSaid reuse)', () => {
  withFakeClock(2800000, (advance) => {
    driveToStartTagLoss(7, 14);

    for(var i = 0; i < SETTINGS.otherTagFrames; i++){
      nav.noteStartLossRecoveryCandidate(5, 2.5);
      advance(100);
    }
    var countAfterFirst = spokenTexts.filter((t) => t.includes('kein Weg zum Ziel')).length;
    assert.equal(countAfterFirst, 1);

    for(var j = 0; j < SETTINGS.otherTagFrames; j++){
      nav.noteStartLossRecoveryCandidate(5, 2.5);
      advance(100);
    }
    var countAfterSecond = spokenTexts.filter((t) => t.includes('kein Weg zum Ziel')).length;
    assert.equal(countAfterSecond, 1, 'must not repeat the rejection message for the same tag every confirmation cycle');
  });
});

// ==================== A candidate already within reach commits immediately (no unnecessary approach) ====================
// Mirrors start-tag-approach.test.js's own "already within startTagReachedM activates
// immediately" case -- onStartTagConfirmed() is reused verbatim, so this behavior
// carries over automatically for a recovery candidate too.

test('a recovery tag already within startTagReachedM commits immediately, without an unnecessary approach phase', () => {
  withFakeClock(2900000, (advance) => {
    driveToStartTagLoss(7, 14);

    for(var i = 0; i < SETTINGS.otherTagFrames; i++){
      nav.noteStartLossRecoveryCandidate(8, 0.5); // already within startTagReachedM (1.0m)
      advance(100);
    }

    assert.deepEqual(nav.pathTagIds, [8, 10, 11, 12, 13, 14], 'must go straight to the real route, no TRACKING_START_TAG delay');
    assert.equal(nav.currentTagId, 8);
    assert.equal(nav.expectedNextTagId, 10);
    assert.equal(nav.navState, nav.NavState.SEARCHING_NEXT_TAG);
    assert.equal(nav.destinationId, 14);
  });
});
