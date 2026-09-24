import { findAtom } from '../atom-cache.js';
import { page } from '../page.js';
import { retryUntil } from '../retry.js';

export function initAbilitySilencer(): void {
  retryUntil(installSilencer, 'the ability silencer');
}

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
    let filtered: Record<string, unknown> | null = null;
    for (const [petId, rawInfo] of Object.entries(value)) {
      if (!rawInfo || typeof rawInfo !== 'object' || Array.isArray(rawInfo)) continue;
      const info = rawInfo as Record<string, unknown>;
      const event = info.lastActionEvent as Record<string, unknown> | undefined;
      if (event?.action !== 'ability' || !silenced.has(String(event.abilityId ?? ''))) continue;
      filtered ??= { ...value };
      const { lastActionEvent: _silenced, ...visibleInfo } = info;
      filtered[petId] = visibleInfo;
    }
    return filtered ?? value;
  };
  atom.__gardenCompanionSilencer = true;
  return true;
}
