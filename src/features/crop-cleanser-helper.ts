import { MUTATION_CATALOG, PLANT_CATALOG, plantName } from '../constants.js';
import { makeDraggable } from '../draggable.js';
import { sendQuinoaCommand } from '../game-connection.js';
import { page } from '../page.js';
import { heldToolCount, mutationSprite } from '../pets.js';
import { state } from '../state.js';
import { toast } from '../toast.js';
import { escapeHtml, humanize, NUMBER_LOCALE } from '../utils.js';

const POSITION_KEY = 'gardenCompanion.cropCleanserPosition.v1';
const MUTATIONS = [
  { id: 'Wet', label: 'Wet' },
  { id: 'Chilled', label: 'Chilled' },
  { id: 'Frozen', label: 'Frozen' },
  { id: 'Thunderstruck', label: 'Thunderstruck' },
  { id: 'Thundercharged', label: 'Thundercharged' },
  { id: 'Ambershine', label: 'Amberlit' },
  { id: 'Dawnlit', label: 'Dawnlit' },
  { id: 'Ambercharged', label: 'Amberbound' },
  { id: 'Dawncharged', label: 'Dawnbound' },
] as const;
const CLEANSEABLE = new Set<string>(MUTATIONS.map(mutation => mutation.id));

interface CleanserRow {
  key: string;
  tileObjectIdx: string | number;
  growSlotIdx: string | number;
  species: string;
  mutations: string[];
  startTime?: number;
}

let selectedMutation = '';
let rowSnapshot: CleanserRow[] = [];
let displayedCleanserCount = 0;
let lastLiveCleanserCount = 0;
let optimisticCountUntil = 0;
let reconcileTimer: number | null = null;
const cleansedRows = new Set<string>();
const changedRows = new Set<string>();

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

function matchingRows(): CleanserRow[] {
  if (!selectedMutation) return [];
  const rows: CleanserRow[] = [];
  for (const [tileIndex, tile] of Object.entries(state.slot?.data?.garden?.tileObjects || {})) {
    const plant = PLANT_CATALOG[tile.species || ''];
    const maturedAt = Number(tile.maturedAt);
    if (plant?.regrows !== false && (!Number.isFinite(maturedAt) || maturedAt > Date.now())) continue;
    for (const [slotIndex, slot] of (tile.slots || []).entries()) {
      const mutations = Array.isArray(slot.mutations) ? slot.mutations : [];
      if (!mutations.includes(selectedMutation) || slot.preserved === true) continue;
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
  return rows.sort((left, right) => {
    const leftName = plantName(left.species);
    const rightName = plantName(right.species);
    return leftName.localeCompare(rightName) || String(left.key).localeCompare(String(right.key), undefined, { numeric: true });
  });
}

function cleanseableSignature(mutations: string[]): string {
  return mutations.filter(mutation => CLEANSEABLE.has(mutation)).sort().join('|');
}

function liveRowMatches(snapshot: CleanserRow): CleanserRow | null {
  const live = matchingRows().find(row => row.key === snapshot.key);
  if (!live || live.species !== snapshot.species || live.startTime !== snapshot.startTime) return null;
  return cleanseableSignature(live.mutations) === cleanseableSignature(snapshot.mutations) ? live : null;
}

function refreshSnapshot(): void {
  rowSnapshot = matchingRows();
  displayedCleanserCount = heldToolCount('CropCleanser');
  lastLiveCleanserCount = displayedCleanserCount;
  optimisticCountUntil = 0;
  cleansedRows.clear();
  changedRows.clear();
}

function panel(): HTMLElement | null {
  return document.getElementById('gc-crop-cleanser');
}

function updateCleanserControls(body: HTMLElement): void {
  const count = body.querySelector<HTMLElement>('.gc-cleanser-summary b');
  if (count) count.textContent = displayedCleanserCount.toLocaleString(NUMBER_LOCALE);
  body.querySelectorAll<HTMLButtonElement>('[data-cleanse-row]').forEach(button => {
    const key = button.dataset.cleanseRow || '';
    button.disabled = displayedCleanserCount <= 0 || cleansedRows.has(key) || changedRows.has(key);
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

function startCountReconciliation(): void {
  if (reconcileTimer !== null) return;
  reconcileTimer = window.setInterval(reconcileCleanserCount, 500);
}

function stopCountReconciliation(): void {
  if (reconcileTimer === null) return;
  window.clearInterval(reconcileTimer);
  reconcileTimer = null;
}

function render(): void {
  const root = panel();
  if (!root) return;
  const body = root.querySelector<HTMLElement>('[data-cleanser-body]');
  if (!body) return;
  const cleaners = displayedCleanserCount;
  const rows = rowSnapshot;
  const choices = MUTATIONS.map(mutation => {
    const sprite = mutationSprite(mutation.id);
    return `<button class="gc-cleanser-choice${selectedMutation === mutation.id ? ' on' : ''}" data-cleanser-mutation="${mutation.id}">${sprite ? `<img src="${escapeHtml(sprite)}" alt="">` : ''}<span>${mutation.label}</span></button>`;
  }).join('');
  const tableRows = rows.map(row => {
    const mutations = row.mutations.filter(id => CLEANSEABLE.has(id));
    const cleansed = cleansedRows.has(row.key);
    const disabled = cleaners <= 0 || cleansed;
    return `<tr><td><b>${escapeHtml(plantName(row.species))}</b><small>Tile ${escapeHtml(String(row.tileObjectIdx))} - Slot ${escapeHtml(String(row.growSlotIdx))}</small></td><td><div class="gc-cleanser-mutations">${mutations.map(mutationBadge).join('')}</div></td><td><button class="gc-primary" data-cleanse-row="${escapeHtml(row.key)}" ${disabled ? 'disabled' : ''}>${cleansed ? 'Cleansed' : 'Cleanse'}</button></td></tr>`;
  }).join('');
  body.innerHTML = `<div class="gc-cleanser-summary"><span>Crop Cleansers</span><b>${cleaners.toLocaleString(NUMBER_LOCALE)}</b></div><p>Choose a mutation to find matching crops.</p><div class="gc-cleanser-choices">${choices}</div>${selectedMutation ? `<p class="gc-cleanser-note">Using a Crop Cleanser removes all cleanseable weather mutations from the selected crop.</p><div class="gc-cleanser-table-wrap">${rows.length ? `<table><thead><tr><th>Slot</th><th>Current mutations</th><th></th></tr></thead><tbody>${tableRows}</tbody></table>` : `<div class="gc-cleanser-empty">No unpreserved crops currently have ${escapeHtml(mutationLabel(selectedMutation))}.</div>`}</div>` : '<div class="gc-cleanser-empty">Select a mutation above.</div>'}`;
  body.querySelectorAll<HTMLButtonElement>('[data-cleanser-mutation]').forEach(button => button.onclick = () => {
    selectedMutation = button.dataset.cleanserMutation || '';
    refreshSnapshot();
    render();
  });
  body.querySelectorAll<HTMLButtonElement>('[data-cleanse-row]').forEach(button => button.onclick = () => {
    const row = rows.find(candidate => candidate.key === button.dataset.cleanseRow);
    if (!row) return;
    const live = liveRowMatches(row);
    if (!live) {
      changedRows.add(row.key);
      button.textContent = 'Changed';
      updateCleanserControls(body);
      toast('That crop changed after this list was opened. Reopen the helper and check it again.', 'error');
      return;
    }
    if (displayedCleanserCount <= 0 || heldToolCount('CropCleanser') <= 0) {
      toast('No Crop Cleansers are available.', 'error');
      return;
    }
    try {
      sendQuinoaCommand({ type: 'CropCleanser', tileObjectIdx: live.tileObjectIdx, growSlotIdx: live.growSlotIdx });
      cleansedRows.add(row.key);
      displayedCleanserCount = Math.max(0, displayedCleanserCount - 1);
      optimisticCountUntil = Date.now() + 2_000;
      button.textContent = 'Cleansed';
      updateCleanserControls(body);
      toast(`Crop Cleanser requested for ${plantName(live.species)}.`, 'success');
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  });
}

function ensurePanel(): HTMLElement {
  const existing = panel();
  if (existing) return existing;
  const root = document.createElement('section');
  root.id = 'gc-crop-cleanser';
  root.hidden = true;
  root.innerHTML = '<header><div><i></i><span>Crop Cleanser Helper</span></div><button data-cleanser-close aria-label="Close">×</button></header><main data-cleanser-body></main>';
  root.querySelector<HTMLButtonElement>('[data-cleanser-close]')!.onclick = () => {
    root.hidden = true;
    stopCountReconciliation();
  };
  document.body.appendChild(root);
  makeDraggable(root, POSITION_KEY);
  return root;
}

function toggle(): void {
  const root = ensurePanel();
  root.hidden = !root.hidden;
  if (!root.hidden) {
    refreshSnapshot();
    render();
    startCountReconciliation();
  } else {
    stopCountReconciliation();
  }
}

export function initCropCleanserHelper(): void {
  page.__gardenCompanionToggleCropCleanser = toggle;
}
