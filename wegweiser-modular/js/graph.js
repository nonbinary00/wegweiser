// ==================== Abgeleitete Graph-Strukturen ====================
// Verbatim aus wegweiser-v13.html (Abschnitte "Abgeleitete Strukturen",
// AUTOMATIK: ROUTENWAHL (BFS), VALIDIERUNG).

import { FLOOR_GEOMETRY, NODES, EDGES } from './graph-data.js';

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

  // ==================== AUTOMATIK: ROUTENWAHL (BFS) ====================
  function findPath(startId, destId){
    if(startId === destId) return [startId];
    var queue = [startId], prev = {}, seen = {};
    seen[startId] = true;
    while(queue.length){
      var cur = queue.shift();
      var next = ADJ[cur] || [];
      for(var i = 0; i < next.length; i++){
        var n = next[i];
        if(seen[n]) continue;
        seen[n] = true;
        prev[n] = cur;
        if(n === destId){
          var path = [n];
          while(path[0] !== startId) path.unshift(prev[path[0]]);
          return path;
        }
        queue.push(n);
      }
    }
    return null;
  }

  function pathToText(path){
    return path.map(function(id){ return "Tag " + id; }).join(" → ");
  }

  // ==================== VALIDIERUNG ====================
  (function validateGraph(){
    EDGES.forEach(function(e){
      if(!MARKERS[e.from]) console.error("[Graph] Kante " + e.from + "->" + e.to + ": Startknoten fehlt.");
      if(!MARKERS[e.to])   console.error("[Graph] Kante " + e.from + "->" + e.to + ": Zielknoten fehlt.");
      if(!e.found)         console.error("[Graph] Kante " + e.from + "->" + e.to + ": found-Text fehlt.");
      if(!e.reached)       console.error("[Graph] Kante " + e.from + "->" + e.to + ": reached-Text fehlt.");
      if(!e.searchHint)    console.warn ("[Graph] Kante " + e.from + "->" + e.to + ": searchHint fehlt.");
    });
    var rows = [];
    Object.keys(NODES).map(Number).forEach(function(id){
      if(!NODES[id].destination) return;
      var p = findPath(1, id);
      if(!p) console.error("[Graph] Ziel " + markerName(id) + " (Tag " + id + ") ist vom Eingang aus NICHT erreichbar.");
      else rows.push({ ziel: markerName(id), pfad: p.join(" -> "),
                       distanzM: +p.reduce(function(s, n, i){
                         if(i === 0) return 0;
                         var e = EDGE_MAP[p[i-1] + "->" + n];
                         return s + (e && e.distanceM || 0);
                       }, 0).toFixed(1) });
    });
    console.table(rows);
  })();

export {
  MARKERS,
  EDGE_MAP,
  ADJ,
  markerName,
  metersDE,
  findPath,
  pathToText
};
