import { findAtom } from '../atom-cache.js';
import { page } from '../page.js';
import { retryUntil } from '../retry.js';

/**
 * How long a silenced ability stays hidden. The game only pops up an ability performed within the
 * last three seconds, so past that the real event can be handed back without it ever showing; the
 * rest is headroom for a slow frame or two.
 *
 * Timed from when we first saw the event rather than from its performedAt: that is the server's
 * clock, and comparing it with this PC's would silence nothing on a PC whose clock runs fast.
 */
const HIDE_FOR_MS = 15_000;

/** When each pet's latest silenced event was first seen, by pet. One entry per pet, replaced as it acts again. */
const firstSeen = new Map<string, { performedAt: unknown; at: number }>();

function seenFor(petId: string, performedAt: unknown): number {
  const seen = firstSeen.get(petId);
  if (seen && seen.performedAt === performedAt) return performance.now() - seen.at;
  firstSeen.set(petId, { performedAt, at: performance.now() });
  return 0;
}

export function initAbilitySilencer(): void {
  retryUntil(installSilencer, 'the ability silencer');
}

/**
 * The game's ability popup and its sound both come from a pet's lastActionEvent in
 * myPetSlotInfosAtom, so a silenced ability's event is left out of what the atom hands back.
 *
 * Only while it is fresh. Other mods read the same atom - QPM checks it against the room state and
 * flags any difference - and a silenced finder fires often enough that hiding its event for as long
 * as it stayed the pet's latest kept the atom different from the room for good. The atom is read
 * again on every change to the player's slot, which pet movement alone makes several times a
 * second, so the real event is back within moments of the popup's window closing.
 */
function installSilencer(): boolean {
  const atom = findAtom('myPetSlotInfosAtom');
  if (typeof atom?.read !== 'function') return false;
  if (atom.__gardenCompanionSilencer) return true;

  const originalRead = atom.read;
  atom.read = function(get: unknown, ...args: unknown[]): unknown {
    const value = originalRead.call(this, get, ...args);
    const config = page.__gardenCompanionConfig?.();
    if (!config?.abilitySilencer || !value || typeof value !== 'object' || Array.isArray(value)) return value;

    const silenced = new Set(config.silencedAbilities);
    if (!silenced.size) return value;
    let filtered: Record<string, unknown> | null = null;
    for (const [petId, rawInfo] of Object.entries(value)) {
      if (!rawInfo || typeof rawInfo !== 'object' || Array.isArray(rawInfo)) continue;
      const info = rawInfo as Record<string, unknown>;
      const event = info.lastActionEvent as Record<string, unknown> | undefined;
      if (event?.action !== 'ability' || !silenced.has(String(event.abilityId ?? ''))) continue;
      if (seenFor(petId, event.performedAt) > HIDE_FOR_MS) continue;
      filtered ??= { ...value };
      const { lastActionEvent: _silenced, ...visibleInfo } = info;
      filtered[petId] = visibleInfo;
    }
    return filtered ?? value;
  };
  atom.__gardenCompanionSilencer = true;
  return true;
}
