import type { Pet } from '../types.js';
import { abilityChips } from '../ability-chips.js';
import { abilityEffectText } from '../ability-effect.js';
import { showAlarmBanner, stopAlarm } from '../alarms.js';
import { feature } from '../config.js';
import { ABILITY_DETAILS, GRANTER_CHANCES, PASSIVE_REQUIRED_WEATHER, PET_CATALOG, PROC_RULES, STACKED_PASSIVE_BY_ABILITY, XP_PER_POTION } from '../constants.js';
import { abilityActiveInWeather, activePets, allActivePetsStarving, formatEstimate, heldToolCount, hungerDisplay, petMetrics, petSprite, teamXpPerHour } from '../pets.js';
import { state } from '../state.js';
import { escapeHtml, humanize, NUMBER_LOCALE } from '../utils.js';
import { weatherLabel } from './weather-timer.js';

/** The Active Pets tab and the whole-team hunger alarm. */

const HUNGER_ALARM_OWNER = 'pets:hunger';
let hungerAlarmRaised = false;

/**
 * Fires once per starvation, not once per state update. It re-arms only after a pet is fed, so a
 * team left at zero overnight does not queue an alarm behind every frame the game sends.
 */
export function processPetHunger(): void {
  if (!feature('petHungerAlarm')) {
    if (hungerAlarmRaised) { stopAlarm(HUNGER_ALARM_OWNER); hungerAlarmRaised = false; }
    return;
  }
  const starving = allActivePetsStarving();
  if (!starving) {
    if (hungerAlarmRaised) { stopAlarm(HUNGER_ALARM_OWNER); hungerAlarmRaised = false; }
    return;
  }
  if (hungerAlarmRaised) return;
  hungerAlarmRaised = true;
  const count = activePets().filter(pet => pet?.id).length;
  showAlarmBanner({
    owner: HUNGER_ALARM_OWNER,
    label: 'PET ALARM | HUNGER',
    title: count === 1 ? 'Your pet has zero hunger' : `All ${count} pets have zero hunger`,
    // No detail or action button: the title says it, feeding happens on the docked pet food
    // buttons rather than in a panel, and Stop holds until something is actually fed.
  });
}

function combinedAbilityRows(pets: Pet[]): string {
  const groups = new Map<string, Array<{ ability: string; pet: Pet }>>();
  for (const pet of pets) {
    if (pet.hunger <= 0) continue;
    for (const ability of pet.abilities ?? []) {
      const key = STACKED_PASSIVE_BY_ABILITY.get(ability)?.key ?? ability;
      const group = groups.get(key) ?? [];
      group.push({ ability, pet });
      groups.set(key, group);
    }
  }
  return [...groups].map(([, entries]) => {
    const ability = entries[0].ability;
    const owners = entries.map(entry => entry.pet);
    const strengths = owners.map(pet => petMetrics(pet)?.strength ?? 100);
    const averageStrength = strengths.reduce((sum, value) => sum + value, 0) / strengths.length;
    const details = ABILITY_DETAILS[ability];
    const passiveGroup = STACKED_PASSIVE_BY_ABILITY.get(ability);
    const proc = PROC_RULES[ability];
    const baseChance = passiveGroup ? undefined : details?.baseProbability ?? proc?.chance ?? GRANTER_CHANCES[ability];
    const requiredWeather = PASSIVE_REQUIRED_WEATHER.get(ability);
    let chance = '';
    // A weather-gated proc does not fire outside its weather, so show that rather than a live rate
    // the ETA (which gates the same abilities) would disagree with.
    if (baseChance != null && !abilityActiveInWeather(ability)) {
      chance = `<div class="gc-ability-rate"><b>--</b><small>needs ${escapeHtml(humanize(requiredWeather || ''))}</small></div>`;
    } else if (baseChance != null) {
      const tick = details?.trigger ? details.trigger === 'continuous' : proc?.tick !== false;
      if (tick) {
        const tickRate = 1 - strengths.reduce((remaining, strength) => remaining * Math.pow(1 - baseChance * strength / 10000, 1 / 60), 1);
        const perMinute = (1 - Math.pow(1 - tickRate, 60)) * 100;
        const mean = tickRate > 0 ? 1 / tickRate : null;
        chance = `<div class="gc-ability-rate"><b>${Math.floor(perMinute * 100) / 100}%/min</b>${mean ? `<small>avg ~${formatEstimate(mean)}</small><small>95% within ${formatEstimate(Math.log(20) * mean)}</small>` : ''}</div>`;
      } else {
        const combined = (1 - strengths.reduce((remaining, strength) => remaining * (1 - baseChance * strength / 10000), 1)) * 100;
        chance = `<div class="gc-ability-rate"><b>${combined.toFixed(1)}%</b><small>per trigger</small></div>`;
      }
    }
    let effect: string;
    if (passiveGroup) {
      // A weather-gated boost contributes nothing until its weather runs, so its live combined
      // total is zero out of weather. Rather than let that read as broken, its would-be value is
      // held aside per weather and shown as what it will add once that weather is up.
      const pendingByWeather = new Map<string, number>();
      const total = entries.reduce((sum, entry) => {
        if (entry.pet.hunger <= 0) return sum;
        const strength = petMetrics(entry.pet)?.strength ?? 100;
        const base = Number(ABILITY_DETAILS[entry.ability]?.baseParameters?.[passiveGroup.parameter] || 0);
        const contribution = base * strength / 100;
        if (!abilityActiveInWeather(entry.ability)) {
          const weather = PASSIVE_REQUIRED_WEATHER.get(entry.ability);
          if (weather && contribution) pendingByWeather.set(weather, (pendingByWeather.get(weather) ?? 0) + contribution);
          return sum;
        }
        return sum + contribution;
      }, 0);
      const amount = Number(total.toFixed(2)).toLocaleString(NUMBER_LOCALE);
      const pending = [...pendingByWeather].map(([weather, value]) =>
        `+${Number(value.toFixed(2)).toLocaleString(NUMBER_LOCALE)}% during ${weatherLabel(weather)}`).join(', ');
      if (passiveGroup.key === 'HungerBoost') effect = `Reduces hunger depletion by ${amount}% combined`;
      else if (passiveGroup.key === 'WeatherMutationBoost') effect = `Weather mutation chance increase: +${amount}% combined`;
      else if (passiveGroup.key === 'PetMutationBoost') effect = `Egg mutation chance increase: +${amount}% combined`;
      else effect = `Active pet ability chance: +${amount}% combined`;
      if (pending) effect += ` (${pending})`;
    } else effect = abilityEffectText(ability, averageStrength, details?.trigger, details?.baseParameters);
    const names = owners.map(pet => pet.name || PET_CATALOG[pet.petSpecies]?.name || humanize(pet.petSpecies)).join(', ');
    const label = passiveGroup?.label ?? ABILITY_DETAILS[ability]?.name ?? humanize(ability);
    return `<article class="gc-card gc-ability-summary"><div><h3>${escapeHtml(label)}</h3><p>${escapeHtml(names)}</p><small>${escapeHtml(effect)}</small></div>${chance}</article>`;
  }).join('');
}

export function renderAbilities(): string {
  const active = state.slot?.data?.petSlots || [];
  const held = heldToolCount('XPPotion');
  const xpRate = teamXpPerHour(active);
  const activeCards = active.map(pet => {
    const metrics = petMetrics(pet);
    const maxText = metrics ? metrics.xpToMax > 0 ? `${formatEstimate(metrics.xpToMax / xpRate * 3600)} until max STR` : 'Max STR reached' : 'Strength estimate unavailable';
    const potionsToMax = metrics?.xpToMax ? Math.ceil(metrics.xpToMax / XP_PER_POTION) : 0;
    const potionText = potionsToMax > 0 ? `${potionsToMax.toLocaleString(NUMBER_LOCALE)} XP potion${potionsToMax === 1 ? '' : 's'} to max` : '';
    // The button only appears when a potion is actually held, so it can never send a doomed request.
    const potionRow = potionText
      ? held > 0
        ? `<button class="gc-pet-potions" data-xp-potion="${escapeHtml(pet.id)}" title="Spend one XP Potion on this pet. ${held} held.">${escapeHtml(potionText)}<i>Use one</i></button>`
        : `<div class="gc-pet-potions">${escapeHtml(potionText)}</div>`
      : '';
    return `<article class="gc-card gc-pet-card"><div class="gc-pet-head">${petSprite(pet)}<div><h3>${escapeHtml(pet.name || PET_CATALOG[pet.petSpecies]?.name || humanize(pet.petSpecies))}</h3><p>${escapeHtml(humanize(pet.petSpecies))}</p>${abilityChips(pet.abilities || [])}</div>${hungerDisplay(pet, active)}</div><div class="gc-pet-strength"><span>${metrics ? `STR <b>${metrics.strength}</b> / ${metrics.maxStrength}` : 'STR unavailable'}</span><strong>${escapeHtml(maxText)}</strong></div>${potionRow}</article>`;
  }).join('');
  const abilityRows = combinedAbilityRows(active);
  const starving = allActivePetsStarving();
  const hungerToggle = `<label class="gc-toggle"><span><b>Alarm when every pet has zero hunger</b><small>${
    starving ? 'All active pets are at zero right now.' : 'Sounds once the whole team hits zero hunger, not for a single hungry pet.'
  }</small></span><input type="checkbox" data-feature="petHungerAlarm" ${feature('petHungerAlarm') ? 'checked' : ''}><i></i></label>`;
  return `<section class="gc-card gc-team-summary"><b>${active.length} active pet${active.length === 1 ? '' : 's'}</b><span>${Math.round(xpRate).toLocaleString(NUMBER_LOCALE)} XP/hour per pet</span></section><div class="gc-list">${hungerToggle}</div><section class="gc-active-pets">${activeCards || '<p class="gc-empty">Waiting for active pet data.</p>'}</section><div class="gc-section-label">Combined abilities</div><section class="gc-stack">${abilityRows || '<p class="gc-empty">No active pet abilities found.</p>'}</section>`;
}
