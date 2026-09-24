import { catalogs, FakeSocket } from './setup.js';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { noteGameSocket } from '../src/game-connection.js';
import {
  allActivePetsStarving, ensureToolReady, formatEstimate, heldToolCount, holdTool, hungerSecondsRemaining, petIsStarving,
  petMetrics, teamXpPerHour, toolIsHeld,
} from '../src/pets.js';
import { state } from '../src/state.js';
import type { Pet, PlayerSlot } from '../src/types.js';

const turtle = catalogs.pets.Turtle;

function pet(overrides: Partial<Pet> & Record<string, unknown>): Pet {
  return { id: 'p1', petSpecies: 'Turtle', hunger: 1000, xp: 0, targetScale: turtle.maxScale, abilities: [], mutations: [], ...overrides } as Pet;
}

test('strength comes from the pet\'s scale and xp, capped at its maximum', () => {
  state.slot = { data: { garden: { tileObjects: {} } } } as unknown as PlayerSlot;
  const fresh = petMetrics(pet({ xp: 0 }))!;
  assert.equal(fresh.maxStrength, 100);
  assert.equal(fresh.strength, 70);
  const xpPerLevel = Math.floor(3600 * turtle.hoursToMature / 30);
  const grown = petMetrics(pet({ xp: xpPerLevel * 40 }))!;
  assert.equal(grown.strength, 100);
  assert.equal(grown.xpToMax, 0);
  assert.equal(petMetrics(pet({ targetScale: 1 }))!.maxStrength, 80);
});

test('a Strength Crystal lends ten without moving the levelling estimate', () => {
  state.slot = { data: { garden: { tileObjects: { 1: { objectType: 'crystal', crystalType: 'Strength', remainingActiveSeconds: 60 } } } } } as unknown as PlayerSlot;
  const metrics = petMetrics(pet({ xp: 0 }))!;
  assert.equal(metrics.strength, 80);
  assert.ok(metrics.xpToMax > 0);
  state.slot = { data: { garden: { tileObjects: {} } } } as unknown as PlayerSlot;
});

test('unknown hunger is not starvation, and the alarm needs every active pet at zero', () => {
  assert.equal(petIsStarving(pet({ hunger: undefined as unknown as number })), false);
  assert.equal(petIsStarving(pet({ hunger: 0 })), true);
  state.slot = { data: { petSlots: [pet({ id: 'a', hunger: 0 }), pet({ id: 'b', hunger: 5 })] } } as unknown as PlayerSlot;
  assert.equal(allActivePetsStarving(), false);
  state.slot = { data: { petSlots: [pet({ id: 'a', hunger: 0 }), pet({ id: 'b', hunger: 0 })] } } as unknown as PlayerSlot;
  assert.equal(allActivePetsStarving(), true);
  state.slot = { data: { petSlots: [] } } as unknown as PlayerSlot;
  assert.equal(allActivePetsStarving(), false, 'no pets is not a starving team');
});

test('hunger lasts longer with a Hunger Boost on the team', () => {
  const alone = pet({ hunger: turtle.maxHunger });
  const plain = hungerSecondsRemaining(alone, [alone])!;
  const boosted = pet({ id: 'b', petSpecies: 'Turtle', abilities: ['HungerBoostII'] });
  const withBoost = hungerSecondsRemaining(alone, [alone, boosted])!;
  assert.ok(plain > 0 && withBoost > plain);
  assert.equal(hungerSecondsRemaining(pet({ hunger: 0 }), []), 0);
});

test('team XP never counts a weather-gated ability outside its weather', () => {
  state.game = { weather: null } as never;
  const withSnowy = teamXpPerHour([pet({ abilities: ['SnowyPetXpBoost'] })]);
  assert.equal(withSnowy, 3600);
  state.game = { weather: 'Frost' } as never;
  assert.ok(teamXpPerHour([pet({ abilities: ['SnowyPetXpBoost'] })]) > 3600);
  state.game = null;
});

test('estimates read in days, hours and minutes', () => {
  assert.equal(formatEstimate(0), 'Ready');
  assert.equal(formatEstimate(90), '2m');
  assert.equal(formatEstimate(3 * 3600 + 60), '3h 1m');
  assert.equal(formatEstimate(26 * 3600), '1d 2h');
});

test('a tool hold lasts through the operation and a short grace after it', () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const release = holdTool('CropCleanser');
  assert.equal(toolIsHeld('CropCleanser'), true);
  release();
  release();
  assert.equal(toolIsHeld('CropCleanser'), true, 'still in the grace window');
  mock.timers.tick(5_001);
  assert.equal(toolIsHeld('CropCleanser'), false);
  mock.timers.reset();
});

test('a tool is fetched from the Tool Shack when none is loose', async () => {
  const socket = new FakeSocket();
  noteGameSocket(socket as unknown as WebSocket);
  const shack = { decorId: 'ToolShack', items: [{ itemType: 'Tool', toolId: 'XPPotion', quantity: 4 }] };
  state.slot = { data: { inventory: { items: [], storages: [shack] } } } as unknown as PlayerSlot;
  assert.equal(heldToolCount('XPPotion'), 4);
  const ready = ensureToolReady('XPPotion');
  // The server's answer: the potion arrives loose.
  state.slot = { data: { inventory: { items: [{ itemType: 'Tool', toolId: 'XPPotion', quantity: 1 }], storages: [shack] } } } as unknown as PlayerSlot;
  assert.equal(await ready, true);
  assert.deepEqual(socket.commands()[0], { type: 'RetrieveItemFromStorage', itemId: 'XPPotion', storageId: 'ToolShack', quantity: 1 });
});
