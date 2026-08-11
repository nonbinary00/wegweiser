// Minimal graph-validation suite. Protects the current, one-directional graph
// behavior (forward-only, entrance-rooted) ahead of dynamic-start and
// reverse-navigation work. Uses only node:test / node:assert/strict, no
// dependencies, no application refactoring.
//
// Does not test camera, TTS, DOM, or distance tracking.

import test from 'node:test';
import assert from 'node:assert/strict';

import { NODES, EDGES, ARRIVALS } from '../js/graph-data.js';
import { EDGE_MAP, findPath, isTurnAction, departureActionSpeech } from '../js/graph.js';
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
    '1->2', '2->3', '3->6', '6->4', '4->7', '7->8', '8->10', '10->11', '4->5',
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

const FORWARD_ROUTES = [
  { from: 1, to: 5, expected: [1, 2, 3, 6, 4, 5] },
  { from: 1, to: 11, expected: [1, 2, 3, 6, 4, 7, 8, 10, 11] },
  { from: 2, to: 5, expected: [2, 3, 6, 4, 5] },
  { from: 2, to: 11, expected: [2, 3, 6, 4, 7, 8, 10, 11] },
  { from: 4, to: 5, expected: [4, 5] },
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

// ==================== Side effects of reconnecting Tag 4 (documented, not fixed) ====================
// The six reverse edges above reconnect Tag 4 -- a branch point in the forward
// graph -- from the reverse direction. findPath()/ADJ have no concept of
// "arrival direction", so the ORIGINAL, untouched edge 4->5 becomes traversable
// from this new reverse side too. This is an EXPECTED CONSEQUENCE of the graph
// shape, not a BFS bug, and is deliberately left as-is (not guarded, not
// disabled, not given predecessor-dependent metadata) pending a graph-design
// decision -- see the implementation report for options.
//
// SAFETY: these Tag-5 paths are mathematically reachable right now, but the
// 4->5 edge's departureAction/searchHint/ARRIVALS text were authored assuming
// arrival at Tag 4 via Tag 6 (the original forward direction) and have NOT
// been physically verified for arrival via Tag 7 (this reverse experiment).
// These paths MUST NOT be used in the current field experiment. The only
// approved experimental route remains 11->10->8->7->4->6->3 above.

test(
  'findPath(11, 5): reachable via the reconnected Tag 4 branch -- NOT approved for use, unverified 4->5 instruction',
  () => {
    assert.deepEqual(findPath(11, 5), [11, 10, 8, 7, 4, 5]);
  }
);

test(
  'findPath(10, 5): reachable via the same reconnected branch -- NOT approved for use',
  () => {
    assert.deepEqual(findPath(10, 5), [10, 8, 7, 4, 5]);
  }
);

test(
  'findPath(8, 5): reachable via the same reconnected branch -- NOT approved for use',
  () => {
    assert.deepEqual(findPath(8, 5), [8, 7, 4, 5]);
  }
);

test(
  'findPath(7, 5): reachable via the same reconnected branch -- NOT approved for use',
  () => {
    assert.deepEqual(findPath(7, 5), [7, 4, 5]);
  }
);

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
    '13->12': 'turn-left',
    '12->11': 'continue-straight',
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

test(
  'findPath(14, 5): reachable via the same already-documented Tag-4 reconnection side effect -- NOT approved for use',
  () => {
    assert.deepEqual(findPath(14, 5), [14, 13, 12, 11, 10, 8, 7, 4, 5]);
  }
);

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
