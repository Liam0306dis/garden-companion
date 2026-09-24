import type { PlantSlot } from '../types.js';
import { feature } from '../config.js';
import { sendQuinoaCommand } from '../game-connection.js';
import { isTyping } from '../keybinds.js';
import { state } from '../state.js';
import { toast } from '../toast.js';
import { worldSceneActive } from '../world-scene.js';

/** Spacebar harvest for mature Gold and Rainbow crops, skipping the game's press and hold. */

export function installInstantHarvest(): void {
  // The just-harvested slot, so a second press before the server confirms the first still advances
  // to the next crop rather than firing at the same one again - the game auto-advances selection the
  // same way, but we bypass that when we skip its press-and-hold.
  // Slots harvested on the current tile whose harvest the state has not caught up to yet. The game
  // depletes its own ready set as it harvests and resolves the current crop as the next slot at or
  // after the selection, wrapping - we mirror that, but suppress our just-harvested slots ourselves
  // because we get no optimistic update for a command we sent, so they still look ready for a beat.
  let harvested: { tile: string; ids: Set<number> } | null = null;
  window.addEventListener('keydown', event => {
    // Any minigame holding the farm owns the keyboard too, or space harvests behind the scene.
    // Crop Protection exists to stop harvests this key exists to fire, so it wins outright.
    if (!feature('instantHarvest') || feature('cropProtection') || worldSceneActive() || event.code !== 'Space' || event.repeat || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || isTyping()) return;
    // Only a guard against harvesting while busy elsewhere - at a shop, the trough, the preserve
    // station. Which crop is eligible is decided below, so every flavour of harvest passes here.
    // rarePatchHarvest earns its place because the action describes the selected slot: once
    // harvesting has left gaps in the slot ids that selection often matches nothing on the tile,
    // and the scan below then settles on a crop the action was never describing.
    // preservedHarvest is deliberately absent: preserving is permanent and the game guards it
    // behind a press and hold, which is the one thing this key exists to skip.
    if (state.currentAction && state.currentAction !== 'none' && !['harvest', 'rainbowHarvest', 'goldHarvest', 'rarePatchHarvest'].includes(state.currentAction)) return;
    // myOwnCurrentDirtTileIndexAtom reports null the moment a plant is on the tile - which is exactly
    // when you harvest - so state.dirtTileIndex is null here. The current grow-slots (currentCrop) are
    // still populated though, so recover which dirt tile they belong to by matching them back to the
    // garden, then use that index both to read the tile and to name the slot in the command.
    const tileObjects = state.slot?.data?.garden?.tileObjects ?? {};
    const current = Array.isArray(state.currentCrop) ? state.currentCrop : [];
    const slotKey = (slot: { slotId?: unknown; species?: unknown; endTime?: unknown }) => `${slot?.slotId}|${slot?.species}|${slot?.endTime}`;
    const currentSignature = current.map(slotKey).join(',');
    let dirtIndex: string | number | null = state.dirtTileIndex;
    if ((dirtIndex == null || !tileObjects[String(dirtIndex)]?.slots?.length) && current.length) {
      const match = Object.keys(tileObjects).find(key => {
        const slots = tileObjects[key]?.slots;
        return Array.isArray(slots) && slots.length === current.length && slots.map(slotKey).join(',') === currentSignature;
      });
      if (match !== undefined) dirtIndex = match;
    }
    const tile = dirtIndex == null ? undefined : tileObjects[String(dirtIndex)];
    if (!tile?.slots?.length) return;
    const now = Date.now();
    // Preserving a crop is permanent and the game guards harvesting one behind a press and hold,
    // which is exactly what this key skips, so a preserved slot is never a candidate here.
    const readyRareGold = (slot: PlantSlot | undefined) => slot?.preserved !== true && Number(slot?.endTime) <= now && (slot?.mutations || []).some(value => value === 'Gold' || value === 'Rainbow');
    // Reset the pending set when the tile changes, and drop any slot the state now agrees is gone -
    // once it reads as not-ready the harvest has landed and it no longer needs suppressing (and a
    // future regrow can be taken again).
    if (!harvested || harvested.tile !== String(dirtIndex)) harvested = { tile: String(dirtIndex), ids: new Set() };
    const taken = harvested.ids;
    for (const id of [...taken]) {
      if (!readyRareGold(tile.slots.find(slot => Number(slot.slotId) === id))) taken.delete(id);
    }
    // The ready Gold/Rainbow slots the game would still offer, minus the ones we have already taken.
    const qualifyingIds = tile.slots.filter(slot => readyRareGold(slot) && !taken.has(Number(slot.slotId))).map(slot => Number(slot.slotId)).sort((left, right) => left - right);
    if (!qualifyingIds.length) return;
    // The game's own resolver: the slot at or after the selection, wrapping to the first.
    const selected = Number(state.selectedSlotId);
    const targetId = qualifyingIds.find(id => id >= selected) ?? qualifyingIds[0];
    const index = tile.slots.findIndex(slot => Number(slot.slotId) === targetId);
    if (index < 0) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const slot = tile.slots[index];
    taken.add(targetId);
    // Harvest is one of the commands the game sends inside the QuinoaCommand envelope, so it
    // needs the sequence too - sent raw the server rejects it and the crop simply stays put.
    // Since bundle 1116 it also carries a client-minted cropItemId: the reducer uses it as the id
    // of the produce the harvest drops into the inventory, and a harvest without one is rejected.
    // Any fresh unique UUID works - the server assigns it to the produce and we never read it back.
    sendQuinoaCommand({ type: 'HarvestCrop', slot: Number(dirtIndex), slotsIndex: slot.slotId ?? index, cropItemId: crypto.randomUUID() });
    toast('Harvest requested.', 'success');
  }, true);
}
