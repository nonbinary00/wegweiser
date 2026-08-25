// Tests for the diagnostic-only exposure of POSIT's non-selected ("alternative")
// pose branch in estimatePose() (js/distance.js). See the accompanying analysis
// of field logs wegweiser-v13-log-20260825-105609(6)/105649(7).json: the
// observed relativeCameraYawDeg alternates between two discrete clusters
// (~-20..-23deg and ~+5..+9deg) even when the detected tag corners barely move.
// vendor/posit.js's coplanar POSIT always computes TWO candidate rotations per
// frame and keeps whichever reprojects with lower error as "best" -- the loser
// was already computed and retained as pose.alternativeRotation/alternativeError,
// just never read before now. This file proves the additive exposure is wired
// correctly WITHOUT altering which branch is selected or any existing field.
//
// These tests load the REAL vendored POSIT solver (not a mock) via node:vm,
// exactly like distance.js expects it as a classic-script global (see
// distance.js's own header comment) -- so the pose numbers here are genuine
// POSIT output, not synthetic rotation matrices.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

// distance.js references the global POS.Posit exactly like a classic <script>
// load would provide it (see distance.js's header comment) -- reproduce that
// here by running the vendored sources as plain scripts in a fresh context
// (top-level `this` in a non-strict classic script equals that context's
// global object, same as `window` in a browser), then publish the resulting
// POS onto this process's globalThis before distance.js's estimatePose() is
// ever called. svd.js must run first since posit.js reads `this.SVD` at
// module-eval time.
var sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(new URL('../vendor/svd.js', import.meta.url), 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(new URL('../vendor/posit.js', import.meta.url), 'utf8'), sandbox);
globalThis.POS = sandbox.POS;

import { estimatePose, distanceMeters, positFor } from '../js/distance.js';
import { MARKER_SIZE_M, PROC_WIDTH } from '../js/config.js';
import { W, H, setFrameSize } from '../js/frame-state.js';

// Same corner-to-image-point transform estimatePose() uses internally, so a
// test can independently call positFor(sizeM).pose(pts) and compare directly
// against estimatePose()'s output -- the strongest possible proof that the
// wrapper forwards the best branch unchanged (rather than a before/after
// snapshot, which the diagnostic-only edit itself makes unavailable).
function toImagePoints(corners){
  return corners.map(function(c){ return { x: c.x - W / 2, y: H / 2 - c.y }; });
}

// Two REAL, consecutive corner sets from field log
// wegweiser-v13-log-20260825-105609(6).json (t=715768 and t=715933) where the
// app's own logged relativeCameraYawDeg flipped from -20.01deg to +9.73deg
// while the corners moved by at most 1px per point.
var FIELD_CORNERS_MODE_A = [{ x: 317, y: 562 }, { x: 213, y: 554 }, { x: 218, y: 443 }, { x: 328, y: 454 }];
var FIELD_CORNERS_MODE_B = [{ x: 316, y: 563 }, { x: 213, y: 555 }, { x: 217, y: 444 }, { x: 327, y: 454 }];

// A generic, non-degenerate quadrilateral unrelated to the field's near-tied
// geometry, used for the plain "fields are exposed / forwarded correctly"
// tests below (its own best/alternative split isn't the point there).
var GENERIC_CORNERS = [{ x: 400, y: 300 }, { x: 250, y: 290 }, { x: 260, y: 140 }, { x: 410, y: 150 }];

test('estimatePose(): existing best-pose fields (rotation/translation/poseError/distanceM) are byte-for-byte the POSIT bestRotation/bestTranslation/bestError, unchanged by the additive fields', () => {
  var posit = positFor(MARKER_SIZE_M);
  var pts = toImagePoints(GENERIC_CORNERS);
  var directPose = posit.pose(pts);

  var result = estimatePose(GENERIC_CORNERS, MARKER_SIZE_M);

  assert.ok(result && result.ok !== false);
  assert.deepEqual(result.rotation, directPose.bestRotation);
  assert.deepEqual(result.translation, directPose.bestTranslation);
  assert.equal(result.poseError, directPose.bestError);
  var expectedDistanceM = Math.sqrt(
    directPose.bestTranslation[0] * directPose.bestTranslation[0] +
    directPose.bestTranslation[1] * directPose.bestTranslation[1] +
    directPose.bestTranslation[2] * directPose.bestTranslation[2]
  );
  assert.equal(result.distanceM, expectedDistanceM);
});

test('estimatePose(): alternativeRotation/alternativePoseError are exposed and match POSIT\'s own alternativeRotation/alternativeError exactly', () => {
  var posit = positFor(MARKER_SIZE_M);
  var pts = toImagePoints(GENERIC_CORNERS);
  var directPose = posit.pose(pts);

  var result = estimatePose(GENERIC_CORNERS, MARKER_SIZE_M);

  assert.ok(directPose.alternativeError >= 0, 'sanity check: this fixture should have a valid alternative branch');
  assert.deepEqual(result.alternativeRotation, directPose.alternativeRotation);
  assert.equal(result.alternativePoseError, directPose.alternativeError);
});

test('estimatePose(): poseErrorGap is abs(alternativePoseError - poseError)', () => {
  var result = estimatePose(GENERIC_CORNERS, MARKER_SIZE_M);
  assert.equal(result.poseErrorGap, Math.abs(result.alternativePoseError - result.poseError));
});

test('estimatePose(): poseErrorGapRatio is poseErrorGap / poseError, guarded against divide-by-zero', () => {
  var result = estimatePose(GENERIC_CORNERS, MARKER_SIZE_M);
  if(result.poseError > 0){
    assert.ok(Math.abs(result.poseErrorGapRatio - (result.poseErrorGap / result.poseError)) < 1e-9);
  }else{
    assert.equal(result.poseErrorGapRatio, null);
  }
});

test('estimatePose(): distanceMeters() compatibility wrapper is unaffected (still returns exactly distanceM)', () => {
  var result = estimatePose(GENERIC_CORNERS, MARKER_SIZE_M);
  var dist = distanceMeters(GENERIC_CORNERS, MARKER_SIZE_M);
  assert.equal(dist, result.distanceM);
});

test('field evidence: on real corners from the 6->4 log, the best and alternative branches disagree sharply in yaw but are nearly tied in reprojection error', () => {
  // The field log itself does not record the exact camera frame width/height
  // that was active at capture time (TAG_ORIENTATION_POSE logs corners in
  // pixel coordinates only). estimatePose() centers those pixel coordinates
  // using frame-state.js's W/H (see distance.js's `c.x - W/2, H/2 - c.y`),
  // and that assumed center materially affects POSIT's ambiguity geometry --
  // under this file's other tests' default W=640/H=480, these exact real
  // corners resolve as nearly fronto-parallel (best~=alt, no interesting
  // ambiguity) purely because that default guesses the wrong image center for
  // this capture. Searching frame heights against this log's OWN
  // corroborating evidence (its logged distanceM of 0.70-0.71m) finds
  // W=640/H=960 reproduces distanceM almost exactly (0.703-0.709m) AND
  // reproduces the field's bimodal yaw signature -- strong independent
  // confirmation that H=960 is a plausible real capture size, used here only
  // to exercise the new diagnostic fields against genuine field geometry, not
  // to assert what the true device resolution was. Frame size is restored
  // immediately after so no state leaks into any other test in this file.
  var originalW = W, originalH = H;
  setFrameSize(640, 960);
  try{
    var resultA = estimatePose(FIELD_CORNERS_MODE_A, MARKER_SIZE_M);
    var resultB = estimatePose(FIELD_CORNERS_MODE_B, MARKER_SIZE_M);

    assert.ok(Math.abs(resultA.distanceM - 0.70) < 0.03, `sanity check vs field-logged distanceM~0.70, got ${resultA.distanceM}`);
    assert.ok(Math.abs(resultB.distanceM - 0.71) < 0.03, `sanity check vs field-logged distanceM~0.71, got ${resultB.distanceM}`);

    for(var result of [resultA, resultB]){
      assert.ok(result && result.rotation, 'expected a valid pose for this real field corner set');
      assert.ok(result.alternativeRotation, 'expected POSIT to expose a valid alternative branch for this near-fronto-parallel geometry');

      var bestYaw = Math.atan2(result.rotation[2][0], result.rotation[2][2]) * 180 / Math.PI;
      var altYaw = Math.atan2(result.alternativeRotation[2][0], result.alternativeRotation[2][2]) * 180 / Math.PI;

      // This is the diagnostic this feature exists to expose: the two
      // branches are angularly far apart (consistent with the ~27deg
      // field-log cluster separation)...
      assert.ok(Math.abs(bestYaw - altYaw) > 15,
        `expected best/alternative yaw to differ sharply, got best=${bestYaw} alt=${altYaw}`);
      // ...while their reprojection errors are nearly tied -- exactly why
      // sub-pixel jitter can flip which one POSIT selects frame to frame.
      assert.ok(result.poseErrorGap <= 5,
        `expected a small poseErrorGap for this near-tied real geometry, got ${result.poseErrorGap} (best=${result.poseError}, alt=${result.alternativePoseError})`);
    }
  }finally{
    setFrameSize(originalW, originalH);
  }
});
