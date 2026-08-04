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

test('the current graph contains no reverse edge pairs', () => {
  for (const e of EDGES) {
    const reverseKey = `${e.to}->${e.from}`;
    assert.equal(
      EDGE_MAP[reverseKey],
      undefined,
      `unexpected reverse edge ${reverseKey} for existing edge ${e.from}->${e.to}`
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

test('findPath(11, 5) returns null -- no cross-branch edges exist yet', () => {
  assert.equal(findPath(11, 5), null);
});

test('a node has a path to itself containing that node only', () => {
  for (const id of ALL_NODE_IDS) {
    assert.deepEqual(findPath(id, id), [id]);
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
