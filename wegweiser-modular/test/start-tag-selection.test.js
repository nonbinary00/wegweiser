// Behavioral tests for the Option-C start-tag selection improvement: when a new
// route begins and more than one known AprilTag is visible in short succession,
// the app must not commit to whichever tag happens to reach CONFIRM_FRAMES
// first -- it must briefly compare confirmed candidates and pick the one with
// the smaller stabilized distance. Regression target: field log
// wegweiser-v13-log-20260820-113140(37).json (farther Tag 12 confirmed first,
// nearer Tag 14 confirmed shortly after, and the route incorrectly committed
// to Tag 12).
//
// These tests drive nav.js's new exported functions directly (recordStartCandidateSample,
// noteStartCandidateConfirmed, checkStartCandidateWindow), bypassing the camera/detector
// and main-loop.js's per-frame CONFIRM_FRAMES counting -- consistent with how nav.test.js
// already tests onStartTagConfirmed() directly. Tag IDs used below (1, 6, 8) are arbitrary
// office/entrance tags, not the specific Tag 12/14 pair from the field case.

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

test('Option C: a nearer candidate confirmed within the window overturns an earlier, farther-confirmed candidate', () => {
  resetState();
  selectDestination(3);
  nav.startNavigation();

  var t = 1000;
  [6.0, 6.1].forEach((d) => nav.recordStartCandidateSample(6, d));
  nav.noteStartCandidateConfirmed(6, t); // farther candidate confirms first

  t += 150;
  [1.5, 1.4].forEach((d) => nav.recordStartCandidateSample(8, d));
  nav.noteStartCandidateConfirmed(8, t); // nearer candidate confirms shortly after, inside the window

  assert.equal(nav.checkStartCandidateWindow(t), false, 'must not resolve before the window elapses');
  assert.equal(nav.pathTagIds, null, 'route must not commit before the window closes');

  t += SETTINGS.startCandidateWindowMs + 50;
  assert.equal(nav.checkStartCandidateWindow(t), true);
  assert.equal(nav.currentTagId, 8, 'the nearer, later-confirmed candidate must win');
});

test('Option C: the winner is order-independent -- the nearer candidate wins even if confirmed first', () => {
  resetState();
  selectDestination(3);
  nav.startNavigation();

  var t = 2000;
  [1.5, 1.4].forEach((d) => nav.recordStartCandidateSample(8, d));
  nav.noteStartCandidateConfirmed(8, t); // nearer candidate confirms first this time

  t += 150;
  [6.0, 6.1].forEach((d) => nav.recordStartCandidateSample(6, d));
  nav.noteStartCandidateConfirmed(6, t); // farther candidate confirms second

  t += SETTINGS.startCandidateWindowMs + 50;
  assert.equal(nav.checkStartCandidateWindow(t), true);
  assert.equal(nav.currentTagId, 8, 'the nearer candidate must win regardless of confirmation order');
});

test('Option C: a single confirmed candidate becomes the start once the (short) window elapses', () => {
  resetState();
  selectDestination(3);
  nav.startNavigation();

  var t = 3000;
  [4.0, 3.9].forEach((d) => nav.recordStartCandidateSample(6, d));
  nav.noteStartCandidateConfirmed(6, t);

  assert.equal(nav.checkStartCandidateWindow(t + 10), false, 'must still be waiting out the window');

  t += SETTINGS.startCandidateWindowMs + 10;
  assert.equal(nav.checkStartCandidateWindow(t), true);
  assert.equal(nav.currentTagId, 6);
  assert.ok(
    SETTINGS.startCandidateWindowMs <= 1000,
    'the comparison window must stay short so the single-candidate case is not meaningfully delayed'
  );
});

test('Option C: a competitor that only appears after the window has already closed cannot change the outcome', () => {
  resetState();
  selectDestination(3);
  nav.startNavigation();

  var t = 4000;
  [4.0, 3.9].forEach((d) => nav.recordStartCandidateSample(6, d));
  nav.noteStartCandidateConfirmed(6, t);

  t += SETTINGS.startCandidateWindowMs + 10;
  assert.equal(nav.checkStartCandidateWindow(t), true);
  assert.equal(nav.currentTagId, 6);
  var pathAfterCommit = nav.pathTagIds.slice();

  // A different tag only becomes confirmable well after the window already closed.
  t += 1000;
  nav.recordStartCandidateSample(8, 1.0);
  nav.noteStartCandidateConfirmed(8, t);

  assert.deepEqual(nav.pathTagIds, pathAfterCommit, 'the already-committed route must not be altered by a late competitor');
  assert.equal(nav.currentTagId, 6, 'Tag 6 remains the committed start tag');
});

test('Option C: a single noisy raw-distance sample for the farther candidate does not let it win', () => {
  resetState();
  selectDestination(3);
  nav.startNavigation();

  var t = 5000;
  // Genuinely farther candidate: consistently ~6m, plus one wildly favorable (small) outlier frame.
  [6.0, 6.1, 0.3, 6.2, 5.9].forEach((d) => nav.recordStartCandidateSample(6, d));
  nav.noteStartCandidateConfirmed(6, t);

  t += 150;
  // Genuinely nearer candidate: consistently ~1.5m across every sample.
  [1.5, 1.4, 1.6, 1.5, 1.4].forEach((d) => nav.recordStartCandidateSample(8, d));
  nav.noteStartCandidateConfirmed(8, t);

  t += SETTINGS.startCandidateWindowMs + 10;
  assert.equal(nav.checkStartCandidateWindow(t), true);
  assert.equal(nav.currentTagId, 8, 'the consistently nearer candidate must win despite one favorable outlier for the farther one');
});

test('Option C: starting at Tag 1 still enters the existing entrance-specific flow', () => {
  resetState();
  selectDestination(5);
  nav.startNavigation();
  spokenTexts.length = 0;

  var t = 6000;
  [0.5, 0.4].forEach((d) => nav.recordStartCandidateSample(1, d));
  nav.noteStartCandidateConfirmed(1, t);

  t += SETTINGS.startCandidateWindowMs + 10;
  assert.equal(nav.checkStartCandidateWindow(t), true);
  assert.equal(nav.navState, nav.NavState.TRACKING_START_TAG);
  assert.ok(
    spokenTexts.some((s) => s.startsWith('Sie befinden sich am Eingang.')),
    `expected the original Tag 1 entrance text, got: ${JSON.stringify(spokenTexts)}`
  );
});

test('Option C: aborting navigation mid-window clears all pending start-candidate state', () => {
  resetState();
  selectDestination(3);
  nav.startNavigation();

  var t = 7000;
  [4.0, 3.9].forEach((d) => nav.recordStartCandidateSample(6, d));
  nav.noteStartCandidateConfirmed(6, t); // window now open, never resolved
  nav.endNavigation(false); // abort mid-window

  selectDestination(3);
  nav.startNavigation();

  t += SETTINGS.startCandidateWindowMs + 60;
  assert.equal(
    nav.checkStartCandidateWindow(t),
    false,
    'no leftover candidate/window from the aborted route may resolve in the new route'
  );

  [2.0, 1.9].forEach((d) => nav.recordStartCandidateSample(8, d));
  nav.noteStartCandidateConfirmed(8, t);
  t += SETTINGS.startCandidateWindowMs + 10;
  assert.equal(nav.checkStartCandidateWindow(t), true);
  assert.equal(nav.currentTagId, 8, 'only the fresh candidate from the new route may win');
});
