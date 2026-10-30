import type { JotaiAtom } from '../types.js';
import { findAtom } from '../atom-cache.js';
import { feature } from '../config.js';
import { gameStore } from '../game-store.js';
import { isTyping } from '../keybinds.js';
import { page } from '../page.js';
import { pixiNodeVisible, pixiSurface } from '../pixi.js';
import { createTicker } from '../ticker.js';
import { toast } from '../toast.js';

/**
 * A cinematic mode button, back where the game kept its own until build 1634 moved cinematic mode
 * onto the Camera (hold it and press Hide UI): at the foot of the right-side rail, under Daily
 * Quests. One click hides the game's HUD, another brings it back. While cinematic mode is on the
 * rail goes with the HUD, so the button moves to the screen's top right corner, faded so it keeps
 * out of shots, since it is the way back out. Esc leaves cinematic mode too.
 *
 * The rail is drawn on the game's canvas, so the button is a page element placed under it each
 * tick from the rail's on-screen bounds.
 */

const CAMERA_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.2l1.5-2h5.6l1.5 2h2.2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5Z"/><circle cx="12" cy="13" r="3.3"/></svg>';
const CAMERA_OFF_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.2l1.5-2h5.6l1.5 2h2.2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5Z"/><circle cx="12" cy="13" r="3.3"/><path d="M3 3l18 18"/></svg>';

/** The rail's own label in the game's scene graph (its `name` as a system is rightSideRail). */
const RAIL_LABEL = 'RightSideRail';
/** Daily Quests, the rail's last button, which the game labels itself. */
const QUESTS_LABEL = 'RightSideRailQuestsButton';
/**
 * What Daily Quests draws around itself while a quest can be taken: a ring that swells out from it and
 * the badge pulsing. Both are left out of its measure, or the button would bob along with them.
 */
const QUESTS_DECORATION_LABELS = new Set(['QuestNoticeRing', 'RightSideRailQuestsBadge']);
/** Space between the last rail button and ours, in CSS pixels. */
const RAIL_GAP_PX = 8;

/** How long to wait before walking the scene graph again when the rail was not found. */
const RAIL_SEARCH_BACKOFF_MS = 3000;

let rail: Record<string, any> | null = null;
let quests: Record<string, any> | null = null;
let lastRailSearch = 0;
/** Where the button was last docked, null until the rail has been measured once. */
let docked: { left: number; top: number } | null = null;
/** The pointer's last spot on the page, to tell when Daily Quests is hovered. */
const pointer = { x: -1, y: -1 };
/** When the pointer was last seen over Daily Quests. */
let questsHoveredAt = 0;
/** How long after the pointer leaves Daily Quests before it is measured again, while it shrinks back. */
const HOVER_SETTLE_MS = 600;

let chatPresentedAtom: JotaiAtom | null = null;

/**
 * Whether the game's chat window is up. It opens over the foot of the rail without hiding the rail,
 * so it is checked on its own.
 */
function chatOpen(): boolean {
  chatPresentedAtom ??= findAtom('isChatWidgetPresentedAtom');
  const store = gameStore();
  if (!chatPresentedAtom || !store) return false;
  try { return Boolean(store.get(chatPresentedAtom)); } catch { return false; }
}

const alive = (node: Record<string, any> | null) => Boolean(node && !node.destroyed && node.parent);

function findRail(stage: Record<string, any>): Record<string, any> | null {
  if (alive(rail)) return rail;
  rail = null;
  // The whole stage is walked to find it, so a miss (world not built yet, or a renamed rail) waits a
  // while before trying again rather than walking thousands of nodes every tick.
  const now = Date.now();
  if (now - lastRailSearch < RAIL_SEARCH_BACKOFF_MS) return null;
  lastRailSearch = now;
  const stack = [stage];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (node.label === RAIL_LABEL) return rail = node;
    if (Array.isArray(node.children)) stack.push(...node.children);
  }
  return null;
}

/**
 * Daily Quests, looked for inside the rail only - a few dozen nodes, so it is cheap to retry until
 * the button appears (it is not there before the tutorial is done).
 */
function findQuests(railNode: Record<string, any>): Record<string, any> | null {
  if (alive(quests)) return quests;
  quests = null;
  const stack = [...(railNode.children ?? [])];
  while (stack.length) {
    const child = stack.pop();
    if (child?.label === QUESTS_LABEL) return quests = child;
    if (Array.isArray(child?.children)) stack.push(...child.children);
  }
  return null;
}

/** A node's bounds with its quest decorations hidden for the measure, then put back as they were. */
function boundsWithoutDecorations(node: Record<string, any>): { x: number; y: number; width: number; height: number } | undefined {
  const hidden: Array<Record<string, any>> = [];
  const stack = [...(node.children ?? [])];
  while (stack.length) {
    const child = stack.pop();
    if (QUESTS_DECORATION_LABELS.has(child?.label) && child.visible) hidden.push(child);
    else if (Array.isArray(child?.children)) stack.push(...child.children);
  }
  for (const child of hidden) child.visible = false;
  try { return node.getBounds?.(); }
  finally { for (const child of hidden) child.visible = true; }
}

/**
 * The foot of the rail in CSS pixels, null when the rail is not on screen, or 'hold' to keep the
 * last spot (while Daily Quests is hovered). Measured off
 * Daily Quests rather than the whole rail, whose bounds also take in the chat preview bubble and
 * open tooltips, either of which would shift the button about. The quests badge pokes out above and
 * to the left, so the right and bottom edges are the ones to go by.
 */
function railFoot(): { x: number; y: number } | 'hold' | null {
  const surface = pixiSurface();
  const node = surface && findRail(surface.stage);
  if (!surface || !node || !shown(node) || chatOpen()) return null;
  const button = findQuests(node);
  const target = button && pixiNodeVisible(button) ? button : node;
  const bounds = target === button ? boundsWithoutDecorations(button) : target.getBounds?.();
  if (!bounds || !(bounds.width > 0) || !(bounds.height > 0)) return null;
  const right = bounds.x + bounds.width;
  const bottom = bounds.y + bounds.height;
  // Daily Quests grows a little while hovered, which would nudge the button about under it, so the
  // last spot stands while the pointer is on it and for a moment after, as it shrinks back.
  if (target === button) {
    const inside = pointer.x >= surface.toScreenX(bounds.x) && pointer.x <= surface.toScreenX(right)
      && pointer.y >= surface.toScreenY(bounds.y) && pointer.y <= surface.toScreenY(bottom);
    if (inside) questsHoveredAt = Date.now();
    if (docked && Date.now() - questsHoveredAt < HOVER_SETTLE_MS) return 'hold';
  }
  const side = target === button ? Math.min(bounds.width, bounds.height) : bounds.width;
  return { x: surface.toScreenX(right - side / 2), y: surface.toScreenY(bottom) };
}

/**
 * Whether the node and every container above it are drawn. The game hides the rail by hiding a
 * container it sits in as well as the rail itself, so the rail's own flags are not enough.
 */
function shown(node: Record<string, any>): boolean {
  for (let current: Record<string, any> | null = node; current; current = current.parent ?? null) {
    if (!pixiNodeVisible(current)) return false;
  }
  return true;
}

function place(button: HTMLElement): void {
  // While cinematic mode is on the rail is gone with the rest of the HUD, so the button waits in the
  // screen's top right corner (the stylesheet's spot) and goes back under the rail when it returns.
  if (button.dataset.active === 'true') {
    button.style.left = button.style.top = button.style.right = button.style.visibility = '';
    return;
  }
  const foot = railFoot();
  if (foot && foot !== 'hold') {
    docked = {
      left: Math.round(foot.x - button.offsetWidth / 2),
      top: Math.round(foot.y + RAIL_GAP_PX),
    };
  }
  // The rail hides while the inventory and other panels are open, and the button goes with it, as it
  // does under the chat window (the window may be resized meanwhile, so it is measured afresh when
  // the rail is back). The same goes until the rail has been found once: with the HUD up, the top
  // right corner the stylesheet gives it is over the player's profile.
  button.style.visibility = foot && docked ? '' : 'hidden';
  if (!foot || !docked) return;
  // Kept on screen, in case the window was resized since the last measure.
  const left = Math.min(Math.max(0, docked.left), Math.max(0, window.innerWidth - button.offsetWidth));
  const top = Math.min(Math.max(0, docked.top), Math.max(0, window.innerHeight - button.offsetHeight));
  button.style.left = `${left}px`;
  button.style.top = `${top}px`;
  button.style.right = 'auto';
}

const dockTicker = createTicker(() => {
  const button = document.getElementById('gc-cinematic');
  if (button && !button.hidden) place(button);
}, 100);

export function updateCinematicButton(): void {
  const button = document.getElementById('gc-cinematic');
  if (!button) return;
  // Our own scenes (the planner, fishing and the like) hold cinematic mode for their own screens and
  // hand it back when they close, so the button steps aside rather than offer to fight them for it.
  // Switched off while it had cinematic mode on, the button would leave no way back out (the camera
  // reset that would normally end it is held off for the pin), so the pin goes with it.
  if (!feature('cinematicButton')) page.__gardenCompanionReleaseCinematicPin?.();
  button.hidden = !feature('cinematicButton') || Boolean(page.__gardenCompanionCinematicClaimed?.());
  dockTicker.sync(!button.hidden);
  const on = Boolean(page.__gardenCompanionCinematicFromGame?.());
  button.dataset.active = String(on);
  // The game's own icons from its old rail button when they have loaded (CameraOff while the HUD is
  // up, CameraOn while it is hidden, as it showed them), a drawn camera until then.
  const sprite = page.__gardenCompanionWeatherSprites?.[on ? 'cameraOn' : 'cameraOff'];
  button.innerHTML = sprite ? `<img src="${sprite}" alt="">` : on ? CAMERA_OFF_ICON : CAMERA_ICON;
  const label = on ? 'Exit cinematic mode' : 'Cinematic mode';
  button.title = label;
  button.setAttribute('aria-label', label);
  // Moved at once rather than on the next tick, so it does not sit in the shot under a vanished rail.
  if (!button.hidden) place(button);
}

export function mountCinematicButton(): void {
  if (document.getElementById('gc-cinematic')) return;
  const button = document.createElement('button');
  button.id = 'gc-cinematic';
  button.addEventListener('click', toggle);
  document.body.appendChild(button);
  window.addEventListener('pointermove', event => {
    pointer.x = event.clientX;
    pointer.y = event.clientY;
  }, { passive: true, capture: true });
  page.__gardenCompanionOnCinematicChange?.(updateCinematicButton);
  updateCinematicButton();
  // Taken as it bubbles up to the window, so anything that handles Esc first and stops it there (our
  // dialogs, keybind capture, the What's new card) keeps it. Only while cinematic mode is the
  // player's own and the button is offered, so Esc keeps its usual jobs the rest of the time.
  window.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.repeat || event.defaultPrevented || isTyping()) return;
    if (button.hidden || !page.__gardenCompanionCinematicFromGame?.()) return;
    event.preventDefault();
    toggle();
  });
}

function toggle(): void {
  // The button keeps keyboard focus otherwise, and WASD would go to it rather than the player.
  document.getElementById('gc-cinematic')?.blur();
  const on = page.__gardenCompanionToggleCinematic?.();
  if (on == null) {
    toast('Cinematic mode is still loading.', 'error');
    return;
  }
  if (on) toast('Cinematic mode on - press Esc or the camera button again to exit');
  updateCinematicButton();
}
