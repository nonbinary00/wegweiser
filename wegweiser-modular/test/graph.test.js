// Minimal graph-validation suite. Protects the current, one-directional graph
// behavior (forward-only, entrance-rooted) ahead of dynamic-start and
// reverse-navigation work. Uses only node:test / node:assert/strict, no
// dependencies, no application refactoring.
//
// Does not test camera, TTS, DOM, or distance tracking.

import test from 'node:test';
import assert from 'node:assert/strict';

import { NODES, EDGES } from '../js/graph-data.js';
import { EDGE_MAP, findPath, isTurnAction, departureActionSpeech } from '../js/graph.js';

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

test('every selectable destination is reachable from Tag 1', () => {
  assert.ok(DESTINATION_IDS.length > 0, 'expected at least one destination node');
  for (const id of DESTINATION_IDS) {
    const path = findPath(1, id);
    assert.ok(path, `destination ${id} (${NODES[id].name}) is not reachable from Tag 1`);
    assert.equal(path[path.length - 1], id);
  }
});

test('Tag 9 is disconnected from route edges and is not selectable', () => {
  assert.equal(NODES[9].destination, false);
  const referencesTag9 = EDGES.some((e) => e.from === 9 || e.to === 9);
  assert.equal(referencesTag9, false, 'Tag 9 must not appear in any route edge');
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
