// ==================== Hauptschleife ====================
// Cross-module state owned by other modules (frame size, ema distance, visual memory,
// candidate tracking) is written here through setter functions (setFrameSize,
// setEmaDist, setLastExpectedVisual, touchExpectedSeen, touchCandidateSeen,
// setCandidate, setWrongCandidate) rather than direct assignment, since ES modules
// only allow the declaring module to reassign its own exported bindings.
// running (camera.js) <-> scheduleNext() (here) is an intentional circular dependency
// between camera.js and main-loop.js.

import { video, canvas, ctx } from './dom.js';
import { PROC_WIDTH, PROC_MS, SETTINGS, DEBUG_SHOW_TAG_ID, CONFIRM_FRAMES, MARKER_SIZE_M } from './config.js';
import { detector } from './detector-state.js';
import { W, H, setFrameSize } from './frame-state.js';
import { MARKERS, markerName } from './graph.js';
import { distanceMeters } from './distance.js';
import { showRoom, showIdle, updatePanel, drawMarker } from './ui.js';
import { record } from './logger.js';
import {
  navState, NavState, navigationActive, pathTagIds, destinationReached, destinationId,
  currentTagId, expectedNextTagId, segIndex, emaDist, candId, candCount, wrongCandId,
  wrongCandCount, lastExpectedVis, candLastSeenAt, trackingStartTagActive,
  setNavState, handleTracking, handleLostStopped, onExpectedTagFound,
  onOtherTagConfirmed, updateSkipCandidate, scanHint, aimGuidance,
  touchExpectedSeen, touchCandidateSeen, setLastExpectedVisual, setWrongCandidate,
  setCandidate, setEmaDist, recordStartCandidateSample, noteStartCandidateConfirmed,
  checkStartCandidateWindow
} from './nav.js';
import { running } from './camera.js';

  // Technical detector exceptions stay in the technical log only (never spoken --
  // detector exceptions can occur every frame, see the call site below) and are
  // rate-limited to at most one log entry per 5s, so a persistently failing detector
  // does not flood the log buffer. Does not change the existing fallback behavior
  // (`detected = []`).
  var lastDetectorErrorLogAt = 0;

  // ==================== HAUPTSCHLEIFE ====================
  function tick(){
    if(!running) return;
    if(video.readyState >= 2 && video.videoWidth){
      var vw = video.videoWidth, vh = video.videoHeight;
      var newH = Math.round(PROC_WIDTH * vh / vw);
      if(canvas.width !== PROC_WIDTH || canvas.height !== newH){
        canvas.width = PROC_WIDTH; canvas.height = newH; setFrameSize(PROC_WIDTH, newH);
      }
      ctx.drawImage(video, 0, 0, W, H);
      var img = ctx.getImageData(0, 0, W, H);
      var detected = [];
      try{ detected = detector.detect(img); }catch(e){
        detected = [];
        var errNow = performance.now();
        if(errNow - lastDetectorErrorLogAt > 5000){
          lastDetectorErrorLogAt = errNow;
          record("DETECTOR_EXCEPTION", { message: (e && e.message) || String(e) });
        }
      }

      var now = performance.now();
      var expectedDet = null, bestKnown = null, bestKnownDist = Infinity;
      var startPhase = navigationActive && pathTagIds == null;
      // All tags decoded this frame, with their distance, for the independent
      // forward-candidate check (updateSkipCandidate() in nav.js) -- regardless of
      // which tag is selected as expectedDet/bestKnown.
      var detectedWithDist = [];

      for(var i = 0; i < detected.length; i++){
        var mk = detected[i];
        var known = MARKERS[mk.id];
        var d = distanceMeters(mk.corners, MARKER_SIZE_M);
        detectedWithDist.push({ id: mk.id, dist: d });
        var isExpected = navigationActive &&
          (startPhase ? !!known : mk.id === expectedNextTagId);
        if(navigationActive && !destinationReached){
          if(isExpected) drawMarker(mk.corners, "#ffd400");
          else drawMarker(mk.corners, "rgba(154,160,166,0.35)", true);
        } else {
          drawMarker(mk.corners, known ? "#37d67a" : "#ff6b6b");
        }
        if(isExpected && (expectedDet == null ||
           (d != null && d < (expectedDet.dist == null ? Infinity : expectedDet.dist))))
          expectedDet = { id: mk.id, corners: mk.corners, dist: d };
        if(known && (d == null || d < bestKnownDist)){
          bestKnown = { id: mk.id, corners: mk.corners, dist: d };
          bestKnownDist = (d == null ? Infinity : d);
        }
      }

      // Visuelles Gedächtnis (700 ms) gegen Detektor-Flackern
      var expectedVisual = !!expectedDet;
      if(navigationActive && !destinationReached){
        if(expectedDet){
          setLastExpectedVisual({ corners: expectedDet.corners, at: now });
        } else if(lastExpectedVis && (now - lastExpectedVis.at) <= SETTINGS.visualMemoryMs){
          expectedVisual = true;
          drawMarker(lastExpectedVis.corners, "#ffd400");
        } else {
          setLastExpectedVisual(null);
        }
      }

      // --- Anzeige + Distanz-EMA ---
      var visDist = null;
      if(navigationActive && !destinationReached){
        if(expectedDet && expectedDet.dist != null){
          setEmaDist((emaDist == null) ? expectedDet.dist : (0.7*emaDist + 0.3*expectedDet.dist));
          visDist = emaDist;
        } else if(expectedVisual){
          visDist = emaDist;
        }
        // WICHTIG: emaDist wird bei Verlust NICHT sofort gelöscht — der letzte
        // Messwert entscheidet, ob "nah verloren" als erreicht gilt.
        if(expectedNextTagId != null){
          var nn = markerName(expectedNextTagId);
          var sub = (navState === NavState.TRACKING) ? "Tracking · " + (expectedVisual ? "sichtbar" : "kurz verdeckt")
                  : (navState === NavState.LOST_STOPPED) ? "Stopp · Markierung suchen"
                  : (expectedVisual ? "Nächstes Ziel · sichtbar" : "Nächstes Ziel · suchen …");
          showRoom(DEBUG_SHOW_TAG_ID ? (nn + " [Tag " + expectedNextTagId + "]") : nn, sub, visDist);
        } else {
          showRoom("Startpunkt suchen", expectedVisual ? "Markierung sichtbar" : "beliebige Markierung suchen …", visDist);
        }
      } else if(destinationReached){
        showRoom(markerName(destinationId || currentTagId), "Ziel erreicht", null);
      } else if(bestKnown){
        if(bestKnown.dist != null){
          setEmaDist((emaDist == null) ? bestKnown.dist : (0.7*emaDist + 0.3*bestKnown.dist));
          visDist = emaDist;
        }
        var nm = markerName(bestKnown.id);
        showRoom(DEBUG_SHOW_TAG_ID ? (nm + " [Tag " + bestKnown.id + "]") : nm, null, visDist);
      } else {
        setEmaDist(null);
        showIdle("Keine Markierung");
      }

      // --- Navigationslogik ---
      if(navigationActive && !destinationReached){
        // Option C (Start-Tag-Auswahl): waehrend startPhase jeden bekannten,
        // erkannten Tag unabhaengig von expectedDet/bestKnown in sein eigenes kurzes
        // Distanz-Fenster einspeisen (detectedWithDist enthaelt ohnehin ALLE
        // Erkennungen dieses Frames), und ein bereits offenes Vergleichsfenster auf
        // Ablauf pruefen. checkStartCandidateWindow() macht bei geschlossenem
        // Fenster nichts (billiger No-op); laeuft es gerade ab, committet sie GENAU
        // EINMAL ueber das bestehende onStartTagConfirmed() und liefert true --
        // dann darf die uebrige, auf einen frischen expectedDet dieses Frames
        // ausgelegte Zustandsmaschine unten fuer diesen Tick nicht mehr laufen
        // (pathTagIds ist jetzt gesetzt, startPhase waere fuer den Rest dieses
        // Ticks veraltet).
        var startWindowResolved = false;
        if(startPhase){
          for(var sci = 0; sci < detectedWithDist.length; sci++){
            var scDet = detectedWithDist[sci];
            if(MARKERS[scDet.id]) recordStartCandidateSample(scDet.id, scDet.dist);
          }
          startWindowResolved = checkStartCandidateWindow(now);
        }
        if(startWindowResolved){
          // committed this frame -- fall through to updatePanel()/scheduleNext() below
        } else if(navState === NavState.TRACKING || navState === NavState.TRACKING_START_TAG){
          if(expectedDet) touchExpectedSeen(now);
          // supplies this frame's fresh raw distance (arrival logic)
          handleTracking(now, expectedVisual, expectedDet ? expectedDet.dist : null);
          // The forward-candidate check keeps running even while the expected tag is
          // already being tracked normally, since a confirmed tag must not fully
          // disable the check for the rest of the segment. The expected tag still
          // takes priority: if it is detected this exact frame, the check is only
          // paused for the frame (not reset, see the candMemoryMs tolerance in
          // updateSkipCandidate()). While Tag 1 is still being physically tracked
          // (trackingStartTagActive), no forward candidate beyond Tag 2 may be
          // searched for here -- expectedNextTagId is intentionally 1 during this
          // phase, so a detected Tag 2 would otherwise be wrongly treated as a
          // forward candidate of itself.
          if(!startPhase && !expectedDet && !trackingStartTagActive) updateSkipCandidate(detectedWithDist, now);
        } else if(navState === NavState.LOST_STOPPED){
          if(expectedDet) touchExpectedSeen(now);
          // updateSkipCandidate() must run here before handleLostStopped(). A
          // forward-candidate retarget can complete in this frame and switch navState
          // straight to TRACKING (beginTrackingForwardCandidate() -> onNextTagFound());
          // if handleLostStopped() still ran afterward for the same frame, it would
          // wrongly keep processing an already-exited LOST_STOPPED episode -- a race
          // where the delayed stop announcement could still be spoken even though the
          // retarget just cancelled it. The navState check below ensures
          // handleLostStopped() only runs if the state is truly still LOST_STOPPED.
          // The same restriction applies to a loss that occurred while Tag 1 was
          // still being tracked.
          if(!startPhase && !expectedDet && !trackingStartTagActive) updateSkipCandidate(detectedWithDist, now);
          if(navState === NavState.LOST_STOPPED){
            handleLostStopped(now, expectedDet);
          }
        } else if(expectedDet){
          // Such-/Startphase: Multi-Frame-Bestätigung
          touchExpectedSeen(now);
          if(candId === expectedDet.id){ setCandidate(candId, candCount + 1); } else { setCandidate(expectedDet.id, 1); }
          touchCandidateSeen(now);
          if(candCount < CONFIRM_FRAMES){
            if(navState === NavState.SEARCHING_START_TAG || navState === NavState.SEARCHING_NEXT_TAG)
              setNavState(NavState.TAG_CANDIDATE);
            aimGuidance(expectedDet.corners);
          } else {
            setCandidate(null, 0);
            if(startPhase) noteStartCandidateConfirmed(expectedDet.id, now);
            else onExpectedTagFound(expectedDet.dist != null ? expectedDet.dist : emaDist);
          }
        } else {
          if(candId != null && (now - candLastSeenAt) > SETTINGS.candMemoryMs){
            setCandidate(null, 0);
          }
          if(navState === NavState.TAG_CANDIDATE)
            setNavState(startPhase ? NavState.SEARCHING_START_TAG : NavState.SEARCHING_NEXT_TAG);
          // Fremde Tags: nur benennen, Route NIE automatisch ändern.
          // Kurzes Aufblitzen wird ignoriert: fremde Tags brauchen ~0,8 s
          // stabile Sicht, die "zurück"-Warnung sogar ~1,3 s.
          if(!startPhase && bestKnown && bestKnown.id !== expectedNextTagId){
            if(wrongCandId === bestKnown.id){ setWrongCandidate(wrongCandId, wrongCandCount + 1); } else { setWrongCandidate(bestKnown.id, 1); }
            var passedIdx2 = pathTagIds ? pathTagIds.indexOf(bestKnown.id) : -1;
            var needFrames = (passedIdx2 >= 0 && passedIdx2 <= segIndex)
              ? SETTINGS.backTagFrames : SETTINGS.otherTagFrames;
            if(wrongCandCount >= needFrames){
              setWrongCandidate(null, 0);
              onOtherTagConfirmed(bestKnown.id);
            }
          } else {
            setWrongCandidate(null, 0);
          }
          // Independent forward-candidate check (controlled skip, derived generically
          // from pathTagIds/EDGE_MAP) -- entirely separate from the wrongCand logic
          // above, inspects all decoded tags (detectedWithDist), not just bestKnown.
          // Also called from the TRACKING/LOST_STOPPED branches above -- this call
          // (expectedDet falsy this frame, during the search/candidate phase) is only
          // one of four call sites. Priority of the normally expected tag follows
          // structurally: the expectedDet branch above does not call this while its
          // own confirmation is in progress.
          if(!startPhase && !trackingStartTagActive){
            updateSkipCandidate(detectedWithDist, now);
          }
          if(navState === NavState.SEARCHING_NEXT_TAG || navState === NavState.SEARCHING_START_TAG){
            scanHint();
          }
        }
      }

      updatePanel(visDist);
    }
    scheduleNext();
  }
  var nextTimer = null;
  function scheduleNext(){ nextTimer = setTimeout(function(){ requestAnimationFrame(tick); }, PROC_MS); }
export { tick, scheduleNext };
