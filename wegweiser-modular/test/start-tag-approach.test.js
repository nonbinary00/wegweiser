// Behavioral tests for the generic start-tag-approach fix: seeing a start marker
// (START_TAG_SELECTED, via the existing Option-C comparison window -- unchanged)
// is not the same as physically reaching it (START_TAG_REACHED). Regression
// target: field log wegweiser-v13-log-20260824-143401(46).json, where Tag 4 was
// confirmed as the start from ~6.46m and the app immediately announced "Sie sind
// bei Martin" and activated segment 4->6, and Tag 2 was confirmed from ~3.7-3.9m
// with the same immediate, physically-impossible commit.
//
// This is deliberately NOT a Tag-2-specific fix: every test below is parameterized
// by tagId and destination, and the same assertions are run for multiple,
// unrelated start tags (2, 4, 7, 8) to demonstrate the fix contains no
// tag-specific branching (see nav.js's onStartTagConfirmed()/beginStartApproach()
// -- the only tag-ID literal touched by this feature is the pre-existing "1",
// excluding Tag 1 from this generic gate because it already has its own,
// always-deferred approach mechanism, unchanged by this fix).
//
// Drives nav.js's exported functions directly (onStartTagConfirmed(tagId,
// winnerDist), noteStartCandidateConfirmed/checkStartCandidateWindow,
// handleTracking, aimGuidance), bypassing the camera/detector and main-loop.js's
// per-frame loop -- consistent with the existing test/start-tag-selection.test.js
// and test/nav.test.js conventions.

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

// One direct edge each, none via Tag 1/11/15/overrides -- purely generic starts.
var CASES = [
  { tagId: 2, destinationId: 9, firstHop: 3, name: 'Patrik' },   // path [2,3,6,4,9]
  { tagId: 4, destinationId: 16, firstHop: 6, name: 'Martin' },  // path [4,6,3,15,16] -- exact field-log-46 case
  { tagId: 7, destinationId: 5, firstHop: 5, name: 'Leonie' },   // path [7,5]
  { tagId: 8, destinationId: 10, firstHop: 10, name: 'Ecke' }    // path [8,10]
];

function reachViaTracking(dist){
  nav.setEmaDist(dist);
  nav.handleTracking(performance.now(), true, dist);
  nav.handleTracking(performance.now(), true, dist); // arrivalConfirmFrames = 2
}

// ==================== Generic far-away selection: no premature commit ====================

CASES.forEach(function(c){
  test(`Tag ${c.tagId} selected from several meters away does not immediately commit the route`, () => {
    resetState();
    selectDestination(c.destinationId);
    nav.startNavigation();
    spokenTexts.length = 0;

    nav.onStartTagConfirmed(c.tagId, 4.5); // winnerDist well beyond startTagReachedM (1.0m)

    assert.equal(nav.navState, nav.NavState.TRACKING_START_TAG,
      `Tag ${c.tagId}: expected the start-approach state, got ${nav.navState}`);
    assert.equal(nav.expectedNextTagId, c.tagId,
      `Tag ${c.tagId}: the approach target must be the selected tag itself, not the route successor`);
    assert.ok(
      !spokenTexts.some((t) => t.startsWith(`Sie sind bei ${c.name}`)),
      `Tag ${c.tagId}: must not announce arrival while still approaching, got: ${JSON.stringify(spokenTexts)}`
    );
    assert.ok(
      !spokenTexts.some((t) => t.includes('suchen Sie die nächste Markierung')),
      `Tag ${c.tagId}: must not tell the user to search for the NEXT route tag while still approaching`
    );
    assert.deepEqual(nav.pathTagIds, [c.tagId],
      `Tag ${c.tagId}: the real multi-hop route must not be active yet`);
  });
});

// Exact field-log-46 reproduction: Tag 4 confirmed at 6.46m.
test('field log 46 reproduction: Tag 4 confirmed at 6.46m does not announce Martin or start segment 4->6', () => {
  resetState();
  selectDestination(16);
  nav.startNavigation();
  spokenTexts.length = 0;

  nav.onStartTagConfirmed(4, 6.46);

  assert.ok(!spokenTexts.some((t) => t.includes('Sie sind bei Martin')));
  assert.equal(nav.expectedNextTagId, 4, 'must still be approaching Tag 4, not tracking toward Tag 6');
  assert.notDeepEqual(nav.pathTagIds, [4, 6, 3, 15, 16]);
});

// ==================== Generic reach transition: route activates exactly once ====================

CASES.forEach(function(c){
  test(`Tag ${c.tagId}: reaching the approached tag activates the route exactly once`, () => {
    resetState();
    selectDestination(c.destinationId);
    nav.startNavigation();
    nav.onStartTagConfirmed(c.tagId, 4.5);
    spokenTexts.length = 0;

    reachViaTracking(0.5); // well within startTagReachedM (1.0m)

    assert.equal(nav.currentTagId, c.tagId, `Tag ${c.tagId}: must now be the physically reached node`);
    assert.equal(nav.expectedNextTagId, c.firstHop,
      `Tag ${c.tagId}: expected tag must now be the real route successor`);
    assert.equal(nav.navState, nav.NavState.SEARCHING_NEXT_TAG);
    var announceCount = spokenTexts.filter((t) => t.startsWith(`Sie sind bei ${c.name}`)).length;
    assert.equal(announceCount, 1, `Tag ${c.tagId}: expected exactly one arrival announcement, got: ${JSON.stringify(spokenTexts)}`);

    // No duplicate commit: further ticks while still close/visible must not repeat it.
    reachViaTracking(0.4);
    var announceCountAfter = spokenTexts.filter((t) => t.startsWith(`Sie sind bei ${c.name}`)).length;
    assert.equal(announceCountAfter, 1, `Tag ${c.tagId}: must not announce arrival a second time`);
  });
});

// ==================== Candidate already close enough: no unnecessary approach ====================

test('a start candidate already within startTagReachedM activates immediately, without an approach phase', () => {
  resetState();
  selectDestination(9);
  nav.startNavigation();
  spokenTexts.length = 0;

  nav.onStartTagConfirmed(2, 0.5); // already within startTagReachedM (1.0m)

  assert.equal(nav.navState, nav.NavState.SEARCHING_NEXT_TAG, 'must go straight to normal tracking, no TRACKING_START_TAG delay');
  assert.equal(nav.currentTagId, 2);
  assert.equal(nav.expectedNextTagId, 3);
  assert.ok(spokenTexts.some((t) => t.startsWith('Sie sind bei Patrik')));
});

// ==================== Multiple visible candidates: comparison logic unchanged ====================

test('multiple visible start candidates: existing nearest-candidate comparison still selects the winner, which is then approached', () => {
  resetState();
  selectDestination(9);
  nav.startNavigation();

  var t = 1000;
  [6.0, 6.1].forEach((d) => nav.recordStartCandidateSample(4, d));
  nav.noteStartCandidateConfirmed(4, t); // farther candidate confirms first
  t += 150;
  [2.0, 1.9].forEach((d) => nav.recordStartCandidateSample(2, d));
  nav.noteStartCandidateConfirmed(2, t); // nearer candidate confirms shortly after

  t += SETTINGS.startCandidateWindowMs + 50;
  spokenTexts.length = 0;
  assert.equal(nav.checkStartCandidateWindow(t), true);

  // Tag 2 (1.9m) wins the comparison (unchanged selection logic) but is still
  // farther than startTagReachedM, so it must be approached, not committed.
  assert.equal(nav.expectedNextTagId, 2, 'the nearer candidate must still win the comparison');
  assert.equal(nav.navState, nav.NavState.TRACKING_START_TAG);
  assert.ok(!spokenTexts.some((t2) => t2.startsWith('Sie sind bei Patrik')));
});

// ==================== Temporary loss during approach ====================

test('the approached start tag disappearing briefly does not mark it reached or drop the target', () => {
  resetState();
  selectDestination(9);
  nav.startNavigation();
  nav.onStartTagConfirmed(2, 4.0);

  // handleTracking()'s loss check computes lostFor = now - expectedLastSeenAt, and
  // expectedLastSeenAt is normally kept current by main-loop.js's own
  // touchExpectedSeen(now) call on every frame the expected tag is visible (see
  // main-loop.js's "if(expectedDet) touchExpectedSeen(now);", called with the same
  // `now` immediately before handleTracking()). Reproducing that exact pairing here
  // -- rather than relying on however far performance.now() (process-uptime, not
  // simulated time) has already drifted -- is what makes the "brief" loss below
  // actually brief from handleTracking()'s point of view, deterministically,
  // regardless of test execution order.
  var now = performance.now();

  // Get a couple of valid measurements first (so loss detection is armed), then lose it.
  nav.setEmaDist(3.0);
  nav.touchExpectedSeen(now); nav.handleTracking(now, true, 3.0);
  now += 180;
  nav.touchExpectedSeen(now); nav.handleTracking(now, true, 3.0);
  now += 180;
  nav.touchExpectedSeen(now); nav.handleTracking(now, true, 3.0);

  // Tag not visible this frame, but well under the loss timeout (trackLostStopMs)
  // -- must be ignored. No touchExpectedSeen() call here: the tag was NOT seen
  // this frame, exactly like main-loop.js would skip it too.
  now += 180;
  nav.handleTracking(now, false, null);
  assert.equal(nav.navState, nav.NavState.TRACKING_START_TAG, 'a brief, sub-timeout loss must not change state');
  assert.equal(nav.expectedNextTagId, 2, 'the target must not change on a single lost frame');
  assert.equal(nav.currentTagId, null, 'must not be marked reached merely because of a brief loss');

  // Reacquired while still farther than startTagReachedM -- resumes the SAME approach.
  now += 180;
  nav.setEmaDist(2.5);
  nav.touchExpectedSeen(now); nav.handleTracking(now, true, 2.5);
  assert.equal(nav.navState, nav.NavState.TRACKING_START_TAG);
  assert.equal(nav.expectedNextTagId, 2);
  assert.equal(nav.currentTagId, null);

  // Now genuinely approach and reach it -- confirms the target survived the loss.
  reachViaTracking(0.5);
  assert.equal(nav.currentTagId, 2);
  assert.equal(nav.expectedNextTagId, 3);
});

test('a long loss during approach resumes TRACKING_START_TAG (not plain TRACKING) once the same tag is found again', () => {
  resetState();
  selectDestination(9);
  nav.startNavigation();
  nav.onStartTagConfirmed(2, 4.0);

  nav.setEmaDist(3.0);
  nav.handleTracking(performance.now(), true, 3.0);
  nav.handleTracking(performance.now(), true, 3.0);
  nav.handleTracking(performance.now(), true, 3.0);

  // Force LOST_STOPPED (loss exceeds trackLostStopMs).
  var pastLossThreshold = performance.now() + SETTINGS.trackLostStopMs + 50;
  nav.setNavState(nav.NavState.LOST_STOPPED);
  nav.handleLostStopped(pastLossThreshold, { dist: 2.0, corners: [] });

  // Reacquisition must return to the start-approach state, not normal TRACKING --
  // otherwise a forward-candidate search could wrongly begin before Tag 2 is reached.
  assert.equal(nav.navState, nav.NavState.TRACKING_START_TAG);
  assert.equal(nav.expectedNextTagId, 2);
  assert.equal(nav.currentTagId, null, 'must not be falsely marked reached by the reacquisition itself');
});

// ==================== Movement away from the selected start tag ====================

test('walking away from the selected start tag triggers the existing away-warning, without activating the route', () => {
  resetState();
  selectDestination(9);
  nav.startNavigation();
  nav.onStartTagConfirmed(2, 4.0);

  // trackingConfirmDetections = 3: prime tracking-confirmed and an away baseline.
  nav.setEmaDist(3.0);
  nav.handleTracking(performance.now(), true, 3.0);
  nav.handleTracking(performance.now(), true, 3.0);
  nav.handleTracking(performance.now(), true, 3.0);
  nav.handleTracking(performance.now(), true, 3.0); // establishes the away baseline
  spokenTexts.length = 0;

  // Distance increases well beyond SETTINGS.awayDeltaM.
  for(var d = 3.0; d <= 4.6; d += 0.4){
    nav.setEmaDist(d);
    nav.handleTracking(performance.now(), true, d);
  }

  assert.ok(
    spokenTexts.some((t) => t.includes('Sie entfernen sich von der Markierung')),
    `expected the existing away-warning to fire during start approach too, got: ${JSON.stringify(spokenTexts)}`
  );
  assert.equal(nav.navState, nav.NavState.TRACKING_START_TAG, 'moving away must not activate the route');
  assert.equal(nav.currentTagId, null);
});

// ==================== Camera-based guidance during approach ====================
//
// aimGuidance()'s cooldown (SETTINGS.aimCooldownMs) compares against
// performance.now(), which is process-uptime-relative -- in a real app session
// this is always far past the cooldown by the time navigation starts, but a
// fresh test process can still be within its first ~1.5s. resetSegmentState()
// (run by every onStartTagConfirmed() call above) resets lastAimAt to 0, so a
// one-time synchronous wait here ensures every test below sees a realistic,
// already-elapsed "now" for its very first aimGuidance() call, exactly like
// production.
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, SETTINGS.aimCooldownMs + 100);

test('aimGuidance speaks "Gehen Sie geradeaus." when the start-approach target is centered', () => {
  resetState();
  selectDestination(9);
  nav.startNavigation();
  nav.onStartTagConfirmed(2, 4.0);
  spokenTexts.length = 0;

  // cx=320, cy=240 -- dead center of the default 640x480 frame (frame-state.js:
  // W=PROC_WIDTH=640, H=480 until setFrameSize() runs, which these unit tests
  // never call), well inside both the horizontal band (211.2, 428.8) and the
  // vertical band (144, 336) that aimGuidance() classifies as "center".
  var centeredCorners = [{ x: 300, y: 220 }, { x: 340, y: 220 }, { x: 340, y: 260 }, { x: 300, y: 260 }];
  nav.aimGuidance(centeredCorners, true);

  assert.ok(spokenTexts.includes('Gehen Sie geradeaus.'),
    `expected the straight-ahead guidance, got: ${JSON.stringify(spokenTexts)}`);
});

test('aimGuidance gives horizontal guidance during start approach, scoped only to that phase', () => {
  resetState();
  selectDestination(9);
  nav.startNavigation();
  nav.onStartTagConfirmed(2, 4.0);
  spokenTexts.length = 0;

  // Left of frame: cx < W*0.33 (frame-state.js defaults; corners chosen well left).
  var leftCorners = [{ x: 0, y: 100 }, { x: 20, y: 100 }, { x: 20, y: 140 }, { x: 0, y: 140 }];
  nav.aimGuidance(leftCorners, true);
  assert.ok(spokenTexts.includes('Etwas nach links.'),
    `expected left guidance during start approach, got: ${JSON.stringify(spokenTexts)}`);
});

test('aimGuidance does NOT give horizontal guidance for normal (non-approach) navigation', () => {
  resetState();
  selectDestination(9);
  nav.startNavigation();
  nav.onStartTagConfirmed(2, 0.5); // already reached -- normal SEARCHING_NEXT_TAG now
  spokenTexts.length = 0;

  var leftCorners = [{ x: 0, y: 100 }, { x: 20, y: 100 }, { x: 20, y: 140 }, { x: 0, y: 140 }];
  nav.aimGuidance(leftCorners); // isStartApproach omitted -- must behave exactly as before

  assert.ok(!spokenTexts.includes('Etwas nach links.'),
    'horizontal guidance must stay scoped to the start-approach phase only');
  assert.ok(!spokenTexts.includes('Gehen Sie geradeaus.'));
});

test('aimGuidance does not repeat the same start-approach announcement every frame (cooldown/zone-change gating)', () => {
  resetState();
  selectDestination(9);
  nav.startNavigation();
  nav.onStartTagConfirmed(2, 4.0);
  spokenTexts.length = 0;

  // cx=320, cy=240 -- see the identical fixture/comment in the previous test.
  var centeredCorners = [{ x: 300, y: 220 }, { x: 340, y: 220 }, { x: 340, y: 260 }, { x: 300, y: 260 }];
  nav.aimGuidance(centeredCorners, true);
  nav.aimGuidance(centeredCorners, true);
  nav.aimGuidance(centeredCorners, true);

  var count = spokenTexts.filter((t) => t === 'Gehen Sie geradeaus.').length;
  assert.equal(count, 1, `must not spam the same guidance every frame, got: ${JSON.stringify(spokenTexts)}`);
});
