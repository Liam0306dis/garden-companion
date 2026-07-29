import type { CompanionPage, JotaiAtom } from '../types.js';

function atomMap(page: CompanionPage): Map<unknown, JotaiAtom> | null {
  const cache = page.jotaiAtomCache;
  if (cache instanceof Map) return cache;
  return cache?.cache ?? null;
}

export function initAbilitySilencer(attempt = 0): void {
  const page = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window) as unknown as CompanionPage;
  const map = atomMap(page);
  if (!map) {
    if (attempt < 240) setTimeout(() => initAbilitySilencer(attempt + 1), 500);
    return;
  }

  const atom = [...map.values()].find(candidate => String(candidate.debugLabel ?? '').endsWith('myPetSlotInfosAtom'));
  if (!atom?.read) {
    if (attempt < 240) setTimeout(() => initAbilitySilencer(attempt + 1), 500);
    return;
  }
  if (atom.__gardenCompanionSilencer) return;

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
}
