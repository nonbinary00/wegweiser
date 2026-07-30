// ==================== Hauptschleife ====================
// tick()/scheduleNext() verbatim aus wegweiser-v13.html (Abschnitt "HAUPTSCHLEIFE"),
// MIT genau 16 mechanischen Ersetzungen fuer die sechs genehmigten Cross-Modul-Mutatoren
// (setFrameSize, setEmaDist, setLastExpectedVisual, touchExpectedSeen, touchCandidateSeen,
// setCandidate, setWrongCandidate) sowie deren zugehoerige lesende Importe. Diese Datei ist
// NICHT byte-identisch mit dem Original -- die einzigen Abweichungen sind exakt diese 16
// Zeilen (jede reine 1:1-Ersetzung von "x = y;" durch "setX(y);", keine Verhaltensaenderung).
// running (camera.js) <-> scheduleNext() (hier) ist der genehmigte Zirkelbezug
// camera.js <-> main-loop.js (Entscheidung 2).

import { video, canvas, ctx } from './dom.js';
import { PROC_WIDTH, PROC_MS, SETTINGS, DEBUG_SHOW_TAG_ID, CONFIRM_FRAMES, MARKER_SIZE_M } from './config.js';
import { detector } from './detector-state.js';
import { W, H, setFrameSize } from './frame-state.js';
import { MARKERS, markerName } from './graph.js';
import { distanceMeters } from './distance.js';
import { showRoom, showIdle, updatePanel, drawMarker } from './ui.js';
import {
  navState, NavState, navigationActive, pathTagIds, destinationReached, destinationId,
  currentTagId, expectedNextTagId, segIndex, emaDist, candId, candCount, wrongCandId,
  wrongCandCount, lastExpectedVis, candLastSeenAt,
  setNavState, handleTracking, handleLostStopped, onStartTagConfirmed, onNextTagFound,
  onOtherTagConfirmed, updateSkipCandidate, scanHint, aimGuidance,
  touchExpectedSeen, touchCandidateSeen, setLastExpectedVisual, setWrongCandidate,
  setCandidate, setEmaDist
} from './nav.js';
import { running } from './camera.js';

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
      try{ detected = detector.detect(img); }catch(e){ detected = []; }

      var now = performance.now();
      var expectedDet = null, bestKnown = null, bestKnownDist = Infinity;
      var startPhase = navigationActive && pathTagIds == null;
      // neu: ALLE diesmal decodierten Tags mit ihrer Distanz, fuer die eigenstaendige
      // Vorgriffs-Kandidaten-Pruefung (updateSkipCandidate() in nav.js) — unabhaengig
      // davon, welcher Tag als expectedDet/bestKnown ausgewaehlt wird.
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
        if(navState === NavState.TRACKING){
          if(expectedDet) touchExpectedSeen(now);
          // v13: frische Roh-Distanz dieses Frames mitgeben (Ankunftslogik)
          handleTracking(now, expectedVisual, expectedDet ? expectedDet.dist : null);
        } else if(navState === NavState.LOST_STOPPED){
          if(expectedDet) touchExpectedSeen(now);
          handleLostStopped(now, expectedDet);
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
            if(startPhase) onStartTagConfirmed(expectedDet.id);
            else onNextTagFound(expectedDet.dist != null ? expectedDet.dist : emaDist);
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
          // neu: eigenstaendige Vorgriffs-Kandidaten-Pruefung (kontrollierter Skip,
          // generisch aus pathTagIds/EDGE_MAP abgeleitet) — komplett getrennt von der
          // obigen wrongCand-Logik, inspiziert ALLE decodierten Tags (detectedWithDist),
          // nicht nur bestKnown. Laeuft NUR in diesem Zweig (expectedDet ist diesmal
          // falsy), wodurch der normale erwartete Tag automatisch Vorrang hat: sobald
          // er selbst wieder sichtbar ist, greift ausschliesslich der Zweig oben, und
          // diese Pruefung pausiert einfach (kein Reset, siehe candMemoryMs-Toleranz
          // in updateSkipCandidate()).
          if(!startPhase){
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
