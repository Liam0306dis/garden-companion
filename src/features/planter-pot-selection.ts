import { page } from '../page.js';
import { state } from '../state.js';
import { isOwnCommand, onOutgoingCommand, sendQuinoaCommand } from '../game-connection.js';

/** Set `gcPotDebug` in local storage to 1 to trace what each hook decides. Off by default. */
function trace(step: string, detail: Record<string, unknown>): void {
  try { if (localStorage.getItem('gcPotDebug') !== '1') return; } catch { return; }
  console.log('[PotKeeper] ' + step, { ...detail, selectedItemId: state.selectedItemId });
}

function isEnabled(): boolean {
  return page.__gardenCompanionFeature?.('keepPlanterPotSelected') === true;
}

/**
 * Bundle 1320 made the held item server state. The selection atoms we used to bounce writes on are
 * gone; the game now predicts `heldItem` from its pending commands, and the server applies the same
 * rule - PotPlant picks the new plant up, so both sides put it in hand. The only way to keep the pot
 * is to ask for it back: a SetSelectedItem for the pot, sent straight after the PotPlant.
 *
 * The listener fires before the PotPlant frame leaves, so ours is queued behind it - sent first, it
 * would land before the pot was used and be overridden by the pickup.
 *
 * The game only sends PotPlant when the player uses the pot, so every PotPlant is one - except our
 * own plant drag's, which is marked and skipped: there the player never picked up a pot. This used
 * to check the held item too, but that leans on a mirror of a derived atom that may not have been
 * recomputed yet, and there is nothing it would catch that the mark does not.
 */
function watchPotCommands(): void {
  onOutgoingCommand((command, frame) => {
    if (command.type !== 'PotPlant') return;
    const own = isOwnCommand(frame);
    trace('command PotPlant', { plantItemId: command.plantItemId, own, enabled: isEnabled() });
    if (!isEnabled() || own) return;
    queueMicrotask(() => {
      try {
        const requestId = sendQuinoaCommand({ type: 'SetSelectedItem', itemId: 'PlanterPot', decorRotation: 0 });
        trace('sent SetSelectedItem', { requestId });
      } catch (error) { trace('SetSelectedItem failed', { error: String(error) }); }
    });
  });
}

export function initPlanterPotSelection(): void {
  watchPotCommands();
}
