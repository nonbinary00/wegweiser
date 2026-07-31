// ==================== Routen- und Markierungs-Konfiguration ====================
// Verbatim aus wegweiser-v13.html (Abschnitte FLOOR_GEOMETRY / GRAPH: KNOTEN / GRAPH: KANTEN).

  // ==================== FLOOR_GEOMETRY ====================
  // 1:1-Import aus "markers (2).json" — EINZIGE Geometriequelle, NICHT von Hand ändern.
  // Genutzt für: Kanten-Distanzen (Anzeige/Plausibilität) und Debug-Tabelle.
  var FLOOR_GEOMETRY = {
    scale_m_per_px: 0.04967096009845022,
    image: { width: 2480, height: 1753 },
    origin: "bottom-left",
    markers: [
      { tag_id:1,  label:"Eingang",     type:"entrance", x_m:103.733, y_m:46.217, dir_deg:180   },
      { tag_id:3,  label:"Flex",        type:"corridor", x_m:94.691,  y_m:42.808, dir_deg:0     },
      { tag_id:2,  label:"Patrik",      type:"corridor", x_m:103.240, y_m:41.290, dir_deg:94.6  },
      { tag_id:4,  label:"Martin",      type:"corridor", x_m:81.431,  y_m:42.682, dir_deg:354.8 },
      { tag_id:5,  label:"Tischtennis", type:"corridor", x_m:76.235,  y_m:52.805, dir_deg:264.1 },
      { tag_id:6,  label:"Korridor",    type:"corridor", x_m:89.966,  y_m:43.100, dir_deg:337.2 },
      { tag_id:8,  label:"Ecke",        type:"corridor", x_m:68.447,  y_m:43.400, dir_deg:335.6 },
      { tag_id:7,  label:"Leonie",      type:"office",   x_m:74.273,  y_m:40.961, dir_deg:2.9   },
      { tag_id:9,  label:"Essbereich",  type:"office",   x_m:78.211,  y_m:37.795, dir_deg:91.4  },
      { tag_id:10, label:"Drucker",     type:"office",   x_m:64.824,  y_m:41.103, dir_deg:10.8  },
      { tag_id:11, label:"end",         type:"office",   x_m:55.470,  y_m:43.375, dir_deg:334   }
    ],
    doors: [
      { label:"Eingang Patrik", type:"door", x_m:103.823, y_m:41.799, width_m:0.710, opening_deg:270.5, dir_deg:0.5   },
      { label:"Eingang",        type:"door", x_m:101.840, y_m:46.057, width_m:0.738, opening_deg:270.8, dir_deg:0.8   },
      { label:"Tür Frex",       type:"door", x_m:95.944,  y_m:41.284, width_m:0.898, opening_deg:0.2,   dir_deg:270.2 },
      { label:"Tür 1",          type:"door", x_m:92.500,  y_m:41.248, width_m:0.927, opening_deg:0,     dir_deg:270   },
      { label:"Tür 2",          type:"door", x_m:89.658,  y_m:41.240, width_m:0.761, opening_deg:0,     dir_deg:270   },
      { label:"Eingang Martin", type:"door", x_m:81.348,  y_m:40.144, width_m:0.757, opening_deg:89.1,  dir_deg:359.1 },
      { label:"Küchentür",      type:"door", x_m:74.557,  y_m:51.549, width_m:0.643, opening_deg:89.7,  dir_deg:179.7 },
      { label:"Tür Leonie",     type:"door", x_m:74.203,  y_m:39.844, width_m:0.802, opening_deg:90.5,  dir_deg:180.5 },
      { label:"Tür 3",          type:"door", x_m:63.275,  y_m:41.069, width_m:0.868, opening_deg:177.7, dir_deg:null  },
      { label:"Tür 4",          type:"door", x_m:59.814,  y_m:41.029, width_m:0.855, opening_deg:0,     dir_deg:null  },
      { label:"Tür end",        type:"door", x_m:55.156,  y_m:41.418, width_m:0.835, opening_deg:90.7,  dir_deg:180.7 }
    ]
  };

  // ==================== GRAPH: KNOTEN ====================
  var NODES = {
    1:  { name:"Eingang",             destination:false },
    2:  { name:"Patrik",              destination:true  },
    3:  { name:"Flex",                destination:true  },
    4:  { name:"Martin",              destination:true  },
    5:  { name:"Tischtennis",         destination:true  },
    6:  { name:"Korridor",            destination:false },
    7:  { name:"Leonie",              destination:true  },
    8:  { name:"Ecke",                destination:false },
    9:  { name:"Essbereich",          destination:false },
    10: { name:"Drucker",             destination:true  },
    11: { name:"Ende des Korridors",  destination:true  }
  };

  // Ansage, wenn die Navigation AN diesem Knoten beginnt (erster bestätigter Tag).
  // Beschreibt den Ort und die Aktion, um den NÄCHSTEN Tag vor die Kamera zu bekommen.
  // neu: KEINE Vorschau mehr auf das spaetere Abbiegen bei Tag 2 (das wird dort erneut
  // und tatsaechlich zum richtigen Zeitpunkt angesagt, siehe reachPoint() in nav.js) —
  // nur noch, was der Nutzer JETZT tun muss. Reiner Text, keine Routen-/Kantendaten
  // beruehrt.
  var START_TEXTS = {
    1: "Sie befinden sich am Eingang. Links befindet sich die Küche, rechts befinden " +
       "sich die Büros. Gehen Sie geradeaus und halten Sie das Smartphone vor sich."
  };

  // ==================== GRAPH: KANTEN (manuelles Ortswissen) ====================
  // GERICHTETE Kante A->B. Der Tag B liegt in Gehrichtung voraus.
  //   found      – NICHT mehr automatisch gesprochen (nur Doku/Fallback), siehe nav.js
  //   reached    – NICHT mehr automatisch bei Zwischen-Tags gesprochen (nur bei ARRIVALS
  //                am tatsaechlichen Ziel); bleibt als Doku/Fallback erhalten
  //   departureAction – neu: EINZIGE autoritative Quelle fuer "was der Nutzer TUN MUSS, UM
  //                DIESE Kante zu gehen". WICHTIG: departureAction von Kante X->Y beschreibt
  //                die Handlung BEI X (Abbiegen oder Geradeaus), BEVOR in Richtung Y
  //                losgegangen wird — NICHT etwas, das beim Erreichen von Y passiert!
  //                Wird daher gesprochen, wenn Tag X erreicht wird (naemlich als "naechste
  //                Kante" X->Y ab diesem Punkt) — siehe reachPoint() in nav.js, das dafuer
  //                die AUSGEHENDE Kante ab dem GERADE erreichten Tag nachschlaegt, nicht
  //                die soeben abgeschlossene eingehende Kante. Beispiel: 8->10 beschreibt
  //                die Handlung BEI Tag 8 (Ecke), um weiter zu Tag 10 (Drucker) zu gehen;
  //                das wird angesagt, sobald Tag 8 erreicht ist. Ein zukuenftiger Zweig ab
  //                Tag 8 (z.B. 8->12) koennte eine ANDERE departureAction haben, ohne 8->10
  //                zu aendern — die Handlung haengt vom gewaehlten NAECHSTEN Schritt ab,
  //                nicht am Tag selbst. Einer von: "turn-left", "turn-right",
  //                "continue-straight" (siehe DEPARTURE_ACTIONS in graph.js). Ersetzt das
  //                alte, nicht mehr verlaessliche "direction"-Feld UND das manuell
  //                gepflegte "continueSpeech"-Feld. graph.js leitet daraus automatisch ab:
  //                ob ein Abbiegen vorliegt (immer ansagen), ob mehrere Kanten zum selben
  //                Geradeaus-Lauf gehoeren (fuer Rueckmeldungen akkumuliert), und den
  //                gesprochenen Kurztext — eine neue Kante legt die Handlung also nur HIER
  //                einmal fest; nav.js kennt keine Tag-spezifischen Sonderfaelle.
  //   searchHint – manuelle Hilfe, solange Tag B noch nicht gefunden ist
  //   reachedM   – optionale eigene Schwelle (Standard SETTINGS.reachedM)
  // distanceM wird automatisch aus FLOOR_GEOMETRY berechnet.
  var EDGES = [
    { from:1, to:2,
      found:
        "Orientierungspunkt gefunden: Patrik. Gehen Sie geradeaus, ungefähr vier Meter. " +
        "Die Tür von Patrik befindet sich dann links. Halten Sie das Smartphone gerade vor sich.",
      reached:
        "Links ist die Tür von Patrik, rechts geht der Bürobereich weiter. " +
        "Biegen Sie rechts ab.",
      searchHint:
        "Nach dem Rechtsabbiegen: halten Sie das Smartphone gerade vor sich und " +
        "bewegen Sie es langsam nach links und rechts, bis die nächste Markierung erkannt wird.",
      // Das Abbiegen passiert BEI Tag 2 (Patrik), nicht beim Gehen dieser Kante selbst —
      // departureAction gehoert daher zu 2->3 (siehe dort), nicht hierher.
      departureAction: "continue-straight" },

    { from:2, to:3,
      found:
        "Orientierungspunkt gefunden: Flex. Gehen Sie geradeaus, ungefähr sechs Meter. " +
        "Die Tür befindet sich auf der linken Seite.",
      reached:
        "Sie sind am Eingang Flex. Die Tür ist links. Gehen Sie weiter geradeaus.",
      searchHint:
        "Bewegen Sie das Smartphone langsam nach links und rechts und suchen Sie die " +
        "Markierung bei Flex, geradeaus im Korridor.",
      // Hierher gehoert das Rechtsabbiegen bei Patrik: es wird angesagt, sobald Tag 2
      // erreicht ist, weil DIESE Kante (2->3) die naechste ausgehende Kante ab Tag 2 ist.
      departureAction: "turn-right" },

    { from:3, to:6,
      found:
        "Orientierungspunkt gefunden: Korridor. Gehen Sie geradeaus, ungefähr fünf Meter. " +
        "Auf der linken Seite folgen zwei Türen zum Büro Alevtyna.",
      reached:
        "Sie sind in der Mitte des Korridors. Gehen Sie weiter geradeaus.",
      searchHint:
        "Bewegen Sie das Smartphone langsam nach links und rechts und suchen Sie die " +
        "Markierung geradeaus im Korridor.",
      departureAction: "continue-straight" },

    { from:6, to:4,
      found:
        "Orientierungspunkt gefunden: Martin. Gehen Sie geradeaus, ungefähr neun Meter, " +
        "und halten Sie sich an der rechten Wand. Sie passieren zwei Türen auf der linken Seite.",
      reached:
        "Sie sind bei Martin. Der Eingang Martin liegt vor Ihnen. Gehen Sie weiter geradeaus.",
      searchHint:
        "Bewegen Sie das Smartphone langsam nach links und rechts und suchen Sie die " +
        "Markierung bei Martin, geradeaus im Korridor.",
      departureAction: "continue-straight" },

    { from:4, to:7,
      found:
        "Orientierungspunkt gefunden: Leonie. Gehen Sie geradeaus, ungefähr sieben Meter. " +
        "Die Tür zu Leonie befindet sich links.",
      reached:
        "Sie sind bei Leonie. Die Tür ist links. Gehen Sie weiter geradeaus.",
      searchHint:
        "Bewegen Sie das Smartphone langsam nach links und rechts und suchen Sie die " +
        "Markierung bei Leonie.",
      departureAction: "continue-straight" },

    { from:7, to:8,
      found:
        "Orientierungspunkt gefunden: Ecke. Gehen Sie geradeaus, ungefähr sechs Meter, " +
        "bis zur Ecke.",
      reached:
        "Sie haben die Ecke erreicht. Gehen Sie weiter geradeaus.",
      searchHint:
        "Bewegen Sie das Smartphone langsam nach links und rechts und suchen Sie die " +
        "Markierung an der Ecke, geradeaus voraus.",
      departureAction: "continue-straight" },

    { from:8, to:10,
      found:
        "Orientierungspunkt gefunden: Drucker. Gehen Sie geradeaus, ungefähr vier Meter.",
      reached:
        "Sie sind beim Drucker. Gehen Sie weiter geradeaus.",
      searchHint:
        "Bewegen Sie das Smartphone langsam nach links und rechts und suchen Sie die " +
        "Markierung beim Drucker, geradeaus im Korridor.",
      departureAction: "continue-straight" },

    { from:10, to:11,
      found:
        "Orientierungspunkt gefunden: Ende des Korridors. Gehen Sie geradeaus, ungefähr " +
        "zehn Meter, und halten Sie sich an der linken Wand. Sie passieren zwei Türen links.",
      reached:
        "Sie haben das Ende des Korridors erreicht. Die Tür befindet sich links.",
      searchHint:
        "Bewegen Sie das Smartphone langsam nach links und rechts und suchen Sie die " +
        "Markierung am Ende des Korridors, geradeaus voraus.",
      // Tag 11 hat keine Nachfolge-Kante -> ist auf jeder Route, die ihn enthaelt,
      // automatisch das Ziel; departureAction hier nur der Vollstaendigkeit halber.
      departureAction: "continue-straight" },

    { from:4, to:5,
      found:
        "Orientierungspunkt gefunden: Tischtennis. Gehen Sie geradeaus, ungefähr elf Meter, " +
        "in Richtung Küche. Die Küchentür befindet sich links.",
      reached:
        "Sie sind bei Tischtennis. Die Küchentür befindet sich links.",
      searchHint:
        "Wenden Sie sich in Richtung Küche und bewegen Sie das Smartphone langsam " +
        "nach links und rechts, bis die Markierung bei Tischtennis erkannt wird.",
      // Tag 5 hat ebenfalls keine Nachfolge-Kante -> immer Ziel; siehe Kommentar oben.
      departureAction: "continue-straight" }
  ];

  // Ankunftsansage am ZIEL (ersetzt das reached der letzten Kante).
  var ARRIVALS = {
    2:  "Ziel erreicht. Sie sind beim Büro von Patrik. Die Tür ist links.",
    3:  "Ziel erreicht. Sie sind am Eingang Flex. Die Tür befindet sich links.",
    4:  "Ziel erreicht. Sie sind bei Martin. Der Eingang Martin liegt vor Ihnen.",
    5:  "Ziel erreicht. Sie sind bei Tischtennis. Die Küchentür befindet sich links.",
    7:  "Ziel erreicht. Sie sind bei Leonie. Die Tür befindet sich links.",
    10: "Ziel erreicht. Sie sind beim Drucker.",
    11: "Ziel erreicht. Sie haben das Ende des Korridors erreicht. Die Tür befindet sich links."
  };

  // Ortsansagen für erkannte Tags, die NICHT auf dem Weg liegen.
  // Sie ändern die Route NICHT — nur benennen und zurückführen.
  var OFF_ROUTE_HINTS = {
    5:  "Erkannt: Tischtennis, in der Nähe der Küche.",
    9:  "Erkannt: Essbereich."
  };

export {
  FLOOR_GEOMETRY,
  NODES,
  START_TEXTS,
  EDGES,
  ARRIVALS,
  OFF_ROUTE_HINTS
};
