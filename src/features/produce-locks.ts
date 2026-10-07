import { createTicker } from '../ticker.js';
import { feature } from '../config.js';
import { state } from '../state.js';
import { sendQuinoaCommandAwaitingResult } from '../game-connection.js';
import { heldProduce, produceSprite } from '../pets.js';
import { pixiNodeVisible, pixiSurface } from '../pixi.js';
import { quinoaEngine } from '../quinoa-engine.js';
import { toast } from '../toast.js';
import { escapeHtml, humanize } from '../utils.js';

/**
 * A row of produce sprites docked along the top edge of the game's inventory while it is open,
 * one tile per species. Right-clicking a tile locks every crop of that species, and right-clicking
 * a fully locked one unlocks them all - the same favourite the game's own padlock sets, one item at
 * a time through ToggleLockItem.
 *
 * The inventory is drawn in PIXI, so the panel is positioned over the scene graph like the pet food
 * dock. The game's inventory system keeps one modal view for both the hotbar and the expanded
 * inventory; showExpandedContent is what tells the two apart.
 */

const PANEL_ID = 'gc-produce-locks';

function favouritedIds(): Set<string> {
  const ids = (state.slot?.data?.inventory as { favoritedItemIds?: unknown } | undefined)?.favoritedItemIds;
  return new Set(Array.isArray(ids) ? ids.map(String) : []);
}

interface SpeciesRow { species: string; ids: string[]; locked: number }

function speciesRows(): SpeciesRow[] {
  const favourites = favouritedIds();
  const bySpecies = new Map<string, SpeciesRow>();
  for (const item of heldProduce()) {
    let row = bySpecies.get(item.species);
    if (!row) bySpecies.set(item.species, row = { species: item.species, ids: [], locked: 0 });
    row.ids.push(item.id);
    if (favourites.has(item.id)) row.locked++;
  }
  return [...bySpecies.values()].sort((left, right) => humanize(left.species).localeCompare(humanize(right.species)));
}

/**
 * Item ids waiting to be toggled. Each is sent only once the server has answered the one before, so
 * a few hundred crops go out as fast as the server takes them and never as one burst.
 */
const queue: string[] = [];
const queued = new Set<string>();
let draining = false;

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const itemId = queue.shift()!;
      queued.delete(itemId);
      const result = await sendQuinoaCommandAwaitingResult({ type: 'ToggleLockItem', itemId });
      // A lost connection would time out every remaining item in turn, so the rest are dropped.
      if (result.timedOut) throw new Error('The game stopped answering; the remaining locks were not sent.');
    }
  } catch (error) {
    queue.length = 0;
    queued.clear();
    toast((error as Error).message, 'error');
  } finally {
    draining = false;
  }
}

/**
 * The command is a toggle, so the direction is decided here and only the items not already that way
 * are sent. Anything still queued for this species is dropped first, so a second click while the
 * first is draining reverses it cleanly rather than toggling items twice.
 */
function toggleSpecies(species: string): void {
  const row = speciesRows().find(entry => entry.species === species);
  if (!row) return;
  const ids = new Set(row.ids);
  for (let index = queue.length - 1; index >= 0; index--) {
    if (ids.has(queue[index])) { queued.delete(queue[index]); queue.splice(index, 1); }
  }
  const favourites = favouritedIds();
  const lock = row.locked < row.ids.length;
  for (const id of row.ids) {
    if (favourites.has(id) === lock || queued.has(id)) continue;
    queued.add(id);
    queue.push(id);
  }
  void drain();
}

function inventoryView(): Record<string, any> | null {
  return quinoaEngine()?.getSystem?.('inventory')?.modalView ?? null;
}

/** The expanded inventory's on-screen rectangle, or null while it is closed or only the hotbar shows. */
function inventoryRect(): { left: number; top: number; right: number; bottom: number } | null {
  const view = inventoryView();
  if (!view || view.isDestroyed || !view.isVisible || !view.showExpandedContent) return null;
  const surface = pixiSurface();
  const node = view.modalBg || view.contentContainer || view.modalContainer;
  if (!surface || !node || typeof node.getBounds !== 'function' || !pixiNodeVisible(node)) return null;
  try {
    const bounds = node.getBounds();
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) return null;
    return {
      left: surface.toScreenX(bounds.x),
      top: surface.toScreenY(bounds.y),
      right: surface.toScreenX(bounds.x + bounds.width),
      bottom: surface.toScreenY(bounds.y + bounds.height),
    };
  } catch { return null; }
}

function createPanel(): HTMLElement {
  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.hidden = true;
  panel.innerHTML = '<div class="gc-produce-locks-head" title="Right-click a crop to lock or unlock every one of that species">Produce</div><div class="gc-produce-locks-list"></div>';
  // Swallowed over the whole panel so a right-click between tiles does not open the browser menu.
  panel.addEventListener('contextmenu', event => {
    event.preventDefault();
    const tile = (event.target as HTMLElement).closest<HTMLElement>('[data-produce-species]');
    if (tile) toggleSpecies(tile.dataset.produceSpecies!);
  });
  // Kept off the canvas, which would otherwise read a press on the panel as a click on the world.
  for (const type of ['pointerdown', 'pointerup', 'wheel'] as const) panel.addEventListener(type, event => event.stopPropagation());
  // The row scrolls sideways, which a plain mouse wheel cannot do on its own.
  const list = panel.querySelector<HTMLElement>('.gc-produce-locks-list')!;
  list.addEventListener('wheel', event => {
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    event.preventDefault();
    list.scrollLeft += event.deltaY;
  }, { passive: false });
  document.body.appendChild(panel);
  return panel;
}

let signature = '';

function render(panel: HTMLElement): void {
  const rows = speciesRows();
  const next = JSON.stringify(rows.map(row => [row.species, row.ids.length, row.locked, Boolean(produceSprite(row.species))]));
  if (next === signature) return;
  signature = next;
  const list = panel.querySelector('.gc-produce-locks-list')!;
  list.innerHTML = rows.length ? rows.map(row => {
    const name = humanize(row.species);
    const sprite = produceSprite(row.species);
    const lockState = row.locked === 0 ? 'none' : row.locked === row.ids.length ? 'all' : 'some';
    const title = `${name} - ${row.ids.length} held, ${row.locked} locked. Right-click to ${lockState === 'all' ? 'unlock' : 'lock'} all.`;
    const icon = sprite ? `<img src="${escapeHtml(sprite)}" alt="">` : `<i>${escapeHtml(name.slice(0, 1))}</i>`;
    return `<div class="gc-produce-lock" data-produce-species="${escapeHtml(row.species)}" data-locked="${lockState}" title="${escapeHtml(title)}">${icon}<span class="gc-produce-lock-count">${row.ids.length}</span><b class="gc-produce-lock-pad" aria-hidden="true"></b></div>`;
  }).join('') : '<p>No produce</p>';
}

function position(): void {
  const rect = feature('produceLocks') ? inventoryRect() : null;
  let panel = document.getElementById(PANEL_ID);
  if (!rect) {
    if (panel) panel.hidden = true;
    return;
  }
  panel ||= createPanel();
  render(panel);
  const gap = 8;
  // Sits on the inventory's top edge, only as wide as its tiles; a row longer than the inventory scrolls sideways.
  panel.style.left = `${Math.round(rect.left)}px`;
  panel.style.maxWidth = `${Math.round(rect.right - rect.left)}px`;
  panel.style.bottom = `${Math.round(innerHeight - rect.top + gap)}px`;
  panel.hidden = false;
}

/**
 * Polled rather than driven by state frames: opening the inventory sends nothing over the socket,
 * and the modal springs into place over several frames. The tick only does real work while the
 * inventory is expanded; the rebuild itself waits on the signature.
 */
const ticker = createTicker(position, 150);

export function syncProduceLocks(): void {
  ticker.sync(feature('produceLocks'));
  if (!feature('produceLocks')) document.getElementById(PANEL_ID)?.remove();
  signature = '';
}
