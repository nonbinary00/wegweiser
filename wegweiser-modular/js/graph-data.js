// ==================== Routen- und Markierungs-Konfiguration ====================

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
      { tag_id:11, label:"end",         type:"office",   x_m:55.470,  y_m:43.375, dir_deg:334   },
      // Buero-Erweiterung 11->12->13->14 (neu, physisch vermessen und begangen,
      // siehe "markers (newTags_16).json"). Der Korridor endet NICHT bei Tag 11 --
      // er setzt sich geradeaus zu Tag 12 fort. dir_deg fehlt fuer Tag 13/14 im
      // Messexport (nicht erfasst) und wird NICHT geschaetzt/ergaenzt.
      { tag_id:12, label:"Büro Malte",  type:"office",   x_m:48.852,  y_m:42.294, dir_deg:355.1 },
      { tag_id:13, label:"Müggelsee",   type:"office",   x_m:51.103,  y_m:47.561 },
      { tag_id:14, label:"end",         type:"office",   x_m:49.111,  y_m:49.867 },
      // Rueckwaerts-Route-Erweiterung 3->15->16 (neu). Label wie im
      // Original-Marker-Export ("back tag1"/"back tag 2") uebernommen -- rein
      // informelle Planungsbezeichnung, siehe NODES-Eintrag fuer den
      // tatsaechlichen Anzeigenamen (analog Tag 11: Marker-Label "end" vs.
      // NODES-Name "Ende des Korridors").
      { tag_id:15, label:"back tag1",   type:"office",   x_m:103.721, y_m:41.415, dir_deg:176.5 },
      { tag_id:16, label:"back tag 2",  type:"office",   x_m:102.083, y_m:47.481, dir_deg:280.4 }
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
      { label:"Tür end",        type:"door", x_m:55.156,  y_m:41.418, width_m:0.835, opening_deg:90.7,  dir_deg:180.7 },
      { label:"tür Malte",      type:"door", x_m:49.703,  y_m:40.570, width_m:0.945, opening_deg:180,   dir_deg:270   },
      { label:"Tür Müggelsee",  type:"door", x_m:52.029,  y_m:47.649, width_m:0.739, opening_deg:358.3, dir_deg:268.3 }
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
    // Essbereich (neu, physisch verifiziert): Tag 9 markiert die Wand, an der
    // die Markierung haengt -- NICHT den eigentlichen Zielort. Das physische
    // Ziel ist der Esstisch/Essbereich, ein paar Schritte VOR der Markierung.
    // Siehe Kante 4->9 unten (reachedM) fuer die daraus abgeleitete
    // "Zonen-Ankunft"; kein neues Feld hier noetig.
    9:  { name:"Essbereich",          destination:true  },
    10: { name:"Drucker",             destination:true  },
    11: { name:"Ende des Korridors",  destination:true  },
    // Buero-Erweiterung 11->12->13->14 (neu, physisch verifiziert): der
    // Korridor setzt sich hinter Tag 11 fort, ist also entgegen dem alten
    // Kommentar bei Kante 10->11 (siehe dort) kein Sackgassen-Ende mehr.
    // Alle drei sind wie Martin/Leonie/Patrik/Drucker echte, waehlbare
    // Ziele (kein reiner Wendepunkt wie Tag 15).
    12: { name:"Malte",               destination:true  },
    13: { name:"Müggelsee",           destination:true  },
    14: { name:"Ende des Büros",      destination:true  },
    // Rueckwaerts-Route-Erweiterung 3->15->16 (neu). Tag 15 ist ein reiner
    // Wendepunkt (kein eigenes Ziel); Tag 16 ist das tatsaechliche Ende der
    // Rueckwaerts-Route (Ausgang), unabhaengig von Tag 1/Tag 2 -- KEINE Kante
    // zurueck zu Tag 1/2, keine Kopie von deren Daten.
    15: { name:"Wendepunkt",          destination:false },
    16: { name:"Ausgang",             destination:true  }
  };

  // Ansage, wenn die Navigation AN diesem Knoten beginnt (erster bestätigter Tag).
  // Beschreibt den Ort und die Aktion, um den NÄCHSTEN Tag vor die Kamera zu bekommen.
  // Speaks only what the user must do now; deliberately does not preview a later turn
  // (that is announced again, at the correct time, by reachPoint() in nav.js). Plain
  // text only, does not affect route/edge data.
  // For Tag 1 (special-cased in nav.js's beginStartTagTracking()): exact wording of the
  // entrance announcement, spoken once, immediately after Tag 1 is visually confirmed.
  // neu (Rueckwaerts-Route-Start bei Tag 11): bewusst OHNE "Gehen Sie geradeaus."
  // -- anders als bei Tag 1 ist die Ausgangsorientierung am Ende des Korridors
  // nicht bekannt (siehe Bericht: der Nutzer koennte dort stehen, gerade aus
  // einem Raum kommen, oder bereits teilweise Richtung Tag 10 blicken). Der
  // Nutzer muss sich zunaechst umdrehen und die Kamera neu ausrichten; die
  // Bestaetigung "Die Richtung stimmt. Gehen Sie geradeaus." folgt erst, sobald
  // Tag 10 tatsaechlich ueber die normale Erkennung bestaetigt wird (siehe
  // onStartTagConfirmed()/setPostTurnPending() in nav.js).
  var START_TEXTS = {
    1: "Sie befinden sich am Eingang. Links befindet sich die Küche, rechts befinden " +
       "sich die Büros. Halten Sie das Smartphone gerade vor sich. Gehen Sie geradeaus.",
    11: "Sie befinden sich am Ende des Korridors. Drehen Sie sich um und halten Sie " +
        "das Smartphone gerade vor sich."
  };

  // ==================== GRAPH: KANTEN (manuelles Ortswissen) ====================
  // GERICHTETE Kante A->B. Der Tag B liegt in Gehrichtung voraus.
  //   found      – NICHT mehr automatisch gesprochen (nur Doku/Fallback), siehe nav.js
  //   reached    – NICHT mehr automatisch bei Zwischen-Tags gesprochen (nur bei ARRIVALS
  //                am tatsaechlichen Ziel); bleibt als Doku/Fallback erhalten
  //   departureAction – the single authoritative source for what the user must do to
  //                walk this edge. Edge X->Y describes the action taken at X (turn or
  //                go straight) before heading toward Y, not anything that happens upon
  //                reaching Y — it is spoken once tag X is reached, as the outgoing edge
  //                from that point on (see reachPoint() in nav.js, which looks up the
  //                outgoing edge from the tag just reached, not the incoming edge just
  //                completed). Example: 8->10 describes the action at Tag 8 (Ecke) to
  //                continue toward Tag 10 (Drucker), spoken as soon as Tag 8 is reached;
  //                the action depends on the chosen next step, not on the tag itself.
  //                One of: "turn-left", "turn-right", "continue-straight" (see
  //                DEPARTURE_ACTIONS in graph.js), from which graph.js derives whether a
  //                turn is involved, whether consecutive edges belong to the same
  //                straight run, and the spoken short text — a new edge only needs to
  //                set this once here; nav.js has no tag-specific special cases.
  //   searchHint – manuelle Hilfe, solange Tag B noch nicht gefunden ist
  //   reachedM   – optionale eigene Schwelle (Standard SETTINGS.reachedM)
  //   allowedPredecessors – neu, OPTIONAL: schraenkt ein, von welchem Vorgaenger-Tag
  //                aus diese Kante begehbar ist (siehe 3->15 unten). Fehlt dieses Feld
  //                (der Normalfall), ist die Kante wie bisher von JEDEM Vorgaenger aus
  //                begehbar. findPath() in graph.js wertet dies gegen den tatsaechlichen
  //                Vorgaenger im jeweiligen Suchlauf aus.
  //   locationDescription – neu: MENSCHENLESBARE Standortbeschreibung fuer GENAU
  //                dieses Wegstueck (Kante.from -> Kante.to), OHNE AprilTag-Nummern
  //                -- einzige Quelle fuer "Wo bin ich?" (siehe whereAmIResponse() in
  //                nav.js), damit dort niemals "Markierung X" gesprochen wird. Pro
  //                Kante eigenstaendig formuliert, nicht automatisch aus found/
  //                reached/NODES-Namen abgeleitet, da dieselbe Wegstrecke je nach
  //                Richtung unterschiedlich beschrieben werden kann (z.B. 3->6 vs.
  //                6->3 -- gleicher Korridor, andere Beschreibung erlaubt).
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
      departureAction: "continue-straight",
      locationDescription:
        "Sie befinden sich zwischen dem Eingang und dem Büro von Patrik." },

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
      departureAction: "turn-right",
      locationDescription:
        "Sie befinden sich zwischen dem Büro von Patrik und dem Flexbüro." },

    { from:3, to:6,
      found:
        "Orientierungspunkt gefunden: Korridor. Gehen Sie geradeaus, ungefähr fünf Meter. " +
        "Auf der linken Seite folgen zwei Türen zum Büro Alevtyna.",
      reached:
        "Sie sind in der Mitte des Korridors. Gehen Sie weiter geradeaus.",
      searchHint:
        "Bewegen Sie das Smartphone langsam nach links und rechts und suchen Sie die " +
        "Markierung geradeaus im Korridor.",
      departureAction: "continue-straight",
      locationDescription:
        "Sie befinden sich zwischen dem Flexbüro und dem Korridor." },

    { from:6, to:4,
      found:
        "Orientierungspunkt gefunden: Martin. Gehen Sie geradeaus, ungefähr neun Meter, " +
        "und halten Sie sich an der rechten Wand. Sie passieren zwei Türen auf der linken Seite.",
      reached:
        "Sie sind bei Martin. Der Eingang Martin liegt vor Ihnen. Gehen Sie weiter geradeaus.",
      searchHint:
        "Bewegen Sie das Smartphone langsam nach links und rechts und suchen Sie die " +
        "Markierung bei Martin, geradeaus im Korridor.",
      departureAction: "continue-straight",
      locationDescription:
        "Sie befinden sich zwischen dem Korridor und dem Büro von Martin." },

    { from:4, to:7,
      found:
        "Orientierungspunkt gefunden: Leonie. Gehen Sie geradeaus, ungefähr sieben Meter. " +
        "Die Tür zu Leonie befindet sich links.",
      reached:
        "Sie sind bei Leonie. Die Tür ist links. Gehen Sie weiter geradeaus.",
      searchHint:
        "Bewegen Sie das Smartphone langsam nach links und rechts und suchen Sie die " +
        "Markierung bei Leonie.",
      departureAction: "continue-straight",
      locationDescription:
        "Sie befinden sich im Korridor zwischen dem Büro von Martin und dem " +
        "Büro von Leonie." },

    // ---- Essbereich-Anbindung 4->9 (neu, physisch verifiziert) ----
    // Verifiziert: von Tag 4 aus geht es weiterhin GERADEAUS (kein Abbiegen im
    // Gehweg) -- departureAction bleibt "continue-straight", exakt wie bei
    // 4->7 und 4->5. Nur die SUCHRICHTUNG der Kamera verschiebt sich leicht
    // nach links, um die Markierung zu finden (searchHint unten) -- das ist
    // KEIN Abbiegen und wird daher nicht als departureAction kodiert.
    //
    // "Zonen-Ankunft" (neu): Tag 9 haengt an der Wand, nicht am eigentlichen
    // Zielort (Esstisch/Essbereich, ein paar Schritte davor). Die bestehende,
    // bereits vorhandene optionale Kanten-Schwelle reachedM (siehe
    // handleTracking() in nav.js) reicht dafuer bereits aus -- kein neues
    // Feld/Mechanismus noetig: ein groesserer Wert als SETTINGS.reachedM
    // (1,8 m) loest REACHED aus, sobald die Markierung zuverlaessig auf
    // groessere Distanz erkannt wird, statt erst direkt vor der Wand. Alle
    // anderen Sicherheitslogiken (arrivalConfirmFrames, trackingConfirmed,
    // Verlust-/Wiederfindungs-Timer, Vorgriffs-Erkennung, Away-Warnung) bleiben
    // dadurch vollstaendig unveraendert -- nur DIESE eine Kante nutzt den
    // groesseren Schwellenwert. 3,0 m ist ein konservativer Startwert
    // (deutlich ueber dem Standard, aber noch keine exakt vor Ort gemessene
    // Distanz zwischen Scan-Punkt und Markierung) und sollte im Feldtest
    // nachjustiert werden.
    { from:4, to:9,
      found:
        "Orientierungspunkt gefunden: Essbereich.",
      reached:
        "Der Essbereich ist erreicht. Der Tisch befindet sich wenige Schritte " +
        "vor Ihnen.",
      searchHint:
        "Gehen Sie noch etwa zwei Meter geradeaus und suchen Sie die Markierung " +
        "leicht links.",
      departureAction: "continue-straight",
      reachedM: 3.0,
      locationDescription:
        "Sie befinden sich zwischen dem Büro von Martin und dem Essbereich." },

    { from:7, to:8,
      found:
        "Orientierungspunkt gefunden: Ecke. Gehen Sie geradeaus, ungefähr sechs Meter, " +
        "bis zur Ecke.",
      reached:
        "Sie haben die Ecke erreicht. Gehen Sie weiter geradeaus.",
      searchHint:
        "Bewegen Sie das Smartphone langsam nach links und rechts und suchen Sie die " +
        "Markierung an der Ecke, geradeaus voraus.",
      departureAction: "continue-straight",
      locationDescription:
        "Sie befinden sich im Korridor zwischen dem Büro von Leonie und der Ecke." },

    { from:8, to:10,
      found:
        "Orientierungspunkt gefunden: Drucker. Gehen Sie geradeaus, ungefähr vier Meter.",
      reached:
        "Sie sind beim Drucker. Gehen Sie weiter geradeaus.",
      searchHint:
        "Bewegen Sie das Smartphone langsam nach links und rechts und suchen Sie die " +
        "Markierung beim Drucker, geradeaus im Korridor.",
      departureAction: "continue-straight",
      locationDescription:
        "Sie befinden sich im Korridor zwischen der Ecke und dem Drucker." },

    { from:10, to:11,
      found:
        "Orientierungspunkt gefunden: Ende des Korridors. Gehen Sie geradeaus, ungefähr " +
        "zehn Meter, und halten Sie sich an der linken Wand. Sie passieren zwei Türen links.",
      reached:
        "Sie haben das Ende des Korridors erreicht. Die Tür befindet sich links.",
      searchHint:
        "Bewegen Sie das Smartphone langsam nach links und rechts und suchen Sie die " +
        "Markierung am Ende des Korridors, geradeaus voraus.",
      // Tag 11 ist NICHT mehr zwangslaeufig das Ziel jeder Route, die ihn
      // enthaelt (Kante 11->12 unten): der Korridor setzt sich physisch
      // verifiziert geradeaus fort. Wie jeder andere Zwischen-Tag (z.B. Tag 10)
      // ist Tag 11 nur dann das Ziel, wenn reachPoint() reachedTagId ===
      // destinationId feststellt (siehe nav.js) -- departureAction hier bleibt
      // trotzdem gepflegt, fuer den Fall, dass die Route bei Tag 11 endet.
      departureAction: "continue-straight",
      locationDescription:
        "Sie befinden sich im Korridor zwischen dem Drucker und dem Ende des " +
        "Korridors." },

    // ---- Buero-Erweiterung 11->12->13->14 (neu, physisch begangen und
    // verifiziert, siehe "markers (newTags_16).json") ----
    // Verifizierte Handlungen: 11->12 geradeaus, 12->13 rechts abbiegen,
    // 13->14 geradeaus. Tag 14 ist das tatsaechliche Ende des Buerobereichs.
    { from:11, to:12,
      found:
        "Orientierungspunkt gefunden: Malte. Gehen Sie weiter geradeaus.",
      reached:
        "Sie sind bei Malte. Gehen Sie weiter geradeaus.",
      searchHint:
        "Bewegen Sie das Smartphone langsam nach links und rechts und suchen Sie die " +
        "Markierung bei Malte, geradeaus im Korridor.",
      departureAction: "continue-straight",
      locationDescription:
        "Sie befinden sich zwischen dem Ende des Korridors und dem Büro von Malte." },

    { from:12, to:13,
      found:
        "Orientierungspunkt gefunden: Müggelsee.",
      reached:
        "Sie sind bei Malte. Biegen Sie rechts ab.",
      searchHint:
        "Nach dem Rechtsabbiegen: halten Sie das Smartphone gerade vor sich und " +
        "bewegen Sie es langsam nach links und rechts, bis die nächste Markierung " +
        "erkannt wird.",
      departureAction: "turn-right",
      locationDescription:
        "Sie befinden sich zwischen dem Büro von Malte und Müggelsee." },

    { from:13, to:14,
      found:
        "Orientierungspunkt gefunden: Ende des Büros. Gehen Sie weiter geradeaus.",
      reached:
        "Sie sind bei Müggelsee. Gehen Sie weiter geradeaus.",
      searchHint:
        "Bewegen Sie das Smartphone langsam nach links und rechts und suchen Sie die " +
        "Markierung am Ende des Büros, geradeaus voraus.",
      departureAction: "continue-straight",
      locationDescription:
        "Sie befinden sich zwischen Müggelsee und dem Ende des Büros." },

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
      departureAction: "continue-straight",
      locationDescription:
        "Sie befinden sich zwischen dem Büro von Martin und Tischtennis." },

    // ---- Rueckwaerts-Experiment 11->10->8->7->4->6->3 (neu) ----
    // Bestaetigt: die gesamte Strecke von Tag 11 bis Tag 3 verlaeuft geradeaus,
    // keine Abbiegung noetig -- departureAction daher fuer alle sechs Kanten
    // "continue-straight" (bei 8->7 zusaetzlich ausdruecklich vor Ort bestaetigt;
    // die Lage von Tag 8 an einer Ecke des Grundrisses ist dabei KEIN Hinweis auf
    // ein Abbiegen). found/reached/searchHint bleiben bewusst knapp und ohne
    // Orientierungspunkt-Namen -- Ziel dieses Experiments ist, den Graph-Ablauf
    // auf einer durchgehend geraden Strecke zu beobachten, nicht jede
    // Zwischenmarkierung anzusagen. Betrifft ausschliesslich dieses Experiment;
    // Tag 1, Tag 2 und die Kante 4->5 sind bewusst NICHT gespiegelt.
    //
    // Rueckweg 14->13->12->11 (neu, physisch begangen und verifiziert):
    // verifizierte Handlungen 14->13 geradeaus, 13->12 links abbiegen,
    // 12->11 geradeaus (exaktes Spiegelbild von 11->12/12->13/13->14 oben).
    // Ab Tag 11 setzt sich der Rueckweg unveraendert ueber die bereits
    // bestehende Kante 11->10 fort -- keine weitere neue Kante noetig.
    { from:14, to:13,
      found: "Gehen Sie weiter geradeaus.",
      reached: "Gehen Sie weiter geradeaus.",
      searchHint:
        "Bewegen Sie das Smartphone langsam nach links und rechts und suchen Sie " +
        "die nächste Markierung.",
      departureAction: "continue-straight",
      locationDescription:
        "Sie befinden sich zwischen dem Ende des Büros und Müggelsee." },

    { from:13, to:12,
      found: "Nächster Punkt gefunden.",
      reached: "Biegen Sie links ab.",
      searchHint:
        "Bewegen Sie das Smartphone langsam nach links und rechts und suchen Sie " +
        "die nächste Markierung.",
      departureAction: "turn-left",
      locationDescription:
        "Sie befinden sich zwischen Müggelsee und dem Büro von Malte." },

    { from:12, to:11,
      found: "Gehen Sie weiter geradeaus.",
      reached: "Gehen Sie weiter geradeaus.",
      searchHint:
        "Bewegen Sie das Smartphone langsam nach links und rechts und suchen Sie " +
        "die nächste Markierung.",
      departureAction: "continue-straight",
      locationDescription:
        "Sie befinden sich zwischen dem Büro von Malte und dem Ende des Korridors." },

    { from:11, to:10,
      found: "Gehen Sie weiter geradeaus.",
      reached: "Gehen Sie weiter geradeaus.",
      searchHint:
        "Bewegen Sie das Smartphone langsam nach links und rechts und suchen Sie " +
        "die nächste Markierung.",
      departureAction: "continue-straight",
      locationDescription:
        "Sie befinden sich im Korridor zwischen dem Ende des Korridors und dem " +
        "Drucker." },

    { from:10, to:8,
      found: "Gehen Sie weiter geradeaus.",
      reached: "Gehen Sie weiter geradeaus.",
      searchHint:
        "Bewegen Sie das Smartphone langsam nach links und rechts und suchen Sie " +
        "die nächste Markierung.",
      departureAction: "continue-straight",
      locationDescription:
        "Sie befinden sich im Korridor zwischen dem Drucker und der Ecke." },

    { from:8, to:7,
      found: "Gehen Sie weiter geradeaus.",
      reached: "Gehen Sie weiter geradeaus.",
      searchHint:
        "Bewegen Sie das Smartphone langsam nach links und rechts und suchen Sie " +
        "die nächste Markierung.",
      departureAction: "continue-straight",
      locationDescription:
        "Sie befinden sich im Korridor zwischen der Ecke und dem Büro von Leonie." },

    { from:7, to:4,
      found: "Gehen Sie weiter geradeaus.",
      reached: "Gehen Sie weiter geradeaus.",
      searchHint:
        "Bewegen Sie das Smartphone langsam nach links und rechts und suchen Sie " +
        "die nächste Markierung.",
      departureAction: "continue-straight",
      locationDescription:
        "Sie befinden sich im Korridor zwischen dem Büro von Leonie und dem " +
        "Büro von Martin." },

    { from:4, to:6,
      found: "Gehen Sie weiter geradeaus.",
      reached: "Gehen Sie weiter geradeaus.",
      searchHint:
        "Bewegen Sie das Smartphone langsam nach links und rechts und suchen Sie " +
        "die nächste Markierung.",
      departureAction: "continue-straight",
      locationDescription:
        "Sie befinden sich zwischen dem Büro von Martin und dem Korridor." },

    // Tag 3 ist das Ziel, WENN die Route dort endet (findPath(11,3)):
    // reachPoint() prueft reachedTagId === destinationId VOR jedem Zugriff auf
    // edge.reached (siehe nav.js) -- das "reached" hier wird in diesem Fall NIE
    // gesprochen, stattdessen ARRIVALS[3]. Fuehrt die Route weiter (findPath(11,16),
    // neu), ist Tag 3 nur ein Zwischen-Tag und die naechste ausgehende Kante
    // (3->15) entscheidet ueber die Ansage. "reached" bleibt in beiden Faellen
    // non-leer (von validateGraph() verlangt) und absichtlich neutral.
    { from:6, to:3,
      found: "Gehen Sie weiter geradeaus.",
      reached: "Gehen Sie weiter geradeaus.",
      searchHint:
        "Bewegen Sie das Smartphone langsam nach links und rechts und suchen Sie " +
        "die nächste Markierung.",
      departureAction: "continue-straight",
      locationDescription:
        "Sie befinden sich zwischen dem Korridor und dem Flexbüro." },

    // ---- Rueckwaerts-Route-Erweiterung 3->15->16 (neu) ----
    // Tag 15 ist ein reiner Wendepunkt: die Kante 3->15 selbst ist geradeaus
    // (Handlung BEI Tag 3), das Abbiegen passiert BEI Tag 15 -- daher gehoert
    // departureAction:"turn-left" zu 15->16, NICHT zu 3->15 (exakt dasselbe
    // Muster wie 1->2/2->3 oben: das Abbiegen bei Patrik gehoert zu 2->3, nicht
    // zu 1->2). Tag 16 ist das Ende dieser Rueckwaerts-Route (Ausgang) -- KEINE
    // Kante zurueck zu Tag 1 oder Tag 2, keine Verbindung/Kopie zu deren Daten.
    //
    // allowedPredecessors (neu, EINZIGE Kante mit diesem Feld): 3->15 ist
    // RICHTUNGSABHAENGIG -- nur begehbar, wenn Tag 3 gerade ueber Tag 6 erreicht
    // wurde (Rueckweg), NICHT ueber Tag 2 (Hinweg in die Bueros). findPath() in
    // graph.js wertet dieses Feld anhand des tatsaechlichen Vorgaenger-Tags im
    // jeweiligen Suchlauf aus (siehe dort); ein frischer Navigationsstart direkt
    // bei Tag 3 hat keinen widersprechenden Vorgaenger und bleibt daher erlaubt
    // (findPath(3,16) liefert weiterhin [3,15,16]). Kanten ohne dieses Feld
    // verhalten sich unveraendert wie zuvor.
    { from:3, to:15,
      found: "Gehen Sie weiter geradeaus.",
      reached: "Gehen Sie weiter geradeaus.",
      searchHint:
        "Bewegen Sie das Smartphone langsam nach links und rechts und suchen Sie " +
        "die nächste Markierung.",
      departureAction: "continue-straight",
      allowedPredecessors: [6],
      locationDescription:
        "Sie befinden sich zwischen dem Flexbüro und dem Büro von Patrik. Die Tür " +
        "zum Büro von Patrik befindet sich etwas rechts." },

    { from:15, to:16,
      found: "Nächster Punkt gefunden.",
      reached: "Biegen Sie links ab.",
      searchHint:
        "Bewegen Sie das Smartphone langsam nach links und rechts und suchen Sie " +
        "die nächste Markierung.",
      departureAction: "turn-left",
      locationDescription: "Sie befinden sich kurz vor dem Ausgang. Die Ausgangstür " +
        "befindet sich links." }
  ];

  // Ankunftsansage am ZIEL (ersetzt das reached der letzten Kante).
  var ARRIVALS = {
    2:  "Ziel erreicht. Sie sind beim Büro von Patrik. Die Tür ist links.",
    3:  "Ziel erreicht. Sie sind am Eingang Flex. Die Tür befindet sich links.",
    4:  "Ziel erreicht. Sie sind bei Martin. Der Eingang Martin liegt vor Ihnen.",
    5:  "Ziel erreicht. Sie sind bei Tischtennis. Die Küchentür befindet sich links.",
    7:  "Ziel erreicht. Sie sind bei Leonie. Die Tür befindet sich links.",
    // Essbereich (neu, Zonen-Ankunft): bewusst OHNE Bezug zur Markierung selbst
    // -- das physische Ziel ist der Tisch, nicht die Wand, an der Tag 9 haengt.
    9:  "Ziel erreicht. Sie sind im Essbereich. Der Tisch befindet sich wenige " +
        "Schritte vor Ihnen.",
    10: "Ziel erreicht. Sie sind beim Drucker.",
    11: "Ziel erreicht. Sie haben das Ende des Korridors erreicht. Die Tür befindet sich links.",
    // Buero-Erweiterung 12/13/14 (neu): Tuerseite (links/rechts) wurde fuer diese
    // drei Ziele NICHT physisch verifiziert -- bewusst ohne "Die Tür ist links/
    // rechts"-Zusatz, anders als bei 2/4/5/7/11 oben.
    12: "Ziel erreicht. Sie sind bei Malte.",
    13: "Ziel erreicht. Sie sind bei Müggelsee.",
    14: "Ziel erreicht. Sie haben das Ende des Büros erreicht.",
    // Rueckwaerts-Route-Erweiterung (neu): arriveAtDestination() stellt bei der
    // Ankunfts-Ansage KEIN "Stopp." voran (anders als reachPoint() bei einem
    // echten Zwischen-Abbiegen) -- der geforderte Wortlaut enthaelt es daher
    // hier direkt als Teil des Textes.
    16: "Stopp. Ziel erreicht. Sie befinden sich am Ausgang. Die Tür befindet sich links."
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
