// ==================== Konfiguration ====================
// NAV_DEBUG is grouped with the other settings here because it is a configuration flag,
// not runtime logic, even though it is only read from the main loop's logging call.

  var MARKER_SIZE_M = 0.12;
  var PROC_WIDTH    = 640;
  var PROC_MS       = 140;
  var DEBUG_SHOW_TAG_ID = true;
  var CONFIRM_FRAMES    = 2;

  var SETTINGS = {
    scanHintAfterMs: 8000,        // Ruhe, bevor der erste Suchhinweis kommt
    scanHintRepeatMs: 12000,      // Suchhinweise wiederholen sich
    candMemoryMs: 700,
    visualMemoryMs: 700,
    wrongTagCooldownMs: 10000,
    aimCooldownMs: 1500,
    reachedM: 1.8,                // Point reached at measured distance <= threshold; kept
                                  // loose rather than tight, since detection becomes
                                  // unreliable just under ~1.5 m (steep angle, tag near
                                  // the screen edge). Still overridable per edge via
                                  // edge.reachedM.
    startTagReachedM: 1.0,        // Tag 1 is special-cased: its own arrival threshold,
                                  // used only during the TRACKING_START_TAG phase (see
                                  // nav.js handleTracking()) — 1.8 m is too far for the
                                  // stop-and-turn-right point at Tag 1. Does not affect
                                  // reachedM (Tag 2 and all later tags stay at 1.8 m or
                                  // their own edge.reachedM).
    nearLostM: 2.5,               // Tag lost between reachedM and 2.5 m => "very close" hint
    arrivalConfirmFrames: 2,      // consecutive frames with arrival <= threshold required
                                  // (protects against a single downward distance outlier)
    nearLossFallbackM: 2.2,       // a loss counts as arrival only if the tag was stably
                                  // approached to <= this distance shortly before
    nearLossMinDets: 6,           // ...and at least this many measurements existed in the segment
    rawWindowN: 5,                // window of the last raw distances (most recent minimum)
    trackingConfirmDetections: 3, // this many valid measurements of the expected tag are
                                  // required before "lost" may be reported at all
    trackLostStopMs: 1800,        // tag gone this long (>= 1.8s) => internal LOST_STOPPED
                                  // state transition; the spoken stop announcement is
                                  // governed separately, see lostSpeechDelayMs
    awayDeltaM: 1.2,              // distance rises this much above the minimum => warning
    otherTagFrames: 6,            // foreign tag: only reported after ~0.8s of stable sight
    backTagFrames: 9,             // "going back" warning only at very stable sight (~1.3s)
    lostSpeechDelayMs: 4500,      // additional delay after entering LOST_STOPPED, before
                                  // the spoken stop announcement actually happens -- gives
                                  // the expected tag or a valid forward candidate time to
                                  // be confirmed, without changing or reinterpreting the
                                  // existing trackLostStopMs state transition (see handleLostStopped())
    lostReminderRepeatMs: 18000,   // interval between short "Suchen Sie weiter." reminders
                                  // during LOST_STOPPED -- deliberately far less frequent
                                  // than the scan-hint repeat interval, so it doesn't nag
    longCorridorReassuranceM: 15,  // after this many accumulated meters without a turn
                                  // (see corridor progress in nav.js), "Gehen Sie weiter
                                  // geradeaus." may be spoken again, even if the same
                                  // phrase was already active once for this corridor --
                                  // purely distance-based, no new time-based timer
    startCandidateWindowMs: 500,     // Option C (start-tag selection): once the first known
                                  // tag reaches CONFIRM_FRAMES during SEARCHING_START_TAG,
                                  // wait this long before committing, so a nearer tag that
                                  // confirms shortly after can still win. Deliberately short
                                  // relative to scanHintAfterMs -- adds only a small, bounded
                                  // delay to every route start, not just contested ones.
    startCandidateSampleWindow: 5   // rolling raw-distance sample count kept per start
                                  // candidate (mirrors rawWindowN's window-of-recent-values
                                  // idea, but kept separate/short-lived -- see nav.js) --
                                  // used to compute a MEDIAN, not a minimum: a minimum would
                                  // let a single spuriously-close outlier frame win outright.
  };

  var SAFETY_SPEECH = "Der Wegweiser unterstützt die Orientierung anhand von Markierungen, " +
    "erkennt aber keine Hindernisse. Bitte verwenden Sie weiterhin Ihren Langstock " +
    "oder Ihre gewohnte Mobilitätshilfe.";

// Debug logging for field tests (console).
var NAV_DEBUG = true;

export {
  MARKER_SIZE_M,
  PROC_WIDTH,
  PROC_MS,
  DEBUG_SHOW_TAG_ID,
  CONFIRM_FRAMES,
  SETTINGS,
  SAFETY_SPEECH,
  NAV_DEBUG
};
