import { MUTATION_CATALOG, PLANT_CATALOG, plantName } from '../constants.js';
import { makeDraggable } from '../draggable.js';
import { sendQuinoaCommand } from '../game-connection.js';
import { page } from '../page.js';
import { ensureToolReady, heldToolCount, holdTool, mutationSprite, onSpritesReady } from '../pets.js';
import { onStateChange, state } from '../state.js';
import { toast } from '../toast.js';
import { escapeHtml, humanize, NUMBER_LOCALE, waitFor } from '../utils.js';
import { serverNow } from '../server-clock.js';

const POSITION_KEY = 'gardenCompanion.cropCleanserPosition.v1';
/**
 * Ids only. The names were written beside them, which meant the same three renamed mutations were
 * spelled out here as well as in the catalog - two places to keep right, and only one of them is
 * what the game actually says.
 */
const MUTATIONS = [
  'Wet', 'Chilled', 'Frozen', 'Thunderstruck', 'Thundercharged',
  'Ambershine', 'Dawnlit', 'Ambercharged', 'Dawncharged',
] as const;
const CLEANSEABLE = new Set<string>(MUTATIONS);
interface Cleanser { id: string; name: string; groups: string[] }
/**
 * The game's clearsMutationGroups for each cleanser. Crop Cleanser comes first so it wins a tie: it
 * is the cheap one, and the game has given it an expiry date.
 */
const CLEANSERS: Cleanser[] = [
  { id: 'CropCleanser', name: 'Crop Cleanser', groups: ['Hydro', 'Lunar'] },
  { id: 'HydroCleanser', name: 'Hydro Cleanser', groups: ['Hydro'] },
  { id: 'LunarCleanser', name: 'Lunar Cleanser', groups: ['Lunar'] },
];
const CLEANSE_ECHO_WAIT_MS = 2_000;
const SCREEN_MARGIN_PX = 12;
const MIN_ROOM_PX = 360;

interface CleanserRow {
  key: string;
  tileObjectIdx: string | number;
  growSlotIdx: string | number;
  species: string;
  mutations: string[];
  startTime?: number;
}

const selectedMutations = new Set<string>();
let rowSnapshot: CleanserRow[] = [];
/** Per cleanser id, like the queue counts below: each kind is fetched, spent and echoed on its own. */
const displayedCount: Record<string, number> = {};
const lastLiveCount: Record<string, number> = {};
const optimisticUntil: Record<string, number> = {};
/** Row key to its rowFingerprint when pressed. Kept until the cleanse settles and the list is rebuilt. */
const cleansedRows = new Map<string, string>();
/** Cleansed rows the server has answered, or has had long enough to. A rebuild may trust these. */
const settledRows = new Set<string>();
const changedRows = new Set<string>();
/** Presses run one at a time: the loose count only tells the truth once the last use has echoed. */
let cleanseQueue: Promise<void> = Promise.resolve();
/** Presses waiting in that queue, by cleanser id, each already promised one the count has not lost yet. */
const unsentCleanses: Record<string, number> = {};
/** The plant search, kept across redraws and reopenings so a narrowed list stays narrowed. */
let plantSearch = '';

function mutationLabel(id: string): string {
  return MUTATION_CATALOG[id]?.name || humanize(id);
}

function mutationBadge(id: string): string {
  const label = mutationLabel(id);
  const sprite = mutationSprite(id);
  return `<span class="gc-cleanser-mutation">${sprite ? `<img src="${escapeHtml(sprite)}" alt="">` : ''}${escapeHtml(label)}</span>`;
}

function commandTileIndex(value: string): string | number {
  const number = Number(value);
  return Number.isInteger(number) && String(number) === value ? number : value;
}

/** Every mature, unpreserved crop, whatever is selected. */
function cropRows(): CleanserRow[] {
  const rows: CleanserRow[] = [];
  for (const [tileIndex, tile] of Object.entries(state.slot?.data?.garden?.tileObjects || {})) {
    const plant = PLANT_CATALOG[tile.species || ''];
    const maturedAt = Number(tile.maturedAt);
    if (plant?.regrows !== false && (!Number.isFinite(maturedAt) || maturedAt > serverNow())) continue;
    for (const [slotIndex, slot] of (tile.slots || []).entries()) {
      const mutations = Array.isArray(slot.mutations) ? slot.mutations : [];
      if (slot.preserved === true) continue;
      const growSlotIdx = slot.slotId ?? slotIndex;
      rows.push({
        key: `${tileIndex}:${String(growSlotIdx)}`,
        tileObjectIdx: commandTileIndex(tileIndex),
        growSlotIdx,
        species: slot.species || tile.species || 'Unknown crop',
        mutations: [...mutations],
        startTime: slot.startTime,
      });
    }
  }
  return rows;
}

function matchingRows(): CleanserRow[] {
  if (!selectedMutations.size) return [];
  return cropRows().filter(row => row.mutations.some(mutation => selectedMutations.has(mutation))).sort((left, right) => {
    const leftName = plantName(left.species);
    const rightName = plantName(right.species);
    return leftName.localeCompare(rightName) || String(left.key).localeCompare(String(right.key), undefined, { numeric: true });
  });
}

function cleanseableSignature(mutations: string[]): string {
  return mutations.filter(mutation => CLEANSEABLE.has(mutation)).sort().join('|');
}

function rowFingerprint(row: CleanserRow): string {
  return `${row.species}|${String(row.startTime)}|${cleanseableSignature(row.mutations)}`;
}

function liveRowMatches(snapshot: CleanserRow): CleanserRow | null {
  const live = cropRows().find(row => row.key === snapshot.key);
  return live && rowFingerprint(live) === rowFingerprint(snapshot) ? live : null;
}

function isCleansed(row: CleanserRow): boolean {
  return cleansedRows.get(row.key) === rowFingerprint(row);
}

/**
 * Rebuilds the list from the live garden. Only settled cleanses are forgotten: until then the server
 * may not have echoed one, and a re-enabled row would spend a second cleanser.
 */
function refreshRows(): void {
  for (const key of settledRows) cleansedRows.delete(key);
  settledRows.clear();
  rowSnapshot = matchingRows();
  changedRows.clear();
}

function refreshSnapshot(): void {
  refreshRows();
  for (const { id } of CLEANSERS) {
    displayedCount[id] = heldToolCount(id);
    lastLiveCount[id] = displayedCount[id];
    optimisticUntil[id] = 0;
  }
}

function clears(cleanser: Cleanser, mutation: string): boolean {
  return cleanser.groups.includes(MUTATION_CATALOG[mutation]?.group || '');
}

/**
 * The cleanser for a row: one that removes every selected mutation on it while removing as few of
 * its other weather mutations as possible. Among equally good ones, the first with one free. A Crop
 * Cleanser removes every cleanseable mutation, so there is always one.
 */
function cleanserFor(row: CleanserRow): Cleanser {
  const targets = row.mutations.filter(mutation => selectedMutations.has(mutation));
  const others = row.mutations.filter(mutation => CLEANSEABLE.has(mutation) && !selectedMutations.has(mutation));
  const fits = CLEANSERS.filter(cleanser => targets.every(mutation => clears(cleanser, mutation)));
  const loss = (cleanser: Cleanser) => others.filter(mutation => clears(cleanser, mutation)).length;
  const least = Math.min(...fits.map(loss));
  const best = fits.filter(cleanser => loss(cleanser) === least);
  return best.find(cleanser => cleansersFree(cleanser.id) > 0) || best[0];
}

function groupLabels(group: string): string {
  return MUTATIONS.filter(id => MUTATION_CATALOG[id]?.group === group).map(mutationLabel).join(', ');
}

function panel(): HTMLElement | null {
  return document.getElementById('gc-crop-cleanser');
}

function showCleanserCount(): void {
  const count = panel()?.querySelector<HTMLElement>('[data-cleanser-count]');
  if (count) count.textContent = CLEANSERS.map(({ id, name }) => `${(displayedCount[id] || 0).toLocaleString(NUMBER_LOCALE)} ${name.split(' ')[0]}`).join(' · ');
}

/**
 * The box grows with its list. It is capped to the room below it rather than moved, so the chips stay
 * under the cursor while several are picked; it only moves when too near the bottom to be usable.
 */
function fitToScreen(root: HTMLElement): void {
  const room = window.innerHeight - root.getBoundingClientRect().top - SCREEN_MARGIN_PX;
  root.style.maxHeight = `min(860px, calc(100vh - 24px), ${Math.round(Math.max(room, MIN_ROOM_PX))}px)`;
  const rect = root.getBoundingClientRect();
  const overflow = rect.bottom - window.innerHeight;
  if (overflow > 0) root.style.top = `${Math.round(Math.max(0, rect.top - overflow))}px`;
}

function cleansersFree(id: string): number {
  return (displayedCount[id] || 0) - (unsentCleanses[id] || 0);
}

function updateCleanserControls(body: HTMLElement): void {
  showCleanserCount();
  body.querySelectorAll<HTMLButtonElement>('[data-cleanse-row]').forEach(button => {
    const key = button.dataset.cleanseRow || '';
    const row = rowSnapshot.find(candidate => candidate.key === key);
    const cleansed = Boolean(row && isCleansed(row));
    const cleanser = row ? cleanserFor(row) : null;
    button.disabled = !cleanser || cleansersFree(cleanser.id) <= 0 || cleansed || changedRows.has(key);
    button.textContent = cleansed ? 'Cleansed' : changedRows.has(key) ? 'Changed' : cleanser?.name || 'Cleanse';
  });
}

function reconcileCleanserCount(): void {
  const root = panel();
  if (!root || root.hidden) return;
  let moved = false;
  for (const { id } of CLEANSERS) {
    const live = heldToolCount(id);
    if (live === lastLiveCount[id] && live === displayedCount[id]) continue;
    if (live === lastLiveCount[id] && Date.now() < (optimisticUntil[id] || 0)) continue;
    lastLiveCount[id] = live;
    displayedCount[id] = live;
    optimisticUntil[id] = 0;
    moved = true;
  }
  if (!moved) return;
  const body = root.querySelector<HTMLElement>('[data-cleanser-body]');
  if (body) updateCleanserControls(body);
}

function markChanged(row: CleanserRow): void {
  changedRows.add(row.key);
  toast('That crop changed after this list was opened. Reopen the helper and check it again.', 'error');
}

async function cleanse(row: CleanserRow, body: HTMLElement, cleanser: Cleanser): Promise<void> {
  const { id, name } = cleanser;
  let sent = false;
  let release = (): void => {};
  try {
    const held = heldToolCount(id);
    // Held across the fetch and the use together, so auto-store cannot file the cleanser back
    // between them.
    release = holdTool(id);
    // The count above is everything owned, the Tool Shack included, but a cleanser is only usable
    // once it is out of storage - so one is fetched before the command rather than after it fails.
    if (!await ensureToolReady(id)) {
      toast(heldToolCount(id) > 0 ? `No ${name} could be taken from the Tool Shack. Make room in your inventory.` : `No ${name}s are available.`, 'error');
      return;
    }
    // Checked here rather than on the press: this row may have waited seconds behind others, and the
    // crop could have been preserved, harvested or replanted since.
    const live = liveRowMatches(row);
    if (!live) {
      markChanged(row);
      return;
    }
    sendQuinoaCommand({ type: 'CropCleanser', toolId: id, tileObjectIdx: live.tileObjectIdx, growSlotIdx: live.growSlotIdx });
    sent = true;
    unsentCleanses[id] -= 1;
    displayedCount[id] = Math.max(0, (displayedCount[id] || 0) - 1);
    optimisticUntil[id] = Date.now() + CLEANSE_ECHO_WAIT_MS;
    updateCleanserControls(body);
    toast(`${name} requested for ${plantName(live.species)}.`, 'success');
    await waitFor(() => heldToolCount(id) < held, CLEANSE_ECHO_WAIT_MS);
    settledRows.add(row.key);
  } catch (error) {
    toast((error as Error).message, 'error');
  } finally {
    if (!sent) {
      unsentCleanses[id] -= 1;
      cleansedRows.delete(row.key);
      settledRows.delete(row.key);
    }
    release();
    // Recomputed rather than simply re-enabled: a cleansed row must stay disabled, or a second
    // press before the server echoes the first spends another cleanser on the same slot.
    updateCleanserControls(body);
  }
}

/**
 * Hides the rows whose plant does not match the search, in place: a redraw would replace the box
 * being typed in, and the rows keep their Cleansed and Changed states as they are.
 */
function applyPlantSearch(body: HTMLElement): void {
  const query = plantSearch.trim().toLowerCase();
  let shown = 0;
  body.querySelectorAll<HTMLTableRowElement>('tr[data-cleanser-plant]').forEach(row => {
    row.hidden = Boolean(query) && !(row.dataset.cleanserPlant || '').includes(query);
    if (!row.hidden) shown += 1;
  });
  const table = body.querySelector<HTMLElement>('.gc-cleanser-table-wrap table');
  const empty = body.querySelector<HTMLElement>('[data-cleanser-no-match]');
  if (table) table.hidden = shown === 0;
  if (empty) {
    empty.hidden = !table || shown > 0;
    empty.textContent = `No listed crops match "${plantSearch.trim()}".`;
  }
}

function render(): void {
  const root = panel();
  if (!root) return;
  const body = root.querySelector<HTMLElement>('[data-cleanser-body]');
  if (!body) return;
  // A redraw (a sprite arriving, say) replaces the search box; whoever was typing keeps their place.
  const typing = document.activeElement?.matches?.('[data-cleanser-search]') ? document.activeElement as HTMLInputElement : null;
  const caret = typing ? [typing.selectionStart, typing.selectionEnd] as const : null;
  const rows = rowSnapshot;
  const choices = MUTATIONS.map(id => {
    const sprite = mutationSprite(id);
    return `<button class="gc-cleanser-choice${selectedMutations.has(id) ? ' on' : ''}" data-cleanser-mutation="${id}">${sprite ? `<img src="${escapeHtml(sprite)}" alt="">` : ''}<span>${escapeHtml(mutationLabel(id))}</span></button>`;
  }).join('');
  const tableRows = rows.map(row => {
    const mutations = row.mutations.filter(id => CLEANSEABLE.has(id));
    return `<tr data-cleanser-plant="${escapeHtml(`${plantName(row.species)} ${row.species}`.toLowerCase())}"><td><b>${escapeHtml(plantName(row.species))}</b><small>Tile ${escapeHtml(String(row.tileObjectIdx))} - Slot ${escapeHtml(String(row.growSlotIdx))}</small></td><td><div class="gc-cleanser-mutations">${mutations.map(mutationBadge).join('')}</div></td><td><button class="gc-primary" data-cleanse-row="${escapeHtml(row.key)}"></button></td></tr>`;
  }).join('');
  const selectedLabels = MUTATIONS.filter(id => selectedMutations.has(id)).map(mutationLabel).join(' or ');
  const search = `<input class="gc-search gc-cleanser-search" type="search" data-cleanser-search placeholder="Search plants" spellcheck="false" autocomplete="off" value="${escapeHtml(plantSearch)}">`;
  const table = rows.length
    ? `<table><thead><tr><th>Slot</th><th>Current mutations</th><th></th></tr></thead><tbody>${tableRows}</tbody></table><div class="gc-cleanser-empty" data-cleanser-no-match hidden></div>`
    : `<div class="gc-cleanser-empty">No unpreserved crops currently have ${escapeHtml(selectedLabels)}.</div>`;
  body.innerHTML = `<p>Choose one or more mutations to find crops with any of them.</p><div class="gc-cleanser-choices">${choices}</div>${selectedMutations.size ? `<p class="gc-cleanser-note">A Hydro Cleanser removes ${escapeHtml(groupLabels('Hydro'))}; a Lunar Cleanser removes ${escapeHtml(groupLabels('Lunar'))}; a Crop Cleanser removes both. Each crop uses the one that removes the selected mutations and keeps the most of its others.</p>${search}<div class="gc-cleanser-table-wrap">${table}</div>` : '<div class="gc-cleanser-empty">Select at least one mutation above.</div>'}`;
  updateCleanserControls(body);
  applyPlantSearch(body);
  const searchInput = body.querySelector<HTMLInputElement>('[data-cleanser-search]');
  if (searchInput) {
    // The game reads movement and hotkeys from window, so typing a search must not reach it.
    for (const type of ['keydown', 'keyup', 'keypress'] as const) searchInput.addEventListener(type, event => event.stopPropagation());
    searchInput.addEventListener('input', () => {
      plantSearch = searchInput.value;
      applyPlantSearch(body);
    });
    if (typing && caret) {
      searchInput.focus();
      searchInput.setSelectionRange(caret[0], caret[1]);
    }
  }
  fitToScreen(root);
  body.querySelectorAll<HTMLButtonElement>('[data-cleanser-mutation]').forEach(button => button.onclick = () => {
    const id = button.dataset.cleanserMutation || '';
    if (!selectedMutations.delete(id)) selectedMutations.add(id);
    refreshRows();
    render();
  });
  body.querySelectorAll<HTMLButtonElement>('[data-cleanse-row]').forEach(button => button.onclick = () => {
    const row = rows.find(candidate => candidate.key === button.dataset.cleanseRow);
    if (!row) return;
    if (!liveRowMatches(row)) {
      markChanged(row);
      updateCleanserControls(body);
      return;
    }
    const cleanser = cleanserFor(row);
    if (cleansersFree(cleanser.id) <= 0 || heldToolCount(cleanser.id) <= 0) {
      toast(`No ${cleanser.name}s are available.`, 'error');
      return;
    }
    // Marked on the press, since the wait can take seconds and anything that redraws this row
    // meanwhile must not make it pressable. A failure takes the mark back off.
    cleansedRows.set(row.key, rowFingerprint(row));
    settledRows.delete(row.key);
    unsentCleanses[cleanser.id] = (unsentCleanses[cleanser.id] || 0) + 1;
    updateCleanserControls(body);
    const run = () => cleanse(row, body, cleanser);
    // Both ways, so that one rejection cannot stop every later press from running.
    cleanseQueue = cleanseQueue.then(run, run);
  });
}

function ensurePanel(): HTMLElement {
  const existing = panel();
  if (existing) return existing;
  const root = document.createElement('section');
  root.id = 'gc-crop-cleanser';
  root.hidden = true;
  root.innerHTML = '<header><div><i></i><span>Crop Cleanser Helper</span><small data-cleanser-count></small></div><button data-cleanser-close aria-label="Close">×</button></header><main data-cleanser-body></main>';
  root.querySelector<HTMLButtonElement>('[data-cleanser-close]')!.onclick = () => {
    root.hidden = true;
  };
  document.body.appendChild(root);
  makeDraggable(root, POSITION_KEY);
  // The room below the box changes when it is moved or the window is resized, not only on a render.
  root.addEventListener('pointerup', () => fitToScreen(root));
  window.addEventListener('resize', () => { if (!root.hidden) fitToScreen(root); });
  return root;
}

function toggle(): void {
  const root = ensurePanel();
  root.hidden = !root.hidden;
  if (!root.hidden) {
    refreshSnapshot();
    render();
  }
}

export function initCropCleanserHelper(): void {
  page.__gardenCompanionToggleCropCleanser = toggle;
  // The count follows the inventory, so it is reconciled when the state moves rather than polled;
  // reconcileCleanserCount does nothing while the helper is closed.
  onStateChange(reconcileCleanserCount);
  // Mutation icons are decoded on demand, so the helper can open before they exist.
  onSpritesReady(() => { if (panel() && !panel()!.hidden) render(); });
}
