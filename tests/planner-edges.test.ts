import assert from 'node:assert/strict';
import { test } from 'node:test';
import { edgeKey, nearestEdge } from '../src/features/planner-edges.js';

const origin = { x: 10, y: 20 };
const holding = (...keys: string[]) => (key: string) => keys.includes(key);

test('edge keys: h runs along a tile top, v down its left', () => {
  assert.equal(edgeKey(2, 3, 'up'), 'h:2:3');
  assert.equal(edgeKey(2, 3, 'down'), 'h:2:4');
  assert.equal(edgeKey(2, 3, 'left'), 'v:2:3');
  assert.equal(edgeKey(2, 3, 'right'), 'v:3:3');
});

test('picks the side the point is nearest, counted from the garden origin', () => {
  const all = () => true;
  assert.equal(nearestEdge({ x: 12.5, y: 23.05 }, origin, 0.3, all), 'h:2:3');
  assert.equal(nearestEdge({ x: 12.5, y: 23.95 }, origin, 0.3, all), 'h:2:4');
  assert.equal(nearestEdge({ x: 12.05, y: 23.5 }, origin, 0.3, all), 'v:2:3');
  assert.equal(nearestEdge({ x: 12.95, y: 23.5 }, origin, 0.3, all), 'v:3:3');
});

test('nothing outside the reach, so the middle of a tile is left to the tile', () => {
  assert.equal(nearestEdge({ x: 12.5, y: 23.5 }, origin, 0.3, () => true), null);
  assert.equal(nearestEdge({ x: 12.5, y: 23.2 }, origin, 0.12, () => true), null);
  assert.equal(nearestEdge({ x: 12.5, y: 23.1 }, origin, 0.12, () => true), 'h:2:3');
});

test('only edges that hold something count, and a corner falls back to the farther line', () => {
  // Near the top-left corner, nearer the top line - but only the left edge holds decor.
  assert.equal(nearestEdge({ x: 12.1, y: 23.05 }, origin, 0.3, holding('v:2:3')), 'v:2:3');
  assert.equal(nearestEdge({ x: 12.5, y: 23.05 }, origin, 0.3, holding('v:2:3')), null);
});

test('a border edge is reachable from the tile outside the garden', () => {
  // The tile left of the origin column is outside the box; its right side is the garden's v:0 line.
  assert.equal(nearestEdge({ x: 9.95, y: 21.5 }, origin, 0.3, holding('v:0:1')), 'v:0:1');
  // And the line under the bottom row from the tile below it.
  assert.equal(nearestEdge({ x: 11.5, y: 25.02 }, origin, 0.3, holding('h:1:5')), 'h:1:5');
});
