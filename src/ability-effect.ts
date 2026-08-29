import { ABILITY_DETAILS, PROC_RULES } from './constants.js';
import { formatDuration, humanize, NUMBER_LOCALE } from './utils.js';

/**
 * What an ability is actually worth at a given Strength, in the game's own wording.
 *
 * Strength scales the effect as well as the chance of getting it, which is why every value here is
 * multiplied through rather than printed as written in the catalog - and why an activated ability's
 * cooldown is divided by it instead.
 *
 * Lifted out of the panel so the granter planner can print the same figures. It had been a closure
 * there, which is why that tab could only ever show a proc chance.
 */
export const GRANTER_MUTATIONS: Record<string, string> = {
  RainDance: 'Wet', SnowGranter: 'Chilled', FrostGranter: 'Frozen', DawnlitGranter: 'Dawnlit',
  AmberlitGranter: 'Ambershine', GoldGranter: 'Gold', RainbowGranter: 'Rainbow', ThunderstruckGranter: 'Thunderstruck',
};

export function abilityEffectText(ability: string, strength: number, trigger: string | undefined, parameters: Record<string, number> | undefined): string {
  const proc = PROC_RULES[ability];
  if (proc) return proc.effect(strength);
  if (GRANTER_MUTATIONS[ability]) return `Applies the ${GRANTER_MUTATIONS[ability]} mutation`;
  const values = parameters ?? {};
  const scaled = (key: string) => Number(values[key] || 0) * strength / 100;
  const percent = (value: number) => Number(value.toFixed(2)).toLocaleString(NUMBER_LOCALE);
  if (values.hungerRefundPercentage != null) return `Reduces hunger depletion by ${percent(scaled('hungerRefundPercentage'))}%`;
  if (values.hungerRestorePercentage != null) return `Restores ${percent(scaled('hungerRestorePercentage'))}% hunger per proc`;
  if (values.mutationChanceIncreasePercentage != null) return `Mutation chance increase: +${percent(scaled('mutationChanceIncreasePercentage'))}%`;
  if (values.scaleIncreasePercentage != null) return `Crop size increase: +${percent(scaled('scaleIncreasePercentage'))}% per proc`;
  if (values.cropSellPriceIncreasePercentage != null) return `Sell bonus: +${percent(scaled('cropSellPriceIncreasePercentage'))}% coins`;
  if (values.plantGrowthReductionMinutes != null) return `Growth reduction: ${scaled('plantGrowthReductionMinutes').toFixed(1)}m per proc`;
  if (values.eggGrowthTimeReductionMinutes != null) return `Hatch reduction: ${scaled('eggGrowthTimeReductionMinutes').toFixed(1)}m per proc`;
  if (values.baseMaxCoinsFindable != null) return `Coins found: 1 - ${Math.floor(scaled('baseMaxCoinsFindable')).toLocaleString(NUMBER_LOCALE)} per proc`;
  if (values.bonusXp != null) return `Bonus XP: +${Math.floor(scaled('bonusXp')).toLocaleString(NUMBER_LOCALE)} per proc`;
  if (values.maxStrengthIncreasePercentage != null) return `Max STR boost: +${percent(scaled('maxStrengthIncreasePercentage'))}%`;
  if (values.plantAbilityChanceBoostPercentage != null) return `Active pet ability chance: +${percent(scaled('plantAbilityChanceBoostPercentage'))}%`;
  if (values.mutationChancePerMinute != null) return `Mutation chance: ${percent(scaled('mutationChancePerMinute'))}% per minute`;
  if (values.cooldownSeconds != null) {
    const cooldown = values.cooldownSeconds / Math.max(strength / 100, .01);
    const range = values.tileRadius != null ? ` | Range: ${values.tileRadius} tile${values.tileRadius === 1 ? '' : 's'}` : '';
    return `Cooldown: ${formatDuration(cooldown * 1000)}${range}`;
  }
  return humanize(trigger || 'Effect details unavailable');
}
