import { generateCelestialLayout, type CelestialGoal, type CelestialSpecies } from './celestial-layout.js';
import type { GardenTile } from './types.js';

/**
 * The celestial layout plan, worked out from the farm map: where each celestial plant should stand so
 * every one gets the chosen buff, and the moves that get the garden there. Farm Manager draws it on its
 * map (its Celestial tab) and the player follows it by dragging plants.
 *
 * Moonbinder (MoonCelestial) grants Amberbound and Dawnbinder (DawnCelestial) grants Dawnbound to the 8
 * tiles around it. Dawnbreaker and Starweaver only receive buffs, so they are interchangeable in a plan.
 */

export type FarmSide = 'left' | 'right';
export type PlacementType = 'moon' | 'dawn' | 'other';

/** A dirt tile of our farm: local index, map position, and what stands on it. */
export interface PlanCell {
  local: number;
  x: number;
  y: number;
  tile: GardenTile | null;
}

export interface CelestialPlan {
  side: FarmSide;
  goal: CelestialGoal;
  /** Planned species per local tile index. */
  plan: Map<number, CelestialSpecies>;
  /** Whether each planned tile gets the goal's buffs in the plan. */
  covered: Map<number, boolean>;
  /** The side's tiles, for coverage and labels. */
  sideTiles: Set<number>;
  /** 1-based row and column of each side tile, for the move list. */
  labels: Map<number, { row: number; column: number }>;
  message: string;
  tone: 'normal' | 'error';
}

/** One step: move the plant on `from` to `to`. `occupied` = `to` still holds another plant when this step comes up. */
export interface CelestialMove {
  from: number;
  to: number;
  species: CelestialSpecies;
  occupied: boolean;
}

export const CELESTIAL_SPECIES = new Set<CelestialSpecies>(['MoonCelestial', 'DawnCelestial', 'Dawnbreaker', 'Starweaver']);
export const CELESTIAL_LABELS: Record<CelestialSpecies, string> = {
  MoonCelestial: 'Moonbinder',
  DawnCelestial: 'Dawnbinder',
  Dawnbreaker: 'Dawnbreaker',
  Starweaver: 'Starweaver',
};
/** Badge letters and colours. Binders get the warm (Amberbound) / cool (Dawnbound) colour of their buff. */
export const CELESTIAL_BADGE: Record<CelestialSpecies, { short: string; color: string }> = {
  MoonCelestial: { short: 'Mb', color: '#fb923c' },
  DawnCelestial: { short: 'Db', color: '#38bdf8' },
  Dawnbreaker: { short: 'Br', color: '#f472b6' },
  Starweaver: { short: 'Sw', color: '#a78bfa' },
};

export function placementType(species: CelestialSpecies): PlacementType {
  if (species === 'MoonCelestial') return 'moon';
  if (species === 'DawnCelestial') return 'dawn';
  return 'other';
}

function isPreserved(tile: GardenTile | null | undefined): boolean {
  return tile?.objectType === 'plant' && Boolean(tile.slots?.some(slot => slot.preserved === true));
}

/** The celestial growing on a tile (not preserved - a preserved plant can't be moved), or null. */
export function celestialOn(tile: GardenTile | null | undefined): CelestialSpecies | null {
  return tile?.objectType === 'plant' && !isPreserved(tile) && CELESTIAL_SPECIES.has(tile.species as CelestialSpecies)
    ? tile.species as CelestialSpecies
    : null;
}

/** The left or right half of the farm's dirt columns, sorted row by row. */
export function sideCells(side: FarmSide, cells: PlanCell[]): PlanCell[] {
  const columns = [...new Set(cells.map(cell => cell.x))].sort((a, b) => a - b);
  const split = Math.floor(columns.length / 2);
  const chosen = new Set(side === 'left' ? columns.slice(0, split) : columns.slice(split));
  return cells.filter(cell => chosen.has(cell.x)).sort((a, b) => a.y - b.y || a.x - b.x);
}

/** The side holding more celestials already, or null when there are none. */
export function likelySide(cells: PlanCell[]): FarmSide | null {
  const count = (side: FarmSide) => sideCells(side, cells).filter(cell => celestialOn(cell.tile)).length;
  const left = count('left');
  const right = count('right');
  if (!left && !right) return null;
  return right > left ? 'right' : 'left';
}

/**
 * Plans already worked out, by everything that shapes them (side, goal, and what stands on each tile).
 * Generating one searches for up to ~120 ms, which a slow PC feels as a hitch, so re-opening the tab or
 * pressing Rebuild with nothing changed reuses the result instead.
 */
const planCache = new Map<string, CelestialPlan>();
const PLAN_CACHE_SIZE = 8;

function planKey(cells: PlanCell[], side: FarmSide, goal: CelestialGoal): string {
  return `${side}|${goal}|${cells.map(cell => {
    const tile = cell.tile;
    if (!tile) return '';
    const preserved = isPreserved(tile) ? '*' : '';
    return tile.objectType === 'plant' && CELESTIAL_SPECIES.has(tile.species as CelestialSpecies) ? `${tile.species}${preserved}` : '#';
  }).join(',')}`;
}

/**
 * Builds the plan for one side of the farm from every celestial on it now (either side). Cached; `force`
 * skips the cache and searches again with a fresh seed, which can turn up a different (better) layout.
 */
export function buildCelestialPlan(cells: PlanCell[], side: FarmSide, goal: CelestialGoal, force = false): CelestialPlan {
  const key = planKey(cells, side, goal);
  const cached = force ? undefined : planCache.get(key);
  if (cached) return cached;
  const plan = computeCelestialPlan(cells, side, goal, force ? String(Date.now()) : '');
  planCache.set(key, plan);
  if (planCache.size > PLAN_CACHE_SIZE) planCache.delete(planCache.keys().next().value!);
  return plan;
}

function computeCelestialPlan(cells: PlanCell[], side: FarmSide, goal: CelestialGoal, salt = ''): CelestialPlan {
  const tiles = sideCells(side, cells);
  const xs = [...new Set(tiles.map(cell => cell.x))].sort((a, b) => a - b);
  const ys = [...new Set(tiles.map(cell => cell.y))].sort((a, b) => a - b);
  const empty: CelestialPlan = {
    side, goal, plan: new Map(), covered: new Map(),
    sideTiles: new Set(tiles.map(cell => cell.local)),
    labels: new Map(tiles.map(cell => [cell.local, { row: ys.indexOf(cell.y) + 1, column: xs.indexOf(cell.x) + 1 }])),
    message: '', tone: 'normal',
  };
  if (!tiles.length || xs.length * ys.length !== tiles.length) {
    return { ...empty, message: 'This side of the farm could not be mapped yet. Walk into your garden and refresh.', tone: 'error' };
  }
  const plants = cells.flatMap(cell => { const species = celestialOn(cell.tile); return species ? [species] : []; });
  const unavailable = tiles.map(cell => isPreserved(cell.tile));
  const blocked = tiles.map(cell => Boolean(cell.tile && !(cell.tile.objectType === 'plant' && CELESTIAL_SPECIES.has(cell.tile.species as CelestialSpecies))));
  const buff = goal === 'both' ? 'both buffs' : goal === 'amber' ? 'Amberbound' : 'Dawnbound';
  const rows = ys.length;
  const columns = xs.length;
  // Current layout first: if every celestial is on this side and already gets the buff, nothing moves.
  const currentTypes = tiles.map(cell => { const species = celestialOn(cell.tile); return species ? placementType(species) : null; });
  const offSide = cells.some(cell => celestialOn(cell.tile) && !empty.sideTiles.has(cell.local));
  if (!offSide && plants.length) {
    const met = coverage(currentTypes, rows, columns, goal);
    if (met.every((ok, index) => ok || !currentTypes[index])) {
      tiles.forEach((cell, index) => {
        const species = celestialOn(cell.tile);
        if (!species) return;
        empty.plan.set(cell.local, species);
        empty.covered.set(cell.local, true);
      });
      return { ...empty, message: `Your layout already gives all ${plants.length} celestial plants ${buff}.`, tone: 'normal' };
    }
  }
  const result = generateCelestialLayout(plants, rows, columns, goal, blocked, unavailable, salt);
  if (!result.cells.length) return { ...empty, message: result.error, tone: 'error' };
  // The generator packs a fresh layout; flipping or sliding it doesn't change who buffs whom, so pick the
  // placement that keeps the most plants where they already stand (the fewest moves).
  const placed = bestPlacement(result.cells.map(cell => cell.species ? placementType(cell.species) : null), currentTypes, rows, columns, blocked, unavailable);
  result.cells.forEach((cell, index) => {
    if (!cell.species) return;
    const target = tiles[placed(index)];
    if (!target) return;
    empty.plan.set(target.local, cell.species);
    empty.covered.set(target.local, cell.met);
  });
  return {
    ...empty,
    message: result.error || `${result.met} of ${result.required} celestial plants receive ${buff}.`,
    tone: result.error ? 'error' : 'normal',
  };
}

/** Per cell: whether the plant there gets the goal's buffs from its 8 neighbours. */
function coverage(types: Array<PlacementType | null>, rows: number, columns: number, goal: CelestialGoal): boolean[] {
  return types.map((type, index) => {
    if (!type) return false;
    const row = Math.floor(index / columns);
    const column = index % columns;
    let amber = false;
    let dawn = false;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const r = row + dr;
      const c = column + dc;
      if (r < 0 || r >= rows || c < 0 || c >= columns) continue;
      const neighbour = types[r * columns + c];
      if (neighbour === 'moon') amber = true;
      if (neighbour === 'dawn') dawn = true;
    }
    return (goal === 'amber' ? amber : goal === 'dawn' ? dawn : amber && dawn);
  });
}

/**
 * Of every mirror image and shift of a generated layout that still fits the side (no plant on a blocked
 * or unavailable tile), the one matching the current plants best. Returns the mapping from a generated
 * cell index to the chosen cell index.
 */
function bestPlacement(planned: Array<PlacementType | null>, current: Array<PlacementType | null>, rows: number, columns: number, blocked: readonly boolean[], unavailable: readonly boolean[]): (index: number) => number {
  const used = planned.flatMap((type, index) => type ? [index] : []);
  const rowsUsed = used.map(index => Math.floor(index / columns));
  const columnsUsed = used.map(index => index % columns);
  const [minR, maxR, minC, maxC] = [Math.min(...rowsUsed), Math.max(...rowsUsed), Math.min(...columnsUsed), Math.max(...columnsUsed)];
  let best = { score: -1, map: (index: number) => index };
  for (const flipR of [false, true]) for (const flipC of [false, true]) {
    for (let dr = -minR; dr <= rows - 1 - maxR; dr++) for (let dc = -minC; dc <= columns - 1 - maxC; dc++) {
      const map = (index: number) => {
        let r = Math.floor(index / columns);
        let c = index % columns;
        if (flipR) r = minR + maxR - r;
        if (flipC) c = minC + maxC - c;
        return (r + dr) * columns + (c + dc);
      };
      let score = 0;
      let fits = true;
      for (const index of used) {
        const target = map(index);
        if (blocked[target] || unavailable[target]) { fits = false; break; }
        if (current[target] === planned[index]) score++;
      }
      if (fits && score > best.score) best = { score, map };
    }
  }
  return best.map;
}

/** Whether the plant on a tile already suits its planned spot. */
export function placedRight(plan: CelestialPlan, cell: PlanCell): boolean {
  const planned = plan.plan.get(cell.local);
  const actual = celestialOn(cell.tile);
  return Boolean(planned && actual && placementType(planned) === placementType(actual));
}

/**
 * The moves from the garden as it is now to the plan, worked out afresh each time so a finished move
 * simply drops off the list. Destinations are planned spots without a plant of their kind; sources are
 * celestials not standing on a spot of their kind. Each destination takes the nearest source of its kind.
 * Moves into empty tiles come first; a move whose tile is still occupied when it comes up is flagged.
 */
export function celestialMoves(plan: CelestialPlan, cells: PlanCell[]): CelestialMove[] {
  const byLocal = new Map(cells.map(cell => [cell.local, cell]));
  const destinations = [...plan.plan.entries()].filter(([local]) => {
    const cell = byLocal.get(local);
    return cell && !placedRight(plan, cell);
  });
  const sources = cells.filter(cell => celestialOn(cell.tile) && !placedRight(plan, cell));
  const distance = (a: PlanCell, b: PlanCell) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  const used = new Set<number>();
  const raw: CelestialMove[] = [];
  for (const [to, planned] of destinations) {
    const target = byLocal.get(to)!;
    let best: PlanCell | null = null;
    for (const source of sources) {
      if (used.has(source.local) || placementType(celestialOn(source.tile)!) !== placementType(planned)) continue;
      if (!best || distance(source, target) < distance(best, target)) best = source;
    }
    if (!best) continue;
    used.add(best.local);
    raw.push({ from: best.local, to, species: celestialOn(best.tile)!, occupied: false });
  }
  // Empty destinations first; a tile emptied by an earlier step counts as empty after it.
  const ordered: CelestialMove[] = [];
  const vacated = new Set<number>();
  const pending = [...raw];
  while (pending.length) {
    const ready = pending.findIndex(move => !byLocal.get(move.to)?.tile || vacated.has(move.to));
    const next = pending.splice(ready === -1 ? 0 : ready, 1)[0]!;
    next.occupied = ready === -1;
    ordered.push(next);
    vacated.add(next.from);
  }
  return ordered;
}

/** The binder kind on a tile (actual plant first, else planned), for coverage highlighting. */
export function binderOn(plan: CelestialPlan | null, cell: PlanCell): 'moon' | 'dawn' | null {
  const species = celestialOn(cell.tile) ?? plan?.plan.get(cell.local) ?? null;
  const kind = species ? placementType(species) : null;
  return kind === 'moon' || kind === 'dawn' ? kind : null;
}

/** The tiles a binder on `cell` buffs: its eight neighbours (on the plan's side when a plan exists). */
export function neighboursOf(cell: PlanCell, cells: PlanCell[], plan: CelestialPlan | null): PlanCell[] {
  return cells.filter(other => other !== cell
    && Math.abs(other.x - cell.x) <= 1 && Math.abs(other.y - cell.y) <= 1
    && (!plan || plan.sideTiles.has(other.local)));
}
