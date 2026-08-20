// Behavioral tests for the generic rule: when the EXPECTED tag is visually confirmed
// and its outgoing edge is continue-straight, speak "Gehen Sie weiter geradeaus."
// immediately, instead of staying silent until REACHED/forward-skip/post-turn/corridor
// reassurance. Regression target: field case where Tag 13 was confirmed but never
// reached (bypassed by a forward-skip to Tag 12), leaving the user without feedback for
// several seconds. Tag IDs below (10-14) are the pre-existing office-extension edges
// used only because their departureAction values are already known and field-verified
// (see graph-data.js) -- the rule itself is generic and applies to any tag.
//
// Drives nav.js's exported functions directly (onExpectedTagFound, handleTracking,
// updateSkipCandidate, onStartTagConfirmed), bypassing the camera/detector and
// main-loop.js's per-frame CONFIRM_FRAMES counting -- consistent with the rest of
// nav.test.js.

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

function reachViaHandleTracking(dist){
  nav.setEmaDist(dist);
  nav.handleTracking(performance.now(), true, dist);
  nav.handleTracking(performance.now(), true, dist); // arrivalConfirmFrames === 2
}

// ==================== Test A ====================

test('confirming an expected tag on a continue-straight edge speaks the straight instruction immediately', () => {
  resetState();
  selectDestination(14);
  nav.startNavigation();
  nav.onStartTagConfirmed(10); // findPath(10,14) = [10,11,12,13,14] -> expectedNextTagId = 11
  spokenTexts.length = 0;

  nav.onExpectedTagFound(3.5); // Tag 11's outgoing edge 11->12 is continue-straight

  assert.ok(
    spokenTexts.includes('Gehen Sie weiter geradeaus.'),
    `expected immediate straight confirmation, got: ${JSON.stringify(spokenTexts)}`
  );
  assert.equal(nav.expectedNextTagId, 11, 'confirmation alone must not advance the segment');
});

// ==================== Test B ====================

test('a same-tag REACHED shortly after straight confirmation does not repeat the announcement, but bookkeeping still advances', () => {
  resetState();
  selectDestination(14);
  nav.startNavigation();
  nav.onStartTagConfirmed(10);
  nav.onExpectedTagFound(3.5);
  assert.ok(spokenTexts.includes('Gehen Sie weiter geradeaus.'));
  spokenTexts.length = 0;

  reachViaHandleTracking(0.5); // well under reachedM -- Tag 11 reached

  assert.ok(
    !spokenTexts.includes('Gehen Sie weiter geradeaus.'),
    `must not repeat the straight confirmation on REACHED for the same tag, got: ${JSON.stringify(spokenTexts)}`
  );
  assert.equal(nav.currentTagId, 11, 'REACHED bookkeeping must still advance currentTagId');
  assert.equal(nav.expectedNextTagId, 12, 'segment must still progress to the next tag');
});

// ==================== Test C ====================

test('confirming an expected tag whose outgoing edge is a turn does not speak straight guidance; the turn itself is unchanged at arrival', () => {
  resetState();
  selectDestination(14);
  nav.startNavigation();
  nav.onStartTagConfirmed(11); // expectedNextTagId = 12
  spokenTexts.length = 0;

  nav.onExpectedTagFound(3.0); // Tag 12's outgoing edge 12->13 is turn-right

  assert.ok(
    !spokenTexts.includes('Gehen Sie weiter geradeaus.'),
    `must not speak straight guidance for a tag whose outgoing action is a turn, got: ${JSON.stringify(spokenTexts)}`
  );

  spokenTexts.length = 0;
  reachViaHandleTracking(0.5); // Tag 12 reached

  assert.ok(
    spokenTexts.some((t) => t.includes('Biegen Sie rechts ab.')),
    `expected the existing turn instruction at arrival, got: ${JSON.stringify(spokenTexts)}`
  );
});

// ==================== Test D ====================

test('confirming the destination tag itself does not speak straight guidance; destination speech is unchanged at arrival', () => {
  resetState();
  selectDestination(14);
  nav.startNavigation();
  nav.onStartTagConfirmed(13); // findPath(13,14) = [13,14] -> expectedNextTagId = 14 === destinationId
  spokenTexts.length = 0;

  nav.onExpectedTagFound(2.0);

  assert.ok(
    !spokenTexts.includes('Gehen Sie weiter geradeaus.'),
    `must not speak straight guidance when the confirmed tag is the destination, got: ${JSON.stringify(spokenTexts)}`
  );

  spokenTexts.length = 0;
  reachViaHandleTracking(0.5);

  assert.ok(
    spokenTexts.some((t) => t.startsWith('Ziel erreicht')),
    `expected the existing destination arrival speech, got: ${JSON.stringify(spokenTexts)}`
  );
});

// ==================== Test E ====================

test('a forward-skip after an earlier straight confirmation still speaks its own confirmation, unsuppressed', () => {
  resetState();
  selectDestination(16);
  nav.startNavigation();
  nav.onStartTagConfirmed(14); // findPath(14,16) = [14,13,12,11,10,8,7,4,6,3,15,16] -> expectedNextTagId = 13
  spokenTexts.length = 0;

  nav.onExpectedTagFound(3.0); // Tag 13's outgoing edge 13->12 is continue-straight
  assert.ok(spokenTexts.includes('Gehen Sie weiter geradeaus.'), 'expected the straight confirmation for Tag 13');
  var countBefore = spokenTexts.filter((t) => t === 'Gehen Sie weiter geradeaus.').length;

  // Tag 12 (one ahead of 13, no maneuver in between -- 13->12 is continue-straight)
  // wins a valid forward-skip, exactly as in the field case.
  for(var f = 0; f < SETTINGS.otherTagFrames; f++){
    nav.updateSkipCandidate([{ id: 12, dist: 3 }], performance.now());
  }

  assert.equal(nav.expectedNextTagId, 12, 'forward skip must still retarget to Tag 12');
  var countAfter = spokenTexts.filter((t) => t === 'Gehen Sie weiter geradeaus.').length;
  assert.equal(
    countAfter, countBefore + 1,
    'the forward-skip confirmation must still speak its own announcement, not be suppressed by the earlier straight-confirmation flag'
  );
});

// ==================== Test F ====================

test('a segment beginning right after a turn defers to the existing post-turn confirmation instead of adding a near-duplicate straight message', () => {
  resetState();
  selectDestination(14);
  nav.startNavigation();
  nav.onStartTagConfirmed(11); // expectedNextTagId = 12
  reachViaHandleTracking(0.5); // Tag 12 reached -> "Stopp. Biegen Sie rechts ab." + postTurnPending for Tag 13

  assert.ok(spokenTexts.some((t) => t.includes('Biegen Sie rechts ab.')));
  assert.equal(nav.expectedNextTagId, 13);
  spokenTexts.length = 0;

  nav.onExpectedTagFound(3.0); // Tag 13 confirmed immediately after the turn

  assert.ok(
    spokenTexts.includes('Gehen Sie geradeaus.'),
    `expected the existing post-turn confirmation, got: ${JSON.stringify(spokenTexts)}`
  );
  assert.ok(
    !spokenTexts.includes('Gehen Sie weiter geradeaus.'),
    `must not also add the new straight confirmation immediately after the turn follow-up, got: ${JSON.stringify(spokenTexts)}`
  );
});

// ==================== Test G ====================

test('the per-tag straight-confirmation flag is segment-scoped -- an earlier confirmation never blocks a later, different tag\'s own straight speech', () => {
  resetState();
  selectDestination(16);
  nav.startNavigation();
  // Real field corridor: findPath(14,16) = [14,13,12,11,10,8,7,4,6,3,15,16].
  // 13->12 and 11->10 and 10->8 are continue-straight; 12->11 is the one turn.
  nav.onStartTagConfirmed(14); // expectedNextTagId = 13

  nav.onExpectedTagFound(3.0); // Tag 13's outgoing edge (13->12) is continue-straight
  assert.ok(spokenTexts.includes('Gehen Sie weiter geradeaus.'));
  spokenTexts.length = 0;

  reachViaHandleTracking(0.5); // Tag 13 reached -- suppressed duplicate (Test B), advances to Tag 12
  assert.equal(nav.expectedNextTagId, 12);
  spokenTexts.length = 0;

  nav.onExpectedTagFound(3.0); // Tag 12's outgoing edge (12->11) is a turn -- no new straight speech
  assert.ok(!spokenTexts.includes('Gehen Sie weiter geradeaus.'));
  reachViaHandleTracking(0.5); // Tag 12 reached -- "Stopp. Biegen Sie links ab.", postTurnPending for Tag 11
  assert.ok(spokenTexts.some((t) => t.includes('Biegen Sie links ab.')));
  assert.equal(nav.expectedNextTagId, 11);
  spokenTexts.length = 0;

  nav.onExpectedTagFound(3.0); // Tag 11 defers to the post-turn confirmation (Test F), sets no flag
  assert.ok(spokenTexts.includes('Gehen Sie geradeaus.'));
  spokenTexts.length = 0;
  reachViaHandleTracking(0.5); // Tag 11 reached -- unsuppressed, normal REACHED straight speech
  assert.ok(spokenTexts.includes('Gehen Sie weiter geradeaus.'));
  assert.equal(nav.expectedNextTagId, 10);
  spokenTexts.length = 0;

  // Tag 10, several segments and one turn removed from Tag 13, confirmed on its own
  // continue-straight edge (10->8) -- must still speak normally.
  nav.onExpectedTagFound(3.0);
  assert.ok(
    spokenTexts.includes('Gehen Sie weiter geradeaus.'),
    `an earlier tag's straight confirmation must never permanently block a later, unrelated tag's own straight speech, got: ${JSON.stringify(spokenTexts)}`
  );
});
