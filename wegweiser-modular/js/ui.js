// ==================== Anzeige (UI-Rendering) ====================
// Verbatim aus wegweiser-v13.html (Abschnitte "---- Anzeige ----" und drawMarker
// aus "---- Entfernung über POSIT ----").
// updatePanel() liest Navigations-Zustand aus nav.js (nur lesend) und ruft
// currentEdge() auf; nav.js wiederum ruft updatePanel() auf -> genehmigter
// Zirkelbezug nav.js <-> ui.js (siehe Abhaengigkeitskarte, Entscheidung 2).
// HINWEIS: nav.js wird erst in Stufe 4 angelegt; bis dahin ist dieser Import-Pfad
// noch nicht aufloesbar (das Modul kann erst ab Stufe 4 tatsaechlich geladen werden).

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

  // ---- Zustandsbasierte Sichtbarkeit der Bedienelemente (neu, UX-Schritt:
  // State-Rendering) ----
  // Einzige Aufgabe: die vorhandenen Steuerelemente #navStartBtn/#navEndBtn/
  // #whereBtn/#destSel je nach den bereits bestehenden nav.js-Zustandsfeldern
  // (navigationActive/destinationReached) ein-/ausblenden bzw. -- nur bei destSel
  // -- (de)aktivieren, sowie den Start-Button-Text anpassen. Liest AUSSCHLIESSLICH
  // bereits vorhandenen Navigations-Zustand, loest KEINE Routen-/Kamera-/TTS-/Log-
  // Aufrufe aus und ist KEINE zweite Zustandsmaschine -- navigationActive/
  // destinationReached bleiben ausschliesslich in nav.js gesetzt. Verwendet das
  // native `hidden`-Attribut (keine neue CSS-Klasse): entfernt das Element
  // vollstaendig aus dem Layout UND aus dem Accessibility-Baum (VoiceOver kann es
  // dann nicht mehr fokussieren), ohne bestehende .ctrl-/.btnrow-Regeln anzufassen.
  // navStartBtn.disabled bleibt bewusst UNBERUEHRT -- das steuert weiterhin
  // ausschliesslich der vorhandene destSel-"change"-Handler in app.js.
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
