import type { PlantSlot } from '../types.js';
import { PLANT_CATALOG } from '../constants.js';
import { page } from '../page.js';
import { findPixiCard } from '../pixi.js';
import { sendQuinoaCommand } from '../game-connection.js';
import { catalogMutationMultiplier } from '../mutation-value.js';
import { state } from '../state.js';
import { toast } from '../toast.js';
import { humanize, NUMBER_LOCALE } from '../utils.js';

/**
 * Preserving a whole potted plant in one go. The game preserves the selected slot only, so standing
 * at the station with a six-slot plant means six trips through its confirm; this offers one button
 * that walks the slots itself.
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
/** Clearance between our bar and the game's own crop card. */
const ANCHOR_GAP = 12;

interface EligibleSlot {
  slotId: string | number;
  species: string;
  cost: number;
}

let sending = false;
let lastSignature = '';
let holdStartedAt = 0;
let holdFrame = 0;

function heldSlots(): PlantSlot[] {
  return Array.isArray(state.currentCrop) ? state.currentCrop : [];
}

function preserveCost(species: string, targetScale: unknown, mutations: readonly string[]): number {
  const base = Number(PLANT_CATALOG[species]?.crop?.baseSellPrice) || 0;
  return Math.round(base * (Number(targetScale) || 1) * catalogMutationMultiplier(mutations));
}

function eligibleSlots(): EligibleSlot[] {
  const now = Date.now();
  const rows: EligibleSlot[] = [];
  for (const slot of heldSlots()) {
    if (!slot || slot.preserved === true || slot.slotId == null) continue;
    if (Number(slot.endTime || 0) > now) continue;
    const species = slot.species || '';
    if (!species) continue;
    rows.push({ slotId: slot.slotId, species, cost: preserveCost(species, slot.targetScale, slot.mutations || []) });
  }
  return rows;
}

function coins(): number {
  return Number(state.slot?.data?.coinsCount) || 0;
}

function cropLabel(rows: EligibleSlot[]): string {
  const species = [...new Set(rows.map(row => row.species))];
  return species.length === 1 ? humanize(species[0]) : `${species.length} crops`;
}

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
    + '<button data-preserve-run><i data-preserve-fill></i><span data-preserve-label></span></button>';
  document.body.appendChild(root);
  const button = root.querySelector<HTMLButtonElement>('[data-preserve-run]')!;
  button.addEventListener('pointerdown', event => {
    if (button.disabled || event.button !== 0) return;
    event.preventDefault();
    try { button.setPointerCapture(event.pointerId); } catch {}
    startHold();
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) button.addEventListener(type, cancelHold);
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

function render(force = false): void {
  const root = panel();
  const rows = eligibleSlots();
  const active = state.preservationMode && rows.length >= 2 && !page.__gardenCompanionCinematicFromGame?.();
  if (!active) {
    lastSignature = '';
    if (root) root.hidden = true;
    return;
  }
  const total = rows.reduce((sum, row) => sum + row.cost, 0);
  const affordable = total <= coins();
  const holding = holdStartedAt > 0;
  const signature = `${rows.length}|${total}|${affordable}|${sending}|${holding}|${cropLabel(rows)}`;
  const element = ensurePanel();
  element.hidden = false;
  if (!force && signature === lastSignature) {
    anchorAboveCard(element);
    return;
  }
  lastSignature = signature;
  element.querySelector('[data-preserve-caption]')!.textContent =
    `${cropLabel(rows)} - ${rows.length} ready slot${rows.length === 1 ? '' : 's'}`;
  element.querySelector('[data-preserve-hint]')!.textContent = sending ? 'Preserving...' : holding ? 'Keep holding...' : 'Press & Hold';
  element.querySelector('[data-preserve-label]')!.textContent = `Preserve All 🪙 ${total.toLocaleString(NUMBER_LOCALE)}`;
  const button = element.querySelector<HTMLButtonElement>('[data-preserve-run]')!;
  button.disabled = sending || !affordable;
  button.title = affordable ? '' : 'Not enough coins to preserve every ready slot.';
  element.dataset.holding = holding ? 'true' : 'false';
  anchorAboveCard(element);
}

export function initPreserveAll(): void {
  window.setInterval(render, 300);
  render();
}
