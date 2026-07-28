// ==================== Anzeige (UI-Rendering) ====================
// Verbatim aus wegweiser-v13.html (Abschnitte "---- Anzeige ----" und drawMarker
// aus "---- Entfernung über POSIT ----").
// updatePanel() liest Navigations-Zustand aus nav.js (nur lesend) und ruft
// currentEdge() auf; nav.js wiederum ruft updatePanel() auf -> genehmigter
// Zirkelbezug nav.js <-> ui.js (siehe Abhaengigkeitskarte, Entscheidung 2).
// HINWEIS: nav.js wird erst in Stufe 4 angelegt; bis dahin ist dieser Import-Pfad
// noch nicht aufloesbar (das Modul kann erst ab Stufe 4 tatsaechlich geladen werden).

import { roomEl, metaEl, uiDest, uiCur, uiNext, uiDist, uiInstr, uiSource, ctx } from './dom.js';
import { W } from './frame-state.js';
import { markerName, pathToText } from './graph.js';
import { destinationId, pathTagIds, currentTagId, expectedNextTagId, lastRouteInstruction, currentEdge } from './nav.js';

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

  function drawMarker(corners, color, faint){
    ctx.lineWidth = faint ? 2 : Math.max(3, W/160);
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for(var i = 1; i < corners.length; i++) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();
    ctx.stroke();
  }

export { showRoom, showIdle, updatePanel, drawMarker };
