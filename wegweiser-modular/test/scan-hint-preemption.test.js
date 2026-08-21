// Regression tests for the "cancel an obsolete nav.scanHint on expected-tag
// confirmation" fix (js/nav.js: onExpectedTagFound(); js/speech.js:
// activeSpeechSource()).
//
// Field evidence: nav.scanHint's "search for the marker" hint was still speaking
// when the expected tag got confirmed. Because the resulting straight instruction
// ("Gehen Sie weiter geradeaus.") was requested with interrupt:false, it was
// delayed/suppressed as "busy" behind the now-obsolete hint, leaving the user
// waiting. The fix narrowly allows THIS ONE call site to set interrupt:true, but
// only when the currently active speech's source is exactly "nav.scanHint" -- any
// other active speech (turn/stop/arrival/lost/etc.) must still block it exactly as
// before.
//
// speechSynthesis.speaking/pending on the shared browser-stubs.js stub are static
// (no speak() call, real or held open via withManualSpeechCompletion, ever flips
// them) -- so say()'s own busy gate
// (`!opts.interrupt && (speechSynthesis.speaking || speechSynthesis.pending)`)
// never trips by itself in this harness. withSimulatedBusy() below flips
// `.pending` directly around the call under test, mirroring what a real browser
// mid-utterance would report, and always restores it in `finally` -- required
// because speechSynthesis is one module-level object shared by every test file in
// the run.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spokenTexts, withManualSpeechCompletion } from './browser-stubs.js';
import { destSel } from '../js/dom.js';
import { SETTINGS } from '../js/config.js';
import { say, activeSpeechSource } from '../js/speech.js';
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

function withSimulatedBusy(run){
  globalThis.speechSynthesis.pending = true;
  try{ return run(); } finally { globalThis.speechSynthesis.pending = false; }
}

// ==================== Test A ====================
// active scanHint + expected straight tag confirmed -> scanHint cancelled -> straight
// instruction starts immediately.

test('an active nav.scanHint is cancelled immediately so the expected-tag straight confirmation is not delayed', () => {
  resetState();
  selectDestination(14);
  nav.startNavigation();
  nav.onStartTagConfirmed(10); // findPath(10,14) = [10,11,12,13,14] -> expectedNextTagId = 11
  spokenTexts.length = 0;

  withManualSpeechCompletion((completeSpeech) => {
    // Stand-in for the real nav.scanHint() call (identical source/category) -- held
    // open (no onend yet) so it is still genuinely the active speech below.
    say('Bewegen Sie das Smartphone langsam nach links und rechts.',
      { source: 'nav.scanHint', category: 'ACTION_REQUIRED' });
    assert.equal(activeSpeechSource(), 'nav.scanHint', 'sanity: scan hint is the active speech');

    withSimulatedBusy(() => {
      nav.onExpectedTagFound(3.5); // Tag 11's outgoing edge 11->12 is continue-straight

      assert.ok(
        spokenTexts.includes('Gehen Sie weiter geradeaus.'),
        `expected the straight confirmation to speak immediately despite the busy scan hint, got: ${JSON.stringify(spokenTexts)}`
      );
      assert.equal(
        activeSpeechSource(), 'nav.expectedTagStraightConfirmation',
        'the obsolete scan hint must have been cancelled and replaced, not merely queued behind'
      );
    });

    completeSpeech();
  });
});

// ==================== Test B ====================
// no active scanHint -> current behavior unchanged.

test('with no active speech, the expected-tag straight confirmation behaves exactly as before', () => {
  resetState();
  selectDestination(14);
  nav.startNavigation();
  nav.onStartTagConfirmed(10); // expectedNextTagId = 11
  spokenTexts.length = 0;

  assert.equal(activeSpeechSource(), null, 'sanity: nothing active before confirmation');
  nav.onExpectedTagFound(3.5);

  // Default stub completes every utterance instantly (onend fires synchronously
  // inside speak()), so activeSpeechSource() is already back to null here -- unlike
  // Test A/C/D, which hold the utterance open on purpose to inspect it mid-flight.
  assert.ok(spokenTexts.includes('Gehen Sie weiter geradeaus.'));
});

// ==================== Test C ====================
// active unrelated route-critical speech -> expected-tag confirmation must NOT
// preempt it.

test('active unrelated route-critical speech is not preempted by an expected-tag confirmation', () => {
  resetState();
  selectDestination(14);
  nav.startNavigation();
  nav.onStartTagConfirmed(10); // expectedNextTagId = 11
  spokenTexts.length = 0;

  withManualSpeechCompletion((completeSpeech) => {
    say('Stopp. Biegen Sie rechts ab.',
      { interrupt: true, source: 'nav.turnInstruction', category: 'ACTION_REQUIRED' });
    assert.equal(activeSpeechSource(), 'nav.turnInstruction');
    var countBefore = spokenTexts.length;

    withSimulatedBusy(() => {
      nav.onExpectedTagFound(3.5); // Tag 11's outgoing edge is continue-straight, but unrelated speech is active

      assert.equal(
        spokenTexts.length, countBefore,
        `must stay silent (suppressed as busy) while unrelated speech is active, got: ${JSON.stringify(spokenTexts)}`
      );
      assert.equal(
        activeSpeechSource(), 'nav.turnInstruction',
        'the unrelated active speech must remain active -- this narrow fix must not cancel it'
      );
    });

    completeSpeech();
  });
});

// ==================== Test D ====================
// A straight confirmation suppressed as busy (non-scanHint case) must not mark any
// dedup/reassurance state as already spoken -- proven by the later REACHED still
// speaking the straight instruction normally.

test('a straight confirmation suppressed as busy (non-scanHint) does not mark dedup state, so the later REACHED still speaks normally', () => {
  resetState();
  selectDestination(14);
  nav.startNavigation();
  nav.onStartTagConfirmed(10); // expectedNextTagId = 11
  spokenTexts.length = 0;

  withManualSpeechCompletion((completeSpeech) => {
    say('Stopp. Biegen Sie rechts ab.',
      { interrupt: true, source: 'nav.turnInstruction', category: 'ACTION_REQUIRED' });

    withSimulatedBusy(() => {
      nav.onExpectedTagFound(3.5);
      assert.ok(
        !spokenTexts.includes('Gehen Sie weiter geradeaus.'),
        'sanity: suppressed while unrelated speech is active'
      );
    });

    completeSpeech(); // let the unrelated speech finish naturally
  });

  spokenTexts.length = 0;
  reachViaHandleTracking(0.5); // Tag 11 reached

  assert.ok(
    spokenTexts.includes('Gehen Sie weiter geradeaus.'),
    `REACHED must speak normally -- the suppressed confirmation must not have set straightConfirmedTagId, got: ${JSON.stringify(spokenTexts)}`
  );
});

// ==================== Test E ====================
// post-turn confirmation behavior remains unchanged (unaffected by the fix, which
// only runs after onExpectedTagFound()'s existing wasPostTurnPendingForThisTag
// early-return).

test('post-turn confirmation is unaffected by the scan-hint preemption fix', () => {
  resetState();
  selectDestination(14);
  nav.startNavigation();
  nav.onStartTagConfirmed(11); // expectedNextTagId = 12
  reachViaHandleTracking(0.5); // Tag 12 reached -> turn + postTurnPending for Tag 13
  assert.ok(spokenTexts.some((t) => t.includes('Biegen Sie rechts ab.')));
  assert.equal(nav.expectedNextTagId, 13);
  spokenTexts.length = 0;

  nav.onExpectedTagFound(3.0); // Tag 13 confirmed right after the turn

  assert.ok(
    spokenTexts.includes('Gehen Sie geradeaus.'),
    `expected the existing post-turn confirmation, got: ${JSON.stringify(spokenTexts)}`
  );
  assert.ok(
    !spokenTexts.includes('Gehen Sie weiter geradeaus.'),
    'must not additionally speak the new straight confirmation right after a turn'
  );
});

// ==================== Test F ====================
// forward-skip behavior remains unchanged.

test('forward-skip confirmation remains unaffected by the scan-hint preemption fix', () => {
  resetState();
  selectDestination(16);
  nav.startNavigation();
  nav.onStartTagConfirmed(14); // expectedNextTagId = 13
  spokenTexts.length = 0;

  nav.onExpectedTagFound(3.0); // Tag 13's outgoing edge 13->12 is continue-straight
  assert.ok(spokenTexts.includes('Gehen Sie weiter geradeaus.'));
  var countBefore = spokenTexts.filter((t) => t === 'Gehen Sie weiter geradeaus.').length;

  for(var f = 0; f < SETTINGS.otherTagFrames; f++){
    nav.updateSkipCandidate([{ id: 12, dist: 3 }], performance.now());
  }

  assert.equal(nav.expectedNextTagId, 12, 'forward skip must still retarget to Tag 12');
  var countAfter = spokenTexts.filter((t) => t === 'Gehen Sie weiter geradeaus.').length;
  assert.equal(
    countAfter, countBefore + 1,
    'forward-skip confirmation must still speak its own announcement, unaffected by the scan-hint fix'
  );
});
