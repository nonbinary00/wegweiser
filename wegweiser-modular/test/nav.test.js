// Behavioral tests for the two TTS improvements: Tag 11 reverse-route start,
// and the "Wo bin ich?" location/direction response. Uses only node:test /
// node:assert/strict plus a small hand-written, dependency-free browser-global
// stub (browser-stubs.js) -- no npm packages -- so nav.js's real module graph
// (dom.js/speech.js/logger.js/ui.js) can be imported and exercised directly,
// bypassing app.js/camera.js (not needed to test nav.js's own logic).
//
// Does not test camera detection, tracking thresholds, skip logic, or general
// speech-queue/VoiceOver behavior -- those are unchanged by this task.

import test from 'node:test';
import assert from 'node:assert/strict';

// Must be imported before nav.js's dependency chain so its globals exist by
// the time dom.js/logger.js run their module-load-time DOM/window calls.
import { spokenTexts } from './browser-stubs.js';
import { destSel } from '../js/dom.js';
import { EDGE_MAP } from '../js/graph.js';
import { SETTINGS } from '../js/config.js';
import * as nav from '../js/nav.js';

function selectDestination(id){
  destSel.value = String(id);
}

function resetState(){
  nav.endNavigation(false);
  spokenTexts.length = 0;
  // Test isolation for the Tag4->9 detector-lifecycle hooks (setTag9DetectorHooks)
  // and the adaptiveDetectorActive flag -- both are nav.js module-level state
  // that must never leak from one test into the next.
  nav.setTag9DetectorHooks(null);
  nav.setAdaptiveDetectorActive(false);
}

// ==================== Problem 1: Tag 11 start ====================

test('starting at Tag 11 speaks the exact required orientation text', () => {
  resetState();
  selectDestination(16);
  nav.startNavigation();
  spokenTexts.length = 0;
  nav.onStartTagConfirmed(11);
  assert.ok(
    spokenTexts.includes(
      'Sie befinden sich am Ende des Korridors. Drehen Sie sich um und halten Sie das Smartphone gerade vor sich.'
    ),
    `expected exact Tag 11 start text among spoken texts, got: ${JSON.stringify(spokenTexts)}`
  );
});

test('starting at Tag 11 does not immediately speak "Gehen Sie geradeaus."', () => {
  resetState();
  selectDestination(16);
  nav.startNavigation();
  spokenTexts.length = 0;
  nav.onStartTagConfirmed(11);
  assert.ok(
    !spokenTexts.includes('Gehen Sie geradeaus.'),
    `must not immediately speak the bare confirmation, got: ${JSON.stringify(spokenTexts)}`
  );
});

test('detecting expected Tag 10 after starting at Tag 11 speaks the direction confirmation', () => {
  resetState();
  selectDestination(16);
  nav.startNavigation();
  nav.onStartTagConfirmed(11);
  spokenTexts.length = 0;
  nav.onNextTagFound(3.0);
  assert.ok(
    spokenTexts.includes('Die Richtung stimmt. Gehen Sie geradeaus.'),
    `expected the direction-confirmation text once Tag 10 is found, got: ${JSON.stringify(spokenTexts)}`
  );
});

test('detecting Tag 10 does not synthetically mark Tag 10 as reached', () => {
  resetState();
  selectDestination(16);
  nav.startNavigation();
  nav.onStartTagConfirmed(11);
  nav.onNextTagFound(3.0);
  assert.equal(nav.currentTagId, 11, 'currentTagId must remain 11 -- no synthetic arrival at Tag 10');
  assert.equal(nav.navState, nav.NavState.TRACKING, 'expected plain TRACKING, not an arrival/destination state');
  assert.equal(nav.segIndex, 0, 'segIndex must not have advanced past the first segment');
  assert.equal(nav.destinationReached, false);
});

test('starting at Tag 1 keeps its existing behavior unchanged', () => {
  resetState();
  selectDestination(5);
  nav.startNavigation();
  spokenTexts.length = 0;
  nav.onStartTagConfirmed(1);
  assert.equal(nav.navState, nav.NavState.TRACKING_START_TAG);
  assert.ok(
    spokenTexts.some((t) => t.startsWith('Sie befinden sich am Eingang.')),
    `expected the original Tag 1 entrance text, got: ${JSON.stringify(spokenTexts)}`
  );
});

// ==================== Problem 2: "Wo bin ich?" ====================

test('"Wo bin ich?" never speaks a raw tag number', () => {
  resetState();
  selectDestination(3);
  nav.startNavigation();
  nav.onStartTagConfirmed(6); // findPath(6,3) = [6,3], a direct one-segment route
  const response = nav.whereAmIResponse();
  assert.ok(response, 'expected a response while navigating with a confirmed tag');
  assert.ok(
    !/Markierung\s+\d/.test(response.text),
    `must not contain "Markierung <number>": ${response.text}`
  );
});

test('for segment 6->3, "Wo bin ich?" uses the configured human-readable location description', () => {
  resetState();
  selectDestination(3);
  nav.startNavigation();
  nav.onStartTagConfirmed(6);
  const response = nav.whereAmIResponse();
  const edge = EDGE_MAP['6->3'];
  assert.ok(edge.locationDescription, 'edge 6->3 must have a configured locationDescription');
  assert.ok(
    response.text.startsWith(edge.locationDescription),
    `expected response to start with the configured description, got: ${response.text}`
  );
});

test('"Wo bin ich?" adds the straight confirmation when a valid forward tag is visible and no turn is pending', () => {
  resetState();
  selectDestination(3);
  nav.startNavigation();
  nav.onStartTagConfirmed(6);
  nav.setLastExpectedVisual({ corners: [], at: performance.now() });
  const response = nav.whereAmIResponse();
  assert.equal(response.directionAdded, true);
  assert.ok(response.text.endsWith('Die Richtung stimmt. Gehen Sie weiter geradeaus.'));
});

test('"Wo bin ich?" does not add the straight confirmation when no tag is visible', () => {
  resetState();
  selectDestination(3);
  nav.startNavigation();
  nav.onStartTagConfirmed(6);
  nav.setLastExpectedVisual(null);
  const response = nav.whereAmIResponse();
  assert.equal(response.directionAdded, false);
  assert.ok(!response.text.includes('Gehen Sie weiter geradeaus.'));
});

// Note: whereAmIResponse() never receives a general per-frame detection list
// -- it only consults lastExpectedVis (the tracked, forward expected tag) and
// the already-vetted forward skip candidate. A tag behind the user, or a tag
// outside the active route, therefore cannot reach the "direction confirmed"
// branch at all by construction; there is no separate runtime path for those
// cases to exercise beyond "no valid forward signal present", covered above.

test('"Wo bin ich?" does not add the straight confirmation while an orientation turn is still unconfirmed (Tag 11 start)', () => {
  resetState();
  selectDestination(16);
  nav.startNavigation();
  nav.onStartTagConfirmed(11); // sets an unresolved postTurnPending for the reverse start
  nav.setLastExpectedVisual({ corners: [], at: performance.now() }); // Tag 10 already visible
  const response = nav.whereAmIResponse();
  assert.equal(response.directionAdded, false, 'must not confirm straight while the orientation is unconfirmed');
  assert.ok(!response.text.includes('Gehen Sie weiter geradeaus.'));
});

test('pressing "Wo bin ich?" does not change route progression or expectedTag', () => {
  resetState();
  selectDestination(3);
  nav.startNavigation();
  nav.onStartTagConfirmed(6);
  const before = {
    pathTagIds: nav.pathTagIds.slice(),
    segIndex: nav.segIndex,
    expectedNextTagId: nav.expectedNextTagId,
    currentTagId: nav.currentTagId,
  };
  nav.whereAmIResponse();
  nav.setLastExpectedVisual({ corners: [], at: performance.now() });
  nav.whereAmIResponse();
  assert.deepEqual(nav.pathTagIds, before.pathTagIds);
  assert.equal(nav.segIndex, before.segIndex);
  assert.equal(nav.expectedNextTagId, before.expectedNextTagId);
  assert.equal(nav.currentTagId, before.currentTagId);
});

// ==================== Off-route warning vs. forward-skip candidate ====================
// Regression coverage: a detected tag that is AHEAD of the expected position on the
// active path is a forward-skip candidate and must never trigger nav.offRouteWarning
// (onOtherTagConfirmed()'s off-route branch) -- that decision belongs exclusively to
// updateSkipCandidate()/beginTrackingForwardCandidate(), even while its confirmation is
// still accumulating. Tags absent from the active path, or behind the current position,
// must keep using the existing off-route/behind-position warnings unchanged.
//
// Uses a fake performance.now() clock (installed only for this block, restored
// afterward) so SETTINGS.wrongTagCooldownMs/candMemoryMs timing is deterministic and
// independent of how fast the real test process happens to run.

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

// Walks the real start-tag/tracking/reachPoint() chain from Tag 1 to Tag 6 on path
// [1, 2, 3, 6, 4, 7, 8, 10, 11] (destination 11), leaving expectedNextTagId = 4 -- the
// exact field-test scenario (expected Tag 4, detected Tag 8).
function walkToTag4Expected(advance){
  resetState();
  selectDestination(11);
  nav.startNavigation();
  nav.onStartTagConfirmed(1);
  var dist = 0.1;
  nav.setEmaDist(dist);
  nav.handleTracking(performance.now(), true, dist);
  advance(50);
  nav.handleTracking(performance.now(), true, dist); // Tag 1 reached (startTagReachedM)
  advance(50);
  for(var i = 0; i < 3; i++){ // reach Tag 2, then Tag 3, then Tag 6
    nav.onNextTagFound(dist);
    nav.setEmaDist(dist);
    nav.handleTracking(performance.now(), true, dist);
    advance(50);
    nav.handleTracking(performance.now(), true, dist);
    advance(50);
  }
  assert.deepEqual(nav.pathTagIds, [1, 2, 3, 6, 4, 7, 8, 10, 11]);
  assert.equal(nav.currentTagId, 6);
  assert.equal(nav.expectedNextTagId, 4);
}

test('a forward-skip candidate ahead on the active path never triggers nav.offRouteWarning, even while confirming', () => {
  withFakeClock(100000, (advance) => {
    walkToTag4Expected(advance);
    spokenTexts.length = 0;

    // Frames 1-5 (below SETTINGS.otherTagFrames): must stay completely silent and must
    // not mark Tag 8 as reached or retarget yet -- only the confirmation counter runs.
    for(var i = 1; i <= 5; i++){
      nav.onOtherTagConfirmed(8);
      advance(100);
      assert.ok(
        !spokenTexts.some((t) => t.includes('nicht auf dem Weg') || t.includes('möglicherweise zurück')),
        `must not warn while forward candidate confirmation accumulates (frame ${i}), got: ${JSON.stringify(spokenTexts)}`
      );
    }
    assert.equal(nav.currentTagId, 6, 'a forward candidate must not be marked reached merely by detection');
    assert.equal(nav.expectedNextTagId, 4, 'must not retarget before the real confirmation threshold is reached');

    // Drive the existing forward-skip confirmation to its real threshold.
    for(var f = 0; f < SETTINGS.otherTagFrames; f++){
      nav.updateSkipCandidate([{ id: 8, dist: 5 }], performance.now());
      advance(100);
    }
    assert.equal(nav.expectedNextTagId, 8, 'forward skip must retarget tracking to Tag 8');
    assert.equal(nav.currentTagId, 6, 'forward skip retargets tracking -- it must not be a synthetic arrival');
    assert.ok(
      !spokenTexts.some((t) => t.includes('nicht auf dem Weg')),
      'a confirmed forward skip must still never have spoken an off-route warning'
    );
  });
});

test('a tag absent from the active path still uses the existing off-route warning', () => {
  withFakeClock(120000, (advance) => {
    walkToTag4Expected(advance);
    spokenTexts.length = 0;
    nav.onOtherTagConfirmed(191); // not present anywhere in pathTagIds
    assert.ok(
      spokenTexts.some((t) => t.includes('nicht auf dem Weg')),
      `expected the existing off-route warning for a tag absent from activePath, got: ${JSON.stringify(spokenTexts)}`
    );
  });
});

test('a tag behind the current position keeps the existing behind-position warning, not a forward candidate', () => {
  withFakeClock(200000, (advance) => {
    walkToTag4Expected(advance);
    spokenTexts.length = 0;
    nav.onOtherTagConfirmed(3); // already passed (index 2, segIndex 3)
    assert.ok(
      spokenTexts.some((t) => t.includes('möglicherweise zurück')),
      `expected the existing behind-position warning for Tag 3, got: ${JSON.stringify(spokenTexts)}`
    );
    assert.ok(
      !spokenTexts.some((t) => t.includes('nicht auf dem Weg')),
      'a behind-position tag must not be treated as off-route'
    );
    assert.notEqual(nav.expectedNextTagId, 3, 'a behind-position tag must not become a forward candidate');
  });
});

// ==================== REACHED must always speak the next action (audit fix) ====================
// A physically REACHED tag must always produce a spoken next-action instruction --
// turn or straight -- even if the immediately preceding corridor already spoke the
// identical "Gehen Sie weiter geradeaus." phrase (previously suppressed via
// speakDirectionIfNew()'s activeDirectionText dedup, see reachPoint()). Secondary
// speech paths (forward-skip confirmation, reacquisition recovery, post-turn
// confirmation, corridor reassurance, scan hints) must keep their existing
// duplicate suppression unchanged -- only the REACHED-triggered straight
// instruction itself is exempted from it.

test('first straight REACHED instruction after a turn is spoken', () => {
  withFakeClock(400000, (advance) => {
    resetState();
    selectDestination(11);
    nav.startNavigation();
    nav.onStartTagConfirmed(1);
    var dist = 0.1;
    nav.setEmaDist(dist);
    nav.handleTracking(performance.now(), true, dist);
    advance(50);
    nav.handleTracking(performance.now(), true, dist); // Tag 1 reached -> turn
    advance(50);
    nav.onNextTagFound(dist);
    nav.setEmaDist(dist);
    nav.handleTracking(performance.now(), true, dist);
    advance(50);
    nav.handleTracking(performance.now(), true, dist); // Tag 2 reached -> turn (edge 2->3)
    advance(50);
    spokenTexts.length = 0;
    nav.onNextTagFound(dist);
    nav.setEmaDist(dist);
    nav.handleTracking(performance.now(), true, dist);
    advance(50);
    nav.handleTracking(performance.now(), true, dist); // Tag 3 reached -> straight (edge 3->6)
    assert.equal(
      spokenTexts.filter((t) => t === 'Gehen Sie weiter geradeaus.').length,
      1,
      `expected exactly one straight instruction at Tag 3, got: ${JSON.stringify(spokenTexts)}`
    );
  });
});

test('a second consecutive straight REACHED instruction is also spoken, not suppressed as a duplicate', () => {
  withFakeClock(500000, (advance) => {
    walkToTag4Expected(advance); // reaches Tag 3 (straight) then Tag 6 (straight) back-to-back
    assert.equal(nav.currentTagId, 6);
    assert.equal(
      spokenTexts.filter((t) => t === 'Gehen Sie weiter geradeaus.').length,
      2,
      `expected the straight instruction spoken at BOTH Tag 3 and Tag 6, got: ${JSON.stringify(spokenTexts)}`
    );
  });
});

test('REACHED + turn still speaks the turn instruction unconditionally (unchanged)', () => {
  withFakeClock(550000, (advance) => {
    resetState();
    selectDestination(11);
    nav.startNavigation();
    nav.onStartTagConfirmed(1);
    var dist = 0.1;
    nav.setEmaDist(dist);
    nav.handleTracking(performance.now(), true, dist);
    advance(50);
    nav.handleTracking(performance.now(), true, dist); // Tag 1 reached -> turn
    advance(50);
    spokenTexts.length = 0;
    nav.onNextTagFound(dist);
    nav.setEmaDist(dist);
    nav.handleTracking(performance.now(), true, dist);
    advance(50);
    nav.handleTracking(performance.now(), true, dist); // Tag 2 reached -> turn (edge 2->3)
    assert.ok(
      spokenTexts.includes('Stopp. Biegen Sie rechts ab.'),
      `expected the turn instruction at Tag 2, got: ${JSON.stringify(spokenTexts)}`
    );
  });
});

test('destination arrival is unaffected by the REACHED-speech fix', () => {
  resetState();
  selectDestination(3);
  nav.startNavigation();
  nav.onStartTagConfirmed(6); // findPath(6,3) = [6,3]
  spokenTexts.length = 0;
  var dist = 0.1;
  nav.onNextTagFound(dist);
  nav.setEmaDist(dist);
  nav.handleTracking(performance.now(), true, dist);
  nav.handleTracking(performance.now(), true, dist); // Tag 3 reached == destination
  assert.ok(
    spokenTexts.includes('Ziel erreicht. Sie sind am Eingang Flex. Die Tür befindet sich links.'),
    `expected the unchanged arrival text, got: ${JSON.stringify(spokenTexts)}`
  );
  assert.equal(nav.destinationReached, true);
});

test('duplicate suppression still applies to forward-skip confirmation (secondary path, unchanged)', () => {
  withFakeClock(600000, (advance) => {
    walkToTag4Expected(advance); // Tag 6 reached -> just spoke "Gehen Sie weiter geradeaus."
    var countBefore = spokenTexts.filter((t) => t === 'Gehen Sie weiter geradeaus.').length;
    assert.equal(countBefore, 2, 'sanity check: Tag 3 and Tag 6 already spoke the straight instruction');
    // Forward-skip candidate Tag 7 (path index 5, reachable from Tag 4 -- index 4 --
    // without an intervening maneuver via edge 4->7). Its own confirmation speech
    // would repeat the identical phrase just spoken at Tag 6 -- this must still be
    // suppressed as a duplicate (unchanged secondary-path dedup).
    for(var f = 0; f < SETTINGS.otherTagFrames; f++){
      nav.updateSkipCandidate([{ id: 7, dist: 5 }], performance.now());
      advance(100);
    }
    assert.equal(nav.expectedNextTagId, 7, 'forward skip must have retargeted tracking to Tag 7');
    var countAfter = spokenTexts.filter((t) => t === 'Gehen Sie weiter geradeaus.').length;
    assert.equal(
      countAfter, countBefore,
      `forward-skip confirmation must still be suppressed as a duplicate of the just-spoken REACHED instruction, got: ${JSON.stringify(spokenTexts)}`
    );
  });
});

// ==================== Tag 4 -> Tag 9 local 3+2 step flow ====================
// Narrow, edge-specific overlay: on the real route [6, 4, 9] (destination
// Essbereich = Tag 9, exactly the field-tested scenario), Tag 4's own arrival
// is unchanged, but the 4->9 edge additionally counts 3 genuine adaptive steps
// after Tag 4, then (after Tag 9 is reliably acquired) 2 more, before the
// destination is announced -- see the large comment block in nav.js for the
// two correctness fixes this design embodies:
//   (1) counts individual onStep candidates filtered by their OWN timestamp
//       (s.t >= phaseEnteredAt), never ADAPTIVE_WALKING_STARTED (which does
//       not re-fire if walking was already confirmed before Tag 4);
//   (2) defers the existing visual reachedM (3.0m) arrival check during the
//       final 2-step window instead of letting it race immediately.

function walkToTag9Segment(advance){
  resetState();
  // The local flow only activates when the adaptive detector is already
  // active as edge 4->9 begins (see nav.js beginSegment()) -- explicit here
  // (not relying on a previous test's leftover state) so every test using
  // this helper deterministically exercises the "detector on" path.
  nav.setAdaptiveDetectorActive(true);
  selectDestination(9);
  nav.startNavigation();
  nav.onStartTagConfirmed(6);
  assert.deepEqual(nav.pathTagIds, [6, 4, 9], 'expected the real field-tested path 6->4->9');
  assert.equal(nav.currentTagId, 6);
  assert.equal(nav.expectedNextTagId, 4);

  var closeDist = 0.5; // well under the default reachedM (1.8) used by edge 6->4
  nav.onNextTagFound(closeDist);
  for(var i = 0; i < 3; i++){
    nav.setEmaDist(closeDist);
    nav.handleTracking(performance.now(), true, closeDist);
    advance(50);
  }
  assert.equal(nav.currentTagId, 4, 'Tag 4 must have been genuinely reached');
  assert.equal(nav.expectedNextTagId, 9, 'the next edge must be exactly 4->9');
  assert.equal(nav.tag9FlowPhase, nav.Tag9Flow.WALK_AFTER_TAG4);
}

// Drives Tag 9 through TRACKING_CONFIRMED at a distance just above the edge's
// own reachedM (3.0m) -- matches the real field logs (TRACKING_CONFIRMED was
// observed at 3.16-3.68m across all 5 real runs, i.e. always just outside the
// visual arrival threshold at that exact moment).
function acquireTag9(advance, dist){
  var d = dist != null ? dist : 3.3;
  nav.onNextTagFound(d);
  for(var i = 0; i < 3; i++){
    nav.setEmaDist(d);
    nav.handleTracking(performance.now(), true, d);
    advance(50);
  }
}

test('continuous walking through Tag 4 (no fresh ADAPTIVE_WALKING_STARTED) still advances via 3 qualifying onStep events', () => {
  withFakeClock(300000, (advance) => {
    walkToTag9Segment(advance);
    spokenTexts.length = 0;
    var enteredAt = performance.now();
    // Simulates steps from a detector whose walking state was ALREADY
    // confirmed before Tag 4 -- these are exactly the kind of individual,
    // already-live onStep candidates that would occur with no new
    // ADAPTIVE_WALKING_STARTED in between (see nav.js comment).
    nav.notifyTag9FlowAdaptiveStep(enteredAt + 100);
    assert.equal(nav.tag9FlowPhase, nav.Tag9Flow.WALK_AFTER_TAG4, 'must not advance on 1 step');
    nav.notifyTag9FlowAdaptiveStep(enteredAt + 700);
    assert.equal(nav.tag9FlowPhase, nav.Tag9Flow.WALK_AFTER_TAG4, 'must not advance on 2 steps');
    nav.notifyTag9FlowAdaptiveStep(enteredAt + 1300);
    assert.equal(nav.tag9FlowPhase, nav.Tag9Flow.SEARCH_TAG9, 'must advance on the 3rd qualifying step');
    assert.ok(
      spokenTexts.includes('Stopp. Drehen Sie das Smartphone leicht nach links und suchen Sie die Markierung.'),
      `expected the search instruction, got: ${JSON.stringify(spokenTexts)}`
    );
  });
});

test('a step candidate timestamped BEFORE the phase entry (a stale pre-Tag4 backfilled step delivered late) is not counted', () => {
  withFakeClock(310000, (advance) => {
    walkToTag9Segment(advance);
    var enteredAt = performance.now();
    // Candidate physically occurred before Tag 4 was reached, but its onStep
    // callback happens to fire only now (backfill delivered late).
    nav.notifyTag9FlowAdaptiveStep(enteredAt - 500);
    nav.notifyTag9FlowAdaptiveStep(enteredAt - 10);
    assert.equal(nav.tag9FlowPhase, nav.Tag9Flow.WALK_AFTER_TAG4,
      'pre-phase candidate timestamps must never count toward this phase');
    // Only a genuinely post-entry step should be able to count from here on.
    nav.notifyTag9FlowAdaptiveStep(enteredAt);
    nav.notifyTag9FlowAdaptiveStep(enteredAt + 600);
    nav.notifyTag9FlowAdaptiveStep(enteredAt + 1200);
    assert.equal(nav.tag9FlowPhase, nav.Tag9Flow.SEARCH_TAG9,
      'exactly 3 genuinely post-entry steps must still be sufficient');
  });
});

test('adaptive steps/peaks during SEARCH_TAG9 never advance progress', () => {
  withFakeClock(320000, (advance) => {
    walkToTag9Segment(advance);
    var enteredAt = performance.now();
    nav.notifyTag9FlowAdaptiveStep(enteredAt + 100);
    nav.notifyTag9FlowAdaptiveStep(enteredAt + 700);
    nav.notifyTag9FlowAdaptiveStep(enteredAt + 1300);
    assert.equal(nav.tag9FlowPhase, nav.Tag9Flow.SEARCH_TAG9);

    // Simulated scanning motion while standing still and searching.
    var scanAt = performance.now();
    for(var i = 0; i < 5; i++){
      nav.notifyTag9FlowAdaptiveStep(scanAt + i * 100);
    }
    assert.equal(nav.tag9FlowPhase, nav.Tag9Flow.SEARCH_TAG9,
      'scan-phase motion must never advance or leak into a later phase');

    // Tag 9 acquisition must still require exactly 2 FRESH steps afterward --
    // if scan-phase motion had silently pre-seeded the counter, fewer than 2
    // new steps would suffice, which must not happen.
    acquireTag9(advance);
    assert.equal(nav.tag9FlowPhase, nav.Tag9Flow.WALK_INTO_ESSBEREICH);
    var finalEnteredAt = performance.now();
    nav.notifyTag9FlowAdaptiveStep(finalEnteredAt + 100);
    assert.equal(nav.destinationReached, false, 'one step must never be enough');
    nav.notifyTag9FlowAdaptiveStep(finalEnteredAt + 700);
    assert.equal(nav.destinationReached, true, 'exactly 2 fresh post-acquisition steps must arrive');
  });
});

test('early TRACKING_CONFIRMED(Tag 9) during WALK_AFTER_TAG4 discards the remaining first-phase count and jumps straight to WALK_INTO_ESSBEREICH', () => {
  withFakeClock(330000, (advance) => {
    walkToTag9Segment(advance);
    spokenTexts.length = 0;
    var enteredAt = performance.now();
    nav.notifyTag9FlowAdaptiveStep(enteredAt + 100); // only 1 of 3 -- still WALK_AFTER_TAG4
    assert.equal(nav.tag9FlowPhase, nav.Tag9Flow.WALK_AFTER_TAG4);

    acquireTag9(advance); // Tag 9 found early, before the 3-step phase completed
    assert.equal(nav.tag9FlowPhase, nav.Tag9Flow.WALK_INTO_ESSBEREICH,
      'early acquisition must skip SEARCH_TAG9 entirely');
    assert.ok(
      spokenTexts.includes('Gehen Sie noch etwa zwei Schritte geradeaus.'),
      `expected the final-phase instruction, got: ${JSON.stringify(spokenTexts)}`
    );
  });
});

test('the final phase requires exactly 2 fresh post-acquisition steps -- not 1, and not stale pre-acquisition ones', () => {
  withFakeClock(340000, (advance) => {
    walkToTag9Segment(advance);
    var enteredAt = performance.now();
    nav.notifyTag9FlowAdaptiveStep(enteredAt + 100);
    nav.notifyTag9FlowAdaptiveStep(enteredAt + 700);
    nav.notifyTag9FlowAdaptiveStep(enteredAt + 1300);
    acquireTag9(advance);
    var finalEnteredAt = performance.now();

    nav.notifyTag9FlowAdaptiveStep(finalEnteredAt - 200); // stale, from before acquisition
    assert.equal(nav.destinationReached, false, 'a pre-acquisition step must never count');

    nav.notifyTag9FlowAdaptiveStep(finalEnteredAt + 100);
    assert.equal(nav.destinationReached, false, 'exactly 1 fresh step must never arrive');

    nav.notifyTag9FlowAdaptiveStep(finalEnteredAt + 700);
    assert.equal(nav.destinationReached, true, 'exactly 2 fresh steps must arrive');
    assert.equal(nav.tag9FlowPhase, nav.Tag9Flow.INACTIVE, 'the flow must disarm itself after arrival');
  });
});

test('the existing visual reachedM(3.0) arrival is deferred during the protected final 2-step window', () => {
  withFakeClock(350000, (advance) => {
    walkToTag9Segment(advance);
    nav.notifyTag9FlowAdaptiveStep(performance.now() + 100);
    nav.notifyTag9FlowAdaptiveStep(performance.now() + 700);
    nav.notifyTag9FlowAdaptiveStep(performance.now() + 1300);
    acquireTag9(advance);
    assert.equal(nav.tag9FlowPhase, nav.Tag9Flow.WALK_INTO_ESSBEREICH);

    // A distance well within the edge's own reachedM (3.0m), fed for many more
    // frames than arrivalConfirmFrames would normally need -- must NOT arrive
    // while still inside the deferral window (well under 4-5s elapsed).
    for(var i = 0; i < 5; i++){
      nav.setEmaDist(1.0);
      nav.handleTracking(performance.now(), true, 1.0);
      advance(200);
    }
    assert.equal(nav.destinationReached, false,
      'visual reachedM must not be allowed to race ahead of the 2-step phase');
    assert.equal(nav.navState, nav.NavState.TRACKING);
  });
});

test('the phase-2 fallback timeout re-enables the existing visual arrival, and the timeout itself never announces destination', () => {
  withFakeClock(360000, (advance) => {
    walkToTag9Segment(advance);
    nav.notifyTag9FlowAdaptiveStep(performance.now() + 100);
    nav.notifyTag9FlowAdaptiveStep(performance.now() + 700);
    nav.notifyTag9FlowAdaptiveStep(performance.now() + 1300);
    acquireTag9(advance);
    assert.equal(nav.tag9FlowPhase, nav.Tag9Flow.WALK_INTO_ESSBEREICH);

    // Let the ~4-5s phase-2 timeout elapse with NO qualifying steps counted.
    advance(5000);
    assert.equal(nav.destinationReached, false,
      'merely letting the timeout elapse must never itself announce arrival');

    // Visual arrival must now be fully re-enabled, exactly like any other edge.
    for(var i = 0; i < 3; i++){
      nav.setEmaDist(1.0);
      nav.handleTracking(performance.now(), true, 1.0);
      advance(200);
    }
    assert.equal(nav.destinationReached, true,
      'the existing visual reachedM arrival must work as the safety fallback after the timeout');
  });
});

test('visual arrival winning the race first prevents a duplicate step-based arrival', () => {
  withFakeClock(370000, (advance) => {
    walkToTag9Segment(advance);
    nav.notifyTag9FlowAdaptiveStep(performance.now() + 100);
    nav.notifyTag9FlowAdaptiveStep(performance.now() + 700);
    nav.notifyTag9FlowAdaptiveStep(performance.now() + 1300);
    acquireTag9(advance);
    advance(5000); // let the phase-2 timeout re-enable visual arrival
    for(var i = 0; i < 3; i++){
      nav.setEmaDist(1.0);
      nav.handleTracking(performance.now(), true, 1.0);
      advance(200);
    }
    assert.equal(nav.destinationReached, true);
    var spokenCountAfterVisualArrival = spokenTexts.length;

    // A step-confirmation callback arriving after visual already won must be a
    // harmless no-op -- no second arrival announcement, no crash.
    assert.doesNotThrow(() => {
      nav.notifyTag9FlowAdaptiveStep(performance.now() + 100);
      nav.notifyTag9FlowAdaptiveStep(performance.now() + 700);
    });
    assert.equal(spokenTexts.length, spokenCountAfterVisualArrival,
      'no additional speech may be produced once the destination is already reached');
  });
});

test('restarting the route clears the Tag 9 flow state', () => {
  withFakeClock(380000, (advance) => {
    walkToTag9Segment(advance);
    nav.notifyTag9FlowAdaptiveStep(performance.now() + 100);
    assert.notEqual(nav.tag9FlowPhase, nav.Tag9Flow.INACTIVE);

    selectDestination(9);
    nav.startNavigation();
    assert.equal(nav.tag9FlowPhase, nav.Tag9Flow.INACTIVE, 'a fresh route start must clear any prior flow state');
  });
});

test('ending navigation clears the Tag 9 flow state', () => {
  withFakeClock(390000, (advance) => {
    walkToTag9Segment(advance);
    nav.notifyTag9FlowAdaptiveStep(performance.now() + 100);
    nav.notifyTag9FlowAdaptiveStep(performance.now() + 700);
    assert.notEqual(nav.tag9FlowPhase, nav.Tag9Flow.INACTIVE);

    nav.endNavigation(false);
    assert.equal(nav.tag9FlowPhase, nav.Tag9Flow.INACTIVE, 'ending navigation must clear any prior flow state');
  });
});

test('a different edge through Tag 4 (not 4->9) never activates the local step flow', () => {
  withFakeClock(400000, (advance) => {
    nav.setAdaptiveDetectorActive(true); // even WITH an active detector, only edge 4->9 may activate
    walkToTag4Expected(advance); // real path [1,2,3,6,4,7,8,10,11] -- next edge is 4->7, not 4->9
    spokenTexts.length = 0;
    var closeDist = 0.5;
    nav.onNextTagFound(closeDist);
    for(var i = 0; i < 3; i++){
      nav.setEmaDist(closeDist);
      nav.handleTracking(performance.now(), true, closeDist);
      advance(50);
    }
    assert.equal(nav.currentTagId, 4);
    assert.equal(nav.expectedNextTagId, 7, 'this route continues 4->7, not 4->9');
    assert.equal(nav.tag9FlowPhase, nav.Tag9Flow.INACTIVE, 'the local flow must never activate on a different edge');
    assert.ok(
      !spokenTexts.includes('Gehen Sie geradeaus.'),
      'the flow-specific phase-1 instruction must never be spoken on a different edge'
    );
  });
});

test('the first-phase fallback timeout advances to SEARCH_TAG9 without ever announcing arrival, and logs a fallback reason (detector active but silent -- weak/no steps counted)', () => {
  withFakeClock(410000, (advance) => {
    walkToTag9Segment(advance);
    spokenTexts.length = 0;
    advance(12000); // past the ~10-12s phase-1 timeout, with zero qualifying steps
    nav.scanHint(); // main-loop.js calls this every frame while SEARCHING_NEXT_TAG
    assert.equal(nav.tag9FlowPhase, nav.Tag9Flow.SEARCH_TAG9,
      'the fallback must still advance the flow even with no detector signal at all');
    assert.equal(nav.destinationReached, false, 'the fallback must never itself announce arrival');
  });
});

// ==================== Field-failure fix: detector inactive at edge entry ====================
// Real field log wegweiser-v13-log-20260817-140404(31).json: 4/4 real Tag 4->9
// attempts had detectorActive:false the whole time (STEP_PERMISSION_DENIED),
// stepCount stayed 0, yet the local flow still activated and the ~11s
// phase-1-timeout became the de-facto (unsafe) trigger for the "Stopp..."
// instruction -- confirmed by the log to fire well after the user had already
// walked past the intended search point. Fix: the flow may only activate if
// the adaptive detector is ALREADY active the moment edge 4->9 begins.

test('detector inactive when edge 4->9 begins: the local flow stays fully INACTIVE and generic visual navigation behaves exactly as before (reproduces the real field failure structurally)', () => {
  withFakeClock(420000, (advance) => {
    resetState();
    nav.setAdaptiveDetectorActive(false); // explicit -- reproduces STEP_PERMISSION_DENIED / detector never started
    selectDestination(9);
    nav.startNavigation();
    nav.onStartTagConfirmed(6);
    var closeDist = 0.5;
    nav.onNextTagFound(closeDist);
    for(var i = 0; i < 3; i++){
      nav.setEmaDist(closeDist);
      nav.handleTracking(performance.now(), true, closeDist);
      advance(50);
    }
    assert.equal(nav.currentTagId, 4);
    assert.equal(nav.expectedNextTagId, 9);
    assert.equal(nav.tag9FlowPhase, nav.Tag9Flow.INACTIVE,
      'the local flow must never enter WALK_AFTER_TAG4 when the detector is inactive');
    spokenTexts.length = 0;

    // Even letting far more than the old ~11s phase-1 timeout elapse, with
    // scanHint() (main-loop.js's real per-frame call) driven repeatedly, must
    // never produce the local flow's instruction or transition -- there is no
    // local phase to time out at all.
    for(var f = 0; f < 5; f++){
      advance(3000);
      nav.scanHint();
    }
    assert.equal(nav.tag9FlowPhase, nav.Tag9Flow.INACTIVE, 'no local phase timeout can fire if the flow never started');
    assert.ok(
      !spokenTexts.includes('Stopp. Drehen Sie das Smartphone leicht nach links und suchen Sie die Markierung.'),
      `the local "Stopp..." instruction must never be generated when the detector is inactive, got: ${JSON.stringify(spokenTexts)}`
    );
    assert.ok(
      !spokenTexts.includes('Gehen Sie geradeaus.'),
      'the local phase-1 instruction must never be spoken when the detector is inactive'
    );
    // Existing generic visual navigation must be fully intact: the untouched
    // scanHint() search hint fires normally...
    assert.ok(
      spokenTexts.some((t) => t.includes('suchen Sie die Markierung')),
      `expected the existing generic search hint to still fire normally, got: ${JSON.stringify(spokenTexts)}`
    );

    // ...and visual reachedM (3.0m) remains immediately active (undeferred) --
    // exactly the pre-existing, previously field-validated behavior for this
    // edge.
    nav.onNextTagFound(3.3);
    for(var j = 0; j < 3; j++){
      nav.setEmaDist(1.0);
      nav.handleTracking(performance.now(), true, 1.0);
      advance(50);
    }
    assert.equal(nav.destinationReached, true,
      'visual reachedM must arrive immediately, undeferred, exactly as on any other edge');
  });
});

test('detector active at edge entry, but stopped again before Tag 4 is reached: the local flow does not activate for that segment', () => {
  withFakeClock(430000, (advance) => {
    resetState();
    nav.setAdaptiveDetectorActive(true);
    nav.setAdaptiveDetectorActive(false); // e.g. STEP_PERMISSION_DENIED after a retry, before Tag 4 is reached
    selectDestination(9);
    nav.startNavigation();
    nav.onStartTagConfirmed(6);
    var closeDist = 0.5;
    nav.onNextTagFound(closeDist);
    for(var i = 0; i < 3; i++){
      nav.setEmaDist(closeDist);
      nav.handleTracking(performance.now(), true, closeDist);
      advance(50);
    }
    assert.equal(nav.tag9FlowPhase, nav.Tag9Flow.INACTIVE,
      'only the detector state AT THE MOMENT Tag 4 is reached matters, not any earlier state');
  });
});

test('the generic time-based scanHint() is suppressed while the local flow is in WALK_AFTER_TAG4, but resumes normally once SEARCH_TAG9 is reached', () => {
  withFakeClock(440000, (advance) => {
    walkToTag9Segment(advance); // detector active, enters WALK_AFTER_TAG4
    spokenTexts.length = 0;

    // Advance well past the generic scanHint's own scanHintAfterMs (8000ms)
    // while still inside WALK_AFTER_TAG4 (no qualifying steps counted) --
    // the real field failure showed this firing here and overlapping/
    // conflicting with the local flow's own instructions.
    advance(9000);
    nav.scanHint();
    assert.ok(
      !spokenTexts.some((t) => t.includes('Gehen Sie noch etwa zwei Meter geradeaus')),
      `the generic time-based scan hint must not speak during WALK_AFTER_TAG4, got: ${JSON.stringify(spokenTexts)}`
    );
    assert.equal(nav.tag9FlowPhase, nav.Tag9Flow.WALK_AFTER_TAG4, 'must not have been force-advanced by scanHint() itself');

    // Now genuinely advance the local flow to SEARCH_TAG9 via 3 qualifying steps.
    var enteredAt = performance.now();
    nav.notifyTag9FlowAdaptiveStep(enteredAt + 100);
    nav.notifyTag9FlowAdaptiveStep(enteredAt + 700);
    nav.notifyTag9FlowAdaptiveStep(enteredAt + 1300);
    assert.equal(nav.tag9FlowPhase, nav.Tag9Flow.SEARCH_TAG9);
    spokenTexts.length = 0;

    // The existing generic search-retry mechanism may continue once in
    // SEARCH_TAG9 -- it must not be permanently suppressed for the rest of
    // the edge.
    advance(13000);
    nav.scanHint();
    assert.ok(
      spokenTexts.length > 0,
      'the generic search-retry mechanism must still be able to speak once SEARCH_TAG9 is reached'
    );
  });
});

// ==================== Automatic detector lifecycle hooks (setTag9DetectorHooks) ====================
// app.js registers { ensureActive, notifyFlowEnded } once at module load (see
// ensureTag9DetectorActive()/onTag9FlowEnded() there); nav.js itself still
// knows nothing about the detector/permission/ownership -- it only calls
// these two functions synchronously at the exact points documented in
// beginSegment()/resetTag9Flow()/completeTag9FlowArrival(). These tests
// exercise that CONTRACT with fake hooks standing in for app.js, without a
// DOM/detector harness (none exists for app.js in this project).

function makeFakeTag9Hooks(simulateGranted){
  var calls = { ensureActiveCount: 0, flowEndedReasons: [] };
  nav.setTag9DetectorHooks({
    ensureActive: function(){
      calls.ensureActiveCount++;
      // Mirrors app.js's real contract: on success, the hook itself calls
      // setAdaptiveDetectorActive(true) as a side effect; on failure
      // (permission denied/unavailable), it does nothing.
      if(simulateGranted) nav.setAdaptiveDetectorActive(true);
    },
    notifyFlowEnded: function(reason){ calls.flowEndedReasons.push(reason); }
  });
  return calls;
}

test('permission granted (simulated via hooks): entering edge 4->9 automatically activates the detector and starts the local flow', () => {
  withFakeClock(500000, (advance) => {
    resetState();
    var calls = makeFakeTag9Hooks(true);
    selectDestination(9);
    nav.startNavigation();
    nav.onStartTagConfirmed(6);
    var closeDist = 0.5;
    nav.onNextTagFound(closeDist);
    for(var i = 0; i < 3; i++){
      nav.setEmaDist(closeDist);
      nav.handleTracking(performance.now(), true, closeDist);
      advance(50);
    }
    assert.equal(calls.ensureActiveCount, 1, 'ensureActive() must be called exactly once when edge 4->9 begins');
    assert.equal(nav.tag9FlowPhase, nav.Tag9Flow.WALK_AFTER_TAG4,
      'the local flow must activate once the hook grants an active detector');
  });
});

test('permission denied (simulated via hooks): entering edge 4->9 does NOT start the local flow, and no 11s fake-distance fallback exists', () => {
  withFakeClock(510000, (advance) => {
    resetState();
    var calls = makeFakeTag9Hooks(false); // hook is called but never activates the detector
    selectDestination(9);
    nav.startNavigation();
    nav.onStartTagConfirmed(6);
    var closeDist = 0.5;
    nav.onNextTagFound(closeDist);
    for(var i = 0; i < 3; i++){
      nav.setEmaDist(closeDist);
      nav.handleTracking(performance.now(), true, closeDist);
      advance(50);
    }
    assert.equal(calls.ensureActiveCount, 1, 'ensureActive() must still be attempted');
    assert.equal(nav.tag9FlowPhase, nav.Tag9Flow.INACTIVE,
      'the local flow must stay inactive when the hook cannot activate the detector');
    spokenTexts.length = 0;
    advance(12000); // well past the old, no-longer-relevant ~11s window
    nav.scanHint();
    assert.equal(nav.tag9FlowPhase, nav.Tag9Flow.INACTIVE, 'there is no local phase to time out');
    assert.ok(
      !spokenTexts.includes('Stopp. Drehen Sie das Smartphone leicht nach links und suchen Sie die Markierung.'),
      'no fake-distance-driven instruction may ever appear when permission was denied'
    );
  });
});

test('ensureActive() is never called for any edge other than 4->9', () => {
  withFakeClock(520000, (advance) => {
    resetState();
    var calls = makeFakeTag9Hooks(true);
    walkToTag4Expected(advance); // real path [1,2,3,6,4,7,8,10,11] -- reaches Tag 2, 3, 6 first
    assert.equal(calls.ensureActiveCount, 0, 'no edge before 4->9 may ever call ensureActive()');
    var closeDist = 0.5;
    nav.onNextTagFound(closeDist);
    for(var i = 0; i < 3; i++){
      nav.setEmaDist(closeDist);
      nav.handleTracking(performance.now(), true, closeDist);
      advance(50);
    }
    assert.equal(nav.expectedNextTagId, 7, 'this route continues 4->7, not 4->9');
    assert.equal(calls.ensureActiveCount, 0, 'edge 4->7 must never call ensureActive() either');
  });
});

test('arrival via the step-based path calls notifyFlowEnded exactly once with reason "step-count"', () => {
  withFakeClock(530000, (advance) => {
    resetState();
    var calls = makeFakeTag9Hooks(true);
    selectDestination(9);
    nav.startNavigation();
    nav.onStartTagConfirmed(6);
    var closeDist = 0.5;
    nav.onNextTagFound(closeDist);
    for(var i = 0; i < 3; i++){
      nav.setEmaDist(closeDist);
      nav.handleTracking(performance.now(), true, closeDist);
      advance(50);
    }
    var enteredAt = performance.now();
    nav.notifyTag9FlowAdaptiveStep(enteredAt + 100);
    nav.notifyTag9FlowAdaptiveStep(enteredAt + 700);
    nav.notifyTag9FlowAdaptiveStep(enteredAt + 1300);
    nav.onNextTagFound(3.3);
    for(var j = 0; j < 3; j++){
      nav.setEmaDist(3.3);
      nav.handleTracking(performance.now(), true, 3.3);
      advance(50);
    }
    assert.equal(nav.tag9FlowPhase, nav.Tag9Flow.WALK_INTO_ESSBEREICH);
    var finalEnteredAt = performance.now();
    nav.notifyTag9FlowAdaptiveStep(finalEnteredAt + 100);
    nav.notifyTag9FlowAdaptiveStep(finalEnteredAt + 700);
    assert.equal(nav.destinationReached, true);
    assert.deepEqual(calls.flowEndedReasons, ['step-count'],
      'notifyFlowEnded must fire exactly once, with reason "step-count"');
  });
});

test('route restart/cancellation calls notifyFlowEnded so an automatically-started detector can be stopped, and a later fresh 4->9 entry starts clean', () => {
  withFakeClock(540000, (advance) => {
    resetState();
    var calls = makeFakeTag9Hooks(true);
    selectDestination(9);
    nav.startNavigation();
    nav.onStartTagConfirmed(6);
    var closeDist = 0.5;
    nav.onNextTagFound(closeDist);
    for(var i = 0; i < 3; i++){
      nav.setEmaDist(closeDist);
      nav.handleTracking(performance.now(), true, closeDist);
      advance(50);
    }
    assert.equal(nav.tag9FlowPhase, nav.Tag9Flow.WALK_AFTER_TAG4);
    assert.equal(calls.ensureActiveCount, 1);

    nav.endNavigation(false); // route cancelled mid-flow
    assert.deepEqual(calls.flowEndedReasons, ['route-end:manual'],
      'ending navigation mid-flow must notify with a route-end reason');
    assert.equal(nav.tag9FlowPhase, nav.Tag9Flow.INACTIVE);

    // A later, fresh 4->9 entry (new route) must call ensureActive() again,
    // independently, and start from a clean phase/step count.
    nav.setAdaptiveDetectorActive(false); // simulates the previous auto-started session having been stopped
    selectDestination(9);
    nav.startNavigation();
    nav.onStartTagConfirmed(6);
    nav.onNextTagFound(closeDist);
    for(var j = 0; j < 3; j++){
      nav.setEmaDist(closeDist);
      nav.handleTracking(performance.now(), true, closeDist);
      advance(50);
    }
    assert.equal(calls.ensureActiveCount, 2, 'a later 4->9 entry must call ensureActive() again, fresh');
    assert.equal(nav.tag9FlowPhase, nav.Tag9Flow.WALK_AFTER_TAG4);
  });
});

test('without any registered hooks, behavior is unchanged from before this stage (nav.setAdaptiveDetectorActive remains the direct control, as used by all prior 3+2 tests)', () => {
  withFakeClock(550000, (advance) => {
    walkToTag9Segment(advance); // no hooks registered -- relies purely on nav.setAdaptiveDetectorActive(true)
    assert.equal(nav.tag9FlowPhase, nav.Tag9Flow.WALK_AFTER_TAG4);
  });
});
