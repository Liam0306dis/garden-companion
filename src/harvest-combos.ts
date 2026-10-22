import type { HarvestCombo } from './types.js';
import { clampSize } from './crop-size.js';

/**
 * Crop protection's ready combos, the parts the saved config needs as well as the panel: two combos
 * are the same when they ask for the same size and the same mutations, in any order.
 */
export function comboKey(combo: Partial<HarvestCombo> | null | undefined): string {
  // Saved settings are read with this at load, so a damaged entry reads as a blank, not a crash.
  const mutations = Array.isArray(combo?.mutations) ? [...combo.mutations].sort() : [];
  return `${clampSize(Number(combo?.minSize))}|${mutations.join('+')}`;
}

/** Whether an earlier combo in the list already asks for exactly what this one does. */
export function repeatsEarlierCombo(combos: Array<Partial<HarvestCombo> | null>, index: number): boolean {
  const key = comboKey(combos[index]);
  return combos.slice(0, index).some(other => comboKey(other) === key);
}

/** The list with every repeat dropped, keeping the first of each. */
export function withoutRepeatedCombos<T extends Partial<HarvestCombo> | null>(combos: T[]): T[] {
  return combos.filter((_, index) => !repeatsEarlierCombo(combos, index));
}
