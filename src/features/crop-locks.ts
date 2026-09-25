import type { PlantSlot } from '../types.js';
import { PLANT_CATALOG, mutationName, patchName, plantName } from '../constants.js';
import { slotSizePercent } from '../crop-size.js';
import { gameConnectionReady, sendQuinoaCommand } from '../game-connection.js';
import { page } from '../page.js';
import { mutationSprite, onSpritesReady, produceSprite } from '../pets.js';
import { onStateChange, state } from '../state.js';
import { toast } from '../toast.js';
import { escapeHtml } from '../utils.js';

/**
 * A manager over the game's own crop lock. The game locks one crop at a time from its crop card
 * (SetGrowSlotLock, sent with the tile and the grow slot); this lists every crop in the garden,
 * grouped by plant, so any number can be locked or unlocked in one go.
 *
 * It sits beside Crop Protection rather than replacing it. A game lock lives on the server and holds
 * everywhere - another device, the script turned off - while Crop Protection is our own rule set
 * that also covers crops not planted yet. The game only lets you lock crops in your own garden, which
 * is the only garden this reads.
 *
 * Built on the Preservation manager's dialog and styles, so the two read as one family.
 */

const MODAL_ID = 'gc-crop-locks';
/**
 * The same gates as the Preservation manager: a press and hold before anything is sent, requests
 * spaced out, and at most BATCH_CAP crops per press so a whole garden never goes in one stroke.
 */
const HOLD_MS = 650;
const SEND_INTERVAL = 100;
const BATCH_CAP = 15;

type LockFilter = 'all' | 'unlocked' | 'locked';

interface LockRow {
  key: string;
  tile: number;
  slotId: number;
  species: string;
  locked: boolean;
  growing: boolean;
  sizePercent: number;
  mutations: string[];
}

interface LockGroup {
  species: string;
  name: string;
  rows: LockRow[];
}

/** Ticked crops, keyed tile::slot. */
const selected = new Set<string>();
let search = '';
let filter: LockFilter = 'all';
let sending = false;
let sendTotal = 0;
let sendDone = 0;
let holdAt = 0;
let holdFrame = 0;
/** Which button the hold (or the batch it started) belongs to. */
let action: 'lock' | 'unlock' | null = null;
let listSignature = '';
let unsubscribe: (() => void) | null = null;
let spritesHooked = false;

const rowKey = (tile: number | string, slotId: number | string) => `${tile}::${slotId}`;

/**
 * Every crop in our garden, one row per grow slot, grouped by what is growing in it. A plant tile
 * reports its own species; a slot's own is preferred, which matters for the odd mixed patch.
 */
function lockGroups(): LockGroup[] {
  const tiles = state.slot?.data?.garden?.tileObjects ?? {};
  const now = Date.now();
  const bySpecies = new Map<string, LockRow[]>();
  for (const [tileKey, tile] of Object.entries(tiles)) {
    if (tile?.objectType !== 'plant' || !Array.isArray(tile.slots)) continue;
    const tileIndex = Number(tileKey);
    if (!Number.isFinite(tileIndex)) continue;
    for (const slot of tile.slots as PlantSlot[]) {
      if (!slot || slot.slotId == null) continue;
      const slotId = Number(slot.slotId);
      if (!Number.isFinite(slotId)) continue;
      const species = slot.species || tile.species || '';
      if (!species) continue;
      const rows = bySpecies.get(species) ?? [];
      rows.push({
        key: rowKey(tileIndex, slotId),
        tile: tileIndex,
        slotId,
        species,
        locked: slot.locked === true,
        growing: Number(slot.endTime || 0) > now,
        sizePercent: slotSizePercent(PLANT_CATALOG[species]?.crop, slot),
        mutations: Array.isArray(slot.mutations) ? slot.mutations.filter(m => typeof m === 'string') : [],
      });
      bySpecies.set(species, rows);
    }
  }
  const groups = [...bySpecies].map(([species, rows]) => ({
    species,
    name: patchName(species),
    rows: rows.sort((a, b) => a.tile - b.tile || a.slotId - b.slotId),
  }));
  return groups.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * What the list shows: the filter and search narrow the drawing, never what is already ticked. The
 * search is by crop name only - mutation names would match on fragments (Amberlit holds "be").
 */
function visibleGroups(groups: LockGroup[]): LockGroup[] {
  const query = search.trim();
  return groups.map(group => {
    const rows = group.rows.filter(row => {
      if (filter === 'locked' && !row.locked) return false;
      if (filter === 'unlocked' && row.locked) return false;
      if (!query) return true;
      return `${group.name} ${plantName(row.species)}`.toLowerCase().includes(query);
    });
    return { ...group, rows };
  }).filter(group => group.rows.length);
}

function allRows(groups: LockGroup[]): LockRow[] {
  return groups.flatMap(group => group.rows);
}

function modal(): HTMLElement | null {
  return document.getElementById(MODAL_ID);
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

const PADLOCK = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
const PADLOCK_OPEN = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.6-1.7"/></svg>';

function groupState(group: LockGroup): { on: number; state: string; mark: string } {
  const on = group.rows.reduce((count, row) => count + (selected.has(row.key) ? 1 : 0), 0);
  const all = on === group.rows.length;
  return { on, state: on === 0 ? 'none' : all ? 'all' : 'some', mark: on === 0 ? '' : all ? '&#10003;' : '&#8211;' };
}

function listMarkup(groups: LockGroup[]): string {
  if (!groups.length) {
    return search.trim() || filter !== 'all'
      ? '<p class="gc-pm-empty">No crops match.</p>'
      : '<p class="gc-pm-empty">Your garden has no crops to lock.</p>';
  }
  return groups.map(group => {
    const sprite = produceSprite(group.species);
    const icon = sprite
      ? `<img class="gc-pm-icon" src="${escapeHtml(sprite)}" alt="">`
      : `<span class="gc-pm-icon gc-pm-icon-text">${escapeHtml(group.name.slice(0, 1))}</span>`;
    const lockedCount = group.rows.filter(row => row.locked).length;
    const mark = groupState(group);
    // Divs rather than buttons: the game restyles every button and its children, which mangles a
    // row this rich - the same reason the Preservation manager does it.
    const rows = group.rows.map(row => {
      const active = selected.has(row.key);
      return `<div class="gc-pm-slot" role="button" tabindex="0" data-lock-row="${row.key}" data-active="${active}">`
        + `<i class="gc-pm-check">${active ? '&#10003;' : ''}</i>`
        + `<span class="gc-pm-size">${row.sizePercent}%</span>`
        + `<span class="gc-pm-muts">${mutationChips(row.mutations)}${row.growing ? '<span class="gc-cl-growing">Growing</span>' : ''}</span>`
        + `<span class="gc-cl-state" data-locked="${row.locked}" title="${row.locked ? 'Locked' : 'Unlocked'}">${row.locked ? PADLOCK : PADLOCK_OPEN}</span>`
        + '</div>';
    }).join('');
    return `<section class="gc-pm-plant">`
      + `<div class="gc-pm-plant-head" role="button" tabindex="0" data-lock-group="${escapeHtml(group.species)}" data-state="${mark.state}">`
      + `${icon}<b>${escapeHtml(group.name)}</b><small>${lockedCount}/${group.rows.length} locked</small><i class="gc-pm-check">${mark.mark}</i></div>`
      + `<div class="gc-pm-slots">${rows}</div></section>`;
  }).join('');
}

function modalMarkup(): string {
  const filters: Array<[LockFilter, string]> = [['all', 'All'], ['unlocked', 'Unlocked'], ['locked', 'Locked']];
  return `<div class="gc-preserve-manager gc-crop-locks" role="dialog" aria-label="Crop Locker">`
    + `<header class="gc-modal-head"><h3>Crop Locker</h3><button class="gc-modal-close" data-lock-close aria-label="Close">&times;</button></header>`
    + `<div class="gc-modal-tools"><input class="gc-pm-search" type="text" data-lock-search placeholder="Search crops" spellcheck="false" value="${escapeHtml(search)}"><div><button data-lock-all>Select all</button><button data-lock-none>Clear</button></div></div>`
    + `<div class="gc-cl-filters">${filters.map(([id, label]) => `<button data-lock-filter="${id}" data-active="${id === filter}">${label}</button>`).join('')}<span class="gc-modal-summary" data-lock-summary></span></div>`
    + `<div class="gc-modal-body" data-lock-list>${listMarkup(visibleGroups(lockGroups()))}</div>`
    + `<footer class="gc-pm-foot"><div class="gc-pm-foot-info"><span class="gc-pm-total" data-lock-total></span><span class="gc-pm-hint" data-lock-hint></span></div>`
    + `<div class="gc-cl-actions">${(['unlock', 'lock'] as const).map(kind => `<button class="gc-cl-${kind}" data-lock-run="${kind}"><i class="gc-cl-fill" data-lock-fill></i><span data-lock-label></span></button>`).join('')}</div></footer></div>`;
}

function dataSignature(groups: LockGroup[]): string {
  return `${search}\n${filter}\n` + groups.map(group => `${group.species}:` + group.rows.map(row =>
    `${row.key},${row.locked ? 1 : 0},${row.growing ? 1 : 0},${row.sizePercent},${row.mutations.join('|')}`).join(';')).join('\n');
}

function redrawList(): void {
  const root = modal();
  const list = root?.querySelector<HTMLElement>('[data-lock-list]');
  if (!list) return;
  const groups = visibleGroups(lockGroups());
  const scroll = list.scrollTop;
  list.innerHTML = listMarkup(groups);
  list.scrollTop = scroll;
  listSignature = dataSignature(groups);
}

/** Ticks and header marks flipped in place, so a click never reparses a garden's worth of rows. */
function syncSelectionDom(): void {
  modal()?.querySelectorAll<HTMLElement>('.gc-pm-plant').forEach(section => {
    const rows = [...section.querySelectorAll<HTMLElement>('[data-lock-row]')];
    let on = 0;
    for (const row of rows) {
      const active = selected.has(row.dataset.lockRow || '');
      if (active) on++;
      row.dataset.active = String(active);
      const check = row.querySelector('.gc-pm-check');
      if (check) check.innerHTML = active ? '&#10003;' : '';
    }
    const head = section.querySelector<HTMLElement>('[data-lock-group]');
    if (!head) return;
    head.dataset.state = on === 0 ? 'none' : on === rows.length ? 'all' : 'some';
    const check = head.querySelector('.gc-pm-check');
    if (check) check.innerHTML = on === 0 ? '' : on === rows.length ? '&#10003;' : '&#8211;';
  });
}

/** The ticked crops as they stand right now, split by what a press would do to them. */
function selectedSplit(): { toLock: LockRow[]; toUnlock: LockRow[]; total: number } {
  const rows = allRows(lockGroups()).filter(row => selected.has(row.key));
  return { toLock: rows.filter(row => !row.locked), toUnlock: rows.filter(row => row.locked), total: rows.length };
}

function updateFooter(): void {
  const root = modal();
  if (!root) return;
  const groups = lockGroups();
  const every = allRows(groups);
  const lockedCount = every.filter(row => row.locked).length;
  const { toLock, toUnlock, total } = selectedSplit();
  const ready = gameConnectionReady();
  const capped = toLock.length > BATCH_CAP || toUnlock.length > BATCH_CAP;

  const summary = root.querySelector<HTMLElement>('[data-lock-summary]');
  if (summary) summary.textContent = `${lockedCount} of ${every.length} locked`;
  const totalEl = root.querySelector<HTMLElement>('[data-lock-total]');
  if (totalEl) totalEl.textContent = sending ? `Updating ${Math.min(sendDone + 1, sendTotal)}/${sendTotal}...`
    : total ? `${total} crop${total === 1 ? '' : 's'} selected` : 'Tick the crops to change.';
  const hint = root.querySelector<HTMLElement>('[data-lock-hint]');
  if (hint) hint.textContent = sending ? ''
    : !ready && total ? 'Waiting for the game connection - your ticks are kept'
    : holdAt ? 'Keep holding...'
    : total ? (capped ? `${BATCH_CAP} per press - press & hold` : 'Press & hold to apply') : '';
  root.dataset.offline = !ready && total > 0 ? 'true' : 'false';

  for (const [kind, rows, verb, busy] of [['lock', toLock, 'Lock', 'Locking'], ['unlock', toUnlock, 'Unlock', 'Unlocking']] as const) {
    const button = root.querySelector<HTMLButtonElement>(`[data-lock-run="${kind}"]`);
    if (!button) continue;
    const batch = Math.min(rows.length, BATCH_CAP);
    const label = button.querySelector<HTMLElement>('[data-lock-label]');
    if (label) label.textContent = sending && action === kind ? `${busy} ${Math.min(sendDone + 1, sendTotal)}/${sendTotal}...`
      : batch ? `${verb} ${batch}` : verb;
    // Only the button being held or sent stays live; the other stands down so the two cannot overlap.
    button.disabled = sending || !ready || !batch || (holdAt > 0 && action !== kind);
    // The fill is the hold gauge while holding and the send progress while sending.
    if (sending && action === kind) paintFill(button, sendTotal ? sendDone / sendTotal : 0);
    else if (!(holdAt && action === kind)) paintFill(button, 0);
  }
  root.dataset.holding = holdAt || sending ? 'true' : 'false';
}

function paintFill(button: HTMLElement, progress: number): void {
  const fill = button.querySelector<HTMLElement>('[data-lock-fill]');
  if (fill) fill.style.width = `${Math.round(progress * 100)}%`;
}

/**
 * The same press and hold the Preservation manager asks for. Letting go early simply lets go -
 * nothing is sent until the bar fills.
 */
function startHold(kind: 'lock' | 'unlock', button: HTMLButtonElement): void {
  if (sending || holdAt || button.disabled) return;
  action = kind;
  holdAt = performance.now();
  const tick = () => {
    if (!holdAt) return;
    if (!modal()) { cancelHold(); return; }
    const progress = Math.min(1, (performance.now() - holdAt) / HOLD_MS);
    paintFill(button, progress);
    if (progress < 1) { holdFrame = requestAnimationFrame(tick); return; }
    holdAt = 0;
    run(kind === 'lock');
  };
  holdFrame = requestAnimationFrame(tick);
  updateFooter();
}

function cancelHold(): void {
  if (!holdAt) return;
  holdAt = 0;
  cancelAnimationFrame(holdFrame);
  updateFooter();
}

/** Heartbeat from state changes: a redraw only when what the list draws has moved. */
function refresh(): void {
  if (!modal()) return;
  const groups = lockGroups();
  const live = new Set(allRows(groups).map(row => row.key));
  let pruned = false;
  // A harvested or removed crop drops out of the selection rather than lingering as a phantom tick.
  for (const key of [...selected]) if (!live.has(key)) { selected.delete(key); pruned = true; }
  if (!sending && dataSignature(visibleGroups(groups)) !== listSignature) redrawList();
  else if (pruned) syncSelectionDom();
  updateFooter();
}

/**
 * One batch - at most BATCH_CAP crops - one request each, spaced out and re-checked against the
 * garden as it goes so a crop that was harvested or already changed in the meantime is skipped
 * rather than sent. The ticks of crops that were sent are cleared; the rest wait for the next press,
 * and anything the connection dropped before reaching stays ticked.
 */
function run(locking: boolean): void {
  if (sending) return;
  const { toLock, toUnlock } = selectedSplit();
  const rows = (locking ? toLock : toUnlock).slice(0, BATCH_CAP);
  if (!rows.length) return;
  if (!gameConnectionReady()) {
    toast('The game connection is not ready. Your ticks are kept - try again once it reconnects.', 'error');
    return;
  }
  sending = true;
  action = locking ? 'lock' : 'unlock';
  sendTotal = rows.length;
  sendDone = 0;
  let index = 0;
  let sent = 0;
  const finish = (message: string, ok: boolean) => {
    sending = false;
    sendTotal = 0;
    sendDone = 0;
    action = null;
    toast(message, ok ? 'success' : 'error');
    refresh();
  };
  const verb = locking ? 'Locked' : 'Unlocked';
  const step = () => {
    if (index < rows.length && !gameConnectionReady()) {
      finish(sent ? `${verb} ${sent} before the connection dropped. The rest are still ticked.` : 'The connection dropped. Your ticks are kept.', false);
      return;
    }
    if (index >= rows.length) {
      const split = selectedSplit();
      const left = (locking ? split.toLock : split.toUnlock).length;
      const done = sent ? `${verb} ${sent} crop${sent === 1 ? '' : 's'}.` : 'Nothing was left to change.';
      finish(left ? `${done} ${left} still ticked - press & hold to continue.` : done, sent > 0);
      return;
    }
    const row = rows[index++];
    sendDone = index;
    const live = allRows(lockGroups()).find(candidate => candidate.key === row.key);
    if (live && live.locked !== locking) {
      try {
        sendQuinoaCommand({ type: 'SetGrowSlotLock', slot: row.tile, growSlotId: row.slotId, locked: locking });
        sent++;
      } catch (error) {
        finish((error as Error).message, false);
        return;
      }
    }
    selected.delete(row.key);
    updateFooter();
    window.setTimeout(step, SEND_INTERVAL);
  };
  updateFooter();
  step();
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') { event.stopPropagation(); closeCropLocks(); }
}

function onSprites(): void {
  listSignature = '';
  refresh();
}

export function closeCropLocks(): void {
  cancelHold();
  modal()?.remove();
  listSignature = '';
  unsubscribe?.();
  unsubscribe = null;
  document.removeEventListener('keydown', onKey, true);
}

export function openCropLocks(): void {
  if (modal()) return;
  selected.clear();
  search = '';
  filter = 'all';
  const backdrop = document.createElement('div');
  backdrop.id = MODAL_ID;
  backdrop.className = 'gc-modal-backdrop';
  backdrop.innerHTML = modalMarkup();
  document.body.appendChild(backdrop);
  listSignature = dataSignature(visibleGroups(lockGroups()));

  if (!spritesHooked) { spritesHooked = true; onSpritesReady(onSprites); }
  page.__gardenCompanionLoadSprites?.();
  page.__gardenCompanionLoadSpriteGroup?.('deferred');

  // The backdrop only closes the dialog when the press started on it too. A click is dispatched to
  // whatever sits under the release, so a press inside the dialog that ends outside it - or a quick
  // second click after a redraw moved things - would otherwise read as a click on the backdrop.
  let pressedBackdrop = false;
  backdrop.addEventListener('pointerdown', event => { pressedBackdrop = event.target === backdrop; });
  backdrop.addEventListener('click', event => {
    const target = event.target as HTMLElement;
    if ((target === backdrop && pressedBackdrop) || target.closest('[data-lock-close]')) { closeCropLocks(); return; }
    if (target === backdrop) return;
    // Driven by the hold handlers below, not a click.
    if (target.closest('[data-lock-run]')) return;
    const filterButton = target.closest<HTMLElement>('[data-lock-filter]');
    if (filterButton) {
      filter = filterButton.dataset.lockFilter as LockFilter;
      backdrop.querySelectorAll<HTMLElement>('[data-lock-filter]').forEach(button => { button.dataset.active = String(button === filterButton); });
      redrawList();
      updateFooter();
      return;
    }
    if (target.closest('[data-lock-all]')) {
      // Only what is on screen, so Select all under the Locked filter means every locked crop.
      for (const row of allRows(visibleGroups(lockGroups()))) selected.add(row.key);
      syncSelectionDom(); updateFooter();
      return;
    }
    if (target.closest('[data-lock-none]')) {
      selected.clear();
      syncSelectionDom(); updateFooter();
      return;
    }
    const head = target.closest<HTMLElement>('[data-lock-group]');
    if (head) {
      const group = visibleGroups(lockGroups()).find(entry => entry.species === head.dataset.lockGroup);
      if (!group) return;
      const turningOff = group.rows.every(row => selected.has(row.key));
      for (const row of group.rows) turningOff ? selected.delete(row.key) : selected.add(row.key);
      syncSelectionDom(); updateFooter();
      return;
    }
    const row = target.closest<HTMLElement>('[data-lock-row]');
    if (row) {
      const key = row.dataset.lockRow!;
      selected.has(key) ? selected.delete(key) : selected.add(key);
      syncSelectionDom(); updateFooter();
    }
  });

  backdrop.querySelectorAll<HTMLButtonElement>('[data-lock-run]').forEach(button => {
    const kind = button.dataset.lockRun === 'lock' ? 'lock' : 'unlock';
    button.addEventListener('pointerdown', event => {
      if (button.disabled || event.button !== 0) return;
      event.preventDefault();
      try { button.setPointerCapture(event.pointerId); } catch {}
      startHold(kind, button);
    });
    for (const type of ['pointerup', 'pointercancel', 'pointerleave']) button.addEventListener(type, cancelHold);
  });

  backdrop.querySelector<HTMLInputElement>('[data-lock-search]')?.addEventListener('input', event => {
    search = (event.target as HTMLInputElement).value.toLowerCase();
    redrawList();
    const list = modal()?.querySelector<HTMLElement>('[data-lock-list]');
    if (list) list.scrollTop = 0;
  });

  document.addEventListener('keydown', onKey, true);
  unsubscribe = onStateChange(refresh);
  updateFooter();
}
