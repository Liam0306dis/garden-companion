import './setup.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveOwnSlot } from '../src/features/plant-drag-move.js';

test('our garden is known from the game even when we have not stood in it since a rebuild', () => {
  assert.equal(resolveOwnSlot(2, null, null), 2);
});

test("the game's record of our slot wins over one remembered from a previous room", () => {
  assert.equal(resolveOwnSlot(3, 1, 1), 3);
});

test('the remembered slot and then the room state stand in when the game has not said', () => {
  assert.equal(resolveOwnSlot(null, 1, 4), 1);
  assert.equal(resolveOwnSlot(null, null, 4), 4);
  assert.equal(resolveOwnSlot(undefined, undefined, undefined), null);
});

test('slot 0 is a real slot, not a missing one', () => {
  assert.equal(resolveOwnSlot(0, 2, 2), 0);
});
