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
let displayedCleanserCount = 0;
let lastLiveCleanserCount = 0;
let optimisticCountUntil = 0;
/** Row key to its rowFingerprint when pressed. Kept until the cleanse settles and the list is rebuilt. */
const cleansedRows = new Map<string, string>();
/** Cleansed rows the server has answered, or has had long enough to. A rebuild may trust these. */
const settledRows = new Set<string>();
const changedRows = new Set<string>();
/** Presses run one at a time: the loose count only tells the truth once the last use has echoed. */
let cleanseQueue: Promise<void> = Promise.resolve();
/** Presses waiting in that queue, each already promised a cleanser the count has not lost yet. */
let unsentCleanses = 0;

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
  displayedCleanserCount = heldToolCount('CropCleanser');
  lastLiveCleanserCount = displayedCleanserCount;
  optimisticCountUntil = 0;
}

function panel(): HTMLElement | null {
  return document.getElementById('gc-crop-cleanser');
}

function showCleanserCount(): void {
  const count = panel()?.querySelector<HTMLElement>('[data-cleanser-count]');
  if (count) count.textContent = `${displayedCleanserCount.toLocaleString(NUMBER_LOCALE)} owned`;
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

function cleansersFree(): number {
  return displayedCleanserCount - unsentCleanses;
}

function updateCleanserControls(body: HTMLElement): void {
  showCleanserCount();
  body.querySelectorAll<HTMLButtonElement>('[data-cleanse-row]').forEach(button => {
    const key = button.dataset.cleanseRow || '';
    const row = rowSnapshot.find(candidate => candidate.key === key);
    const cleansed = Boolean(row && isCleansed(row));
    button.disabled = cleansersFree() <= 0 || cleansed || changedRows.has(key);
    button.textContent = cleansed ? 'Cleansed' : changedRows.has(key) ? 'Changed' : 'Cleanse';
  });
}

function reconcileCleanserCount(): void {
  const root = panel();
  if (!root || root.hidden) return;
  const live = heldToolCount('CropCleanser');
  if (live === lastLiveCleanserCount && live === displayedCleanserCount) return;
  if (live === lastLiveCleanserCount && Date.now() < optimisticCountUntil) return;
  lastLiveCleanserCount = live;
  displayedCleanserCount = live;
  optimisticCountUntil = 0;
  const body = root.querySelector<HTMLElement>('[data-cleanser-body]');
  if (body) updateCleanserControls(body);
}

function markChanged(row: CleanserRow): void {
  changedRows.add(row.key);
  toast('That crop changed after this list was opened. Reopen the helper and check it again.', 'error');
}

async function cleanse(row: CleanserRow, body: HTMLElement): Promise<void> {
  let sent = false;
  let release = (): void => {};
  try {
    const held = heldToolCount('CropCleanser');
    // Held across the fetch and the use together, so auto-store cannot file the cleanser back
    // between them.
    release = holdTool('CropCleanser');
    // The count above is everything owned, the Tool Shack included, but a cleanser is only usable
    // once it is out of storage - so one is fetched before the command rather than after it fails.
    if (!await ensureToolReady('CropCleanser')) {
      toast(heldToolCount('CropCleanser') > 0 ? 'No Crop Cleanser could be taken from the Tool Shack. Make room in your inventory.' : 'No Crop Cleansers are available.', 'error');
      return;
    }
    // Checked here rather than on the press: this row may have waited seconds behind others, and the
    // crop could have been preserved, harvested or replanted since.
    const live = liveRowMatches(row);
    if (!live) {
      markChanged(row);
      return;
    }
    sendQuinoaCommand({ type: 'CropCleanser', tileObjectIdx: live.tileObjectIdx, growSlotIdx: live.growSlotIdx });
    sent = true;
    unsentCleanses -= 1;
    displayedCleanserCount = Math.max(0, displayedCleanserCount - 1);
    optimisticCountUntil = Date.now() + CLEANSE_ECHO_WAIT_MS;
    updateCleanserControls(body);
    toast(`Crop Cleanser requested for ${plantName(live.species)}.`, 'success');
    await waitFor(() => heldToolCount('CropCleanser') < held, CLEANSE_ECHO_WAIT_MS);
    settledRows.add(row.key);
  } catch (error) {
    toast((error as Error).message, 'error');
  } finally {
    if (!sent) {
      unsentCleanses -= 1;
      cleansedRows.delete(row.key);
      settledRows.delete(row.key);
    }
    release();
    // Recomputed rather than simply re-enabled: a cleansed row must stay disabled, or a second
    // press before the server echoes the first spends another cleanser on the same slot.
    updateCleanserControls(body);
  }
}

function render(): void {
  const root = panel();
  if (!root) return;
  const body = root.querySelector<HTMLElement>('[data-cleanser-body]');
  if (!body) return;
  const rows = rowSnapshot;
  const choices = MUTATIONS.map(id => {
    const sprite = mutationSprite(id);
    return `<button class="gc-cleanser-choice${selectedMutations.has(id) ? ' on' : ''}" data-cleanser-mutation="${id}">${sprite ? `<img src="${escapeHtml(sprite)}" alt="">` : ''}<span>${escapeHtml(mutationLabel(id))}</span></button>`;
  }).join('');
  const tableRows = rows.map(row => {
    const mutations = row.mutations.filter(id => CLEANSEABLE.has(id));
    return `<tr><td><b>${escapeHtml(plantName(row.species))}</b><small>Tile ${escapeHtml(String(row.tileObjectIdx))} - Slot ${escapeHtml(String(row.growSlotIdx))}</small></td><td><div class="gc-cleanser-mutations">${mutations.map(mutationBadge).join('')}</div></td><td><button class="gc-primary" data-cleanse-row="${escapeHtml(row.key)}"></button></td></tr>`;
  }).join('');
  const selectedLabels = MUTATIONS.filter(id => selectedMutations.has(id)).map(mutationLabel).join(' or ');
  body.innerHTML = `<p>Choose one or more mutations to find crops with any of them.</p><div class="gc-cleanser-choices">${choices}</div>${selectedMutations.size ? `<p class="gc-cleanser-note">Using a Crop Cleanser removes all cleanseable weather mutations from the selected crop.</p><div class="gc-cleanser-table-wrap">${rows.length ? `<table><thead><tr><th>Slot</th><th>Current mutations</th><th></th></tr></thead><tbody>${tableRows}</tbody></table>` : `<div class="gc-cleanser-empty">No unpreserved crops currently have ${escapeHtml(selectedLabels)}.</div>`}</div>` : '<div class="gc-cleanser-empty">Select at least one mutation above.</div>'}`;
  updateCleanserControls(body);
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
    if (cleansersFree() <= 0 || heldToolCount('CropCleanser') <= 0) {
      toast('No Crop Cleansers are available.', 'error');
      return;
    }
    // Marked on the press, since the wait can take seconds and anything that redraws this row
    // meanwhile must not make it pressable. A failure takes the mark back off.
    cleansedRows.set(row.key, rowFingerprint(row));
    settledRows.delete(row.key);
    unsentCleanses += 1;
    updateCleanserControls(body);
    const run = () => cleanse(row, body);
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
