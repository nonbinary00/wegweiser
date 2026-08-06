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
import * as nav from '../js/nav.js';

function selectDestination(id){
  destSel.value = String(id);
}

function resetState(){
  nav.endNavigation(false);
  spokenTexts.length = 0;
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
