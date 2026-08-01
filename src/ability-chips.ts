import { ABILITY_COLOURS, ABILITY_COLOUR_FALLBACK, ABILITY_DETAILS } from './constants.js';
import { escapeHtml, humanize } from './utils.js';

/**
 * The game colours each ability chip from a switch in its own bundle, which the build extracts
 * verbatim, so these match the in-game pet card exactly.
 */
export function abilityChips(abilities: string[]): string {
  if (!abilities.length) return '';
  const chips = abilities.map(ability => {
    const colour = ABILITY_COLOURS[ability] || ABILITY_COLOUR_FALLBACK;
    const name = ABILITY_DETAILS[ability]?.name || humanize(ability);
    return `<i class="gc-ability-chip" style="background:${escapeHtml(colour)}" title="${escapeHtml(name)}"></i>`;
  }).join('');
  return `<span class="gc-ability-chips" title="${escapeHtml(abilities.map(ability => ABILITY_DETAILS[ability]?.name || humanize(ability)).join(', '))}">${chips}</span>`;
}
