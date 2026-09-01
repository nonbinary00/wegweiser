// Behavioral tests for GENERIC mid-route off-route recovery (see
// noteOffRouteRecoveryCandidate()/attemptOffRouteRecovery() in nav.js, and
// onOtherTagConfirmed()'s off-route branch, which now delegates to the same
// function). Regression target: field log
// wegweiser-v13-log-20260901-113550(62).json -- destination 2 ("Patrik"), start
// Tag 7 physically reached, active path becomes 7 -> 4 -> 6 -> 3 -> 15 (Tag 15 is
// the ARRIVAL_ALIASES arrival tag for destination 2), expectedTag = 4, the user
// walked in the wrong direction, and Tag 8 was repeatedly detected but repeatedly
// rejected as NOT_ON_ACTIVE_PATH by findVisibleForwardCandidate() -- with no
// recovery of any kind.
//
// Reuses the exact same "visible != reached" safety model already proven for
// start-tag-loss recovery (see test/start-tag-loss-recovery.test.js): stable
// confirmation (wrongCandId/wrongCandCount, SETTINGS.otherTagFrames) -> route
// validation (findPathToDestination(tagId, destinationId), destination
// preserved) -> deferred physical approach (onStartTagConfirmed() ->
// beginStartApproach() -> TRACKING_START_TAG) -> only once
// SETTINGS.startTagReachedM is satisfied does commitStartTag() replace the stale
// active route.
//
// Drives nav.js's exported functions directly, bypassing camera/detector and
// main-loop.js's per-frame loop -- consistent with test/nav.test.js's and
// test/start-tag-loss-recovery.test.js's own conventions.
//
// Graph fixture (see js/graph-data.js): destination 2 ("Patrik"), start Tag 7
// ("Leonie") reached immediately -> real route [7,4,6,3,15] (via ARRIVAL_ALIASES),
// expectedTag 4. Recovery candidate Tag 8 ("Ecke") has a real path back to
// destination 2 (8 -> 7 -> 4 -> 6 -> 3 -> 15); Tag 5 ("Tischtennis") has no
// outgoing edges at all and therefore no path to destination 2, used as the
// "no valid path" case.

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

// Same small fake-clock helper already used by test/nav.test.js and
// test/start-tag-loss-recovery.test.js.
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

// Reproduces the Log 62 setup exactly: destination 2, Tag 7 reached immediately
// (already within startTagReachedM), giving the real active route [7,4,6,3,15]
// with expectedTag 4 -- SEARCHING_NEXT_TAG, tag 4 never yet confirmed.
function driveToMidRouteSearching(){
  resetState();
  selectDestination(2);
  nav.startNavigation();
  nav.onStartTagConfirmed(7, 0.5); // already within startTagReachedM -- commits immediately
  assert.deepEqual(nav.pathTagIds, [7, 4, 6, 3, 15], 'setup: active route must be the real multi-hop route');
  assert.equal(nav.currentTagId, 7, 'setup: Tag 7 must be the confirmed current position');
  assert.equal(nav.expectedNextTagId, 4, 'setup: expectedTag must be 4');
  assert.equal(nav.navState, nav.NavState.SEARCHING_NEXT_TAG);
  spokenTexts.length = 0;
}

// Same route, but tag 4 was briefly confirmed once (ordinary TRACKING) before the
// user turned away -- exercises the NEW TRACKING-branch integration point.
function driveToMidRouteTracking(){
  driveToMidRouteSearching();
  nav.onExpectedTagFound(3.0);
  assert.equal(nav.navState, nav.NavState.TRACKING, 'setup: must now be TRACKING toward tag 4');
  spokenTexts.length = 0;
}

// Same again, but the loss has since progressed all the way to LOST_STOPPED
// (mirrors how the existing tests force LOST_STOPPED directly via setNavState()).
function driveToMidRouteLost(){
  driveToMidRouteTracking();
  nav.setNavState(nav.NavState.LOST_STOPPED);
  spokenTexts.length = 0;
}

function reachViaTracking(dist){
  nav.setEmaDist(dist);
  nav.handleTracking(performance.now(), true, dist);
  nav.handleTracking(performance.now(), true, dist); // arrivalConfirmFrames = 2
}

// ==================== Test 1 -- Log 62 style mid-route off-route recovery ====================

test('Test 1: a stably confirmed off-route tag is no longer silently rejected forever, recovery starts, destination unchanged', () => {
  withFakeClock(3000000, (advance) => {
    driveToMidRouteTracking();

    for(var i = 0; i < SETTINGS.otherTagFrames; i++){
      nav.noteOffRouteRecoveryCandidate(8, 2.5); // ~2.5m -- Tag 8, not on the active path [7,4,6,3,15]
      advance(100);
    }

    assert.equal(nav.navState, nav.NavState.TRACKING_START_TAG, 'Tag 8 must become a recovery approach target');
    assert.equal(nav.expectedNextTagId, 8);
    assert.equal(nav.destinationId, 2, 'destination must remain unchanged');
    assert.ok(
      spokenTexts.some((t) => t.includes('wiedergefunden')),
      `expected the recovery-acceptance message, got: ${JSON.stringify(spokenTexts)}`
    );
  });
});

// ==================== Test 2 -- far recovery tag: no immediate commit ====================

test('Test 2: a recovery tag confirmed several meters away enters an approach, no immediate commit', () => {
  withFakeClock(3100000, (advance) => {
    driveToMidRouteTracking();

    for(var i = 0; i < SETTINGS.otherTagFrames; i++){
      nav.noteOffRouteRecoveryCandidate(8, 2.5);
      advance(100);
    }

    assert.equal(nav.navState, nav.NavState.TRACKING_START_TAG, 'must enter the deferred approach, not commit immediately');
    assert.equal(nav.trackingStartTagActive, true);
    assert.deepEqual(nav.pathTagIds, [8], 'only the placeholder -- no real multi-hop route yet');
    assert.notEqual(nav.currentTagId, 8, 'must NOT be marked reached merely by a stable sighting');
    assert.equal(nav.currentTagId, null);
  });
});

// ==================== Test 3 -- physical reach: only then commit and replace the stale route ====================

test('Test 3: only once Tag 8 is physically reached does the app discard the stale route and start the new one to destination 2', () => {
  withFakeClock(3200000, (advance) => {
    driveToMidRouteTracking();
    for(var i = 0; i < SETTINGS.otherTagFrames; i++){
      nav.noteOffRouteRecoveryCandidate(8, 2.5);
      advance(100);
    }
    spokenTexts.length = 0;

    reachViaTracking(0.5); // well within startTagReachedM (1.0m)

    assert.deepEqual(nav.pathTagIds, [8, 7, 4, 6, 3, 15],
      `expected findPathToDestination(8, 2)'s real route, got: ${JSON.stringify(nav.pathTagIds)}`);
    assert.equal(nav.currentTagId, 8, 'Tag 8 must become the current position only now');
    assert.equal(nav.expectedNextTagId, 7, 'must now be tracking toward the real route successor');
    assert.equal(nav.destinationId, 2, 'destination must remain unchanged');
    assert.equal(nav.trackingStartTagActive, false);
    assert.equal(nav.navState, nav.NavState.SEARCHING_NEXT_TAG);
  });
});

// ==================== Test 4 -- noisy off-route tag: no reroute ====================

test('Test 4a: a single-frame sighting of an off-route tag never triggers a recovery approach', () => {
  withFakeClock(3300000, (advance) => {
    driveToMidRouteTracking();

    nav.noteOffRouteRecoveryCandidate(8, 2.5);
    advance(100);

    assert.equal(nav.navState, nav.NavState.TRACKING, 'must remain on the original route');
    assert.equal(nav.expectedNextTagId, 4);
    assert.deepEqual(nav.pathTagIds, [7, 4, 6, 3, 15], 'the active route must not be touched by sub-threshold noise');
    assert.equal(nav.currentTagId, 7);
    assert.deepEqual(spokenTexts, [], `must stay silent for sub-threshold noise, got: ${JSON.stringify(spokenTexts)}`);
  });
});

test('Test 4b: an interrupted series of sightings (different tags alternating) never accumulates toward recovery', () => {
  withFakeClock(3350000, (advance) => {
    driveToMidRouteTracking();

    // Interrupted series: switching tags resets the counter, never accumulates.
    for(var i = 0; i < SETTINGS.otherTagFrames - 1; i++){
      nav.noteOffRouteRecoveryCandidate(8, 2.5);
      advance(100);
    }
    nav.noteOffRouteRecoveryCandidate(9, 3.0); // a different tag interrupts the series
    advance(100);
    for(var j = 0; j < SETTINGS.otherTagFrames - 1; j++){
      nav.noteOffRouteRecoveryCandidate(8, 2.5);
      advance(100);
    }

    assert.deepEqual(nav.pathTagIds, [7, 4, 6, 3, 15], 'an interrupted series must never accumulate across the switch');
    assert.equal(nav.navState, nav.NavState.TRACKING);
  });
});

// ==================== Test 5 -- known tag with no valid path: old route is not destroyed ====================

test('Test 5: a known off-route tag with no path to the destination is rejected, the old route survives untouched', () => {
  withFakeClock(3400000, (advance) => {
    driveToMidRouteTracking(); // Tag 5 has no outgoing edges -- no path to destination 2 exists

    for(var i = 0; i < SETTINGS.otherTagFrames; i++){
      nav.noteOffRouteRecoveryCandidate(5, 2.0);
      advance(100);
    }

    assert.deepEqual(nav.pathTagIds, [7, 4, 6, 3, 15], 'must not replace the route with an invalid one');
    assert.equal(nav.currentTagId, 7, 'must not touch the confirmed current position');
    assert.equal(nav.expectedNextTagId, 4, 'must not abandon the active segment');
    assert.equal(nav.navState, nav.NavState.TRACKING);
    assert.equal(nav.destinationId, 2, 'destination must remain unchanged even on rejection');
    assert.ok(
      spokenTexts.some((t) => t.includes('nicht auf dem Weg')),
      `expected the existing "no path" instruction to be reused, got: ${JSON.stringify(spokenTexts)}`
    );
  });
});

// ==================== Test 6 -- expected tag still wins ====================

test('Test 6: the expected tag reappearing before the off-route tag is stably confirmed keeps normal navigation, no reroute', () => {
  withFakeClock(3500000, (advance) => {
    driveToMidRouteTracking();

    // Tag 8 accumulates, but not yet to threshold.
    for(var i = 0; i < SETTINGS.otherTagFrames - 1; i++){
      nav.noteOffRouteRecoveryCandidate(8, 2.5);
      advance(100);
    }
    assert.deepEqual(nav.pathTagIds, [7, 4, 6, 3, 15], 'no reroute yet');

    // Expected Tag 4 reappears -- ordinary tracking continues, unaffected.
    nav.setEmaDist(2.0);
    nav.handleTracking(performance.now(), true, 2.0);

    assert.equal(nav.navState, nav.NavState.TRACKING, 'normal route continues');
    assert.equal(nav.expectedNextTagId, 4);
    assert.deepEqual(nav.pathTagIds, [7, 4, 6, 3, 15], 'no reroute happened');
    assert.equal(nav.currentTagId, 7);
  });
});

// ==================== Test 7 -- existing forward-skip behavior is unaffected ====================

test('Test 7: an on-path forward-skip candidate is never treated as an off-route recovery candidate', () => {
  withFakeClock(3600000, (advance) => {
    driveToMidRouteTracking();

    // Tag 6 is ON the active path [7,4,6,3,15], ahead of expectedTag 4 (index 2 > 1) --
    // must be handled exclusively by the existing forward-skip mechanism
    // (updateSkipCandidate()), never by off-route recovery.
    for(var i = 0; i < SETTINGS.otherTagFrames; i++){
      nav.updateSkipCandidate([{ id: 6, dist: 3.0 }], performance.now());
      advance(100);
    }

    assert.equal(nav.expectedNextTagId, 6, 'forward skip must retarget tracking to Tag 6, unaffected by the new mechanism');
    assert.deepEqual(nav.pathTagIds, [7, 4, 6, 3, 15], 'the existing route itself must never be replaced by a forward skip');
    assert.ok(
      !spokenTexts.some((t) => t.includes('wiedergefunden')),
      `a forward-skip candidate must never speak the off-route recovery message, got: ${JSON.stringify(spokenTexts)}`
    );

    // A genuinely off-route tag afterward must still work normally.
    spokenTexts.length = 0;
    for(var j = 0; j < SETTINGS.otherTagFrames; j++){
      nav.noteOffRouteRecoveryCandidate(8, 2.5);
      advance(100);
    }
    assert.equal(nav.navState, nav.NavState.TRACKING_START_TAG,
      'off-route recovery must still work normally after an unrelated forward-skip retarget');
  });
});

// ==================== SEARCHING_NEXT_TAG coverage: onOtherTagConfirmed() now recovers instead of a dead-end warning ====================

test('SEARCHING_NEXT_TAG: onOtherTagConfirmed() escalates a confirmed off-route tag into recovery instead of a dead-end warning', () => {
  withFakeClock(3700000, (advance) => {
    driveToMidRouteSearching(); // still SEARCHING_NEXT_TAG -- tag 4 never confirmed at all

    nav.onOtherTagConfirmed(8, 2.5); // "already confirmed" entry point, matching existing test/nav.test.js conventions

    assert.equal(nav.navState, nav.NavState.TRACKING_START_TAG, 'must start a recovery approach toward Tag 8');
    assert.equal(nav.expectedNextTagId, 8);
    assert.equal(nav.destinationId, 2);
    assert.ok(spokenTexts.some((t) => t.includes('wiedergefunden')));
  });
});

test('SEARCHING_NEXT_TAG: an unknown/unregistered tag still gets the original off-route warning, unchanged', () => {
  withFakeClock(3800000, (advance) => {
    driveToMidRouteSearching();

    nav.onOtherTagConfirmed(191, 4.0); // not a known graph node -- mirrors the existing off-route-warning regression test

    assert.equal(nav.navState, nav.NavState.SEARCHING_NEXT_TAG, 'must not attempt any recovery for an unknown tag');
    assert.deepEqual(nav.pathTagIds, [7, 4, 6, 3, 15]);
    assert.ok(
      spokenTexts.some((t) => t.includes('nicht auf dem Weg')),
      `expected the original, unchanged off-route warning text, got: ${JSON.stringify(spokenTexts)}`
    );
  });
});

test('SEARCHING_NEXT_TAG: an already-passed on-path tag still uses the existing back-tag warning, unaffected by recovery', () => {
  withFakeClock(3900000, (advance) => {
    driveToMidRouteSearching();
    // Advance one more real segment (7->4, tag 4 physically reached) so Tag 7 is a
    // genuinely already-passed tag, distinct from the CURRENT position (Tag 4) --
    // onOtherTagConfirmed()'s very first guard (tagId === currentTagId) would
    // otherwise short-circuit before ever reaching the back-tag/off-route branching.
    nav.onExpectedTagFound(3.0);
    reachViaTracking(0.5);
    assert.equal(nav.currentTagId, 4, 'setup: Tag 4 must now be the confirmed current position');
    assert.equal(nav.segIndex, 1);
    spokenTexts.length = 0;

    nav.onOtherTagConfirmed(7, 1.0); // Tag 7 -- already passed (index 0 <= segIndex 1), not current

    assert.equal(nav.navState, nav.NavState.SEARCHING_NEXT_TAG, 'back-tag sighting must never trigger recovery');
    assert.deepEqual(nav.pathTagIds, [7, 4, 6, 3, 15]);
    assert.ok(
      spokenTexts.some((t) => t.includes('möglicherweise zurück')),
      `expected the existing back-tag warning, got: ${JSON.stringify(spokenTexts)}`
    );
  });
});

// ==================== LOST_STOPPED coverage: mid-route loss (not start-tag-loss) also recovers ====================

test('LOST_STOPPED (mid-route, not start-tag-loss): a stably confirmed off-route tag still recovers correctly', () => {
  withFakeClock(4000000, (advance) => {
    driveToMidRouteLost();
    assert.equal(nav.trackingStartTagActive, false, 'setup: this is the ordinary mid-route loss, not start-tag-loss');

    for(var i = 0; i < SETTINGS.otherTagFrames; i++){
      nav.noteOffRouteRecoveryCandidate(8, 2.5);
      advance(100);
    }

    assert.equal(nav.navState, nav.NavState.TRACKING_START_TAG);
    assert.equal(nav.expectedNextTagId, 8);
    assert.equal(nav.destinationId, 2);

    reachViaTracking(0.5);
    assert.deepEqual(nav.pathTagIds, [8, 7, 4, 6, 3, 15]);
    assert.equal(nav.currentTagId, 8);
    assert.equal(nav.destinationId, 2, 'destination must remain unchanged through to the final commit');
  });
});

test('LOST_STOPPED (mid-route): the original expected tag reappearing still reacquires normally, no recovery interference', () => {
  withFakeClock(4100000, (advance) => {
    driveToMidRouteLost();

    nav.noteOffRouteRecoveryCandidate(8, 2.5); // one sub-threshold frame first
    advance(100);

    nav.handleLostStopped(performance.now(), { dist: 2.0, corners: [] }); // Tag 4 seen again

    assert.equal(nav.navState, nav.NavState.TRACKING, 'must resume ordinary tracking, not a recovery approach');
    assert.equal(nav.expectedNextTagId, 4);
    assert.deepEqual(nav.pathTagIds, [7, 4, 6, 3, 15], 'no reroute -- the original route is untouched');
    assert.equal(nav.currentTagId, 7);
  });
});
