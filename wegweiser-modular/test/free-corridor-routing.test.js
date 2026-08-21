// Behavioral tests for the "free corridor routing" feature set:
//   1. Tag 2 and Tag 15 both work as full, normal start tags near Patrik.
//   2. Tag 2 -> Tag 16 is a start-only override (no graph edge), reusing the
//      existing setPostTurnPending()/tryPostTurnConfirmation() mechanism.
//   3. Patrik (destination 2) has an alternate physical arrival marker (Tag 15)
//      for the reverse-corridor approach, via ARRIVAL_ALIASES/isArrivalTag().
//   4. Tag 16 is silently ignored by onOtherTagConfirmed() when it is not part
//      of the active path (it sits ~2m from Tag 1 and is otherwise a false alarm).
//   5. The Tag 8->7->5 staged step flow (3 real adaptive steps, then the exact
//      approved turn instruction; the unchanged 4->7->5 approach; the safe
//      "never auto-advance" fallback).
//
// NOTE: the new edge 15->3 (Tag 15 as a start toward the main office corridor)
// is intentionally NOT implemented yet -- its departureAction/text still need
// field verification (see graph-data.js). Tests that would need it are omitted;
// the invariant that Tag 15 does not falsely trigger a Patrik arrival is instead
// exercised against destination 16.

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

// Walks pathTagIds[0..] forward by `count` REACHED segments using the same
// onNextTagFound()+handleTracking() pattern already established in nav.test.js.
function walkSegments(count, dist){
  for(var i = 0; i < count; i++){
    nav.onNextTagFound(dist);
    nav.setEmaDist(dist);
    nav.handleTracking(performance.now(), true, dist);
    nav.handleTracking(performance.now(), true, dist);
  }
}

// ==================== Tag 2 / Tag 15 as normal starts ====================

test('Tag 2 behaves as a completely normal start toward the main office corridor', () => {
  resetState();
  selectDestination(14);
  nav.startNavigation();
  nav.onStartTagConfirmed(2);
  assert.deepEqual(nav.pathTagIds, [2, 3, 6, 4, 7, 8, 10, 11, 12, 13, 14]);
  assert.equal(nav.expectedNextTagId, 3);
  assert.ok(!spokenTexts.some((t) => t.includes('kein Weg')));
});

test('Tag 15 as start toward destination 16 uses the existing, unmodified 15->16 edge', () => {
  resetState();
  selectDestination(16);
  nav.startNavigation();
  nav.onStartTagConfirmed(15);
  assert.deepEqual(nav.pathTagIds, [15, 16]);
  assert.equal(nav.expectedNextTagId, 16);
});

test('starting at Tag 15 for a destination other than Patrik does not trigger any Patrik arrival', () => {
  resetState();
  selectDestination(16);
  nav.startNavigation();
  nav.onStartTagConfirmed(15);
  assert.equal(nav.destinationReached, false, 'must not immediately arrive');
  assert.deepEqual(nav.pathTagIds, [15, 16]);
});

// ==================== Tag 2 -> Tag 16 start-only override ====================

test('Tag 2 start with destination 16 uses the start-only override: approved wording, then accepts Tag 16 as expected', () => {
  resetState();
  selectDestination(16);
  nav.startNavigation();
  nav.onStartTagConfirmed(2);

  assert.deepEqual(nav.pathTagIds, [2, 16]);
  assert.equal(nav.expectedNextTagId, 16);
  assert.ok(
    spokenTexts.includes('Drehen Sie sich um und halten Sie das Smartphone gerade vor sich.'),
    `expected the approved start instruction, got: ${JSON.stringify(spokenTexts)}`
  );
  assert.ok(!spokenTexts.some((t) => t.includes('Ausgang suchen')), 'must not encourage scanning/searching wording');
  spokenTexts.length = 0;

  // Tag 16 genuinely confirmed via the normal detection path -> deferred post-turn confirmation.
  nav.onNextTagFound(3.0);
  assert.ok(
    spokenTexts.includes('Die Richtung stimmt. Halten Sie das Smartphone gerade vor sich.'),
    `expected the approved post-turn confirmation, got: ${JSON.stringify(spokenTexts)}`
  );

  spokenTexts.length = 0;
  nav.setEmaDist(0.1);
  nav.handleTracking(performance.now(), true, 0.1);
  nav.handleTracking(performance.now(), true, 0.1); // Tag 16 reached == destination
  assert.equal(nav.destinationReached, true);
  assert.ok(spokenTexts.some((t) => t.includes('Ausgang')));
});

// ==================== Tag 16 silent-ignore (off-path) ====================

test('Tag 16 detected off-path (unrelated destination) is completely silent and does not alter route state', () => {
  withFakeClock(700000, () => {
    resetState();
    selectDestination(14);
    nav.startNavigation();
    nav.onStartTagConfirmed(4); // any ordinary, non-special-cased start tag
    var before = {
      path: nav.pathTagIds.slice(), segIndex: nav.segIndex,
      expected: nav.expectedNextTagId, navState: nav.navState,
    };
    spokenTexts.length = 0;

    nav.onOtherTagConfirmed(16);

    assert.equal(spokenTexts.length, 0, `must be completely silent, got: ${JSON.stringify(spokenTexts)}`);
    assert.deepEqual(nav.pathTagIds, before.path);
    assert.equal(nav.segIndex, before.segIndex);
    assert.equal(nav.expectedNextTagId, before.expected);
    assert.equal(nav.navState, before.navState);
  });
});

test('a genuinely off-route tag other than 16 still speaks the existing warning, unaffected by the Tag-16 guard', () => {
  withFakeClock(710000, () => {
    resetState();
    selectDestination(14);
    nav.startNavigation();
    nav.onStartTagConfirmed(4);
    spokenTexts.length = 0;

    nav.onOtherTagConfirmed(5); // Tischtennis, not on this path

    assert.ok(spokenTexts.some((t) => t.includes('nicht auf dem Weg')));
  });
});

test('sighting Tag 16 off-path does not suppress a later, genuinely off-route warning for a different tag', () => {
  withFakeClock(720000, () => {
    resetState();
    selectDestination(14);
    nav.startNavigation();
    nav.onStartTagConfirmed(4);
    spokenTexts.length = 0;

    nav.onOtherTagConfirmed(16); // silent -- must not touch the shared cooldown timer
    nav.onOtherTagConfirmed(5); // must still speak normally right after

    assert.ok(
      spokenTexts.some((t) => t.includes('nicht auf dem Weg')),
      `Tag 16's silence must not have suppressed this via the shared cooldown, got: ${JSON.stringify(spokenTexts)}`
    );
  });
});

test('a route that genuinely includes Tag 16 still recognizes it normally (guard does not fire)', () => {
  resetState();
  selectDestination(16);
  nav.startNavigation();
  nav.onStartTagConfirmed(15); // pathTagIds = [15, 16]
  spokenTexts.length = 0;
  nav.onNextTagFound(0.1);
  nav.setEmaDist(0.1);
  nav.handleTracking(performance.now(), true, 0.1);
  nav.handleTracking(performance.now(), true, 0.1);
  assert.equal(nav.destinationReached, true, 'Tag 16 must still be recognized as the destination on a route that includes it');
});

// ==================== Patrik alternate arrival (Tag 15) ====================

test('Patrik from the entrance side still ends at Tag 2', () => {
  resetState();
  selectDestination(2);
  nav.startNavigation();
  nav.onStartTagConfirmed(1); // Tag 1 special case: beginStartTagTracking(), not beginSegment() yet
  assert.deepEqual(nav.pathTagIds, [1, 2]);
  spokenTexts.length = 0;
  nav.setEmaDist(0.1);
  nav.handleTracking(performance.now(), true, 0.1);
  nav.handleTracking(performance.now(), true, 0.1); // Tag 1 reached (startTagReachedM) -> beginSegment() for 1->2
  nav.onNextTagFound(0.1);
  nav.setEmaDist(0.1);
  nav.handleTracking(performance.now(), true, 0.1);
  nav.handleTracking(performance.now(), true, 0.1); // Tag 2 reached == destination
  assert.equal(nav.destinationReached, true);
  assert.ok(spokenTexts.some((t) => t.includes('Patrik')));
});

test('Patrik from the reverse corridor side (fresh start at Tag 3) ends at Tag 15 (alias), not Tag 2', () => {
  resetState();
  selectDestination(2);
  nav.startNavigation();
  nav.onStartTagConfirmed(3); // findPathToDestination(3,2): direct fails, alias -> [3,15]
  assert.deepEqual(nav.pathTagIds, [3, 15]);
  assert.equal(nav.expectedNextTagId, 15);
  assert.ok(!spokenTexts.some((t) => t.includes('kein Weg')));

  spokenTexts.length = 0;
  nav.onNextTagFound(0.1);
  nav.setEmaDist(0.1);
  nav.handleTracking(performance.now(), true, 0.1);
  nav.handleTracking(performance.now(), true, 0.1); // Tag 15 reached

  assert.equal(nav.destinationReached, true, 'Tag 15 must count as Patrik reached -- Tag 2 must never be required');
  // ARRIVALS[15] is intentionally not defined yet (pending field verification) --
  // arriveAtDestination() falls back to ARRIVALS[destinationId] (2) in the meantime.
  assert.ok(spokenTexts.some((t) => t.includes('Patrik')));
});

test('starting exactly at Tag 15 with destination Patrik arrives immediately via the alias', () => {
  resetState();
  selectDestination(2);
  nav.startNavigation();
  nav.onStartTagConfirmed(15);
  assert.equal(nav.destinationReached, true);
  assert.ok(spokenTexts.some((t) => t.includes('Patrik')));
});

// ==================== Start-candidate comparison: Tag 2 and Tag 15 both visible ====================

test('both Tag 2 and Tag 15 confirmed in the same window: Tag 2 winning (nearer) still produces a valid route', () => {
  resetState();
  selectDestination(7);
  nav.startNavigation();
  var t = 5000;
  [2.0, 1.9].forEach((d) => nav.recordStartCandidateSample(2, d));
  nav.noteStartCandidateConfirmed(2, t);
  t += 150;
  [5.0, 5.1].forEach((d) => nav.recordStartCandidateSample(15, d));
  nav.noteStartCandidateConfirmed(15, t);
  t += SETTINGS.startCandidateWindowMs + 50;

  assert.equal(nav.checkStartCandidateWindow(t), true);
  assert.equal(nav.currentTagId, 2, 'the nearer candidate (Tag 2) must win');
  assert.ok(!spokenTexts.some((s) => s.includes('kein Weg')));
  assert.deepEqual(nav.pathTagIds, [2, 3, 6, 4, 7]);
});

test('both Tag 2 and Tag 15 confirmed in the same window: Tag 15 winning (nearer) still produces a valid route', () => {
  resetState();
  selectDestination(16);
  nav.startNavigation();
  var t = 6000;
  [5.0, 5.1].forEach((d) => nav.recordStartCandidateSample(2, d));
  nav.noteStartCandidateConfirmed(2, t);
  t += 150;
  [2.0, 1.9].forEach((d) => nav.recordStartCandidateSample(15, d));
  nav.noteStartCandidateConfirmed(15, t);
  t += SETTINGS.startCandidateWindowMs + 50;

  assert.equal(nav.checkStartCandidateWindow(t), true);
  assert.equal(nav.currentTagId, 15, 'the nearer candidate (Tag 15) must win');
  assert.deepEqual(nav.pathTagIds, [15, 16]);
});

// ==================== Tag 8 -> Tag 7 -> Tag 5 staged flow ====================

test('reaching Tag 7 via predecessor 8 toward Tag 5: speaks "Gehen Sie geradeaus.", suppresses the generic turn text', () => {
  resetState();
  selectDestination(5);
  nav.startNavigation();
  nav.onStartTagConfirmed(14); // findPath(14,5) = [14,13,12,11,10,8,7,5]
  walkSegments(6, 0.1); // reach 13,12,11,10,8,7 in sequence

  assert.equal(nav.currentTagId, 7);
  assert.equal(nav.expectedNextTagId, 5);
  assert.ok(spokenTexts.includes('Gehen Sie geradeaus.'), `expected the walk prompt, got: ${JSON.stringify(spokenTexts)}`);
  assert.ok(
    !spokenTexts.some((t) => t.includes('Biegen Sie rechts ab.')),
    'the generic via-4 turn text must be suppressed for this approach'
  );
});

test('exactly 3 real adaptive steps -> the exact approved turn instruction, not before', () => {
  resetState();
  selectDestination(5);
  nav.startNavigation();
  nav.onStartTagConfirmed(14);
  walkSegments(6, 0.1);
  spokenTexts.length = 0;

  var enteredAt = performance.now();
  nav.notifyTag7Via8FlowStep(enteredAt + 100);
  nav.notifyTag7Via8FlowStep(enteredAt + 700);
  assert.ok(
    !spokenTexts.some((t) => t.includes('Biegen Sie links ab')),
    'must not speak the turn before 3 steps'
  );

  nav.notifyTag7Via8FlowStep(enteredAt + 1300);
  assert.ok(
    spokenTexts.includes(
      'Stopp. Biegen Sie links ab. Gehen Sie danach geradeaus und halten Sie das Smartphone gerade vor sich.'
    ),
    `expected the exact approved turn instruction, got: ${JSON.stringify(spokenTexts)}`
  );
  assert.equal(nav.tag7Via8FlowPhase, nav.Tag7Via8Flow.INACTIVE);
});

test('the existing 4->7->5 approach remains completely unaffected', () => {
  resetState();
  selectDestination(5);
  nav.startNavigation();
  nav.onStartTagConfirmed(4); // findPath(4,5) = [4,7,5]
  walkSegments(1, 0.1); // reach Tag 7 via predecessor 4

  assert.equal(nav.currentTagId, 7);
  assert.ok(
    spokenTexts.some((t) => t.includes('Stopp. Biegen Sie rechts ab.')),
    `expected the unchanged immediate via-4 turn instruction, got: ${JSON.stringify(spokenTexts)}`
  );
  assert.ok(!spokenTexts.includes('Gehen Sie geradeaus.'), 'the staged flow must not activate for this approach');
});

test('no steps within the reminder window: a reposition reminder is spoken, the turn is never spoken automatically', () => {
  withFakeClock(910000, (advance) => {
    resetState();
    selectDestination(5);
    nav.startNavigation();
    nav.onStartTagConfirmed(14);
    walkSegments(6, 0.1);
    spokenTexts.length = 0;

    advance(6100); // just over the reminder interval
    nav.scanHint();

    assert.ok(
      spokenTexts.some((t) => t.includes('Halten Sie das Smartphone gerade vor sich')),
      `expected a reposition reminder, got: ${JSON.stringify(spokenTexts)}`
    );
    assert.ok(!spokenTexts.some((t) => t.includes('Biegen Sie links ab')), 'must never auto-advance to the turn');
    assert.equal(nav.tag7Via8FlowPhase, nav.Tag7Via8Flow.WALKING, 'must remain in WALKING, not advance');

    spokenTexts.length = 0;
    advance(6100);
    nav.scanHint();
    assert.ok(spokenTexts.length > 0, 'the reminder must repeat, not fire only once');
    assert.ok(!spokenTexts.some((t) => t.includes('Biegen Sie links ab')));
  });
});

test('Tag 5 visually confirmed early ends the flow silently, without ever speaking the turn line', () => {
  resetState();
  selectDestination(5);
  nav.startNavigation();
  nav.onStartTagConfirmed(14);
  walkSegments(6, 0.1);
  spokenTexts.length = 0;

  nav.setEmaDist(3.0);
  for(var i = 0; i < SETTINGS.trackingConfirmDetections; i++){
    nav.handleTracking(performance.now(), true, 3.0); // well above reachedM (1.0) -- no arrival, just tracking-confirmed
  }

  assert.equal(nav.tag7Via8FlowPhase, nav.Tag7Via8Flow.INACTIVE);
  assert.ok(!spokenTexts.some((t) => t.includes('Biegen Sie links ab')));
});

test('the staged flow resets cleanly on navigation restart', () => {
  resetState();
  selectDestination(5);
  nav.startNavigation();
  nav.onStartTagConfirmed(14);
  walkSegments(6, 0.1);
  assert.equal(nav.tag7Via8FlowPhase, nav.Tag7Via8Flow.WALKING);

  resetState();
  assert.equal(nav.tag7Via8FlowPhase, nav.Tag7Via8Flow.INACTIVE);
});
