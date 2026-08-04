// ==================== Anzeige (UI-Rendering) ====================
// updatePanel() reads navigation state from nav.js (read-only) and calls
// currentEdge(); nav.js in turn calls updatePanel() -- an intentional circular
// dependency between nav.js and ui.js.

import { roomEl, metaEl, uiDest, uiCur, uiNext, uiDist, uiInstr, uiSource, ctx,
  destSel, navStartBtn, navEndBtn, whereBtn } from './dom.js';
import { W } from './frame-state.js';
import { markerName, pathToText } from './graph.js';
import { destinationId, pathTagIds, currentTagId, expectedNextTagId, lastRouteInstruction, currentEdge,
  navigationActive, destinationReached } from './nav.js';

  // ---- Anzeige ----
  function showRoom(label, sub, distM){
    roomEl.textContent = label;
    roomEl.classList.remove("empty");
    var m = sub || "";
    if(distM != null) m += (m ? " · " : "") + "≈ " + Math.max(0, Math.round(distM)) + " m";
    metaEl.textContent = m;
    metaEl.classList.toggle("empty", !m);
  }
  function showIdle(txt){
    roomEl.textContent = txt || "Keine Markierung";
    roomEl.classList.add("empty");
    metaEl.textContent = "";
    metaEl.classList.add("empty");
  }
  function updatePanel(visDist){
    var destTxt = destinationId != null ? (markerName(destinationId) + " (Tag " + destinationId + ")") : "–";
    if(pathTagIds) destTxt += " · " + pathToText(pathTagIds);
    uiDest.textContent = destTxt;
    uiCur.textContent  = currentTagId != null ? ("Tag " + currentTagId + " · " + markerName(currentTagId)) : "–";
    uiNext.textContent = expectedNextTagId != null ? ("Tag " + expectedNextTagId + " · " + markerName(expectedNextTagId)) : "–";
    uiDist.textContent = visDist != null ? ("≈ " + visDist.toFixed(1) + " m") : "–";
    uiInstr.textContent = lastRouteInstruction || "–";
    var e = currentEdge();
    uiSource.textContent = e ? "MANUELL" : "–";
    uiSource.className = e ? "auto" : "";
  }

  // ---- Zustandsbasierte Sichtbarkeit der Bedienelemente ----
  // Sole purpose: show/hide #navStartBtn/#navEndBtn/#whereBtn (and, for destSel,
  // enable/disable) according to the existing nav.js state fields
  // (navigationActive/destinationReached), and adjust the start-button text. Reads
  // only already-existing navigation state, triggers no route/camera/TTS/log calls,
  // and is not a second state machine -- navigationActive/destinationReached
  // continue to be set exclusively in nav.js. Uses the native `hidden` attribute
  // (no new CSS class): this removes the element from both the layout and the
  // accessibility tree (VoiceOver can no longer focus it), without touching the
  // existing .ctrl-/.btnrow rules. navStartBtn.disabled is deliberately left
  // untouched here -- that remains controlled solely by the existing destSel
  // "change" handler in app.js.
  function renderNavigationUi(){
    if(navigationActive){
      navStartBtn.hidden = true;
      navEndBtn.hidden = false;
      whereBtn.hidden = false;
      destSel.disabled = true;
      return;
    }
    if(destinationReached){
      navStartBtn.hidden = false;
      navEndBtn.hidden = true;
      whereBtn.hidden = true;
      destSel.disabled = false;
      navStartBtn.textContent = "Neue Navigation starten";
      return;
    }
    // Vor der Navigation (Anfangszustand) ODER nach manuellem Beenden.
    navStartBtn.hidden = false;
    navEndBtn.hidden = true;
    whereBtn.hidden = true;
    destSel.disabled = false;
    navStartBtn.textContent = "Navigation starten";
  }

  function drawMarker(corners, color, faint){
    ctx.lineWidth = faint ? 2 : Math.max(3, W/160);
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for(var i = 1; i < corners.length; i++) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();
    ctx.stroke();
  }

export { showRoom, showIdle, updatePanel, drawMarker, renderNavigationUi };
