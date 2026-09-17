import { page } from '../page.js';
import type { JotaiAtom } from '../types.js';
import { onOutgoingCommand } from '../game-connection.js';
import { onCurrentRoomState, type RoomStateInstance } from '../game-room-state.js';

type AtomGetter = (atom: JotaiAtom) => unknown;
type AtomSetter = (atom: JotaiAtom, value: unknown) => unknown;
type AtomWrite = (get: AtomGetter, set: AtomSetter, ...args: unknown[]) => unknown;

interface PendingPotSelection {
  addedPlantIds: Set<string>;
  restoreItemId: string | null;
  expiresAt: number;
  /** When the pot went out, so a later hotbar press can be told apart from the game's own writes. */
  armedAt: number;
}

const wrappedAtoms = new WeakSet<JotaiAtom>();
/** A hotbar press this much after the pot counts as the player overriding, not the pot's auto-select. */
const GESTURE_GAP_MS = 30;
/** How fresh that press must be when the selection write lands, so a stale click does not count. */
const GESTURE_RECENT_MS = 250;
let pendingSelection: PendingPotSelection | null = null;
/** Last trusted keydown/pointerdown, used to spot the player reselecting the plant themselves. */
let lastUserGestureAt = 0;
let gestureWatch = false;

/**
 * The game keeps the pot selected because we bounce every write of the new plant's id back to it for
 * a two-second window. The catch is that the player's own hotbar press to select that plant is such
 * a write, so within the window it gets bounced too - the plant will not select until the window
 * runs out. This says whether the current write is the player deciding to pick the plant up after
 * the pot: a trusted gesture that happened after the pot went out, and recently enough to be the one
 * driving this very write. The pot's own auto-select fires in the same tick it was armed, and the
 * server's later re-select has no gesture behind it, so neither is mistaken for the player.
 */
function playerReselect(pending: PendingPotSelection): boolean {
  const now = performance.now();
  return lastUserGestureAt > pending.armedAt + GESTURE_GAP_MS && now - lastUserGestureAt < GESTURE_RECENT_MS;
}

function watchUserGestures(): void {
  if (gestureWatch) return;
  gestureWatch = true;
  const mark = (event: Event) => { if (event.isTrusted) lastUserGestureAt = performance.now(); };
  window.addEventListener('keydown', mark, true);
  window.addEventListener('pointerdown', mark, true);
}
/**
 * The selection as last written. Tracked rather than read back: a command goes out before any
 * getter is to hand, and this is the only thing that says whether the pot was what was in use.
 */
let lastSelectedItemId: unknown = null;

/** Set `gcPotDebug` in local storage to 1 to trace what each hook decides. Off by default. */
function trace(step: string, detail: Record<string, unknown>): void {
  try { if (localStorage.getItem('gcPotDebug') !== '1') return; } catch { return; }
  console.log('[PotKeeper] ' + step, { ...detail, lastSelectedItemId, armed: Boolean(pendingSelection) });
}

function isEnabled(): boolean {
  return page.__gardenCompanionFeature?.('keepPlanterPotSelected') === true;
}

/**
 * Both halves of a selection, and both are plain writable atoms.
 *
 * Bundle 1206 moved them into `currentRoomAtom`'s state instance - `selection.itemId` and
 * `selection.lastExplicitItemId` - from the old standalone mySelectedItemIdAtom /
 * myLastExplicitlySelectedItemIdAtom; game-room-state.ts hands over the field atoms. The wrapping is
 * unchanged.
 *
 * What the interface shows is validated rather than stored: the index is derived from the selected
 * id, then discarded unless the item it lands on is the one last explicitly selected -
 *
 *   (item.itemType === Tool && lastExplicitlySelected !== itemKey) ? null : index
 *
 * Putting the id back while the explicit id still named the new plant failed that test and resolved
 * to null, which is the interface holding nothing at all. Both have to go back.
 */
function installHooks(state: RoomStateInstance): boolean {
  const selectedItemAtom = state.selection?.itemId ?? null;
  const explicitItemAtom = state.selection?.lastExplicitItemId ?? null;
  if (!selectedItemAtom?.write || !explicitItemAtom?.write) return false;
  if (wrappedAtoms.has(selectedItemAtom)) return true;

  const originalSelectedItemWrite = selectedItemAtom.write as AtomWrite;
  const originalExplicitItemWrite = explicitItemAtom.write as AtomWrite;

  explicitItemAtom.write = function(get, set, ...args) {
    const pending = pendingSelection;
    const targetsPlant = Boolean(pending) && performance.now() <= (pending?.expiresAt ?? 0)
      && typeof args[0] === 'string' && Boolean(pending?.addedPlantIds.has(args[0] as string));
    // A hotbar press or click landing on the just-potted plant is the player choosing it: disarm so
    // it selects at once instead of being bounced back to the pot for the rest of the window.
    if (targetsPlant && pending && playerReselect(pending)) pendingSelection = null;
    const redirecting = targetsPlant && Boolean(pendingSelection);
    trace('explicit write', { requested: args[0], redirecting });
    const value = redirecting ? pending!.restoreItemId : args[0];
    return originalExplicitItemWrite.call(this, get as AtomGetter, set as AtomSetter, value);
  };

  selectedItemAtom.write = function(get, set, ...args) {
    const pending = pendingSelection;
    if (!isEnabled() || (pending && performance.now() > pending.expiresAt)) pendingSelection = null;

    const nextItemId = args[0];
    // Held for the whole window rather than spent on the first write. Under prediction the game
    // sets the selection when it predicts and again when the server confirms, and consuming this on
    // whichever came first let the other one through - which is how the plant stopped being
    // selected without the pot ever coming back.
    const targetsPlant = Boolean(pendingSelection) && typeof nextItemId === 'string'
      && Boolean(pendingSelection?.addedPlantIds.has(nextItemId));
    // ...but a fresh hotbar press on the plant is the player overriding the keeper, so let it land.
    if (targetsPlant && pendingSelection && playerReselect(pendingSelection)) pendingSelection = null;
    const redirecting = targetsPlant && Boolean(pendingSelection);
    trace('select write', { requested: nextItemId, redirecting });
    if (redirecting && pendingSelection) {
      lastSelectedItemId = pendingSelection.restoreItemId;
      // Set alongside, so the validation that reads both sees a pair that agrees however the game
      // reached here - it does not always write the two together.
      (set as AtomSetter)(explicitItemAtom!, pendingSelection.restoreItemId);
      return originalSelectedItemWrite.call(this, get as AtomGetter, set as AtomSetter, pendingSelection.restoreItemId);
    }

    lastSelectedItemId = nextItemId;
    return originalSelectedItemWrite.call(this, get as AtomGetter, set as AtomSetter, ...args);
  };

  wrappedAtoms.add(selectedItemAtom);
  wrappedAtoms.add(explicitItemAtom);
  return true;
}

/**
 * Armed from the command rather than from the inventory. Registered once, independent of the atoms.
 *
 * This used to intercept the inventory write and work out what had just been potted. Build 1029 left
 * no write to intercept - the inventory became a value derived from the predicted state - and
 * watching its read is too late, because the game acts on its own prediction and moves the selection
 * before that value is ever recomputed.
 *
 * The command going out is both earlier and exact: since 1029 it carries the id of the plant it is
 * about to create, so there is nothing left to deduce.
 */
function watchPotCommands(): void {
  onOutgoingCommand(command => {
    if (command.type === 'SetSelectedItem' || command.type === 'PotPlant') {
      trace('command ' + command.type, { itemIndex: command.itemIndex, plantItemId: command.plantItemId });
    }
    // Only when the pot is what is in hand. Our own plant drag pots a plant too, and there the
    // player never picked up a pot, so there is nothing to put back.
    if (!isEnabled() || command.type !== 'PotPlant' || lastSelectedItemId !== 'PlanterPot') return;
    const plantItemId = command.plantItemId;
    if (typeof plantItemId !== 'string') return;
    pendingSelection = {
      addedPlantIds: new Set([plantItemId]),
      restoreItemId: 'PlanterPot',
      expiresAt: performance.now() + 2_000,
      armedAt: performance.now(),
    };
  });
}

export function initPlanterPotSelection(): void {
  watchUserGestures();
  watchPotCommands();
  // The selection atoms live on the room state instance, re-handed on a room reset so a reconnect
  // re-wraps the fresh atoms rather than the dead ones.
  onCurrentRoomState(state => { installHooks(state); });
}
