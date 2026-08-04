// ==================== Frame-Groesse ====================
// Holds the current processing-canvas dimensions. main-loop.js (tick) is the only
// writer, updating them whenever the video dimensions change; distance.js, ui.js and
// nav.js only read them. Kept in its own small module so main-loop.js and distance.js
// do not need to import each other.
import { PROC_WIDTH } from './config.js';

var W = PROC_WIDTH, H = 480;

function setFrameSize(w, h){
  W = w;
  H = h;
}

export { W, H, setFrameSize };
