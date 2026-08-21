// Minimal graph-validation suite. Protects the current, one-directional graph
// behavior (forward-only, entrance-rooted) ahead of dynamic-start and
// reverse-navigation work. Uses only node:test / node:assert/strict, no
// dependencies, no application refactoring.
//
// Does not test camera, TTS, DOM, or distance tracking.

import test from 'node:test';
import assert from 'node:assert/strict';

import { NODES, EDGES, ARRIVALS, ARRIVAL_ALIASES, START_ROUTE_OVERRIDES } from '../js/graph-data.js';
import { EDGE_MAP, ADJ, findPath, isTurnAction, departureActionSpeech,
         isArrivalTag, findPathToDestination } from '../js/graph.js';
import { SETTINGS } from '../js/config.js';

const ALLOWED_DEPARTURE_ACTIONS = ['turn-left', 'turn-right', 'continue-straight'];

const ALL_NODE_IDS = Object.keys(NODES).map(Number);
const DESTINATION_IDS = ALL_NODE_IDS.filter((id) => NODES[id].destination);

// ==================== Graph integrity ====================

test('every edge references existing nodes', () => {
  for (const e of EDGES) {
    assert.ok(NODES[e.from], `edge ${e.from}->${e.to}: unknown from-node ${e.from}`);
    assert.ok(NODES[e.to], `edge ${e.from}->${e.to}: unknown to-node ${e.to}`);
  }
});

test('every edge has a valid from and to', () => {
  for (const e of EDGES) {
    assert.equal(typeof e.from, 'number');
    assert.equal(typeof e.to, 'number');
    assert.ok(Number.isFinite(e.from), `edge has non-finite from: ${e.from}`);
    assert.ok(Number.isFinite(e.to), `edge has non-finite to: ${e.to}`);
  }
});

test('every directed edge is unique', () => {
  const seen = new Set();
  for (const e of EDGES) {
    const key = `${e.from}->${e.to}`;
    assert.ok(!seen.has(key), `duplicate edge ${key}`);
    seen.add(key);
  }
});

test('every edge has the required navigation metadata', () => {
  for (const e of EDGES) {
    const key = `${e.from}->${e.to}`;
    assert.ok(e.found, `${key}: missing found text`);
    assert.ok(e.reached, `${key}: missing reached text`);
    assert.ok(e.searchHint, `${key}: missing searchHint text`);
    assert.ok(
      ALLOWED_DEPARTURE_ACTIONS.includes(e.departureAction),
      `${key}: invalid departureAction "${e.departureAction}"`
    );
  }
});

// Replaces the old blanket "every destination reachable from Tag 1" assumption,
// which no longer holds universally: Tag 16 is a reverse-route-only destination
// by design (see the 3->15 allowedPredecessors gating above), reachable only
// from the return-approach side, never from the main entrance. Split into two
// explicit categories rather than silently dropping the original check.

test('every original (forward-route) destination remains reachable from Tag 1', () => {
  const ORIGINAL_DESTINATION_IDS = DESTINATION_IDS.filter((id) => id !== 16);
  assert.ok(ORIGINAL_DESTINATION_IDS.length > 0, 'expected at least one original destination node');
  for (const id of ORIGINAL_DESTINATION_IDS) {
    const path = findPath(1, id);
    assert.ok(path, `destination ${id} (${NODES[id].name}) is not reachable from Tag 1`);
    assert.equal(path[path.length - 1], id);
  }
});

test('Tag 16 (Ausgang) is a reverse-route-only destination, not reachable from Tag 1 or Tag 2', () => {
  assert.equal(findPath(1, 16), null);
  assert.equal(findPath(2, 16), null);
  assert.deepEqual(findPath(3, 16), [3, 15, 16]);
  assert.deepEqual(findPath(11, 16), [11, 10, 8, 7, 4, 6, 3, 15, 16]);
});

// ==================== Essbereich (Tag 9) zone destination ====================
// Replaces the old "Tag 9 stays disconnected" assumption above, which no
// longer holds: Tag 9 is now a real, physically verified destination. The
// AprilTag is mounted on a wall near the dining table, not at the table
// itself -- reaching it should not require walking all the way up to the
// wall. Verified: from Tag 4 the walking path stays straight (no real turn);
// only the camera/search direction shifts slightly left.

test('Tag 9 (Essbereich) is a selectable destination', () => {
  assert.ok(NODES[9], 'Tag 9 must exist as a node');
  assert.equal(NODES[9].destination, true);
});

test('findPath(4, 9) and findPath(1, 9) reach the Essbereich', () => {
  assert.deepEqual(findPath(4, 9), [4, 9]);
  assert.deepEqual(findPath(1, 9), [1, 2, 3, 6, 4, 9]);
});

test('edge 4->9 uses continue-straight, not turn-left -- there is no real turn in the walking path', () => {
  const edge = EDGE_MAP['4->9'];
  assert.ok(edge, 'missing edge 4->9');
  assert.equal(edge.departureAction, 'continue-straight');
  assert.equal(isTurnAction(edge), false);
});

test('edge 4->9 searchHint tells the user to scan/point the camera slightly left, not to turn', () => {
  const edge = EDGE_MAP['4->9'];
  assert.ok(edge.searchHint, 'edge 4->9 must have a searchHint');
  assert.match(edge.searchHint, /links/, 'searchHint must mention scanning left');
  assert.doesNotMatch(
    edge.searchHint,
    /biegen|abbiegen/i,
    'searchHint must describe a camera scan, not a turn instruction'
  );
});

test('edge 4->9 implements zone-destination arrival via the existing reachedM override, not a new mechanism', () => {
  const edge = EDGE_MAP['4->9'];
  assert.ok(
    typeof edge.reachedM === 'number' && edge.reachedM > SETTINGS.reachedM,
    'edge 4->9 must use a larger-than-default reachedM so arrival does not require reaching the wall-mounted marker'
  );
});

test('other existing destinations keep normal distance-based arrival (no reachedM override introduced by this change)', () => {
  const EDGES_EXPECTED_WITHOUT_REACHEDM_OVERRIDE = [
    '1->2', '2->3', '3->6', '6->4', '4->7', '7->8', '8->10', '10->11',
  ];
  for (const key of EDGES_EXPECTED_WITHOUT_REACHEDM_OVERRIDE) {
    const edge = EDGE_MAP[key];
    assert.ok(edge, `missing edge ${key}`);
    assert.equal(
      edge.reachedM,
      undefined,
      `${key} must keep using SETTINGS.reachedM (no per-edge override) -- global threshold must stay unaffected`
    );
  }
});

// Reverse edges are now intentional for the 11->3 experiment (see below), so the
// old blanket "no reverse edge pairs at all" assumption no longer holds.
// Replaced with a precise check: exactly the six edges the experiment defines
// have a reverse counterpart; the edges explicitly outside this experiment's
// scope (1->2, 2->3, 4->5 -- Tag 1, Tag 2, and the Tag 5 branch) must not.
test('only the intentional 11->3 experiment edges have a reverse counterpart', () => {
  const EXPECTED_REVERSE_PAIRS = [
    [11, 10], [10, 8], [8, 7], [7, 4], [4, 6], [6, 3],
  ];
  const OUT_OF_SCOPE_FORWARD_EDGES = [[1, 2], [2, 3], [4, 5]];

  for (const [from, to] of EXPECTED_REVERSE_PAIRS) {
    assert.ok(EDGE_MAP[`${from}->${to}`], `expected intentional reverse edge ${from}->${to} is missing`);
  }
  for (const [from, to] of OUT_OF_SCOPE_FORWARD_EDGES) {
    assert.equal(
      EDGE_MAP[`${to}->${from}`],
      undefined,
      `edge ${from}->${to} is out of scope for this experiment and must not have a reverse counterpart yet`
    );
  }
});

// Guards against the code's existing silent fallback (isTurnAction()/
// departureActionSpeech() both quietly treat a missing/unrecognized
// departureAction as non-turn / "Gehen Sie weiter geradeaus.", see graph.js) --
// this documents that behavior explicitly rather than changing it, and then
// separately proves none of the real reverse edges rely on it.
test('a missing departureAction silently resolves as non-turn -- documented, not relied upon', () => {
  const edgeWithoutAction = { from: 999, to: 998 };
  assert.equal(isTurnAction(edgeWithoutAction), false);
  assert.equal(departureActionSpeech(edgeWithoutAction), 'Gehen Sie weiter geradeaus.');
});

test('every reverse edge for the 11->3 experiment explicitly declares its own departureAction', () => {
  const REVERSE_EDGE_KEYS = ['11->10', '10->8', '8->7', '7->4', '4->6', '6->3'];
  for (const key of REVERSE_EDGE_KEYS) {
    const edge = EDGE_MAP[key];
    assert.ok(edge, `missing edge ${key}`);
    assert.ok(
      Object.prototype.hasOwnProperty.call(edge, 'departureAction'),
      `${key}: departureAction must be explicitly present, not silently defaulted`
    );
    assert.ok(
      ALLOWED_DEPARTURE_ACTIONS.includes(edge.departureAction),
      `${key}: invalid departureAction "${edge.departureAction}"`
    );
  }
});

// ==================== Current forward routes ====================
// Expected arrays derived by hand-tracing findPath()'s BFS against the current
// EDGES/ADJ (see the report preceding this file's creation).

// Tischtennis-Korrektur (neu): a field test found the previous direct edge
// 4->5 was physically unwalkable -- the real path continues straight from
// Tag 4 to Tag 7, then turns right toward Tag 5 (see edge 7->5).
const FORWARD_ROUTES = [
  { from: 1, to: 5, expected: [1, 2, 3, 6, 4, 7, 5] },
  { from: 1, to: 11, expected: [1, 2, 3, 6, 4, 7, 8, 10, 11] },
  { from: 2, to: 5, expected: [2, 3, 6, 4, 7, 5] },
  { from: 2, to: 11, expected: [2, 3, 6, 4, 7, 8, 10, 11] },
  { from: 4, to: 5, expected: [4, 7, 5] },
  { from: 4, to: 11, expected: [4, 7, 8, 10, 11] },
];

for (const { from, to, expected } of FORWARD_ROUTES) {
  test(`findPath(${from}, ${to}) returns the exact current path`, () => {
    assert.deepEqual(findPath(from, to), expected);
  });
}

// ==================== Current known limitations ====================
// Documents today's one-directional graph as expected behavior, not as bugs.
// These assertions are meant to change in a later commit once reverse edges
// are added.

test('findPath(5, 1) returns null -- no reverse edges exist yet', () => {
  assert.equal(findPath(5, 1), null);
});

test('findPath(11, 1) returns null -- no reverse edges exist yet', () => {
  assert.equal(findPath(11, 1), null);
});

test('findPath(5, 11) returns null -- no cross-branch edges exist yet', () => {
  assert.equal(findPath(5, 11), null);
});

// findPath(11, 5) moved below to "Reverse-experiment route and side effects" --
// it no longer returns null once the 11->3 reverse edges exist (expected
// consequence of reconnecting Tag 4, not a limitation of this list).

test('a node has a path to itself containing that node only', () => {
  for (const id of ALL_NODE_IDS) {
    assert.deepEqual(findPath(id, id), [id]);
  }
});

// ==================== Reverse-experiment route (11->3) ====================
// The only approved experimental route right now. All six departureAction
// values are field-verified as "continue-straight" (including at Tag 8,
// confirmed explicitly, not inferred from its position at a corner).

const REVERSE_EXPERIMENT_ROUTE = { from: 11, to: 3, expected: [11, 10, 8, 7, 4, 6, 3] };

test('findPath(11, 3) returns the exact approved reverse-experiment path', () => {
  assert.deepEqual(
    findPath(REVERSE_EXPERIMENT_ROUTE.from, REVERSE_EXPERIMENT_ROUTE.to),
    REVERSE_EXPERIMENT_ROUTE.expected
  );
});

test('the reverse-experiment route does not include Tag 1 or Tag 2', () => {
  const path = findPath(11, 3);
  assert.ok(!path.includes(1), 'route must not include Tag 1 (out of scope)');
  assert.ok(!path.includes(2), 'route must not include Tag 2 (out of scope)');
});

test('every segment of the reverse-experiment route exists in EDGE_MAP', () => {
  const path = REVERSE_EXPERIMENT_ROUTE.expected;
  for (let i = 0; i < path.length - 1; i++) {
    const key = `${path[i]}->${path[i + 1]}`;
    assert.ok(EDGE_MAP[key], `missing edge metadata for segment ${key}`);
  }
});

test('reverse-experiment route 11->3: every segment has valid edge metadata', () => {
  const path = REVERSE_EXPERIMENT_ROUTE.expected;
  for (let i = 0; i < path.length - 1; i++) {
    const key = `${path[i]}->${path[i + 1]}`;
    const edge = EDGE_MAP[key];
    assert.ok(edge, `missing edge metadata for segment ${key}`);
    assert.ok(
      ALLOWED_DEPARTURE_ACTIONS.includes(edge.departureAction),
      `segment ${key} has invalid departureAction "${edge.departureAction}"`
    );

    const spoken = departureActionSpeech(edge);
    assert.equal(typeof spoken, 'string');
    assert.ok(spoken.length > 0, `segment ${key} produced empty spoken text`);

    const expectedIsTurn = edge.departureAction !== 'continue-straight';
    assert.equal(
      isTurnAction(edge),
      expectedIsTurn,
      `segment ${key}: isTurnAction() disagreed with departureAction "${edge.departureAction}"`
    );
  }
});

// ==================== Tischtennis-Korrektur: the former Tag-4 reconnection ====================
// ==================== side effect, and the later approved Tag-8 reverse approach ====================
// This section previously documented an OPEN, unfixed side effect: the six
// reverse edges above reconnect Tag 4 from the reverse direction, and since
// findPath()/ADJ had no concept of "arrival direction", the old direct edge
// 4->5 became traversable from Tags 11/10/8/7 too -- using departureAction/
// searchHint text that was never physically verified for that direction.
//
// The field test that produced the 7->5 correction above resolved this at
// the root: edge 4->5 no longer exists at all (it was physically invalid --
// see the 7->5 comment), and its replacement, 7->5, originally carried
// allowedPredecessors: [4] only. A later, separately field-verified and
// approved requirement (free-corridor-routing) explicitly added Tag 8 as a
// second allowed predecessor -- the office-extension reverse chain
// (11->10->8->7) now DOES reach Tag 5, but with different, physically
// verified guidance ("walk a few steps straight, THEN turn left") owned
// entirely by nav.js's Tag7Via8Flow, not by this edge's own
// departureAction/searchHint text (unchanged, Tag-4-approach only -- see
// nav.js tests for the staged-flow speech sequence).

test('findPath(11, 5), findPath(10, 5), findPath(8, 5): reachable via the approved Tag-8 reverse approach (staged flow, see nav.js tests for its speech)', () => {
  assert.deepEqual(findPath(11, 5), [11, 10, 8, 7, 5]);
  assert.deepEqual(findPath(10, 5), [10, 8, 7, 5]);
  assert.deepEqual(findPath(8, 5), [8, 7, 5]);
});

test('findPath(7, 5): a fresh start at Tag 7 has no contradicting predecessor, so the verified 7->5 turn remains available', () => {
  assert.deepEqual(findPath(7, 5), [7, 5]);
});

test('edge 7->5 carries the verified right-turn semantics', () => {
  const edge = EDGE_MAP['7->5'];
  assert.ok(edge, 'missing edge 7->5');
  assert.equal(edge.departureAction, 'turn-right');
  assert.equal(isTurnAction(edge), true);
  assert.equal(departureActionSpeech(edge), 'Biegen Sie rechts ab.');
});

test('edge 7->8 (toward the corner/Drucker/end-of-corridor branch) is unaffected by the new 7->5 turn', () => {
  const edge = EDGE_MAP['7->8'];
  assert.ok(edge, 'missing edge 7->8');
  assert.equal(edge.departureAction, 'continue-straight');
  assert.equal(isTurnAction(edge), false);
});

test('edge 7->5 uses its own smaller arrival threshold (reachedM: 1.0), not the global SETTINGS.reachedM', () => {
  const edge = EDGE_MAP['7->5'];
  assert.equal(edge.reachedM, 1.0);
  assert.ok(edge.reachedM < SETTINGS.reachedM, 'the Tag 5 approach must use a smaller-than-default threshold');
});

// These two reuse only the two already field-verified edges (4->6, 6->3) --
// unlike the Tag-5 case above, the edge DATA itself is verified
// (continue-straight, confirmed). These paths are newly reachable because they
// use the newly added reverse edges relative to the original forward route
// (Tag 3 was previously only reachable from Tags 1/2, never from Tag 4 or
// Tag 6). What's undesigned here is using Tag 4 or Tag 6 as an ad-hoc start
// point outside the specific Tag-11-start experiment -- documented as a new
// capability, not a content-verification risk.

test('findPath(4, 3): newly reachable path toward Tag 3 via reverse edges', () => {
  assert.deepEqual(findPath(4, 3), [4, 6, 3]);
});

test('findPath(6, 3): newly reachable path toward Tag 3 via reverse edge', () => {
  assert.deepEqual(findPath(6, 3), [6, 3]);
});

// ==================== Reverse-route extension 3->15->16 ====================
// Extends the already-approved 11->3 reverse-experiment route with two new
// logical nodes: Tag 15 (a pure turning point, not itself a destination) and
// Tag 16 (the actual end of this reverse route -- "Ausgang" -- with no edge
// back to Tag 1 or Tag 2). Per the existing "the turn belongs to the edge
// LEAVING the just-reached tag" convention (see 1->2/2->3 above), the
// left-turn action lives on edge 15->16, spoken when Tag 15 is reached --
// NOT on 3->15, which stays continue-straight.
//
// 3->15 is direction-dependent: it only exists for arrival at Tag 3 via
// Tag 6 (the return approach), not via Tag 2 (the forward route into the
// office) -- enforced by EDGE_MAP['3->15'].allowedPredecessors and the
// (previousTag, currentTag)-aware findPath() in graph.js. A fresh navigation
// start directly at Tag 3 has no contradicting predecessor and remains
// allowed.

const EXTENDED_REVERSE_ROUTE = { from: 11, to: 16, expected: [11, 10, 8, 7, 4, 6, 3, 15, 16] };

test('findPath(11, 16) returns the exact extended reverse-experiment path', () => {
  assert.deepEqual(
    findPath(EXTENDED_REVERSE_ROUTE.from, EXTENDED_REVERSE_ROUTE.to),
    EXTENDED_REVERSE_ROUTE.expected
  );
});

test('findPath(3, 16) returns the local turn-point path (fresh start, no predecessor)', () => {
  assert.deepEqual(findPath(3, 16), [3, 15, 16]);
});

test('findPath(6, 16) returns the path via the allowed Tag-6 arrival at Tag 3', () => {
  assert.deepEqual(findPath(6, 16), [6, 3, 15, 16]);
});

test('findPath(4, 16) returns the path via Tag 6 reaching the allowed arrival at Tag 3', () => {
  assert.deepEqual(findPath(4, 16), [4, 6, 3, 15, 16]);
});

test('the extended reverse-experiment route does not include Tag 1 or Tag 2', () => {
  const path = findPath(11, 16);
  assert.ok(!path.includes(1), 'route must not include Tag 1 (out of scope)');
  assert.ok(!path.includes(2), 'route must not include Tag 2 (out of scope)');
});

test('EDGE_MAP contains the new 3->15 and 15->16 segments', () => {
  assert.ok(EDGE_MAP['3->15'], 'missing edge metadata for 3->15');
  assert.ok(EDGE_MAP['15->16'], 'missing edge metadata for 15->16');
});

test('the edge leaving Tag 15 (15->16) uses the existing left-turn action', () => {
  const edge = EDGE_MAP['15->16'];
  assert.equal(edge.departureAction, 'turn-left');
  assert.equal(isTurnAction(edge), true);
  assert.equal(departureActionSpeech(edge), 'Biegen Sie links ab.');
});

test('Tag 16 has the exact requested arrival text', () => {
  assert.equal(
    ARRIVALS[16],
    'Stopp. Ziel erreicht. Sie befinden sich am Ausgang. Die Tür befindet sich links.'
  );
});

test('Tag 16 is a selectable destination; Tag 15 is not', () => {
  assert.equal(NODES[16].destination, true);
  assert.equal(NODES[15].destination, false);
});

// ==================== Büro-Erweiterung 11->12->13->14 ====================
// Extends the corridor past Tag 11 with three physically walked and verified
// tags (measured via "markers (newTags_16).json"): Tag 11 is no longer a dead
// end -- it now has a real successor. Replaces the old blanket "12/13/14 stay
// disconnected" assumption above, which no longer holds (mirrors how the
// Tag 16 test above replaced the old "every destination reachable" blanket
// check when Tag 16 was added).

test('Tags 12, 13, and 14 exist and are selectable destinations, like the other named offices', () => {
  for (const id of [12, 13, 14]) {
    assert.ok(NODES[id], `Tag ${id} must exist as a node`);
    assert.equal(NODES[id].destination, true, `Tag ${id} must be a selectable destination`);
  }
});

test('findPath(11, 14) reaches the office extension in the physically verified order', () => {
  assert.deepEqual(findPath(11, 14), [11, 12, 13, 14]);
});

test('findPath(14, 11) returns via the physically verified reverse order', () => {
  assert.deepEqual(findPath(14, 11), [14, 13, 12, 11]);
});

test('the six new Büro-Erweiterung edges use exactly the physically verified departureAction', () => {
  const EXPECTED_ACTIONS = {
    '11->12': 'continue-straight',
    '12->13': 'turn-right',
    '13->14': 'continue-straight',
    '14->13': 'continue-straight',
    // Feldtest-Korrektur: die Ecke liegt bei Tag 12, nicht bei Tag 13 -- siehe
    // graph-data.js.
    '13->12': 'continue-straight',
    '12->11': 'turn-left',
  };
  for (const key of Object.keys(EXPECTED_ACTIONS)) {
    const edge = EDGE_MAP[key];
    assert.ok(edge, `missing edge ${key}`);
    assert.equal(
      edge.departureAction,
      EXPECTED_ACTIONS[key],
      `${key}: expected departureAction "${EXPECTED_ACTIONS[key]}"`
    );
  }
});

test('Tag 14 (Ende des Büros) is reachable from Tag 1, continuing straight past Tag 11', () => {
  assert.deepEqual(findPath(1, 14), [1, 2, 3, 6, 4, 7, 8, 10, 11, 12, 13, 14]);
});

test('a route starting at Tag 14 travels back through Tags 13/12/11 and then the existing reverse graph to the exit', () => {
  assert.deepEqual(findPath(14, 16), [14, 13, 12, 11, 10, 8, 7, 4, 6, 3, 15, 16]);
});

// Tischtennis-Korrektur / free-corridor-routing: this path was unreachable
// after 4->5 was removed (7->5 was gated to arrival via Tag 4 only), and was
// later, separately, explicitly approved and re-enabled for the Tag-8 reverse
// approach (see the 7->5 edge comment and nav.js's Tag7Via8Flow).
test('findPath(14, 5): reachable via the approved Tag-8 reverse approach (office-extension chain)', () => {
  assert.deepEqual(findPath(14, 5), [14, 13, 12, 11, 10, 8, 7, 5]);
});

test('office-extension route (11->12->13->14): every segment has valid edge metadata', () => {
  const path = [11, 12, 13, 14];
  for (let i = 0; i < path.length - 1; i++) {
    const key = `${path[i]}->${path[i + 1]}`;
    const edge = EDGE_MAP[key];
    assert.ok(edge, `missing edge metadata for segment ${key}`);
    assert.ok(
      ALLOWED_DEPARTURE_ACTIONS.includes(edge.departureAction),
      `segment ${key} has invalid departureAction "${edge.departureAction}"`
    );

    const spoken = departureActionSpeech(edge);
    assert.equal(typeof spoken, 'string');
    assert.ok(spoken.length > 0, `segment ${key} produced empty spoken text`);

    const expectedIsTurn = edge.departureAction !== 'continue-straight';
    assert.equal(
      isTurnAction(edge),
      expectedIsTurn,
      `segment ${key}: isTurnAction() disagreed with departureAction "${edge.departureAction}"`
    );
  }
});

test('reverse office-extension route (14->13->12->11): every segment has valid edge metadata', () => {
  const path = [14, 13, 12, 11];
  for (let i = 0; i < path.length - 1; i++) {
    const key = `${path[i]}->${path[i + 1]}`;
    const edge = EDGE_MAP[key];
    assert.ok(edge, `missing edge metadata for segment ${key}`);
    assert.ok(
      ALLOWED_DEPARTURE_ACTIONS.includes(edge.departureAction),
      `segment ${key} has invalid departureAction "${edge.departureAction}"`
    );

    const spoken = departureActionSpeech(edge);
    assert.equal(typeof spoken, 'string');
    assert.ok(spoken.length > 0, `segment ${key} produced empty spoken text`);

    const expectedIsTurn = edge.departureAction !== 'continue-straight';
    assert.equal(
      isTurnAction(edge),
      expectedIsTurn,
      `segment ${key}: isTurnAction() disagreed with departureAction "${edge.departureAction}"`
    );
  }
});

test('extended reverse-experiment route 11->16: every segment has valid edge metadata', () => {
  const path = EXTENDED_REVERSE_ROUTE.expected;
  for (let i = 0; i < path.length - 1; i++) {
    const key = `${path[i]}->${path[i + 1]}`;
    const edge = EDGE_MAP[key];
    assert.ok(edge, `missing edge metadata for segment ${key}`);
    assert.ok(
      ALLOWED_DEPARTURE_ACTIONS.includes(edge.departureAction),
      `segment ${key} has invalid departureAction "${edge.departureAction}"`
    );

    const spoken = departureActionSpeech(edge);
    assert.equal(typeof spoken, 'string');
    assert.ok(spoken.length > 0, `segment ${key} produced empty spoken text`);

    const expectedIsTurn = edge.departureAction !== 'continue-straight';
    assert.equal(
      isTurnAction(edge),
      expectedIsTurn,
      `segment ${key}: isTurnAction() disagreed with departureAction "${edge.departureAction}"`
    );
  }
});

// ==================== Direction-dependent 3->15: predecessor gating ====================
// Tag 3 is reachable via two structurally different predecessors -- Tag 2
// (the forward route into the office) and Tag 6 (the return approach).
// Continuing on to Tag 15 must only be allowed for the Tag-6 arrival. This
// proves the (previousTag, currentTag) state distinction actually works, not
// just that the six required routes happen to resolve correctly.

test('EDGE_MAP[3->15] is gated to arrival via Tag 6 only', () => {
  const edge = EDGE_MAP['3->15'];
  assert.deepEqual(edge.allowedPredecessors, [6]);
});

test('Tag 3 is reachable via both Tag 2 and Tag 6, but only the Tag-6 arrival may continue to Tag 15/16', () => {
  // Same destination node (3), reached via two different predecessor states.
  assert.deepEqual(findPath(2, 3), [2, 3]);
  assert.deepEqual(findPath(6, 3), [6, 3]);

  // Only the arrival via Tag 6 is allowed to continue toward Tag 15/16.
  assert.equal(findPath(1, 16), null, 'arrival at Tag 3 via Tag 2 must not reach Tag 15/16');
  assert.equal(findPath(2, 16), null, 'arrival at Tag 3 via Tag 2 must not reach Tag 15/16');
  assert.deepEqual(findPath(6, 16), [6, 3, 15, 16], 'arrival at Tag 3 via Tag 6 must reach Tag 15/16');
});

test('the extended route does not become reachable from Tag 1 or Tag 2 (direction-gated, not just distance-gated)', () => {
  assert.equal(findPath(1, 16), null);
  assert.equal(findPath(2, 16), null);
});

// findPath(1, 16) must not "escape" the Tag-2 predecessor restriction by
// looping back through Tag 6 to Tag 3 a second time under a different
// predecessor state (the path [1,2,3,6,3,15,16] revisits Tag 3 and is not a
// valid navigation route -- see nodeAlreadyOnPath() in graph.js). This is the
// specific scenario that guard exists to prevent, checked explicitly rather
// than only implied by the null assertions above.
test('findPath(1, 16) does not escape via 1->2->3->6->3->15->16 (no route may revisit a tag)', () => {
  const path = findPath(1, 16);
  assert.equal(path, null, 'must not find any route, looping or otherwise, from Tag 1 to Tag 16');
});

// ==================== Cycle safety of the (previousTag, currentTag) traversal ====================
// Tag 3 and Tag 6 are now connected in both directions (3->6 forward, 6->3
// reverse), a genuine cycle at the node level. The pair-keyed seen state alone
// already guarantees findPath() terminates (the state space is bounded by the
// number of edges); nodeAlreadyOnPath() additionally guarantees every
// RETURNED route is a simple path that never revisits the same tag, checked
// here across every reachable pair in the whole graph, not just the pairs
// already covered by name above.

test('findPath() returns only simple (non-repeating) paths for every reachable node pair in the whole graph', () => {
  for (const from of ALL_NODE_IDS) {
    for (const to of ALL_NODE_IDS) {
      const path = findPath(from, to);
      if (path === null) continue;
      const unique = new Set(path);
      assert.equal(
        unique.size,
        path.length,
        `findPath(${from}, ${to}) = [${path.join(', ')}] repeats a tag`
      );
    }
  }
});

// ==================== Safety metadata ====================
// For every segment of the current canonical routes: the edge must exist,
// its departureAction must be a known value, and isTurnAction()/
// departureActionSpeech() must resolve from that value rather than silently
// falling back for a missing or unrecognized one.

for (const { from, to, expected: path } of FORWARD_ROUTES) {
  test(`route ${from}->${to} (${path.join('->')}): every segment has valid edge metadata`, () => {
    for (let i = 0; i < path.length - 1; i++) {
      const key = `${path[i]}->${path[i + 1]}`;
      const edge = EDGE_MAP[key];
      assert.ok(edge, `missing edge metadata for segment ${key}`);
      assert.ok(
        ALLOWED_DEPARTURE_ACTIONS.includes(edge.departureAction),
        `segment ${key} has invalid departureAction "${edge.departureAction}"`
      );

      const spoken = departureActionSpeech(edge);
      assert.equal(typeof spoken, 'string');
      assert.ok(spoken.length > 0, `segment ${key} produced empty spoken text`);

      const expectedIsTurn = edge.departureAction !== 'continue-straight';
      assert.equal(
        isTurnAction(edge),
        expectedIsTurn,
        `segment ${key}: isTurnAction() disagreed with departureAction "${edge.departureAction}"`
      );
    }
  });
}

// ==================== free-corridor-routing: Tag 2 / Tag 15 start area ====================
// No graph edge changes were made for this feature (no 2->16 edge, no 3->15
// allowedPredecessors relaxation) -- these tests guard that invariant directly,
// plus the two new small mechanisms added in graph.js/graph-data.js:
// ARRIVAL_ALIASES/isArrivalTag/findPathToDestination (Patrik's alternate physical
// arrival marker) and START_ROUTE_OVERRIDES (a start-only, non-graph route,
// consumed exclusively by nav.js's onStartTagConfirmed(), never by findPath()).

test('Tag 2 already reaches every main-office destination directly, with no graph change needed', () => {
  assert.deepEqual(findPath(2, 7), [2, 3, 6, 4, 7]);
  assert.deepEqual(findPath(2, 14), [2, 3, 6, 4, 7, 8, 10, 11, 12, 13, 14]);
});

test('no graph edge 2->16 exists, and 1->16/2->16 remain unreachable via findPath()', () => {
  assert.equal(EDGE_MAP['2->16'], undefined, 'must not have added a 2->16 edge');
  assert.ok(!(ADJ[2] || []).includes(16), 'ADJ[2] must not include 16');
  assert.equal(findPath(1, 16), null, 'must remain unreachable -- no 3->15 allowedPredecessors relaxation');
  assert.equal(findPath(2, 16), null, 'must remain unreachable via the graph -- Tag2->16 is a start-only override, not an edge');
});

test('EDGE_MAP[3->15] is still gated to arrival via Tag 6 only (not relaxed to include Tag 2)', () => {
  const edge = EDGE_MAP['3->15'];
  assert.deepEqual(edge.allowedPredecessors, [6]);
});

test('isArrivalTag: plain identity match and the Patrik alias (Tag 15 for destination 2)', () => {
  assert.equal(isArrivalTag(2, 2), true);
  assert.equal(isArrivalTag(15, 2), true);
  assert.equal(isArrivalTag(15, 7), false, 'the alias must never match a non-Patrik destination');
  assert.equal(isArrivalTag(2, 16), false);
});

test('findPathToDestination: direct hit for Patrik from the entrance side', () => {
  const result = findPathToDestination(1, 2);
  assert.deepEqual(result, { path: [1, 2], arrivalTagId: 2 });
});

test('findPathToDestination: alias fallback to Tag 15 for every reverse-side start toward Patrik', () => {
  for (const start of [14, 13, 12, 11, 10, 8, 7, 6, 4, 3]) {
    const result = findPathToDestination(start, 2);
    assert.ok(result, `expected an alias-fallback path for start ${start}`);
    assert.equal(result.arrivalTagId, 15, `start ${start}: expected the path to terminate at the alias (15)`);
    assert.equal(result.path[result.path.length - 1], 15);
  }
});

test('findPathToDestination: returns null when neither the direct destination nor its alias is reachable', () => {
  assert.equal(findPathToDestination(9, 2), null, 'Tag 9 (dead-end office) cannot reach 2 or its alias 15');
});

test('ARRIVAL_ALIASES has exactly one entry (Patrik only) -- no unintended overreach', () => {
  assert.deepEqual(ARRIVAL_ALIASES, { 2: 15 });
});

test('START_ROUTE_OVERRIDES has exactly the approved Tag2->16 entry, with the approved wording', () => {
  assert.deepEqual(Object.keys(START_ROUTE_OVERRIDES), ['2']);
  assert.deepEqual(Object.keys(START_ROUTE_OVERRIDES[2]), ['16']);
  const override = START_ROUTE_OVERRIDES[2][16];
  assert.deepEqual(override.path, [2, 16]);
  assert.equal(override.startText, 'Drehen Sie sich um und halten Sie das Smartphone gerade vor sich.');
  assert.equal(override.postTurnConfirmationText, 'Die Richtung stimmt. Halten Sie das Smartphone gerade vor sich.');
});
