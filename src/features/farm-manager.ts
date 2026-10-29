import { DECOR_CATALOG, MUTATION_CATALOG, patchName } from '../constants.js';
import { makeDraggable } from '../draggable.js';
import { page } from '../page.js';
import { freeInventorySlots, heldToolCount, onSpritesReady, produceSprite } from '../pets.js';
import { onStateChange, state } from '../state.js';
import { sendQuinoaCommand } from '../game-connection.js';
import { pauseAutoStore } from './auto-store.js';
import { toast } from '../toast.js';
import type { GardenTile, PlantSlot } from '../types.js';
import { escapeHtml, waitFor } from '../utils.js';
import { plantActions } from './plant-drag-move.js';
import { serverNow } from '../server-clock.js';
import type { CelestialGoal } from '../celestial-layout.js';
import {
  binderOn, buildCelestialPlan, CELESTIAL_BADGE, CELESTIAL_LABELS, CELESTIAL_SPECIES, celestialMoves, celestialOn,
  likelySide, neighboursOf, placedRight, type CelestialMove, type CelestialPlan, type FarmSide, type PlanCell,
} from '../celestial-plan.js';

/**
 * A top-down map of your own garden. Plants on the farm, potted plants and seeds can each be
 * dragged onto an empty dirt tile, and a plant dropped on the side bar is potted into the inventory.
 * Occupied tiles and decor never take part in a move. Moves go
 * through the same Planter Pot and replant commands as the hold-and-drag on the canvas, and seeds
 * through the game's own PlantSeed, so nothing here does what the game would not let you do by hand.
 */

const POSITION_KEY = 'gardenCompanion.farmManagerPosition.v1';
const MIN_CELL = 14;
const CELL_GAP = 2;
const MAX_CELL = 56;
const SEED_SILO = 'SeedSilo';
const PLACE_TIMEOUT_MS = 12_000;
/** The game's loose inventory limit; a potted plant never stacks, so it always needs a slot of its own. */
const INVENTORY_SLOTS = 100;

interface Cell {
  kind: 'dirt' | 'board';
  local: number;
  x: number;
  y: number;
  tile: GardenTile | null;
}

interface PottedPlant {
  id: string;
  species: string;
}

interface SeedStack {
  species: string;
  loose: number;
  stored: number;
}

type Drag = { from: 'tile'; local: number } | { from: 'inventory'; itemId: string } | { from: 'seed'; species: string };

let drag: Drag | null = null;
let busyTiles = new Set<number>();
let renderQueued = false;
let search = '';
type Tab = 'plants' | 'seeds' | 'celestial';
let tab: Tab = 'plants';
/**
 * The Celestial tab: a plan for where each celestial plant should stand (see celestial-plan.ts), drawn on
 * the map with species badges, step numbers on the plants that have to move and an arrow for the next one. The player follows
 * it by dragging plants as usual. The plan is only rebuilt on request (side, goal, Refresh); the moves are
 * worked out afresh on every draw, so a finished move drops off the list by itself.
 */
let celPlan: CelestialPlan | null = null;
let celSide: FarmSide | null = null;
let celGoal: CelestialGoal = 'both';
let celMoves: CelestialMove[] = [];
/** The tile of the numbered plant under the pointer, whose move the arrow shows; null for move 1. */
let celShownFrom: number | null = null;
/** A tile a plant was just dropped on that the plan doesn't want it on: its fix goes to the top of the list. */
let celMisplaced: number | null = null;
/** What was wrong with that drop, shown in the title bar until it is fixed. */
let celMisplacedText = '';
/**
 * The seed picked on the Seeds tab, which every click on an empty tile plants until the same seed
 * is clicked again, another is picked, the Plants tab is opened, or the seeds run out.
 */
let armedSeed: string | null = null;
/**
 * The potted plant picked on the Plants tab, clicked or dragged. Planting it takes it out of the
 * list, so its place in the list is kept as well: whichever plant moves up into that place is picked
 * next, and a row of tiles can be filled by clicking them one after another.
 */
let armedPlant: { id: string; index: number } | null = null;
/** Set while a seed is being planted, which plant-drag-move knows nothing about. */
let seeding = false;

function root(): HTMLElement | null {
  return document.getElementById('gc-farm-manager');
}

function isOpen(): boolean {
  const element = root();
  return Boolean(element && !element.hidden);
}

function ownSlot(): number | null {
  const captured = page.__gardenCompanionFarmSystems?.ownUserSlotIdx;
  if (typeof captured === 'number') return captured;
  return state.userSlotIndex ?? state.slotIndex ?? null;
}

/**
 * Tile positions come from the game's own map, so the grid is laid out exactly as the farm is,
 * gaps and both sides included. Contents come from the reported garden state rather than the
 * rendered tiles, which the layout planner may be drawing over.
 */
function farmCells(): Cell[] | null {
  const map = page.__gardenCompanionFarmSystems?.tileSystem?.map as Record<string, any> | undefined;
  const slot = ownSlot();
  if (!map?.cols || slot === null) return null;
  const garden = state.slot?.data?.garden;
  const cells: Cell[] = [];
  const add = (kind: Cell['kind'], indexes: Record<string, number> | undefined, objects: Record<string, GardenTile> | undefined) => {
    for (const [local, global] of Object.entries(indexes ?? {})) {
      if (typeof global !== 'number') continue;
      cells.push({ kind, local: Number(local), x: global % map.cols, y: Math.floor(global / map.cols), tile: objects?.[local] ?? null });
    }
  };
  add('dirt', map.userSlotIdxAndDirtTileIdxToGlobalTileIdx?.[slot], garden?.tileObjects);
  add('board', map.userSlotIdxAndBoardwalkTileIdxToGlobalTileIdx?.[slot], garden?.boardwalkTileObjects);
  return cells.length ? cells : null;
}

/** Our dirt tiles in the shape the celestial planner works with. */
function planCells(cells: Cell[] | null): PlanCell[] {
  return (cells ?? []).filter(cell => cell.kind === 'dirt').map(cell => ({ local: cell.local, x: cell.x, y: cell.y, tile: cell.tile }));
}

/** Set while a plan is being worked out, so the side bar can say so. */
let celCalculating = false;
let celCalcTimer = 0;

/**
 * Rebuilds the plan after the next frame is drawn: the search can take a moment on a slow PC, and doing
 * it straight from the click held up the button's own feedback. The side bar shows "Calculating layout"
 * meanwhile. A cached plan (nothing changed) comes back instantly either way.
 */
function requestCelestialPlan(force = false): void {
  celCalculating = true;
  render();
  if (celCalcTimer) clearTimeout(celCalcTimer);
  celCalcTimer = window.setTimeout(() => {
    celCalcTimer = 0;
    requestAnimationFrame(() => {
      rebuildCelestialPlan(force);
      celCalculating = false;
      render();
    });
  }, 0);
}

function rebuildCelestialPlan(force = false): void {
  const cells = planCells(farmCells());
  if (!celSide) celSide = likelySide(cells) ?? 'left';
  celPlan = cells.length ? buildCelestialPlan(cells, celSide, celGoal, force) : null;
  celMoves = [];
  celShownFrom = null;
  celMisplaced = null;
  celMovesBasis = '';
}

/** The move the arrow points at: the hovered plant's, or move 1 when none is hovered (or it is done). */
function shownMove(): CelestialMove | null {
  return celMoves.find(move => move.from === celShownFrom) ?? celMoves[0] ?? null;
}

function celBadge(species: keyof typeof CELESTIAL_BADGE): string {
  const badge = CELESTIAL_BADGE[species];
  return `<i class="gc-fm-chip" style="--chip:${badge.color}">${badge.short}</i>`;
}

/**
 * The move list, kept steady between draws. Worked out from scratch each time, the nearest-plant
 * pairing reshuffled whenever a tile changed - including mid-move, when the lifted plant's tile is
 * briefly empty - and the arrow jumped between pairings. So: nothing changes while a move is in flight;
 * otherwise every step still valid keeps its place and pairing, finished or broken steps drop out, and
 * only spots no step covers yet get new steps, appended at the end.
 */
/** Where the celestials stood when the moves were last worked out, so routine state updates skip the work. */
let celMovesBasis = '';
let celMovesPlan: CelestialPlan | null = null;

function stableMoves(plan: CelestialPlan, cells: PlanCell[], busy: boolean): CelestialMove[] {
  if (busy || busyTiles.size) return celMoves;
  // Most state updates (growth timers, other players) leave every tile's occupant as it was: nothing to redo.
  const basis = cells.map(cell => cell.tile ? `${cell.local}:${celestialOn(cell.tile) ?? '#'}` : '').join(',');
  if (basis === celMovesBasis && plan === celMovesPlan) return celMoves;
  celMovesBasis = basis;
  celMovesPlan = plan;
  const byLocal = new Map(cells.map(cell => [cell.local, cell]));
  const kept = celMoves.filter(move => {
    const from = byLocal.get(move.from);
    const to = byLocal.get(move.to);
    return from && to && celestialOn(from.tile) === move.species && !placedRight(plan, from)
      && plan.plan.has(move.to) && !placedRight(plan, to);
  });
  const usedFrom = new Set(kept.map(move => move.from));
  const usedTo = new Set(kept.map(move => move.to));
  let added = celestialMoves(plan, cells).filter(move => !usedFrom.has(move.from) && !usedTo.has(move.to));
  // A plant just dropped on the wrong tile: correcting it comes first, before the list carries on.
  const misplaced = celMisplaced;
  if (misplaced !== null && !byLocal.get(misplaced)?.tile) celMisplaced = null;
  const fixIndex = misplaced === null ? -1 : added.findIndex(move => move.from === misplaced);
  const keptFix = misplaced === null ? -1 : kept.findIndex(move => move.from === misplaced);
  if (fixIndex !== -1) {
    const [fix] = added.splice(fixIndex, 1);
    kept.unshift(fix!);
  } else if (keptFix > 0) {
    kept.unshift(...kept.splice(keptFix, 1));
  } else if (misplaced !== null && keptFix === -1) {
    celMisplaced = null;
  }
  return [...kept, ...added];
}

/**
 * Points the arrow and the yellow outlines at another move, so hovering a plant marked 2 or later shows
 * where it goes. Done on the drawn board in place - redrawing the whole map per hover is what lagged -
 * and kept in celShownFrom, which the next draw follows, so a redraw mid-hover leaves the arrow where it is.
 */
function showCelestialMove(fromLocal: number | null): void {
  if (fromLocal === celShownFrom) return;
  celShownFrom = fromLocal;
  const element = root();
  const move = shownMove();
  const line = element?.querySelector<SVGLineElement>('.gc-fm-cel-arrow line');
  if (!element || !move || !line) return;
  const cellNode = (local: number) => element.querySelector<HTMLElement>(`.gc-fm-cell[data-kind="dirt"][data-local="${local}"]`);
  const from = cellNode(move.from);
  const to = cellNode(move.to);
  if (!from || !to) return;
  element.querySelectorAll<HTMLElement>('[data-cel-active]').forEach(node => { delete node.dataset.celActive; });
  from.dataset.celActive = 'true';
  to.dataset.celActive = 'true';
  line.setAttribute('x1', String(from.offsetLeft + from.offsetWidth / 2));
  line.setAttribute('y1', String(from.offsetTop + from.offsetHeight / 2));
  line.setAttribute('x2', String(to.offsetLeft + to.offsetWidth / 2));
  line.setAttribute('y2', String(to.offsetTop + to.offsetHeight / 2));
}

/** After a drag on the Celestial tab: warn when the plant landed where the plan doesn't want it. */
function checkCelestialDrop(local: number): void {
  if (!celPlan) return;
  const cell = planCells(farmCells()).find(item => item.local === local);
  const species = celestialOn(cell?.tile);
  if (!cell || !species || placedRight(celPlan, cell)) return;
  celMisplaced = local;
  const planned = celPlan.plan.get(local);
  celMisplacedText = planned
    ? `Wrong spot: that tile is for a ${CELESTIAL_LABELS[planned]}, not a ${CELESTIAL_LABELS[species]}`
    : `Wrong spot: that tile isn't in the plan for the ${CELESTIAL_LABELS[species]}`;
  toast(`${celMisplacedText} - the plant marked 1 now moves it.`, 'error');
}

/** The Celestial tab's side bar: choices, counts and help. Progress is in the map's toolbar. */
function celestialPanel(cells: Cell[] | null): string {
  const counts: Record<string, number> = {};
  for (const cell of cells ?? []) { const species = celestialOn(cell.tile); if (species) counts[species] = (counts[species] ?? 0) + 1; }
  const segment = (attr: string, value: string, label: string, active: boolean) => `<button data-${attr}="${value}" data-active="${active}">${label}</button>`;
  const total = celPlan?.plan.size ?? 0;
  return `<div class="gc-fm-cel">
${celCalculating ? '<p class="gc-fm-cel-msg">Calculating layout...</p>' : celPlan?.message ? `<p class="gc-fm-cel-msg" data-tone="${celPlan.tone}">${escapeHtml(celPlan.message)}</p>` : ''}
${cells && !total && !celCalculating && celPlan?.tone !== 'error' ? '<div class="gc-fm-empty">No celestial plants on your farm to plan yet.</div>' : ''}
<section class="gc-fm-card"><h4>Layout</h4>
<div class="gc-fm-cel-label">Farm side</div><div class="gc-fm-cel-seg">${segment('cel-side', 'left', 'Left', celSide === 'left')}${segment('cel-side', 'right', 'Right', celSide === 'right')}</div>
<div class="gc-fm-cel-label">Every plant needs</div><div class="gc-fm-cel-seg">${segment('cel-goal', 'amber', 'Amber', celGoal === 'amber')}${segment('cel-goal', 'dawn', 'Dawn', celGoal === 'dawn')}${segment('cel-goal', 'both', 'Both', celGoal === 'both')}</div>
<button class="gc-fm-cel-refresh" data-cel-refresh title="Search again from scratch - can find a different layout">${ICONS.refresh}Recalculate</button>
</section>
<section class="gc-fm-card"><h4>On your farm</h4><div class="gc-fm-cel-counts">${[...CELESTIAL_SPECIES].map(species => `<span>${celBadge(species)}<em>${CELESTIAL_LABELS[species]}</em><b>${counts[species] ?? 0}</b></span>`).join('')}</div></section>
<small class="gc-fm-cel-help">Moonbinder (Mb) gives Amberbound and Dawnbinder (Db) gives Dawnbound to the 8 tiles around it. Hover a binder on the map to see which plants it reaches, or a numbered plant to see where it goes.</small>
</div>`;
}

/** Line icons for the window's chrome, drawn in the text colour. */
const icon = (paths: string) => `<svg class="gc-fm-ico" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
const ICONS = {
  farm: icon('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'),
  plants: icon('<path d="M12 21v-9"/><path d="M12 12c0-4.5 3-7.5 7.5-7.5 0 4.5-3 7.5-7.5 7.5z"/><path d="M12 14.5c0-3.5-2.5-6-6.5-6 0 3.5 2.5 6 6.5 6z"/><path d="M7 21h10"/>'),
  seeds: icon('<path d="M12 3c4.5 3.5 6.5 7.5 6.5 10.5a6.5 6.5 0 0 1-13 0C5.5 10.5 7.5 6.5 12 3z"/><path d="M12 10v8"/>'),
  celestial: icon('<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/><path d="M17 3v4M15 5h4"/>'),
  search: icon('<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>'),
  close: icon('<path d="M6 6l12 12M18 6 6 18"/>'),
  refresh: icon('<path d="M20 11a8 8 0 0 0-14.6-4.5M4 4v3.5h3.5"/><path d="M4 13a8 8 0 0 0 14.6 4.5M20 20v-3.5h-3.5"/>'),
};

const TAB_SUBTITLES: Record<Tab, string> = {
  plants: 'Move, swap and pot the plants on your farm',
  seeds: 'Plant seeds from your inventory or Seed Silo',
  celestial: 'Plans the best placement so every celestial gets full Moonbinder and Dawnbinder coverage',
};

const TAB_HINTS: Record<Tab, Array<[string, string]>> = {
  plants: [['Drag', 'move'], ['Right click', 'pot'], ['Click card', 'pick']],
  seeds: [['Click card', 'pick'], ['Click tile', 'plant'], ['Drag', 'plant once']],
  celestial: [['Drag', 'move'], ['Drop on plant', 'swap'], ['Hover number', 'its target']],
};

/** One card in the side bar's grid: a sprite, an optional count and the name underneath. */
function listCard(attrs: string, sprite: string, name: string, extra = ''): string {
  return `<div class="gc-fm-item"${attrs}><span class="gc-fm-art">${sprite}${extra}</span><b>${escapeHtml(name)}</b></div>`;
}

/** One decor on a tile edge: string lights fill the `line` part, a lantern or windchime the `hanging` one. */
type EdgeParts = Partial<Record<EdgePart, { decorId?: string; mirrored?: boolean }>>;

/**
 * Edge decor, drawn over the gaps between tiles. The game keys an edge `h:x:y` (along the top of tile
 * x,y) or `v:x:y` (down its left), counted from the top-left of the box around the garden's dirt and
 * boardwalk - the same box the map is laid out in, so the map's own origin lines them up.
 *
 * Purely a picture: the markers take no pointer events, so dragging and dropping on the tiles they
 * overhang works exactly as before.
 */
function edgeMarkers(size: number): string {
  const edges = (state.slot?.data?.garden as { edgeObjects?: Record<string, EdgeParts> } | undefined)?.edgeObjects;
  if (!edges) return '';
  const step = size + CELL_GAP;
  const markers: string[] = [];
  for (const [key, parts] of Object.entries(edges)) {
    const match = /^([hv]):(-?\d+):(-?\d+)$/.exec(key);
    if (!match || !parts) continue;
    const horizontal = match[1] === 'h';
    const x = Number(match[2]) * step - (horizontal ? 0 : CELL_GAP / 2);
    const y = Number(match[3]) * step - (horizontal ? CELL_GAP / 2 : 0);
    if (parts.line?.decorId) {
      const box = horizontal ? `left:${x}px;top:${y - 2}px;width:${size}px;height:4px` : `left:${x - 2}px;top:${y}px;width:4px;height:${size}px`;
      markers.push(`<i class="gc-fm-edge-line" style="${box}"></i>`);
    }
    if (parts.hanging?.decorId) {
      const icon = Math.round(size * .55);
      const centreX = horizontal ? x + size / 2 : x;
      const centreY = horizontal ? y : y + size / 2;
      const sprite = page.__gardenCompanionShopSprites?.[parts.hanging.decorId] || '';
      const flip = parts.hanging.mirrored ? 'transform:scaleX(-1);' : '';
      markers.push(`<i class="gc-fm-edge-hang" style="left:${Math.round(centreX - icon / 2)}px;top:${Math.round(centreY - icon / 2)}px;width:${icon}px;height:${icon}px;${flip}">${sprite ? `<img src="${escapeHtml(sprite)}" alt="" draggable="false">` : ''}</i>`);
    }
  }
  return markers.length ? `<div class="gc-fm-edges" aria-hidden="true">${markers.join('')}</div>` : '';
}

function pottedPlants(): PottedPlant[] {
  const items = (state.slot?.data?.inventory?.items ?? []) as unknown as Array<Record<string, any>>;
  return items
    .filter(item => item?.itemType === 'Plant' && typeof item.id === 'string' && item.species)
    .map(item => ({ id: item.id, species: item.species }));
}

/** Seeds by species, loose and in the Seed Silo together, since either can be planted from here. */
function seedStacks(): SeedStack[] {
  const stacks = new Map<string, SeedStack>();
  const count = (rows: unknown[] | undefined, field: 'loose' | 'stored') => {
    for (const row of (rows ?? []) as Array<Record<string, any>>) {
      if (row?.itemType !== 'Seed' || !row.species) continue;
      const stack = stacks.get(row.species) ?? { species: row.species, loose: 0, stored: 0 };
      stack[field] += Math.max(0, Number(row.quantity ?? 1));
      stacks.set(row.species, stack);
    }
  };
  const inventory = state.slot?.data?.inventory;
  count(inventory?.items, 'loose');
  count(inventory?.storages?.find(storage => storage.decorId === SEED_SILO)?.items, 'stored');
  return [...stacks.values()]
    .filter(stack => stack.loose + stack.stored > 0)
    .sort((left, right) => speciesName(left.species).localeCompare(speciesName(right.species)));
}

function looseSeeds(species: string): number {
  return seedStacks().find(stack => stack.species === species)?.loose ?? 0;
}

/**
 * A seed has to be loose to plant, so one still in the Seed Silo is taken out first. Auto-store is
 * paused across the whole of it: it files seeds whose species the Silo already holds, which is
 * exactly the seed just taken out, and would put it back before PlantSeed could use it.
 */
async function plantSeed(species: string, local: number): Promise<void> {
  const resume = pauseAutoStore('Seed');
  try {
    // Checked before any seed leaves the Silo as well as after, so a drop on a tile that has filled
    // costs nothing rather than a round trip and a seed filed straight back.
    if (state.slot?.data?.garden?.tileObjects?.[String(local)]) throw new Error('That tile is not empty');
    if (looseSeeds(species) <= 0) {
      const stored = seedStacks().find(stack => stack.species === species)?.stored ?? 0;
      if (stored <= 0) throw new Error(`No ${speciesName(species)} seeds are left`);
      sendQuinoaCommand({ type: 'MoveItem', from: SEED_SILO, to: 'inventory', itemId: species, quantity: 1 });
      if (!await waitFor(() => looseSeeds(species) > 0, 4_000)) {
        throw new Error('The seed could not be taken out of the Seed Silo. Make room in your inventory');
      }
    }
    if (state.slot?.data?.garden?.tileObjects?.[String(local)]) throw new Error('That tile is not empty');
    sendQuinoaCommand({ type: 'PlantSeed', slot: local, species });
    const planted = await waitFor(() => {
      const tile = state.slot?.data?.garden?.tileObjects?.[String(local)];
      return tile?.objectType === 'plant' && tile.species === species;
    }, PLACE_TIMEOUT_MS);
    if (!planted) throw new Error('Planting was not confirmed. Check the tile before retrying');
    toast(`${speciesName(species)} planted.`, 'success');
  } finally {
    resume();
  }
}

/**
 * Everything here is a plant, a potted plant or a seed for one, so it goes by the plant's name rather
 * than its crop's: a Thunderspire grows Thunderpeel. The bare " Plant" the game tails most of them
 * with is dropped, but a Tree, Bush or Patch is kept.
 */
function speciesName(species: string): string {
  return patchName(species).replace(/ Plant$/, '');
}

function slotMutations(slots: PlantSlot[] | undefined): string[] {
  const seen = new Set<string>();
  for (const slot of slots ?? []) for (const mutation of slot.mutations ?? []) seen.add(mutation);
  return [...seen];
}

function mutationLabel(id: string): string {
  return MUTATION_CATALOG[id]?.name || id;
}

function spriteImage(src: string, fallback: string): string {
  return src ? `<img src="${escapeHtml(src)}" alt="" draggable="false">` : `<i>${escapeHtml(fallback.slice(0, 2))}</i>`;
}

function tileTitle(cell: Cell): string {
  const tile = cell.tile;
  if (!tile) return cell.kind === 'board' ? 'Boardwalk' : `Empty dirt tile ${cell.local}`;
  if (tile.objectType === 'plant') {
    const slots = tile.slots ?? [];
    const ready = slots.filter(slot => Number(slot.endTime) <= serverNow()).length;
    const mutations = slotMutations(slots).map(mutationLabel);
    return [
      speciesName(tile.species || ''),
      slots.length ? `${ready}/${slots.length} ready` : '',
      mutations.length ? mutations.join(', ') : '',
      'Drag onto an empty tile to move, right click to pot',
    ].filter(Boolean).join('\n');
  }
  if (tile.objectType === 'decor') return DECOR_CATALOG[tile.decorId || '']?.name || tile.decorId || 'Decor';
  if (tile.objectType === 'egg') return 'Egg';
  return tile.objectType || 'Occupied';
}

function cellContent(cell: Cell): string {
  const tile = cell.tile;
  if (!tile) return '';
  if (tile.objectType === 'plant') {
    const slots = tile.slots ?? [];
    const ready = slots.filter(slot => Number(slot.endTime) <= serverNow()).length;
    const badge = slots.length > 1 ? `<small>${ready}/${slots.length}</small>` : '';
    return `${spriteImage(produceSprite(tile.species || ''), tile.species || '?')}${badge}`;
  }
  if (tile.objectType === 'decor') return spriteImage(page.__gardenCompanionShopSprites?.[tile.decorId || ''] || '', tile.decorId || '?');
  const eggId = (tile as Record<string, any>).eggId as string | undefined;
  return spriteImage(eggId ? page.__gardenCompanionShopSprites?.[eggId] || '' : '', eggId || '?');
}

/** What a drop on this cell would do for the current drag, or null when it would be refused. */
function dropAction(cell: Cell): 'move' | 'swap' | 'place' | null {
  if (!drag || cell.kind !== 'dirt' || busyTiles.has(cell.local)) return null;
  // On the Celestial tab a plant can be dropped onto another plant to swap the two (plant-drag-move's
  // move does the double pot-and-replant): a plant on someone else's spot usually belongs where that
  // plant is, so one swap often finishes two steps. Elsewhere only empty tiles take a drop.
  if (cell.tile) {
    return tab === 'celestial' && drag.from === 'tile' && cell.tile.objectType === 'plant' && cell.local !== drag.local ? 'swap' : null;
  }
  return drag.from === 'tile' ? 'move' : 'place';
}

function scheduleRender(): void {
  // A redraw replaces the element being dragged, which ends the drag, so it waits for the drop.
  if (renderQueued || !isOpen()) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (drag) return;
    render();
  });
}

/**
 * The markup each part of the window was last drawn from. State patches arrive constantly, and
 * rebuilding the tiles on every one restarted their hover outline under the pointer, which read as a
 * flicker; a part whose markup has not changed is left exactly as it is.
 */
let rendered = new WeakMap<HTMLElement, string>();

function setHtml(node: HTMLElement, html: string): void {
  if (rendered.get(node) === html) return;
  rendered.set(node, html);
  // Replacing the contents empties the node for a moment, which snaps a scrolled list (the side bar's
  // celestial panel) back to the top; its position is put back once the new contents are in.
  const scroll = node.scrollTop;
  node.innerHTML = html;
  if (scroll) node.scrollTop = scroll;
}

function render(): void {
  const element = root();
  if (!element || element.hidden) return;
  const grid = element.querySelector<HTMLElement>('[data-fm-grid]')!;
  const list = element.querySelector<HTMLElement>('[data-fm-inventory]')!;
  const status = element.querySelector<HTMLElement>('[data-fm-status]')!;
  const busy = seeding || (plantActions()?.busy() ?? false);
  const stacks = seedStacks();
  if (armedSeed && (tab !== 'seeds' || !stacks.some(stack => stack.species === armedSeed))) armedSeed = null;
  const query = search.trim().toLowerCase();
  const matches = (species: string) => !query || speciesName(species).toLowerCase().includes(query);
  const allPotted = pottedPlants();
  const potted = allPotted.filter(item => matches(item.species));
  if (armedPlant && tab !== 'plants') armedPlant = null;
  // Gone from the inventory means it was planted (or sold, or fed): the plant now in its place is next.
  if (armedPlant && !allPotted.some(item => item.id === armedPlant!.id)) {
    const next = potted[Math.min(armedPlant.index, potted.length - 1)];
    armedPlant = next ? { id: next.id, index: armedPlant.index } : null;
  }
  const armedSpecies = armedSeed ?? allPotted.find(item => item.id === armedPlant?.id)?.species ?? null;
  const placing = element.querySelector<HTMLElement>('[data-fm-placing]')!;
  placing.hidden = !armedSpecies;
  if (armedSpecies) {
    const sprite = (armedSeed ? page.__gardenCompanionShopSprites?.[armedSpecies] : '') || produceSprite(armedSpecies);
    setHtml(placing, `${sprite ? `<img src="${escapeHtml(sprite)}" alt="">` : ''}Placing ${escapeHtml(speciesName(armedSpecies))}<button data-fm-disarm title="Stop placing" aria-label="Stop placing">${ICONS.close}</button>`);
  }

  const cells = farmCells();
  if (tab === 'celestial' && !celPlan && cells && !celCalculating) { requestCelestialPlan(); return; }
  const warn = element.querySelector<HTMLElement>('[data-fm-warn]')!;
  celMoves = tab === 'celestial' && celPlan ? stableMoves(celPlan, planCells(cells), busy) : [];
  // A plant dropped on the wrong tile is called out in the toolbar as well as the toast, until fixed.
  // A narrow map cuts the pill short, so the full text is on its tooltip too.
  const warning = tab === 'celestial' && celMisplaced !== null ? `${celMisplacedText} - move the plant marked 1` : '';
  warn.hidden = !warning;
  if (warn.textContent !== warning) { warn.textContent = warning; warn.title = warning; }
  // The toolbar's label doubles as the Celestial tab's progress: plants in place and moves still to make.
  // It stays up beside a wrong-spot warning, since that is when the counts matter most.
  const where = element.querySelector<HTMLElement>('[data-fm-where]')!;
  where.hidden = Boolean(armedSpecies);
  let whereText = 'Your garden';
  if (tab === 'celestial' && celPlan?.plan.size) {
    const plan = celPlan;
    const placed = planCells(cells).filter(cell => plan.plan.has(cell.local) && placedRight(plan, cell)).length;
    whereText = celMoves.length
      ? `${placed} / ${plan.plan.size} in place · ${celMoves.length} move${celMoves.length === 1 ? '' : 's'} left`
      : 'Every celestial is in place';
  }
  if (where.textContent !== whereText) where.textContent = whereText;
  const legend = element.querySelector<HTMLElement>('[data-fm-legend]')!;
  legend.hidden = tab !== 'celestial';
  if (!cells) {
    setHtml(grid, '<div class="gc-fm-empty">Waiting for your farm to load. Walk into your garden once if this does not clear.</div>');
  } else {
    const minX = Math.min(...cells.map(cell => cell.x));
    const minY = Math.min(...cells.map(cell => cell.y));
    const columns = Math.max(...cells.map(cell => cell.x)) - minX + 1;
    const rows = Math.max(...cells.map(cell => cell.y)) - minY + 1;
    // Gaps, the grid's own padding and the plot's frame come out first, so the whole farm fits across without scrolling.
    const width = Math.max(120, grid.clientWidth - 32 - 20 - (columns - 1) * CELL_GAP);
    const size = Math.max(MIN_CELL, Math.min(MAX_CELL, Math.floor(width / columns)));
    const celestial = tab === 'celestial' && celPlan ? celPlan : null;
    const plan = celestial ? planCells(cells) : [];
    const planByLocal = new Map(plan.map(cell => [cell.local, cell]));
    const stepOf = new Map(celMoves.map((move, index) => [move.from, index + 1]));
    const activeMove = shownMove();
    const annotate = (cell: Cell): { attrs: string; inner: string } => {
      if (!celestial || cell.kind !== 'dirt') return { attrs: '', inner: '' };
      const planned = celestial.plan.get(cell.local) ?? null;
      const actual = celestialOn(cell.tile);
      const planCell = planByLocal.get(cell.local)!;
      const right = planned ? placedRight(celestial, planCell) : false;
      const mustMove = Boolean(actual && !right);
      if (!planned && !actual) return { attrs: celestial.sideTiles.has(cell.local) ? ' data-cel-area="true"' : '', inner: '' };
      const state = right ? 'ok' : mustMove ? 'move' : 'planned';
      const shown = planned ?? actual!;
      const active = activeMove && (activeMove.from === cell.local || activeMove.to === cell.local);
      // Only tiles that need something carry marks: a spot still waiting for its plant shows which species
      // goes there, a plant that has to leave shows its step number. Plants already in place stay clean.
      let inner = planned && !right ? `<i class="gc-fm-cel-badge">${CELESTIAL_BADGE[planned].short}</i>` : '';
      if (mustMove) inner += `<i class="gc-fm-cel-num">${stepOf.get(cell.local) ?? '!'}</i>`;
      if (cell.local === celMisplaced) inner += '<i class="gc-fm-cel-oops">!</i>';
      // A missing plant shows faintly where it belongs.
      if (planned && !cell.tile) inner = `${spriteImage(produceSprite(planned), '')}${inner}`;
      return { attrs: ` data-cel="${state}" data-cel-area="${celestial.sideTiles.has(cell.local)}"${active ? ' data-cel-active="true"' : ''} style="--chip:${CELESTIAL_BADGE[shown].color};`, inner };
    };
    // The current step's arrow, from the plant to its spot, in board pixels.
    const centre = (local: number) => {
      const cell = cells.find(item => item.kind === 'dirt' && item.local === local);
      return cell ? { x: (cell.x - minX) * (size + CELL_GAP) + size / 2, y: (cell.y - minY) * (size + CELL_GAP) + size / 2 } : null;
    };
    const a = celestial && activeMove ? centre(activeMove.from) : null;
    const b = celestial && activeMove ? centre(activeMove.to) : null;
    const arrow = a && b ? `<svg class="gc-fm-cel-arrow"><defs><marker id="gc-fm-head" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#fde68a"/></marker></defs><line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" marker-end="url(#gc-fm-head)"/></svg>` : '';
    setHtml(grid, `<div class="gc-fm-plot"><div class="gc-fm-board" style="--gc-fm-cell:${size}px;grid-template-columns:repeat(${columns},${size}px);grid-template-rows:repeat(${rows},${size}px)">${cells.map(cell => {
      const movable = cell.kind === 'dirt' && cell.tile?.objectType === 'plant' && !busyTiles.has(cell.local) && !busy;
      const plantable = armedSpecies && cell.kind === 'dirt' && !cell.tile && !busyTiles.has(cell.local);
      const extra = annotate(cell);
      const position = `grid-column:${cell.x - minX + 1};grid-row:${cell.y - minY + 1}`;
      const style = extra.attrs.includes('style="') ? `${position}"` : ` style="${position}"`;
      return `<div class="gc-fm-cell" data-kind="${cell.kind}" data-type="${escapeHtml(cell.tile?.objectType || 'empty')}" data-local="${cell.local}"${busyTiles.has(cell.local) ? ' data-pending="true"' : ''}${plantable ? ' data-drop="place" data-armed="true"' : ''}${extra.attrs}${style} title="${escapeHtml(tileTitle(cell))}"${movable ? ' draggable="true"' : ''}>${cellContent(cell)}${extra.inner}</div>`;
    }).join('')}${edgeMarkers(size)}${arrow}</div></div>`);
  }

  const count = cells?.filter(cell => cell.kind === 'dirt' && cell.tile?.objectType === 'plant').length ?? 0;
  const free = cells?.filter(cell => cell.kind === 'dirt' && !cell.tile).length ?? 0;
  const celestials = cells?.filter(cell => cell.kind === 'dirt' && celestialOn(cell.tile)).length ?? 0;
  const pots = planterPots();
  const used = INVENTORY_SLOTS - freeInventorySlots();
  const stat = (label: string, value: string | number, bad = false) => `<span${bad ? ' data-tone="bad"' : ''}><small>${label}</small><b>${value}</b></span>`;
  setHtml(element.querySelector<HTMLElement>('[data-fm-stats]')!, [
    stat('Plants', count), stat('Empty', free), stat('Pots', pots, pots === 0), stat('Inventory', `${used}/${INVENTORY_SLOTS}`, used >= INVENTORY_SLOTS),
  ].join(''));

  const tabCounts: Record<Tab, number> = { plants: allPotted.length, seeds: stacks.length, celestial: celestials };
  element.querySelectorAll<HTMLButtonElement>('[data-fm-tab]').forEach(button => {
    const name = button.dataset.fmTab as Tab;
    button.dataset.active = String(name === tab);
    const badge = button.querySelector('em')!;
    const text = tabCounts[name] ? String(tabCounts[name]) : '';
    if (badge.textContent !== text) badge.textContent = text;
  });
  element.querySelector<HTMLElement>('[data-fm-search-wrap]')!.hidden = tab === 'celestial';
  const subtitle = element.querySelector<HTMLElement>('[data-fm-subtitle]')!;
  if (subtitle.textContent !== TAB_SUBTITLES[tab]) subtitle.textContent = TAB_SUBTITLES[tab];
  setHtml(element.querySelector<HTMLElement>('[data-fm-hints]')!, TAB_HINTS[tab].map(([key, what]) => `<span><kbd>${key}</kbd>${what}</span>`).join(''));
  const head = element.querySelector<HTMLElement>('[data-fm-list-head]')!;
  if (tab === 'celestial') {
    setHtml(head, '<b>Celestial planner</b>');
    setHtml(list, celestialPanel(cells));
  } else if (tab === 'seeds') {
    const seeds = stacks.filter(stack => matches(stack.species));
    setHtml(head, `<b>Seeds</b><small>${seeds.length} kind${seeds.length === 1 ? '' : 's'}</small>`);
    setHtml(list, seeds.length
      ? seeds.map(stack => listCard(
        ` data-seed="${escapeHtml(stack.species)}"${stack.species === armedSeed ? ' data-active="true"' : ''}${busy ? '' : ' draggable="true"'} title="${escapeHtml(speciesName(stack.species))}\nClick to place on empty tiles, or drag onto one${stack.stored ? `\n${stack.stored} in the Seed Silo` : ''}"`,
        spriteImage(page.__gardenCompanionShopSprites?.[stack.species] || produceSprite(stack.species), stack.species),
        speciesName(stack.species),
        `<em class="gc-fm-qty">${stack.loose + stack.stored}</em>${stack.stored ? '<i class="gc-fm-silo">Silo</i>' : ''}`,
      )).join('')
      : `<div class="gc-fm-empty">${query ? 'No seeds match.' : 'No seeds in your inventory or Seed Silo.'}</div>`);
  } else {
    setHtml(head, `<b>Potted plants</b><small>${potted.length}${query ? ` of ${allPotted.length}` : ''}</small>`);
    setHtml(list, potted.length
      ? potted.map((item, index) => listCard(
        ` data-item="${escapeHtml(item.id)}" data-index="${index}"${item.id === armedPlant?.id ? ' data-active="true"' : ''}${busy ? '' : ' draggable="true"'} title="${escapeHtml(speciesName(item.species))}\nClick to place on empty tiles, or drag onto one"`,
        spriteImage(produceSprite(item.species), item.species),
        speciesName(item.species),
      )).join('')
      : `<div class="gc-fm-empty">${query ? 'No potted plants match.' : 'No potted plants in your inventory. Drag a plant here or right click it on the map to pot it.'}</div>`);
  }

  const footer = element.querySelector<HTMLElement>('footer')!;
  footer.dataset.busy = String(busy || busyTiles.size > 0);
  if (!busy && tab === 'celestial') {
    const text = celMoves.length
      ? `Drag the plant marked 1 to the tile the arrow points at - drop onto a plant to swap them. A move uses a Planter Pot, a swap two (${pots} left).`
      : celPlan?.plan.size ? 'Every celestial is in place.' : 'Plant some celestials to plan a layout.';
    if (status.textContent !== text) status.textContent = text;
  } else if (!busy) {
    const text = armedSpecies
      ? `${free} empty tiles. Click a highlighted tile to plant ${speciesName(armedSpecies)}; click it in the list again to stop.`
      : tab === 'seeds'
        ? 'Pick a seed, then click empty tiles to plant it, or drag a seed onto a tile.'
        : 'Drag a plant onto an empty tile to move it, or right click it to pot it. Each uses a Planter Pot.';
    if (status.textContent !== text) status.textContent = text;
  }
}

function cellFor(local: number): Cell | undefined {
  return farmCells()?.find(cell => cell.kind === 'dirt' && cell.local === local);
}

function markTargets(): void {
  root()?.querySelectorAll<HTMLElement>('.gc-fm-cell').forEach(node => {
    const cell = node.dataset.kind === 'dirt' ? cellFor(Number(node.dataset.local)) : undefined;
    const action = cell ? dropAction(cell) : null;
    if (action) node.dataset.drop = action;
    else delete node.dataset.drop;
  });
}

function clearDrag(): void {
  drag = null;
  // The drag marked tiles in place, outside the markup, so the next draw has to start fresh.
  rendered = new WeakMap();
  root()?.classList.remove('gc-fm-dragging');
  if (root()) delete root()!.dataset.potting;
  root()?.querySelectorAll<HTMLElement>('[data-drop],[data-over]').forEach(node => {
    delete node.dataset.drop;
    delete node.dataset.over;
  });
  scheduleRender();
}

/**
 * Every move off a tile spends a Planter Pot, from the inventory or fetched out of the Tool Shack.
 * Checked before anything is sent, so a move with no pot to spend never lifts the plant at all.
 */
function planterPots(): number {
  return heldToolCount('PlanterPot');
}

function refusePotless(): boolean {
  if (planterPots() > 0) return false;
  toast('You need a Planter Pot to move plants.', 'error');
  return true;
}

/** A plant dragged off the farm onto the side bar goes into the inventory in a Planter Pot. */
async function potFromTile(local: number): Promise<void> {
  const actions = plantActions();
  // Refused before the pending tiles are touched: they belong to the move still running.
  if (!actions || seeding || actions.busy()) {
    toast(actions ? 'Finish the current move first.' : 'Plant moving is not ready yet.', 'error');
    return;
  }
  if (refusePotless()) return;
  const status = root()?.querySelector<HTMLElement>('[data-fm-status]');
  busyTiles = new Set([local]);
  if (status) status.textContent = 'Potting plant...';
  render();
  try {
    await actions.pot(local);
  } catch (error) {
    toast(`Potting stopped: ${(error as Error).message}.`, 'error');
  } finally {
    busyTiles = new Set();
    render();
  }
}

async function perform(work: Drag, target: Cell): Promise<void> {
  const actions = plantActions();
  if (work.from === 'seed') {
    if (seeding || actions?.busy()) {
      toast('Finish the current move first.', 'error');
      return;
    }
    seeding = true;
  } else if (!actions || seeding || actions.busy()) {
    toast(actions ? 'Finish the current move first.' : 'Plant moving is not ready yet.', 'error');
    return;
  }
  if (work.from === 'tile') {
    if (refusePotless()) return;
    // The plant passes through the inventory on its way to the new tile, so it needs a slot there; a swap
    // lifts both plants, so it needs two slots and two pots.
    const swap = Boolean(target.tile);
    if (swap && planterPots() < 2) {
      toast('A swap needs two Planter Pots.', 'error');
      return;
    }
    if (freeInventorySlots() < (swap ? 2 : 1)) {
      toast(swap ? 'A swap needs two free inventory slots.' : 'Your inventory is full, so the plant cannot be lifted. Free a slot first.', 'error');
      return;
    }
  }
  const status = root()?.querySelector<HTMLElement>('[data-fm-status]');
  const involved = work.from === 'tile' ? [work.local, target.local] : [target.local];
  busyTiles = new Set(involved);
  if (status) status.textContent = work.from !== 'tile' ? 'Planting...' : target.tile ? 'Swapping plants...' : 'Moving plant...';
  render();
  try {
    if (work.from === 'seed') await plantSeed(work.species, target.local);
    else if (work.from === 'tile') {
      await actions!.move(work.local, target.local);
      if (tab === 'celestial') checkCelestialDrop(target.local);
    }
    else await actions!.replant(target.local, work.itemId);
  } catch (error) {
    toast(`Move stopped: ${(error as Error).message}.`, 'error');
  } finally {
    if (work.from === 'seed') seeding = false;
    busyTiles = new Set();
    render();
  }
}

function bindEvents(element: HTMLElement): void {
  element.addEventListener('dragstart', event => {
    const target = event.target as HTMLElement;
    const cellNode = target.closest<HTMLElement>('.gc-fm-cell[draggable="true"]');
    const itemNode = target.closest<HTMLElement>('.gc-fm-item[draggable="true"]');
    if (cellNode && refusePotless()) {
      event.preventDefault();
      return;
    }
    if (cellNode) drag = { from: 'tile', local: Number(cellNode.dataset.local) };
    else if (itemNode?.dataset.seed) drag = { from: 'seed', species: itemNode.dataset.seed };
    else if (itemNode?.dataset.item) {
      drag = { from: 'inventory', itemId: itemNode.dataset.item };
      armedPlant = { id: itemNode.dataset.item, index: Number(itemNode.dataset.index) || 0 };
    }
    else return;
    event.dataTransfer?.setData('text/plain', 'gc-farm-manager');
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    element.classList.add('gc-fm-dragging');
    // A full inventory has no room for the potted plant, so the side bar says so instead of taking it.
    if (drag.from === 'tile') element.dataset.potting = freeInventorySlots() > 0 ? 'true' : 'full';
    markTargets();
  });
  element.addEventListener('dragover', event => {
    const aside = (event.target as HTMLElement).closest<HTMLElement>('aside');
    if (aside && drag?.from === 'tile' && freeInventorySlots() > 0) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      aside.dataset.over = 'true';
      return;
    }
    const node = (event.target as HTMLElement).closest<HTMLElement>('.gc-fm-cell');
    if (!drag || !node?.dataset.drop) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    if (!node.dataset.over) {
      element.querySelectorAll<HTMLElement>('[data-over]').forEach(other => delete other.dataset.over);
      node.dataset.over = 'true';
    }
  });
  element.addEventListener('dragleave', event => {
    const aside = (event.target as HTMLElement).closest<HTMLElement>('aside');
    if (aside && !aside.contains(event.relatedTarget as Node | null)) delete aside.dataset.over;
    const node = (event.target as HTMLElement).closest<HTMLElement>('.gc-fm-cell');
    if (node && !node.contains(event.relatedTarget as Node | null)) delete node.dataset.over;
  });
  element.addEventListener('drop', event => {
    if ((event.target as HTMLElement).closest('aside') && drag?.from === 'tile' && freeInventorySlots() > 0) {
      event.preventDefault();
      const local = drag.local;
      clearDrag();
      void potFromTile(local);
      return;
    }
    const node = (event.target as HTMLElement).closest<HTMLElement>('.gc-fm-cell');
    const work = drag;
    if (!work || !node?.dataset.drop) return;
    event.preventDefault();
    // Read again at the drop: the farm may have changed while the drag was in the air.
    const target = cellFor(Number(node.dataset.local));
    clearDrag();
    if (!target || !dropActionFor(work, target)) {
      toast('That tile changed during the drag.', 'error');
      return;
    }
    void perform(work, target);
  });
  element.addEventListener('dragend', clearDrag);
  // Celestial tab: hovering a binder on the map lights the plants it buffs. The coverage marks are set on the tiles directly, so the board is not redrawn per tile.
  element.addEventListener('mouseover', event => {
    if (tab !== 'celestial' || drag) return;
    const target = event.target as HTMLElement;
    const node = target.closest<HTMLElement>('.gc-fm-cell[data-kind="dirt"]');
    element.querySelectorAll<HTMLElement>('[data-cel-lit],[data-cel-source]').forEach(other => { delete other.dataset.celLit; delete other.dataset.celSource; });
    // A numbered plant under the pointer gets the arrow; anywhere else it goes back to move 1.
    const local = node ? Number(node.dataset.local) : null;
    showCelestialMove(celMoves.some(move => move.from === local) ? local : null);
    if (!node) return;
    const cells = planCells(farmCells());
    const cell = cells.find(item => item.local === Number(node.dataset.local));
    const kind = cell ? binderOn(celPlan, cell) : null;
    if (!cell || !kind) return;
    node.dataset.celSource = kind;
    for (const other of neighboursOf(cell, cells, celPlan)) {
      if (!celestialOn(other.tile) && !celPlan?.plan.has(other.local)) continue;
      const otherNode = element.querySelector<HTMLElement>(`.gc-fm-cell[data-kind="dirt"][data-local="${other.local}"]`);
      if (otherNode) otherNode.dataset.celLit = kind;
    }
  });
  element.addEventListener('mouseleave', () => {
    element.querySelectorAll<HTMLElement>('[data-cel-lit],[data-cel-source]').forEach(other => { delete other.dataset.celLit; delete other.dataset.celSource; });
    if (tab === 'celestial') showCelestialMove(null);
  });
  // Right click pots a plant straight into the inventory, the same as dragging it to the side bar.
  element.addEventListener('contextmenu', event => {
    const target = event.target as HTMLElement;
    // The whole map is a right click target, gaps between tiles included, so a near miss on a plant
    // does nothing rather than opening the browser's menu over the farm.
    if (!target.closest('[data-fm-grid]')) return;
    event.preventDefault();
    // On the Celestial tab the map is for following the plan, so a stray right click never pots a plant.
    if (tab === 'celestial') return;
    const cellNode = target.closest<HTMLElement>('.gc-fm-cell[data-kind="dirt"][data-type="plant"]');
    if (!cellNode) return;
    if (cellNode.dataset.pending) return;
    if (freeInventorySlots() < 1) {
      toast('Your inventory is full, so the plant cannot be potted.', 'error');
      return;
    }
    void potFromTile(Number(cellNode.dataset.local));
  });
  element.addEventListener('click', event => {
    const target = event.target as HTMLElement;
    if (target.closest('[data-fm-disarm]')) {
      armedSeed = null;
      armedPlant = null;
      render();
      return;
    }
    const side = target.closest<HTMLElement>('[data-cel-side]')?.dataset.celSide;
    if (side === 'left' || side === 'right') {
      celSide = side;
      requestCelestialPlan();
      return;
    }
    const goal = target.closest<HTMLElement>('[data-cel-goal]')?.dataset.celGoal;
    if (goal) {
      celGoal = goal as CelestialGoal;
      requestCelestialPlan();
      return;
    }
    if (target.closest('[data-cel-refresh]')) {
      // Always a fresh search: skips the remembered plan and tries a new seed.
      requestCelestialPlan(true);
      return;
    }
    const plantNode = target.closest<HTMLElement>('.gc-fm-item[data-item]');
    if (plantNode) {
      const id = plantNode.dataset.item!;
      armedPlant = armedPlant?.id === id ? null : { id, index: Number(plantNode.dataset.index) || 0 };
      render();
      return;
    }
    const seedNode = target.closest<HTMLElement>('.gc-fm-item[data-seed]');
    if (seedNode) {
      const species = seedNode.dataset.seed!;
      armedSeed = armedSeed === species ? null : species;
      render();
      return;
    }
    const cellNode = target.closest<HTMLElement>('.gc-fm-cell[data-armed]');
    if (!cellNode || (!armedSeed && !armedPlant)) return;
    const cell = cellFor(Number(cellNode.dataset.local));
    const work: Drag = armedSeed ? { from: 'seed', species: armedSeed } : { from: 'inventory', itemId: armedPlant!.id };
    if (!cell || !dropActionFor(work, cell)) {
      toast('That tile is no longer empty.', 'error');
      render();
      return;
    }
    void perform(work, cell);
  });
}

function dropActionFor(work: Drag, cell: Cell): ReturnType<typeof dropAction> {
  const previous = drag;
  drag = work;
  try { return dropAction(cell); } finally { drag = previous; }
}

function ensurePanel(): HTMLElement {
  const existing = root();
  if (existing) return existing;
  const element = document.createElement('section');
  element.id = 'gc-farm-manager';
  element.hidden = true;
  element.dataset.gcUi = '';
  const tabButton = (name: Tab, label: string) => `<button data-fm-tab="${name}">${ICONS[name]}<span>${label}</span><em></em></button>`;
  element.innerHTML = `<header><div class="gc-fm-title"><span class="gc-fm-logo">${ICONS.farm}</span><div><b>Farm Manager</b><small data-fm-subtitle></small></div></div>
<nav class="gc-fm-tabs">${tabButton('plants', 'Plants')}${tabButton('seeds', 'Seeds')}${tabButton('celestial', 'Celestials')}</nav>
<div class="gc-fm-head-end"><div class="gc-fm-stats" data-fm-stats></div><button class="gc-fm-close" data-fm-close aria-label="Close">${ICONS.close}</button></div></header>
<main><div class="gc-fm-stage"><div class="gc-fm-toolbar" data-no-drag><span><b class="gc-fm-where" data-fm-where>Your garden</b><b class="gc-fm-placing" data-fm-placing hidden></b><b class="gc-fm-warn" data-fm-warn hidden></b></span><span class="gc-fm-legend" data-fm-legend hidden><span><i class="gc-fm-legend-mix" style="--g:linear-gradient(135deg,${Object.values(CELESTIAL_BADGE).map(badge => badge.color).join(',')})"></i>Planned spot</span><span><i style="--c:#fb7185"></i>Must move</span><span><i style="--c:#4ade80"></i>In place</span><span><i style="--c:#fde68a"></i>Current step</span></span></div><div class="gc-fm-grid" data-fm-grid data-no-drag></div></div><aside data-no-drag><div class="gc-fm-list-head" data-fm-list-head></div><label class="gc-fm-search" data-fm-search-wrap>${ICONS.search}<input data-fm-search placeholder="Search" spellcheck="false"></label><div class="gc-fm-list" data-fm-inventory></div></aside></main>
<footer><i class="gc-fm-dot"></i><span class="gc-fm-status" data-fm-status></span><span class="gc-fm-hints" data-fm-hints></span></footer>`;
  element.querySelector<HTMLButtonElement>('[data-fm-close]')!.onclick = () => { element.hidden = true; };
  // The game reads movement and hotkeys from window, so typing a search must not reach it.
  const input = element.querySelector<HTMLInputElement>('[data-fm-search]')!;
  for (const type of ['keydown', 'keyup', 'keypress'] as const) input.addEventListener(type, event => event.stopPropagation());
  input.addEventListener('input', () => { search = input.value; render(); });
  element.querySelectorAll<HTMLButtonElement>('[data-fm-tab]').forEach(button => button.onclick = () => {
    tab = button.dataset.fmTab as Tab;
    // Each visit to the Celestial tab plans from the garden as it is now.
    if (tab === 'celestial') celPlan = null;
    render();
  });
  bindEvents(element);
  document.body.appendChild(element);
  makeDraggable(element, POSITION_KEY, { handle: 'header' });
  return element;
}

function toggle(): void {
  const element = ensurePanel();
  element.hidden = !element.hidden;
  if (element.hidden) return;
  if (tab === 'celestial') celPlan = null;
  // Decor artwork is only decoded on demand, and the map draws the decor around your tiles.
  page.__gardenCompanionLoadSpriteGroup?.('deferred');
  render();
}

export function initFarmManager(): void {
  page.__gardenCompanionToggleFarmManager = toggle;
  onStateChange(scheduleRender);
  onSpritesReady(scheduleRender);
  window.addEventListener('resize', scheduleRender);
}
