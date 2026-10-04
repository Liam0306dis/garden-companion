import { DECOR_CATALOG, MUTATION_CATALOG, patchName } from '../constants.js';
import { makeDraggable } from '../draggable.js';
import { page } from '../page.js';
import { freeInventorySlots, heldToolCount, mutationSprite, onSpritesReady, produceSprite } from '../pets.js';
import { onStateChange, state } from '../state.js';
import { sendQuinoaCommand } from '../game-connection.js';
import { pauseAutoStore } from './auto-store.js';
import { toast } from '../toast.js';
import type { GardenTile, PlantSlot } from '../types.js';
import { escapeHtml } from '../utils.js';
import { plantActions } from './plant-drag-move.js';

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
let tab: 'plants' | 'seeds' = 'plants';
/**
 * The seed picked on the Seeds tab, which every click on an empty tile plants until the same seed
 * is clicked again, another is picked, the Plants tab is opened, or the seeds run out.
 */
let armedSeed: string | null = null;
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

function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  return new Promise(resolve => {
    const poll = window.setInterval(() => {
      let done = false;
      try { done = condition(); } catch {}
      if (done || Date.now() - started >= timeoutMs) {
        window.clearInterval(poll);
        resolve(done);
      }
    }, 100);
  });
}

/**
 * A seed has to be loose to plant, so one still in the Seed Silo is taken out first. Auto-store is
 * paused across the whole of it: it files seeds whose species the Silo already holds, which is
 * exactly the seed just taken out, and would put it back before PlantSeed could use it.
 */
async function plantSeed(species: string, local: number): Promise<void> {
  const resume = pauseAutoStore('Seed');
  try {
    if (looseSeeds(species) <= 0) {
      const stored = seedStacks().find(stack => stack.species === species)?.stored ?? 0;
      if (stored <= 0) throw new Error(`No ${speciesName(species)} seeds are left`);
      sendQuinoaCommand({ type: 'RetrieveItemFromStorage', itemId: species, storageId: SEED_SILO, quantity: 1 });
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

function mutationIcons(mutations: string[]): string {
  if (!mutations.length) return '';
  return `<span class="gc-fm-muts">${mutations.slice(0, 3).map(id => {
    const sprite = mutationSprite(id);
    return sprite ? `<img src="${escapeHtml(sprite)}" alt="">` : `<b>${escapeHtml(mutationLabel(id).slice(0, 1))}</b>`;
  }).join('')}</span>`;
}

function spriteImage(src: string, fallback: string): string {
  return src ? `<img src="${escapeHtml(src)}" alt="" draggable="false">` : `<i>${escapeHtml(fallback.slice(0, 2))}</i>`;
}

function tileTitle(cell: Cell): string {
  const tile = cell.tile;
  if (!tile) return cell.kind === 'board' ? 'Boardwalk' : `Empty dirt tile ${cell.local}`;
  if (tile.objectType === 'plant') {
    const slots = tile.slots ?? [];
    const ready = slots.filter(slot => Number(slot.endTime) <= Date.now()).length;
    const mutations = slotMutations(slots).map(mutationLabel);
    return [
      speciesName(tile.species || ''),
      slots.length ? `${ready}/${slots.length} ready` : '',
      mutations.length ? mutations.join(', ') : '',
      'Drag onto an empty tile to move',
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
    const ready = slots.filter(slot => Number(slot.endTime) <= Date.now()).length;
    const badge = slots.length > 1 ? `<small>${ready}/${slots.length}</small>` : '';
    return `${spriteImage(produceSprite(tile.species || ''), tile.species || '?')}${mutationIcons(slotMutations(slots))}${badge}`;
  }
  if (tile.objectType === 'decor') return spriteImage(page.__gardenCompanionShopSprites?.[tile.decorId || ''] || '', tile.decorId || '?');
  const eggId = (tile as Record<string, any>).eggId as string | undefined;
  return spriteImage(eggId ? page.__gardenCompanionShopSprites?.[eggId] || '' : '', eggId || '?');
}

/** What a drop on this cell would do for the current drag, or null when it would be refused. */
function dropAction(cell: Cell): 'move' | 'place' | null {
  if (!drag || cell.kind !== 'dirt' || cell.tile || busyTiles.has(cell.local)) return null;
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
  node.innerHTML = html;
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
  const placing = element.querySelector<HTMLElement>('[data-fm-placing]')!;
  placing.hidden = !armedSeed;
  if (armedSeed) {
    const sprite = page.__gardenCompanionShopSprites?.[armedSeed] || produceSprite(armedSeed);
    setHtml(placing, `${sprite ? `<img src="${escapeHtml(sprite)}" alt="">` : ''}Placing ${escapeHtml(speciesName(armedSeed))}`);
  }

  const cells = farmCells();
  if (!cells) {
    setHtml(grid, '<div class="gc-fm-empty">Waiting for your farm to load. Walk into your garden once if this does not clear.</div>');
  } else {
    const minX = Math.min(...cells.map(cell => cell.x));
    const minY = Math.min(...cells.map(cell => cell.y));
    const columns = Math.max(...cells.map(cell => cell.x)) - minX + 1;
    const rows = Math.max(...cells.map(cell => cell.y)) - minY + 1;
    // Gaps and the grid's own padding come out first, so the whole farm fits across without scrolling.
    const width = Math.max(120, grid.clientWidth - 24 - (columns - 1) * CELL_GAP);
    const size = Math.max(MIN_CELL, Math.min(MAX_CELL, Math.floor(width / columns)));
    setHtml(grid, `<div class="gc-fm-board" style="--gc-fm-cell:${size}px;grid-template-columns:repeat(${columns},${size}px);grid-template-rows:repeat(${rows},${size}px)">${cells.map(cell => {
      const movable = cell.kind === 'dirt' && cell.tile?.objectType === 'plant' && !busyTiles.has(cell.local) && !busy;
      const plantable = armedSeed && cell.kind === 'dirt' && !cell.tile && !busyTiles.has(cell.local);
      return `<div class="gc-fm-cell" data-kind="${cell.kind}" data-type="${escapeHtml(cell.tile?.objectType || 'empty')}" data-local="${cell.local}"${busyTiles.has(cell.local) ? ' data-pending="true"' : ''}${plantable ? ' data-drop="place" data-armed="true"' : ''} style="grid-column:${cell.x - minX + 1};grid-row:${cell.y - minY + 1}" title="${escapeHtml(tileTitle(cell))}"${movable ? ' draggable="true"' : ''}>${cellContent(cell)}</div>`;
    }).join('')}</div>`);
  }

  element.querySelectorAll<HTMLButtonElement>('[data-fm-tab]').forEach(button => {
    button.dataset.active = String(button.dataset.fmTab === tab);
  });
  const capacity = element.querySelector<HTMLElement>('[data-fm-capacity]')!;
  capacity.hidden = tab !== 'plants';
  const used = INVENTORY_SLOTS - freeInventorySlots();
  capacity.dataset.full = String(used >= INVENTORY_SLOTS);
  setHtml(capacity, `<span>Inventory</span><b>${used}/${INVENTORY_SLOTS}</b>`);
  const query = search.trim().toLowerCase();
  const matches = (species: string) => !query || speciesName(species).toLowerCase().includes(query);
  if (tab === 'seeds') {
    const seeds = stacks.filter(stack => matches(stack.species));
    setHtml(list, seeds.length
      ? seeds.map(stack => `<div class="gc-fm-item" data-seed="${escapeHtml(stack.species)}"${stack.species === armedSeed ? ' data-active="true"' : ''}${busy ? '' : ' draggable="true"'} title="Click to place on empty tiles, or drag onto one${stack.stored ? `\n${stack.stored} in the Seed Silo` : ''}">${spriteImage(page.__gardenCompanionShopSprites?.[stack.species] || produceSprite(stack.species), stack.species)}<span><b>${escapeHtml(speciesName(stack.species))}</b><small>x${stack.loose + stack.stored}${stack.stored ? ' · Silo' : ''}</small></span></div>`).join('')
      : `<div class="gc-fm-empty">${query ? 'No seeds match.' : 'No seeds in your inventory or Seed Silo.'}</div>`);
  } else {
    const potted = pottedPlants().filter(item => matches(item.species));
    setHtml(list, potted.length
      ? potted.map(item => `<div class="gc-fm-item" data-item="${escapeHtml(item.id)}"${busy ? '' : ' draggable="true"'} title="Drag onto an empty dirt tile to plant">${spriteImage(produceSprite(item.species), item.species)}<span><b>${escapeHtml(speciesName(item.species))}</b></span></div>`).join('')
      : `<div class="gc-fm-empty">${query ? 'No potted plants match.' : 'No potted plants in your inventory.'}</div>`);
  }

  const count = cells?.filter(cell => cell.kind === 'dirt' && cell.tile?.objectType === 'plant').length ?? 0;
  const free = cells?.filter(cell => cell.kind === 'dirt' && !cell.tile).length ?? 0;
  if (!busy) {
    const text = armedSeed
      ? `${free} empty tiles. Click a highlighted tile to plant ${speciesName(armedSeed)}; click the seed again to stop.`
      : `${count} plants, ${free} empty tiles, ${planterPots()} Planter Pots. Drag a plant onto an empty tile to move it; each move uses a Planter Pot.`;
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
  if (!actions || seeding) {
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
  } else if (!actions || seeding) {
    toast(actions ? 'Finish the current move first.' : 'Plant moving is not ready yet.', 'error');
    return;
  }
  if (work.from === 'tile') {
    if (refusePotless()) return;
    // The plant passes through the inventory on its way to the new tile, so it needs a slot there.
    if (freeInventorySlots() < 1) {
      toast('Your inventory is full, so the plant cannot be lifted. Free a slot first.', 'error');
      return;
    }
  }
  const status = root()?.querySelector<HTMLElement>('[data-fm-status]');
  const involved = work.from === 'tile' ? [work.local, target.local] : [target.local];
  busyTiles = new Set(involved);
  if (status) status.textContent = work.from !== 'tile' ? 'Planting...' : 'Moving plant...';
  render();
  try {
    if (work.from === 'seed') await plantSeed(work.species, target.local);
    else if (work.from === 'tile') await actions!.move(work.local, target.local);
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
    else if (itemNode?.dataset.item) drag = { from: 'inventory', itemId: itemNode.dataset.item };
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
  element.addEventListener('click', event => {
    const target = event.target as HTMLElement;
    const seedNode = target.closest<HTMLElement>('.gc-fm-item[data-seed]');
    if (seedNode) {
      const species = seedNode.dataset.seed!;
      armedSeed = armedSeed === species ? null : species;
      render();
      return;
    }
    const cellNode = target.closest<HTMLElement>('.gc-fm-cell[data-armed]');
    if (!cellNode || !armedSeed) return;
    const cell = cellFor(Number(cellNode.dataset.local));
    const work: Drag = { from: 'seed', species: armedSeed };
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
  element.innerHTML = `<header><div><i></i><span>Farm Manager</span><b class="gc-fm-placing" data-fm-placing hidden></b></div><button data-fm-close aria-label="Close">×</button></header>
<main><div class="gc-fm-grid" data-fm-grid data-no-drag></div><aside data-no-drag><div class="gc-fm-tabs"><button data-fm-tab="plants">Plants</button><button data-fm-tab="seeds">Seeds</button></div><div class="gc-fm-capacity" data-fm-capacity hidden></div><input data-fm-search placeholder="Search" spellcheck="false"><div class="gc-fm-list" data-fm-inventory></div></aside></main>
<footer data-fm-status></footer>`;
  element.querySelector<HTMLButtonElement>('[data-fm-close]')!.onclick = () => { element.hidden = true; };
  // The game reads movement and hotkeys from window, so typing a search must not reach it.
  const input = element.querySelector<HTMLInputElement>('[data-fm-search]')!;
  for (const type of ['keydown', 'keyup', 'keypress'] as const) input.addEventListener(type, event => event.stopPropagation());
  input.addEventListener('input', () => { search = input.value; render(); });
  element.querySelectorAll<HTMLButtonElement>('[data-fm-tab]').forEach(button => button.onclick = () => {
    tab = button.dataset.fmTab as typeof tab;
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
