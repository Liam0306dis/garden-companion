import './setup.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateCelestialLayout, type CelestialSpecies } from '../src/celestial-layout.js';

const repeat = <T>(value: T, count: number): T[] => Array.from({ length: count }, () => value);
const planted = (cells: Array<{ species: CelestialSpecies | null }>) => cells.flatMap(cell => (cell.species ? [cell.species] : [])).sort();

const bothPlants: CelestialSpecies[] = [
  'MoonCelestial', 'MoonCelestial', 'DawnCelestial', 'DawnCelestial',
  ...repeat('Dawnbreaker' as const, 5), ...repeat('Starweaver' as const, 3),
];

test('a typical set gets both buffs on every plant, without changing what is planted', () => {
  const layout = generateCelestialLayout(bothPlants, 10, 5, 'both');
  assert.equal(layout.error, '');
  assert.equal(layout.met, bothPlants.length);
  assert.deepEqual(planted(layout.cells), [...bothPlants].sort());
});

test('the layout is deterministic, compact and centred', () => {
  const layout = generateCelestialLayout(bothPlants, 10, 5, 'both');
  assert.deepEqual(generateCelestialLayout(bothPlants, 10, 5, 'both'), layout);
  const occupied = layout.cells.flatMap((cell, index) => (cell.species ? [index] : []));
  const rows = occupied.map(index => Math.floor(index / 5));
  const columns = occupied.map(index => index % 5);
  const area = (Math.max(...rows) - Math.min(...rows) + 1) * (Math.max(...columns) - Math.min(...columns) + 1);
  assert.ok(area <= 20, `occupied area ${area}`);
  assert.ok(Math.abs((Math.min(...rows) + Math.max(...rows)) / 2 - 4.5) <= 1);
  assert.ok(Math.abs((Math.min(...columns) + Math.max(...columns)) / 2 - 2) <= 1);
});

test('a single-buff goal only needs its own binder', () => {
  assert.equal(generateCelestialLayout(['MoonCelestial', 'MoonCelestial', 'Starweaver'], 10, 5, 'amber').met, 3);
  assert.equal(generateCelestialLayout(['DawnCelestial', 'DawnCelestial', 'Dawnbreaker'], 10, 5, 'dawn').met, 3);
});

test('19 Moonbinders cover a 97-plant Amberbound layout', () => {
  const set: CelestialSpecies[] = [...repeat('MoonCelestial' as const, 19), ...repeat('DawnCelestial' as const, 33), ...repeat('Dawnbreaker' as const, 45)];
  const layout = generateCelestialLayout(set, 10, 10, 'amber');
  assert.equal(layout.met, set.length);
  assert.deepEqual(planted(layout.cells), [...set].sort());
});

test('a binder cannot buff itself', () => {
  assert.match(generateCelestialLayout(['MoonCelestial', 'Starweaver'], 10, 5, 'amber').error, /At least two Moonbinders/);
  assert.match(generateCelestialLayout(['DawnCelestial', 'Dawnbreaker'], 10, 5, 'dawn').error, /At least two Dawnbinders/);
});

test('empty tiles are preferred over occupied ones, and unavailable tiles are never used', () => {
  const blocked = Array.from({ length: 50 }, (_, index) => index >= 10 && index < 40);
  const preferEmpty = generateCelestialLayout(['DawnCelestial', 'DawnCelestial', 'Starweaver'], 10, 5, 'dawn', blocked);
  assert.equal(preferEmpty.met, 3);
  assert.ok(preferEmpty.cells.every((cell, index) => !cell.species || !blocked[index]));
  const unavailable = Array.from({ length: 50 }, (_, index) => index === 22 || index === 23);
  const avoiding = generateCelestialLayout(['MoonCelestial', 'MoonCelestial', 'Starweaver'], 10, 5, 'amber', [], unavailable);
  assert.ok(avoiding.cells.every((cell, index) => !cell.species || !unavailable[index]));
});

test('a provably impossible large layout gives up quickly', () => {
  const set: CelestialSpecies[] = ['MoonCelestial', 'MoonCelestial', 'DawnCelestial', 'DawnCelestial', ...repeat('Starweaver' as const, 196)];
  const started = performance.now();
  generateCelestialLayout(set, 100, 50, 'both');
  assert.ok(performance.now() - started < 500);
});

test('too many plants for the side is reported rather than laid out', () => {
  const layout = generateCelestialLayout(repeat('MoonCelestial' as const, 60), 10, 5, 'amber');
  assert.match(layout.error, /has 50 slots, but 60/);
});
