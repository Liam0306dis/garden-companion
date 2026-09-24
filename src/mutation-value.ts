import { MUTATION_CATALOG } from './constants.js';

/**
 * A crop's coin multiplier from its mutations, by the game's own arithmetic read from its mutation
 * catalog: the growth mutation (Gold or Rainbow) scales the crop, and every other mutation adds its
 * multiplier less one. A crop carries at most one mutation from each group.
 *
 * This replaced two hand-written tables of weather and lunar pairs, which were missing the
 * Wet/Chilled pairs with Dawnbound and Amberbound and priced those crops one step low.
 */
export function catalogMutationMultiplier(mutations: readonly string[]): number {
  const growth = mutations.find(id => MUTATION_CATALOG[id]?.group === 'Growth');
  const others = mutations.filter(id => MUTATION_CATALOG[id] && MUTATION_CATALOG[id].group !== 'Growth');
  const added = others.reduce((sum, id) => sum + MUTATION_CATALOG[id].coinMultiplier, 0);
  return (growth ? MUTATION_CATALOG[growth].coinMultiplier : 1) * (1 + added - others.length);
}
