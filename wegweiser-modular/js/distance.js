// ==================== Entfernung ueber POSIT ====================
// detector and stream live in detector-state.js and camera.js respectively, not here.
// POS is the global js-aruco2 library (vendor/posit.js, loaded as a classic <script>,
// not imported as a module).

import { MARKER_SIZE_M, PROC_WIDTH } from './config.js';
import { W, H } from './frame-state.js';

  var positCache = {};
  function positFor(sizeM){
    var key = String(sizeM);
    if(!positCache[key]) positCache[key] = new POS.Posit(sizeM, PROC_WIDTH);
    return positCache[key];
  }

  // Orientation PoC (Tag 3 -> Tag 6, logging only, see nav.js): the POSIT solve
  // already computes a full pose (rotation + translation), not just distance --
  // distanceMeters() below has always discarded pose.bestRotation immediately
  // after use. estimatePose() exposes the full solve result (distanceM plus the
  // raw rotation/translation/poseError) so a caller that needs pose diagnostics
  // for a specific marker can reuse this SAME solve instead of running POSIT a
  // second time for the same corners. distanceMeters() is reimplemented as a thin
  // wrapper over this so its existing behavior/signature is unchanged for any
  // other caller.
  function estimatePose(corners, sizeM){
    try{
      var posit = positFor(sizeM || MARKER_SIZE_M);
      var pts = corners.map(function(c){ return { x: c.x - W/2, y: H/2 - c.y }; });
      var pose = posit.pose(pts);
      var t = pose.bestTranslation;
      var distanceM = Math.sqrt(t[0]*t[0] + t[1]*t[1] + t[2]*t[2]);
      return { distanceM: distanceM, rotation: pose.bestRotation, translation: t,
               poseError: pose.bestError };
    }catch(e){ return null; }
  }

  function distanceMeters(corners, sizeM){
    var result = estimatePose(corners, sizeM);
    return result ? result.distanceM : null;
  }

export { distanceMeters, estimatePose, positFor };
