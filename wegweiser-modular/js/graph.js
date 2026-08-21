// ==================== Abgeleitete Graph-Strukturen ====================

import { FLOOR_GEOMETRY, NODES, EDGES, ARRIVAL_ALIASES } from './graph-data.js';

  // ---- Abgeleitete Strukturen ----
  var MARKERS = {};
  FLOOR_GEOMETRY.markers.forEach(function(m){ MARKERS[m.tag_id] = m; });

  var EDGE_MAP = {};
  var ADJ = {};
  EDGES.forEach(function(e){
    var a = MARKERS[e.from], b = MARKERS[e.to];
    e.distanceM = (a && b) ? Math.hypot(b.x_m - a.x_m, b.y_m - a.y_m) : null;
    EDGE_MAP[e.from + "->" + e.to] = e;
    (ADJ[e.from] = ADJ[e.from] || []).push(e.to);
  });

  function markerName(id){
    return NODES[id] ? NODES[id].name : (MARKERS[id] ? MARKERS[id].label : ("Tag " + id));
  }
  function metersDE(d){
    var m = Math.max(1, Math.round(d));
    var words = { 1:"einen", 2:"zwei", 3:"drei", 4:"vier", 5:"fünf", 6:"sechs",
                  7:"sieben", 8:"acht", 9:"neun", 10:"zehn", 11:"elf", 12:"zwölf" };
    return (words[m] || m) + " Meter";
  }

  // ==================== DEPARTURE_ACTIONS ====================
  // Einzige Quelle der Wahrheit fuer "was der Nutzer BEI Kante.from tun muss, um in
  // Richtung Kante.to weiterzugehen" (Abbiegen oder Geradeaus) — NICHT etwas, das beim
  // Erreichen von Kante.to passiert. Gesprochen wird sie, sobald Tag "from" erreicht ist
  // (siehe reachPoint() in nav.js, das dafuer die AUSGEHENDE Kante ab dem gerade
  // erreichten Tag nachschlaegt). Jede Handlung wird GENAU EINMAL definiert (Abbiege-
  // Erkennung + gesprochener Text). Neue Handlungen (z.B. spaeter "turn-slight-left"
  // oder "turn-around") werden NUR hier ergaenzt — nav.js fragt ausschliesslich
  // isTurnAction()/departureActionSpeech() ab und kennt keine Tag- oder routen-
  // spezifischen Sonderfaelle. Kein Parsen von deutschem Sprachtext zur Verhaltens-
  // Ableitung.
  var DEPARTURE_ACTIONS = {
    "turn-left":         { isTurn: true,  speech: "Biegen Sie links ab." },
    "turn-right":        { isTurn: true,  speech: "Biegen Sie rechts ab." },
    "continue-straight": { isTurn: false, speech: "Gehen Sie weiter geradeaus." }
  };

  function isTurnAction(edge){
    var a = edge && DEPARTURE_ACTIONS[edge.departureAction];
    return !!(a && a.isTurn);
  }
  function departureActionSpeech(edge){
    var a = edge && DEPARTURE_ACTIONS[edge.departureAction];
    return a ? a.speech : "Gehen Sie weiter geradeaus.";
  }

  // ==================== AUTOMATIK: ROUTENWAHL (BFS) ====================
  // Zustand ist ein Paar (from, node) -- von welchem Tag aus node erreicht
  // wurde, nicht nur node selbst. Noetig, weil eine Kante ueber
  // allowedPredecessors optional einschraenken kann, von welchem Vorgaenger aus
  // sie begehbar ist (siehe 3->15 in graph-data.js: nur nach Ankunft ueber
  // Tag 6, nicht ueber Tag 2) -- ein reiner knotenbasierter BFS besucht jeden
  // Knoten pro Lauf nur einmal, unabhaengig vom Vorgaenger, und koennte das
  // nicht abbilden. Terminierung ist bereits durch den paarweisen seen-Zustand
  // allein garantiert (Zustandsraum ist durch die Anzahl der Kanten begrenzt).
  // nodeAlreadyOnPath() sichert zusaetzlich die KORREKTHEIT des Ergebnisses:
  // ohne diese Pruefung koennte der Suchlauf ueber Tag 6 zurueck zu Tag 3
  // laufen, um dort unter einem ANDEREN Vorgaenger-Zustand erneut anzukommen
  // und so 3->15 freizuschalten -- ein Pfad, der Tag 3 zweimal enthaelt und
  // physisch keine sinnvolle Anweisung waere. parent-Zeiger haengen direkt am
  // Zustand (statt an einer separaten Map). Oeffentliche Signatur und
  // Rueckgabewert (flaches Array von Tag-IDs oder null) bleiben unveraendert;
  // jede Kante ohne allowedPredecessors verhaelt sich exakt wie zuvor.
  function findPath(startId, destId){
    if(startId === destId) return [startId];

    function stateKey(from, node){ return from + "|" + node; }
    function nodeAlreadyOnPath(state, nodeId){
      var walk = state;
      while(walk){
        if(walk.node === nodeId) return true;
        walk = walk.parent;
      }
      return false;
    }

    var startState = { from: null, node: startId, parent: null };
    var queue = [startState];
    var seen = {};
    seen[stateKey(null, startId)] = true;

    while(queue.length){
      var cur = queue.shift();
      var next = ADJ[cur.node] || [];
      for(var i = 0; i < next.length; i++){
        var n = next[i];
        var edge = EDGE_MAP[cur.node + "->" + n];
        if(edge && edge.allowedPredecessors && cur.from !== null &&
           edge.allowedPredecessors.indexOf(cur.from) === -1){
          continue;
        }
        if(nodeAlreadyOnPath(cur, n)) continue;
        var key = stateKey(cur.node, n);
        if(seen[key]) continue;
        seen[key] = true;
        var nextState = { from: cur.node, node: n, parent: cur };
        if(n === destId){
          var path = [];
          var walkBack = nextState;
          while(walkBack){
            path.unshift(walkBack.node);
            walkBack = walkBack.parent;
          }
          return path;
        }
        queue.push(nextState);
      }
    }
    return null;
  }

  function pathToText(path){
    return path.map(function(id){ return "Tag " + id; }).join(" → ");
  }

  // ==================== Alternative Ankunfts-Markierung (siehe ARRIVAL_ALIASES) ====================
  // Generischer Ersatz fuer den blossen Identitaets-Vergleich "ist dieser Tag das
  // Ziel?" -- erkennt zusaetzlich den in ARRIVAL_ALIASES (graph-data.js) hinterlegten
  // alternativen physischen Ankunfts-Tag fuer ein logisches Ziel (z.B. Tag 15 fuer
  // destinationId 2/Patrik). Ohne Eintrag verhaelt sich dies exakt wie der bisherige
  // "tagId === destId"-Vergleich.
  function isArrivalTag(tagId, destId){
    return tagId === destId || ARRIVAL_ALIASES[destId] === tagId;
  }

  // Versucht zuerst den direkten Weg zum echten Ziel; nur wenn dieser nicht
  // existiert, wird der in ARRIVAL_ALIASES hinterlegte alternative Ankunfts-Tag (falls
  // vorhanden) als Fallback-Ziel versucht. Gibt { path, arrivalTagId } zurueck
  // (arrivalTagId ist destId, ausser der Fallback wurde tatsaechlich verwendet) oder
  // null, wenn keiner der beiden Wege existiert. Aendert findPath() selbst nicht --
  // reiner Aufrufer-seitiger Fallback, ausschliesslich fuer destIds mit einem Eintrag
  // in ARRIVAL_ALIASES ueberhaupt wirksam.
  function findPathToDestination(startId, destId){
    var direct = findPath(startId, destId);
    if(direct) return { path: direct, arrivalTagId: destId };
    var alias = ARRIVAL_ALIASES[destId];
    if(alias != null){
      var aliasPath = findPath(startId, alias);
      if(aliasPath) return { path: aliasPath, arrivalTagId: alias };
    }
    return null;
  }

  // ==================== VALIDIERUNG ====================
  (function validateGraph(){
    EDGES.forEach(function(e){
      if(!MARKERS[e.from]) console.error("[Graph] Kante " + e.from + "->" + e.to + ": Startknoten fehlt.");
      if(!MARKERS[e.to])   console.error("[Graph] Kante " + e.from + "->" + e.to + ": Zielknoten fehlt.");
      if(!e.found)         console.error("[Graph] Kante " + e.from + "->" + e.to + ": found-Text fehlt.");
      if(!e.reached)       console.error("[Graph] Kante " + e.from + "->" + e.to + ": reached-Text fehlt.");
      if(!e.searchHint)    console.warn ("[Graph] Kante " + e.from + "->" + e.to + ": searchHint fehlt.");
      if(!DEPARTURE_ACTIONS[e.departureAction])
        console.error("[Graph] Kante " + e.from + "->" + e.to + ": departureAction fehlt oder unbekannt ("
                       + e.departureAction + ").");
    });
    Object.keys(NODES).map(Number).forEach(function(id){
      if(!NODES[id].destination) return;
      var p = findPath(1, id);
      if(!p) console.error("[Graph] Ziel " + markerName(id) + " (Tag " + id + ") ist vom Eingang aus NICHT erreichbar.");
    });
  })();

export {
  MARKERS,
  EDGE_MAP,
  ADJ,
  markerName,
  metersDE,
  findPath,
  pathToText,
  isTurnAction,
  departureActionSpeech,
  isArrivalTag,
  findPathToDestination
};
