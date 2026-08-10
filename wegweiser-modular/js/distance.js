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

  function distanceMeters(corners, sizeM){
    try{
      var posit = positFor(sizeM || MARKER_SIZE_M);
      var pts = corners.map(function(c){ return { x: c.x - W/2, y: H/2 - c.y }; });
      var pose = posit.pose(pts);
      var t = pose.bestTranslation;
      return Math.sqrt(t[0]*t[0] + t[1]*t[1] + t[2]*t[2]);
    }catch(e){ return null; }
  }

export { distanceMeters, positFor };
