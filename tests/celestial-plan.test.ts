import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCelestialPlan, celestialMoves, type PlanCell } from '../src/celestial-plan.js';
import type { GardenTile } from '../src/types.js';

/** A farm of two 4x4 halves (left x 0-3, right x 4-7); `plants` maps "x,y" to a species. */
function farm(plants: Record<string, string>): PlanCell[] {
  const cells: PlanCell[] = [];
  for (let y = 0; y < 4; y++) for (let x = 0; x < 8; x++) {
    const species = plants[`${x},${y}`];
    const tile = species ? { objectType: 'plant', species, slots: [] } as unknown as GardenTile : null;
    cells.push({ local: y * 8 + x, x, y, tile });
  }
  return cells;
}

test('a layout that already gives every plant the buff needs no moves', () => {
  // Two Moonbinders next to each other, each with two neighbours that are buffed by one of them.
  const cells = farm({ '4,0': 'MoonCelestial', '5,0': 'MoonCelestial', '4,1': 'Starweaver', '5,1': 'Dawnbreaker' });
  const plan = buildCelestialPlan(cells, 'right', 'amber');
  assert.match(plan.message, /already gives all 4/);
  assert.equal(celestialMoves(plan, cells).length, 0);
});

test('plants on the other side are brought over, keeping the ones already well placed', () => {
  const cells = farm({ '4,0': 'MoonCelestial', '5,0': 'MoonCelestial', '4,1': 'Starweaver', '0,3': 'Dawnbreaker' });
  const plan = buildCelestialPlan(cells, 'right', 'amber');
  const moves = celestialMoves(plan, cells);
  assert.ok(moves.length >= 1);
  assert.ok(moves.some(move => move.from === 3 * 8 + 0), 'the left-side plant moves');
  // The planned spots are all on the right side.
  for (const local of plan.plan.keys()) assert.ok(plan.sideTiles.has(local));
});
