import type { PlantSlot } from '../types.js';
import { PLANT_CATALOG, plantName, patchName, mutationName } from '../constants.js';
import { slotScale, slotSizePercent } from '../crop-size.js';
import { page } from '../page.js';
import { findPixiCard } from '../pixi.js';
import { sendQuinoaCommand, gameConnectionReady } from '../game-connection.js';
import { catalogMutationMultiplier } from '../mutation-value.js';
import { produceSprite, mutationSprite, onSpritesReady } from '../pets.js';
import { state } from '../state.js';
import { toast } from '../toast.js';
import { escapeHtml, NUMBER_LOCALE } from '../utils.js';

/**
 * Preserving a whole potted plant in one go. The game preserves the selected slot only, so standing
 * at the station with a six-slot plant means six trips through its confirm; this offers one button
 * that walks the slots itself.
 *
 * Alongside it sits a preservation manager: a dialog over EVERY potted plant in the inventory - not
 * just the one in hand - grouped by plant and listing each ready slot, so a run can be picked slot by
 * slot with a live total of what it will cost. Preserve is a server command carrying the plant's own
 * itemId, so it stands on its own for any owned plant; the manager sends one per ticked slot the same
 * way the held-plant button does, without needing that plant to be the one being held.
 *
 * The eligibility and price rules are the game's own preserve handler: a slot must not already be
 * preserved and must have finished growing, and each one costs what the crop is worth on its own -
 * base price by size by mutations, with no room bonus. Getting the price wrong here would be the
 * server rejecting requests halfway through a batch, so it is worth matching exactly.
 */

/** How long the button must be held, matching the feel of the game's own press-and-hold. */
const HOLD_MS = 650;
/** Requests are spaced out so a long batch does not arrive as one burst. */
const SEND_INTERVAL = 100;
/**
 * The most slots one press of the manager will preserve. Preserving hundreds in a single stroke
 * floods the socket and gives no chance to stop, so a run is capped and the player presses again for
 * the next chunk - a deliberate gate, not a convenience.
 */
const MANAGER_BATCH_CAP = 15;
/** Clearance between our bar and the game's own crop card. */
const ANCHOR_GAP = 12;

interface EligibleSlot {
  slotId: string | number;
  species: string;
  cost: number;
}

/** A ready slot as the manager lists it: enough to draw the row and to send the request. */
interface ManagerSlot {
  key: string;
  itemId: string;
  slotId: string | number;
  species: string;
  cost: number;
  sizePercent: number;
  mutations: string[];
}

interface ManagerPlant {
  itemId: string;
  species: string;
  name: string;
  rows: ManagerSlot[];
}

let sending = false;
let lastSignature = '';
let holdStartedAt = 0;
let holdFrame = 0;

/**
 * The plant being preserved is held, not stood on, so its grow slots are not in state.currentCrop
 * (that only tracks the tile underfoot). A held potted plant is the selected inventory item with
 * itemType 'Plant', and it carries its own grow slots - the same object the game's own preserve
 * handler reads (Preserve is sent with itemId = that item's id, growSlotIdx = a slot's slotId).
 */
function heldPlantItem(): { id: string; slots: PlantSlot[] } | null {
  const id = state.selectedItemId;
  if (!id) return null;
  const items = state.slot?.data?.inventory?.items as
    | Array<{ id?: string; itemType?: string; slots?: PlantSlot[] }>
    | undefined;
  if (!Array.isArray(items)) return null;
  const item = items.find(entry => entry?.id === id && entry?.itemType === 'Plant');
  return item && Array.isArray(item.slots) ? { id, slots: item.slots } : null;
}

function heldSlots(): PlantSlot[] {
  return heldPlantItem()?.slots ?? [];
}

/**
 * Favourited plants are kept out of the manager - the request is to never offer one for preserving.
 * The game marks a favourite not on the item but in `inventory.favoritedItemIds`, a flat list of the
 * item ids the player has starred, so membership there is what hides a plant.
 */
function favouritedItemIds(): Set<string> {
  const ids = (state.slot?.data?.inventory as { favoritedItemIds?: unknown } | undefined)?.favoritedItemIds;
  return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []);
}

/** Every potted plant in the inventory, held or not, each with its own grow slots; favourites omitted. */
function allPlantItems(): Array<{ id: string; species: string; slots: PlantSlot[] }> {
  const items = state.slot?.data?.inventory?.items as unknown as
    | Array<{ id?: string; itemType?: string; species?: string; slots?: PlantSlot[] }>
    | undefined;
  if (!Array.isArray(items)) return [];
  const favourites = favouritedItemIds();
  const out: Array<{ id: string; species: string; slots: PlantSlot[] }> = [];
  for (const item of items) {
    if (item?.itemType !== 'Plant' || !item.id || !Array.isArray(item.slots)) continue;
    if (favourites.has(item.id)) continue;
    out.push({ id: item.id, species: item.species || '', slots: item.slots });
  }
  return out;
}

function preserveCost(species: string, slot: PlantSlot, mutations: readonly string[]): number {
  const crop = PLANT_CATALOG[species]?.crop;
  const base = Number(crop?.baseSellPrice) || 0;
  return Math.round(base * slotScale(crop, slot) * catalogMutationMultiplier(mutations));
}

/** The ready slots of one plant, in the order they sit on it. Shared by the held button and manager. */
function eligibleFrom(slots: PlantSlot[]): EligibleSlot[] {
  const now = Date.now();
  const rows: EligibleSlot[] = [];
  for (const slot of slots) {
    if (!slot || slot.preserved === true || slot.slotId == null) continue;
    if (Number(slot.endTime || 0) > now) continue;
    const species = slot.species || '';
    if (!species) continue;
    rows.push({ slotId: slot.slotId, species, cost: preserveCost(species, slot, slot.mutations || []) });
  }
  return rows;
}

function eligibleSlots(): EligibleSlot[] {
  return eligibleFrom(heldSlots());
}

function coins(): number {
  return Number(state.slot?.data?.coinsCount) || 0;
}

function cropLabel(rows: Array<{ species: string }>): string {
  const species = [...new Set(rows.map(row => row.species))];
  return species.length === 1 ? plantName(species[0]) : `${species.length} crops`;
}

// --- Preservation manager ------------------------------------------------------------------------

const MANAGER_ID = 'gc-preserve-manager';

/** Ticked slots, keyed itemId::slotId so the same slot on two plants can never collide. */
const selected = new Set<string>();
/** The search box's text, lower-cased; filters the list only, never what a run preserves. */
let managerSearch = '';
let managerHoldAt = 0;
let managerHoldFrame = 0;
/** Progress of the batch in flight, so the footer can draw the bar and count while it sends. */
let batchTotal = 0;
let batchDone = 0;
/** True once a batch has run and left ticks behind, so the button asks to continue rather than start. */
let managerAwaitingContinue = false;

function slotKey(itemId: string, slotId: string | number): string {
  return `${itemId}::${slotId}`;
}

/**
 * Every plant with at least one ready slot, ordered by plant name and then by the slots' own order
 * on the plant - the grouping the request asked for. A plant reports its own species; a slot's own
 * species is the fallback for the odd mixed pot.
 */
function managerPlants(): ManagerPlant[] {
  const plants: ManagerPlant[] = [];
  for (const item of allPlantItems()) {
    const rows: ManagerSlot[] = [];
    const now = Date.now();
    for (const slot of item.slots) {
      if (!slot || slot.preserved === true || slot.slotId == null) continue;
      if (Number(slot.endTime || 0) > now) continue;
      const species = slot.species || item.species || '';
      if (!species) continue;
      const crop = PLANT_CATALOG[species]?.crop;
      rows.push({
        key: slotKey(item.id, slot.slotId),
        itemId: item.id,
        slotId: slot.slotId,
        species,
        cost: preserveCost(species, slot, slot.mutations || []),
        sizePercent: slotSizePercent(crop, slot),
        mutations: Array.isArray(slot.mutations) ? slot.mutations.filter(m => typeof m === 'string') : [],
      });
    }
    if (rows.length) {
      const species = item.species || rows[0].species;
      plants.push({ itemId: item.id, species, name: patchName(species), rows });
    }
  }
  plants.sort((a, b) => a.name.localeCompare(b.name) || a.itemId.localeCompare(b.itemId));
  return plants;
}

/** How many ready slots exist across the whole inventory - what decides whether Manage is offered. */
function allEligibleCount(): number {
  return managerPlants().reduce((total, plant) => total + plant.rows.length, 0);
}

/** The ticked rows that are still ready right now, read fresh so a stale tick cannot be sent. */
function selectedManagerRows(): ManagerSlot[] {
  const rows: ManagerSlot[] = [];
  for (const plant of managerPlants()) for (const row of plant.rows) if (selected.has(row.key)) rows.push(row);
  return rows;
}

/** The slots the next press will preserve: the ticked ones, capped at one batch. */
function nextBatchRows(): ManagerSlot[] {
  return selectedManagerRows().slice(0, MANAGER_BATCH_CAP);
}

/**
 * The plants the list should show for the current search, matched against the plant name, each
 * slot's own crop, and its mutations. The search only narrows what is drawn - selection and what a
 * run preserves are always over the whole inventory.
 */
function visibleManagerPlants(plants: ManagerPlant[]): ManagerPlant[] {
  const query = managerSearch.trim();
  if (!query) return plants;
  return plants.filter(plant => {
    const haystack = `${plant.name} ${plant.rows.map(row =>
      `${plantName(row.species)} ${row.mutations.map(mutationName).join(' ')}`).join(' ')}`.toLowerCase();
    return haystack.includes(query);
  });
}

function managerModal(): HTMLElement | null {
  return document.getElementById(MANAGER_ID);
}

function managerOpen(): boolean {
  return !!managerModal();
}

function mutationChips(mutations: string[]): string {
  return mutations.map(mutation => {
    const sprite = mutationSprite(mutation);
    const label = escapeHtml(mutationName(mutation));
    return sprite
      ? `<img class="gc-pm-mut" src="${escapeHtml(sprite)}" alt="${label}" title="${label}">`
      : `<span class="gc-pm-mut-text" title="${label}">${label}</span>`;
  }).join('');
}

/** A tri-state tick for a plant header: all its slots, some, or none. */
function plantMark(plant: ManagerPlant): { on: number; mark: string } {
  const on = plant.rows.reduce((count, row) => count + (selected.has(row.key) ? 1 : 0), 0);
  const mark = on === 0 ? '' : on === plant.rows.length ? '&#10003;' : '&#8211;';
  return { on, mark };
}

function managerListMarkup(plants: ManagerPlant[]): string {
  if (!plants.length) {
    return managerSearch
      ? '<p class="gc-pm-empty">No plants match that search.</p>'
      : '<p class="gc-pm-empty">No plants have ready slots to preserve.</p>';
  }
  return plants.map(plant => {
    const sprite = produceSprite(plant.species);
    const icon = sprite
      ? `<img class="gc-pm-icon" src="${escapeHtml(sprite)}" alt="">`
      : `<span class="gc-pm-icon gc-pm-icon-text">${escapeHtml(plant.name.slice(0, 1))}</span>`;
    const { on, mark } = plantMark(plant);
    // Rows are divs, not buttons, on purpose: the game restyles every button and its children
    // (stacking them into a column, resetting their flex), which mangles a rich row like this.
    const slots = plant.rows.map(row => {
      const active = selected.has(row.key);
      const crop = row.species
        ? `<span class="gc-pm-crop">${escapeHtml(plantName(row.species))}</span>` : '';
      return `<div class="gc-pm-slot" role="button" tabindex="0" data-mgr-slot="${escapeHtml(row.key)}" data-active="${active}">`
        + `<i class="gc-pm-check">${active ? '&#10003;' : ''}</i>`
        + `<span class="gc-pm-size">${row.sizePercent}%</span>`
        + crop
        + `<span class="gc-pm-muts">${mutationChips(row.mutations)}</span>`
        + `<span class="gc-pm-cost">&#129689; ${row.cost.toLocaleString(NUMBER_LOCALE)}</span>`
        + '</div>';
    }).join('');
    return `<section class="gc-pm-plant">`
      + `<div class="gc-pm-plant-head" role="button" tabindex="0" data-mgr-plant="${escapeHtml(plant.itemId)}" data-state="${on === 0 ? 'none' : on === plant.rows.length ? 'all' : 'some'}">`
      + `${icon}<b>${escapeHtml(plant.name)}</b><small>${on}/${plant.rows.length}</small><i class="gc-pm-check">${mark}</i></div>`
      + `<div class="gc-pm-slots">${slots}</div></section>`;
  }).join('');
}

function managerModalMarkup(): string {
  return `<div class="gc-preserve-manager" role="dialog" aria-label="Preservation manager">`
    + `<header class="gc-modal-head"><h3>Preservation manager</h3><button class="gc-modal-close" data-mgr-close aria-label="Close">&times;</button></header>`
    + `<div class="gc-modal-tools"><input class="gc-pm-search" type="text" data-mgr-search placeholder="Search plants" spellcheck="false" value="${escapeHtml(managerSearch)}"><div><button data-mgr-all>Select all</button><button data-mgr-none>Clear</button></div></div>`
    + `<div class="gc-pm-summary-row"><span class="gc-modal-summary" data-mgr-summary></span></div>`
    + `<div class="gc-modal-body" data-mgr-list>${managerListMarkup(visibleManagerPlants(managerPlants()))}</div>`
    + `<footer class="gc-pm-foot"><div class="gc-pm-foot-info"><span class="gc-pm-total" data-mgr-total></span><span class="gc-pm-hint" data-mgr-hint></span></div>`
    + `<button class="gc-pm-run" data-mgr-run><i class="gc-pm-fill" data-mgr-fill></i><span data-mgr-label></span></button></footer></div>`;
}

/**
 * A digest of what the list draws - the search term, plus the plants, their ready slots, and each
 * slot's size, cost and mutations. Rebuilding a thousand rows of innerHTML is the expensive part, so
 * it is only done when this changes; a tick that finds the same inventory and search leaves the
 * parsed DOM alone.
 */
function managerDataSignature(plants: ManagerPlant[]): string {
  return managerSearch + '\n' + plants.map(plant => `${plant.itemId}:${plant.name}:` +
    plant.rows.map(row => `${row.slotId},${row.sizePercent},${row.cost},${row.mutations.join('|')}`).join(';')).join('\n');
}

let managerListSignature = '';

/** Rebuild the whole list (filtered by the search) from markup, keeping scroll; skipped mid-hold and mid-batch. */
function redrawManagerList(plants: ManagerPlant[]): void {
  const root = managerModal();
  if (!root || managerHoldAt || sending) return;
  const list = root.querySelector<HTMLElement>('[data-mgr-list]');
  if (!list) return;
  const scroll = list.scrollTop;
  list.innerHTML = managerListMarkup(visibleManagerPlants(plants));
  list.scrollTop = scroll;
  managerListSignature = managerDataSignature(plants);
}

/**
 * Paint the current selection onto the rows already on the page - flipping ticks and header counts
 * with attribute writes rather than reparsing the list. This is the path a click takes, so toggling
 * a slot on a full inventory never rebuilds a thousand rows.
 */
function syncManagerSelectionDom(): void {
  const root = managerModal();
  if (!root) return;
  root.querySelectorAll<HTMLElement>('.gc-pm-plant').forEach(section => {
    const slots = [...section.querySelectorAll<HTMLElement>('.gc-pm-slot[data-mgr-slot]')];
    let on = 0;
    for (const el of slots) {
      const active = selected.has(el.dataset.mgrSlot || '');
      if (active) on += 1;
      el.dataset.active = String(active);
      const check = el.querySelector('.gc-pm-check');
      if (check) check.innerHTML = active ? '&#10003;' : '';
    }
    const head = section.querySelector<HTMLElement>('.gc-pm-plant-head');
    if (!head) return;
    const total = slots.length;
    head.dataset.state = on === 0 ? 'none' : on === total ? 'all' : 'some';
    const small = head.querySelector('small');
    if (small) small.textContent = `${on}/${total}`;
    const check = head.querySelector('.gc-pm-check');
    if (check) check.innerHTML = on === 0 ? '' : on === total ? '&#10003;' : '&#8211;';
  });
}

/** A user selection change: cheap in-place updates, never a full rebuild. */
function onManagerSelectionChanged(): void {
  // Touching the selection ends the just-ran continue prompt: a fresh pick reads as a fresh start.
  managerAwaitingContinue = false;
  syncManagerSelectionDom();
  updateManagerFooter();
}

/**
 * The totals, the progress bar and the run button. A press only ever does the next batch, so the
 * footer speaks in those terms: the total is the whole ticked selection, but the button and its
 * affordability are the batch about to be sent. While a batch is in flight the bar fills with its
 * progress and the button is disabled, so a second run cannot be queued on top of the first.
 */
function updateManagerFooter(): void {
  const root = managerModal();
  if (!root) return;
  const selectedRows = selectedManagerRows();
  const batch = nextBatchRows();
  const selectedCost = selectedRows.reduce((sum, row) => sum + row.cost, 0);
  const batchCost = batch.reduce((sum, row) => sum + row.cost, 0);
  const affordable = batchCost <= coins();
  const plants = new Set(selectedRows.map(row => row.itemId)).size;
  const capped = selectedRows.length > MANAGER_BATCH_CAP;

  const summary = root.querySelector<HTMLElement>('[data-mgr-summary]');
  if (summary) summary.textContent = selectedRows.length
    ? `${selectedRows.length} slot${selectedRows.length === 1 ? '' : 's'} ticked across ${plants} plant${plants === 1 ? '' : 's'}`
      + (capped ? ` · ${MANAGER_BATCH_CAP} per press` : '')
    : 'Tick the slots you want to preserve.';

  const totalEl = root.querySelector<HTMLElement>('[data-mgr-total]');
  if (totalEl) {
    totalEl.textContent = selectedRows.length
      ? (affordable ? `This press 🪙 ${batchCost.toLocaleString(NUMBER_LOCALE)}` : `This press 🪙 ${batchCost.toLocaleString(NUMBER_LOCALE)} - more than you have`)
      : '';
    totalEl.dataset.short = affordable ? 'false' : 'true';
  }

  const awaiting = managerAwaitingContinue && selectedRows.length > 0 && !sending;
  const ready = gameConnectionReady();

  const label = root.querySelector<HTMLElement>('[data-mgr-label]');
  if (label) label.textContent = sending
    ? `Preserving ${Math.min(batchDone + 1, batchTotal)}/${batchTotal}...`
    : managerHoldAt ? 'Keep holding...'
    : !batch.length ? 'Preserve'
    : awaiting ? `Continue (${batch.length})` : `Preserve ${batch.length}`;

  // A short line under the total makes the gate explicit: what a press does, that more remains, or
  // that the game connection is down and the ticks are being held for it.
  const hint = root.querySelector<HTMLElement>('[data-mgr-hint]');
  if (hint) hint.textContent = sending ? ''
    : !selectedRows.length ? ''
    : !ready ? 'Waiting for the game connection - your ticks are kept'
    : awaiting ? `${selectedRows.length} slot${selectedRows.length === 1 ? '' : 's'} left - press & hold to continue`
    : capped ? `${MANAGER_BATCH_CAP} per press - press & hold` : 'Press & hold to preserve';

  // The fill behind the button is the hold gauge while holding and the send progress while sending.
  if (sending) managerPaintHold(batchTotal ? batchDone / batchTotal : 0);
  else if (!managerHoldAt) managerPaintHold(0);

  const button = root.querySelector<HTMLButtonElement>('[data-mgr-run]');
  if (button) {
    button.disabled = sending || batch.length === 0 || !affordable || !ready;
    button.title = !ready ? 'The game connection is not ready.' : affordable ? '' : 'Not enough coins to preserve this batch.';
  }
  root.dataset.holding = managerHoldAt || sending ? 'true' : 'false';
  // Only pulse for "press to continue" when a press is actually possible - not while disconnected.
  root.dataset.awaiting = awaiting && ready ? 'true' : 'false';
  root.dataset.offline = !ready && selectedRows.length > 0 ? 'true' : 'false';
}

/**
 * The heartbeat refresh (and the after-a-send refresh). It rebuilds the list only when the
 * inventory it draws has actually changed - the common case, a tick over an unchanged inventory,
 * costs a signature compare and a footer update rather than reparsing every row.
 */
function refreshManagerModal(): void {
  if (!managerOpen()) return;
  const plants = managerPlants();
  // Drop ticks whose slots are no longer ready, so the totals cannot count a phantom.
  const live = new Set(plants.flatMap(plant => plant.rows.map(row => row.key)));
  let pruned = false;
  for (const key of [...selected]) if (!live.has(key)) { selected.delete(key); pruned = true; }
  if (managerDataSignature(plants) !== managerListSignature) redrawManagerList(plants);
  else if (pruned) syncManagerSelectionDom();
  updateManagerFooter();
}

function managerPaintHold(progress: number): void {
  const fill = managerModal()?.querySelector<HTMLElement>('[data-mgr-fill]');
  if (fill) fill.style.width = `${Math.round(progress * 100)}%`;
}

function managerStartHold(): void {
  if (sending || managerHoldAt) return;
  const button = managerModal()?.querySelector<HTMLButtonElement>('[data-mgr-run]');
  if (!button || button.disabled) return;
  managerHoldAt = performance.now();
  const tick = () => {
    if (!managerHoldAt) return;
    if (!managerOpen()) { managerCancelHold(); return; }
    const progress = Math.min(1, (performance.now() - managerHoldAt) / HOLD_MS);
    managerPaintHold(progress);
    if (progress < 1) { managerHoldFrame = requestAnimationFrame(tick); return; }
    managerCancelHold();
    runManager();
  };
  managerHoldFrame = requestAnimationFrame(tick);
  updateManagerFooter();
}

function managerCancelHold(): void {
  if (!managerHoldAt) return;
  managerHoldAt = 0;
  cancelAnimationFrame(managerHoldFrame);
  managerPaintHold(0);
  updateManagerFooter();
}

/**
 * Preserve one batch - at most MANAGER_BATCH_CAP ticked slots - then stop. One request per slot,
 * spaced out and re-checked as it goes: each slot carries its own plant id, so the batch spans every
 * plant it touches without any of them being the one in hand, and a slot is only sent if it is still
 * ready right now. Coins are checked once against the batch cost up front - the balance the game
 * reports lags far behind requests sent this close together. When the batch ends, any slots still
 * ticked wait for the next press; sending is guarded so a batch already in flight is never doubled.
 */
function runManager(): void {
  if (sending) return;
  const rows = nextBatchRows();
  if (!rows.length) return;
  if (!gameConnectionReady()) {
    // Nothing is sent while the socket is down; the ticks stay, so a press once it is back continues.
    managerAwaitingContinue = true;
    toast('The game connection is not ready. Your ticks are kept - press again once it reconnects.', 'error');
    updateManagerFooter();
    return;
  }
  const total = rows.reduce((sum, row) => sum + row.cost, 0);
  if (total > coins()) {
    toast(`Preserving these ${rows.length} slots costs ${total.toLocaleString(NUMBER_LOCALE)} coins, which is more than you have.`, 'error');
    return;
  }
  sending = true;
  batchTotal = rows.length;
  batchDone = 0;
  let index = 0;
  let sent = 0;
  const step = () => {
    // A socket that drops part-way through stops the batch where it is; the slots not yet sent are
    // still ticked, saved for a press once the connection returns rather than lost or errored out.
    if (index < rows.length && !gameConnectionReady()) {
      sending = false;
      batchTotal = 0;
      batchDone = 0;
      managerAwaitingContinue = selectedManagerRows().length > 0;
      toast(sent
        ? `Preserved ${sent} before the connection dropped. The rest are kept - press to continue when it is back.`
        : 'The connection dropped. Your ticks are kept - press to continue when it is back.', 'error');
      refreshManagerModal();
      render();
      return;
    }
    if (index >= rows.length) {
      sending = false;
      batchTotal = 0;
      batchDone = 0;
      const remaining = selectedManagerRows().length;
      // Ticks left after a batch mean the run was capped; the button now asks to continue.
      managerAwaitingContinue = remaining > 0;
      const plants = new Set(rows.map(row => row.itemId)).size;
      const done = sent
        ? `Preserving ${sent} slot${sent === 1 ? '' : 's'} across ${plants} plant${plants === 1 ? '' : 's'}.`
        : 'Nothing was left to preserve.';
      toast(remaining ? `${done} ${remaining} still ticked - press to continue.` : done, sent ? 'success' : 'error');
      refreshManagerModal();
      render();
      return;
    }
    const row = rows[index++];
    batchDone = index;
    const liveItem = allPlantItems().find(item => item.id === row.itemId);
    const stillReady = liveItem && eligibleFrom(liveItem.slots).some(slot => String(slot.slotId) === String(row.slotId));
    if (stillReady) {
      try {
        sendQuinoaCommand({ type: 'Preserve', itemId: row.itemId, growSlotIdx: row.slotId });
        selected.delete(row.key);
        sent++;
      } catch (error) {
        sending = false;
        batchTotal = 0;
        batchDone = 0;
        toast((error as Error).message, 'error');
        refreshManagerModal();
        render();
        return;
      }
    }
    refreshManagerModal();
    render();
    window.setTimeout(step, SEND_INTERVAL);
  };
  step();
}

function onManagerKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') { event.stopPropagation(); closeManager(); }
}

function closeManager(): void {
  managerCancelHold();
  managerModal()?.remove();
  managerListSignature = '';
  document.removeEventListener('keydown', onManagerKey, true);
}

function openManager(): void {
  if (managerOpen()) return;
  // Opens with nothing ticked and no filter - the player picks exactly what to preserve.
  selected.clear();
  managerSearch = '';
  managerAwaitingContinue = false;
  const backdrop = document.createElement('div');
  backdrop.id = MANAGER_ID;
  backdrop.className = 'gc-modal-backdrop';
  backdrop.innerHTML = managerModalMarkup();
  document.body.appendChild(backdrop);
  // The markup above already drew the list, so record its signature to stop the first tick redrawing.
  managerListSignature = managerDataSignature(managerPlants());

  // Plant and mutation icons decode in the deferred sprite stage, which the main panel normally
  // triggers - the manager can open without it, so ask for them here. Sprite readiness is not in the
  // list signature, so force one rebuild when the art lands to flip the text fallbacks to icons.
  page.__gardenCompanionLoadSprites?.();
  page.__gardenCompanionLoadSpriteGroup?.('deferred');
  onSpritesReady(() => { managerListSignature = ''; refreshManagerModal(); });

  backdrop.addEventListener('click', event => {
    const target = event.target as HTMLElement;
    if (target === backdrop || target.closest('[data-mgr-close]')) { closeManager(); return; }
    if (target.closest('[data-mgr-run]')) return; // driven by the hold handlers, not a click
    if (target.closest('[data-mgr-all]')) {
      event.preventDefault();
      for (const plant of managerPlants()) for (const row of plant.rows) selected.add(row.key);
      onManagerSelectionChanged();
      return;
    }
    if (target.closest('[data-mgr-none]')) {
      event.preventDefault();
      selected.clear();
      onManagerSelectionChanged();
      return;
    }
    const head = target.closest<HTMLElement>('[data-mgr-plant]');
    if (head) {
      event.preventDefault();
      const plant = managerPlants().find(entry => entry.itemId === head.dataset.mgrPlant);
      if (!plant) return;
      // A plant whose slots are all ticked clears itself; anything else fills in.
      const turningOff = plant.rows.every(row => selected.has(row.key));
      for (const row of plant.rows) turningOff ? selected.delete(row.key) : selected.add(row.key);
      onManagerSelectionChanged();
      return;
    }
    const slot = target.closest<HTMLElement>('[data-mgr-slot]');
    if (slot) {
      event.preventDefault();
      const key = slot.dataset.mgrSlot!;
      selected.has(key) ? selected.delete(key) : selected.add(key);
      onManagerSelectionChanged();
      return;
    }
  });

  const runButton = backdrop.querySelector<HTMLButtonElement>('[data-mgr-run]')!;
  runButton.addEventListener('pointerdown', event => {
    if (runButton.disabled || event.button !== 0) return;
    event.preventDefault();
    try { runButton.setPointerCapture(event.pointerId); } catch {}
    managerStartHold();
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) runButton.addEventListener(type, managerCancelHold);

  // Only the list is redrawn on a keystroke and the field lives outside it, so focus and caret hold.
  backdrop.querySelector<HTMLInputElement>('[data-mgr-search]')?.addEventListener('input', event => {
    managerSearch = (event.target as HTMLInputElement).value.toLowerCase();
    refreshManagerModal();
    const list = managerModal()?.querySelector<HTMLElement>('[data-mgr-list]');
    if (list) list.scrollTop = 0;
  });

  document.addEventListener('keydown', onManagerKey, true);
  updateManagerFooter();
}

// --- Held-plant "Preserve All" bar ---------------------------------------------------------------

function panel(): HTMLElement | null {
  return document.getElementById('gc-preserve-all');
}

/**
 * Built once and only ever updated by text, because a hold in progress must survive a redraw: the
 * price and slot count both change as the batch runs.
 */
function ensurePanel(): HTMLElement {
  const existing = panel();
  if (existing) return existing;
  const root = document.createElement('section');
  root.id = 'gc-preserve-all';
  root.hidden = true;
  root.innerHTML = '<small data-preserve-caption></small><small data-preserve-hint></small>'
    + '<button data-preserve-run><i data-preserve-fill></i><span data-preserve-label></span></button>'
    + '<button data-preserve-manage>Open Preservation Manager</button>';
  document.body.appendChild(root);
  const button = root.querySelector<HTMLButtonElement>('[data-preserve-run]')!;
  button.addEventListener('pointerdown', event => {
    if (button.disabled || event.button !== 0) return;
    event.preventDefault();
    try { button.setPointerCapture(event.pointerId); } catch {}
    startHold();
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) button.addEventListener(type, cancelHold);
  root.querySelector<HTMLButtonElement>('[data-preserve-manage]')!.addEventListener('click', event => {
    event.preventDefault();
    openManager();
  });
  return root;
}

/**
 * The game asks for a press and hold before anything that spends coins, and this spends rather more
 * of them, so it does the same. Progress is drawn straight onto the button, and letting go early
 * simply lets go - nothing is sent until the bar fills.
 */
function startHold(): void {
  if (sending || holdStartedAt) return;
  holdStartedAt = performance.now();
  const tick = () => {
    if (!holdStartedAt) return;
    // Putting the plant down mid-hold hides the bar, and the slots our state reports fall back to
    // whichever garden tile is underfoot, so the hold has to end with it rather than run on unseen.
    if (!state.preservationMode) { cancelHold(); return; }
    const progress = Math.min(1, (performance.now() - holdStartedAt) / HOLD_MS);
    paintHold(progress);
    if (progress < 1) { holdFrame = requestAnimationFrame(tick); return; }
    cancelHold();
    run();
  };
  holdFrame = requestAnimationFrame(tick);
  render(true);
}

function cancelHold(): void {
  if (!holdStartedAt) return;
  holdStartedAt = 0;
  cancelAnimationFrame(holdFrame);
  paintHold(0);
  render(true);
}

function paintHold(progress: number): void {
  const fill = panel()?.querySelector<HTMLElement>('[data-preserve-fill]');
  if (fill) fill.style.width = `${Math.round(progress * 100)}%`;
}

/**
 * One request per slot, spaced out and re-checked as it goes: the plant can change under us while
 * the batch runs, so each request is only sent if that exact slot is still eligible on the plant we
 * started with. Coins are checked once against the total up front - the balance the game reports
 * lags far behind requests sent this close together, so a per-slot check would only be reading a
 * stale number. Only the start is guarded: once the batch is away, walking off does not stop it,
 * because each request stands on its own.
 */
function run(): void {
  if (sending) return;
  const rows = eligibleSlots();
  if (!state.preservationMode || rows.length < 2) return;
  if (!gameConnectionReady()) {
    toast('The game connection is not ready. Try again once it reconnects.', 'error');
    return;
  }
  const total = rows.reduce((sum, row) => sum + row.cost, 0);
  if (total > coins()) {
    toast(`Preserving all ${rows.length} slots costs ${total.toLocaleString(NUMBER_LOCALE)} coins, which is more than you have.`, 'error');
    return;
  }
  const itemId = state.selectedItemId;
  if (!itemId) {
    toast('The held plant could not be identified. Reselect it and try again.', 'error');
    return;
  }
  sending = true;
  let index = 0;
  let sent = 0;
  const step = () => {
    // A dropped socket stops the batch cleanly; the slots it did not reach are still unpreserved on
    // the plant, so the bar simply offers them again once the connection is back.
    if (index < rows.length && !gameConnectionReady()) {
      sending = false;
      toast(sent
        ? `Preserved ${sent} before the connection dropped. Try the rest once it is back.`
        : 'The connection dropped before anything was preserved.', 'error');
      render();
      return;
    }
    if (index >= rows.length) {
      sending = false;
      toast(sent ? `Preserving ${sent} slot${sent === 1 ? '' : 's'} of ${cropLabel(rows)}.` : 'Nothing was left to preserve.', sent ? 'success' : 'error');
      render();
      return;
    }
    const row = rows[index++];
    const live = eligibleSlots().find(candidate => String(candidate.slotId) === String(row.slotId));
    if (live && state.selectedItemId === itemId) {
      try {
        sendQuinoaCommand({ type: 'Preserve', itemId, growSlotIdx: row.slotId });
        sent++;
      } catch (error) {
        sending = false;
        toast((error as Error).message, 'error');
        return;
      }
    }
    render();
    window.setTimeout(step, SEND_INTERVAL);
  };
  step();
}

/**
 * Sat directly above the game's own crop card. The action buttons live in a PIXI container that
 * also holds the press-and-hold hint and any secondary buttons, so its bounds are a poor guide to
 * where the button itself is; the card already has a reader in `findPixiCard`, and being above it
 * keeps the bar clear of the buttons either way. The CSS position is the fallback for when the
 * scene cannot be read.
 */
function anchorAboveCard(element: HTMLElement): void {
  const card = findPixiCard();
  const rect = element.getBoundingClientRect();
  if (!card || !rect.width) return;
  element.style.left = `${Math.round(Math.max(8, card.centerX - rect.width / 2))}px`;
  element.style.top = `${Math.round(Math.max(8, card.top - rect.height - ANCHOR_GAP))}px`;
  element.style.right = 'auto';
  element.style.bottom = 'auto';
  element.style.transform = 'none';
}

/**
 * The bar sits above the held plant's card only while it is that plant's Preserve All. With no
 * preservable held plant it is just the Manage button, which belongs to no card - so it drops back
 * to the stylesheet's fixed spot (bottom centre) by clearing the inline anchor a prior frame set.
 */
function positionPanel(element: HTMLElement, aboveCard: boolean): void {
  if (aboveCard) { anchorAboveCard(element); return; }
  element.style.left = '';
  element.style.top = '';
  element.style.right = '';
  element.style.bottom = '';
  element.style.transform = '';
}

function render(force = false): void {
  const root = panel();
  const rows = eligibleSlots();
  const manageCount = allEligibleCount();
  const canPreserveAll = rows.length >= 2;
  const canManage = manageCount >= 1;
  const active = state.preservationMode && (canPreserveAll || canManage) && !page.__gardenCompanionCinematicFromGame?.();
  if (!active) {
    lastSignature = '';
    if (root) root.hidden = true;
    return;
  }
  const total = rows.reduce((sum, row) => sum + row.cost, 0);
  const affordable = total <= coins();
  const ready = gameConnectionReady();
  const holding = holdStartedAt > 0;
  const signature = `${rows.length}|${total}|${affordable}|${ready}|${sending}|${holding}|${canPreserveAll}|${canManage}|${manageCount}|${cropLabel(rows)}`;
  const element = ensurePanel();
  element.hidden = false;
  if (!force && signature === lastSignature) {
    positionPanel(element, canPreserveAll);
    return;
  }
  lastSignature = signature;
  const caption = element.querySelector<HTMLElement>('[data-preserve-caption]')!;
  const hint = element.querySelector<HTMLElement>('[data-preserve-hint]')!;
  const runButton = element.querySelector<HTMLButtonElement>('[data-preserve-run]')!;
  const manageButton = element.querySelector<HTMLButtonElement>('[data-preserve-manage]')!;
  caption.hidden = !canPreserveAll;
  hint.hidden = !canPreserveAll;
  runButton.hidden = !canPreserveAll;
  if (canPreserveAll) {
    caption.textContent = `${cropLabel(rows)} - ${rows.length} ready slot${rows.length === 1 ? '' : 's'}`;
    hint.textContent = sending ? 'Preserving...' : !ready ? 'Waiting for connection...' : holding ? 'Keep holding...' : 'Press & Hold';
    element.querySelector('[data-preserve-label]')!.textContent = `Preserve All 🪙 ${total.toLocaleString(NUMBER_LOCALE)}`;
    runButton.disabled = sending || !affordable || !ready;
    runButton.title = !ready ? 'The game connection is not ready.' : affordable ? '' : 'Not enough coins to preserve every ready slot.';
  }
  manageButton.hidden = !canManage;
  manageButton.textContent = 'Open Preservation Manager';
  element.dataset.holding = holding ? 'true' : 'false';
  positionPanel(element, canPreserveAll);
}

export function initPreserveAll(): void {
  window.setInterval(() => { render(); refreshManagerModal(); }, 300);
  render();
}
