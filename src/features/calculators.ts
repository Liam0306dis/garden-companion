import type { Pet } from '../types.js';
import { config } from '../config.js';
import { ABILITY_DETAILS, EGG_CATALOG, EXCLUDED_TRACKED_ABILITIES, PET_CATALOG } from '../constants.js';
import { page } from '../page.js';
import { state } from '../state.js';
import { escapeHtml, formatDuration, humanize } from '../utils.js';

/**
 * The Dust, Food and Granter calculators. Pet lookups that need the panel's sprite cache and
 * strength maths are passed in once at start-up rather than reached for through the panel, so this
 * file only owns the calculators themselves.
 */
export interface CalculatorPetHelpers {
  allPets(): Pet[];
  activePets(): Pet[];
  petMetrics(pet: Pet | undefined): { strength: number; maxStrength: number; xpPerLevel: number; xpToMax: number } | null;
  petSprite(pet: Pet): string;
  petDiet(species: string): string[];
  produceSprite(species: string): string;
}

let petHelpers: CalculatorPetHelpers;

export function initCalculators(helpers: CalculatorPetHelpers): void {
  petHelpers = helpers;
}

const DUST_RARITY: Record<string, number> = { Common: 1, Uncommon: 2, Rare: 5, Legendary: 10, Mythic: 50 };
const DUST_HATCH_MUTATION = (1 - .01 - .001) + .01 * 25 + .001 * 50;
const HATCH_WEIGHT = new Map<string, number>();
for (const egg of Object.values(EGG_CATALOG)) {
  for (const [species, weight] of Object.entries(egg.spawnWeights)) if (!HATCH_WEIGHT.has(species)) HATCH_WEIGHT.set(species, weight);
}

// Minutes a full hunger bar lasts per species, and crop regrow or grow minutes.
// Neither is present in the game bundle, so both come from the standalone calculators.
const HUNGER_MINUTES: Record<string, number> = {
  Worm: 30, Snail: 60, Bee: 15, Chicken: 60, Bunny: 45, Dragonfly: 15, Pig: 60, Cow: 75, Turkey: 60,
  SnowFox: 45, Stoat: 60, WhiteCaribou: 75, Squirrel: 30, Turtle: 90, Goat: 60, Sheep: 60, Ostrich: 45,
  Pony: 60, Horse: 75, FireHorse: 90, Bat: 30, Platypus: 60, ThunderWolf: 60, Butterfly: 30, Peacock: 60, Capybara: 60,
};
const CROP_REGROW: Record<string, [number, number]> = {
  Cacao: [90, 30], Squash: [15, 5], Date: [180, 60], DragonFruit: [7.5, 2.5], Pepper: [5, 2], Lychee: [15, 5],
  Coconut: [90, 30], Apple: [30, 10], Banana: [112.5, 37.5], Camellia: [135, 45], Chrysanthemum: [270, 90],
  Eggplant: [180, 60], Lemon: [90, 30], Peach: [135, 45], Pear: [135, 45], Poinsettia: [9, 3], PricklyPear: [90, 30],
  Strawberry: [15 / 60, 5 / 60], Tomato: [1, 20 / 60], BurrosTail: [4.5, 1.5], FavaBean: [12, 2], PassionFruit: [90, 30],
  Blueberry: [33 / 60, 11 / 60], Cabbage: [52 / 60, 0], Corn: [45 / 60, 0], Grape: [22.5, 0], Sunflower: [1320, 0],
};
const CROP_GROW: Record<string, number> = {
  Daffodil: 50 / 60, Lily: 4, Carrot: 4 / 60, Aloe: 45 / 60, Bamboo: 1320, Cactus: 180, Beet: 1, Clover: 6,
  Delphinium: 25 / 60, FourLeafClover: 6, Gentian: 1.5, Leek: 1.5, Mushroom: 1320, OrangeTulip: 8 / 60,
  Pumpkin: 35, VioletCort: 1320, Watermelon: 12,
};

export function dustMultiplier(species: string, mutations: string[] = []): number {
  const rarity = DUST_RARITY[PET_CATALOG[species]?.rarity || ''] || 1;
  const hatch = HATCH_WEIGHT.get(species) ?? 100;
  const hatchMultiplier = hatch >= 50 ? 1 : hatch > 10 ? 2 : 5;
  const colour = mutations.includes('Rainbow') ? 50 : mutations.includes('Gold') ? 25 : 1;
  return 100 * rarity * hatchMultiplier * colour;
}

export function petMaxDust(pet: Pet): number {
  return Math.floor(dustMultiplier(pet.petSpecies, pet.mutations || []) * Number(pet.targetScale || 1));
}

function eggDustRange(eggId: string): { low: number; average: number; high: number } {
  const weights = EGG_CATALOG[eggId]?.spawnWeights || {};
  const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0) || 1;
  let low = 0, average = 0, high = 0;
  for (const [species, weight] of Object.entries(weights)) {
    const share = weight / total;
    const multiplier = dustMultiplier(species);
    const maxScale = PET_CATALOG[species]?.maxScale || 1;
    low += share * Math.floor(multiplier);
    average += share * Math.floor(multiplier * (1 + maxScale) / 2);
    high += share * Math.floor(multiplier * maxScale);
  }
  return { low: low * DUST_HATCH_MUTATION, average: average * DUST_HATCH_MUTATION, high: high * DUST_HATCH_MUTATION };
}

function heldEggs(): Array<{ eggId: string; quantity: number }> {
  const counts = new Map<string, number>();
  const items = (state.slot?.data?.inventory?.items || []) as unknown as Array<{ itemType?: string; eggId?: string; quantity?: number }>;
  const stored = (state.slot?.data?.inventory?.storages || []).flatMap(storage => (storage.items || []) as unknown as Array<{ itemType?: string; eggId?: string; quantity?: number }>);
  for (const item of [...items, ...stored]) {
    if (item?.itemType !== 'Egg' || !item.eggId) continue;
    counts.set(item.eggId, (counts.get(item.eggId) || 0) + Number(item.quantity || 1));
  }
  for (const tile of Object.values(state.slot?.data?.garden?.tileObjects || {})) {
    for (const slot of tile?.slots || []) {
      const species = String(slot?.species || '');
      if (EGG_CATALOG[species]) counts.set(species, (counts.get(species) || 0) + 1);
    }
  }
  return [...counts].map(([eggId, quantity]) => ({ eggId, quantity })).sort((left, right) => right.quantity - left.quantity);
}

let calculatorTab = 'dust';
const dustSelection = new Set<string>();
let granterAbility = 'RainbowGranter';
const granterStrengths: Array<number | null> = [null, null, null];
const granterEnabled = [true, true, true];
const foodSlots: Array<{ species: string; food: string } | null> = [null, null, null];

const CALCULATOR_TABS = [['dust', 'Dust'], ['food', 'Food'], ['granter', 'Granters']];

export function setCalculatorTab(tab: string): void {
  calculatorTab = tab;
}

export function toggleDustPet(petId: string, selected: boolean): void {
  if (selected) dustSelection.add(petId);
  else dustSelection.delete(petId);
}

export function setDustSelection(petIds: string[]): void {
  dustSelection.clear();
  for (const petId of petIds) dustSelection.add(petId);
}

/** Switching ability drops any hand-set Strengths, since they described the previous ability. */
export function selectGranterAbility(ability: string): void {
  granterAbility = ability;
  granterStrengths[0] = granterStrengths[1] = granterStrengths[2] = null;
  granterEnabled[0] = granterEnabled[1] = granterEnabled[2] = true;
}

export function setFoodSlot(index: number, slot: { species: string; food: string }): void {
  foodSlots[index] = slot;
}

export function updateDustTotal(main: HTMLElement): void {
  const total = petHelpers.allPets().filter(pet => dustSelection.has(pet.id)).reduce((sum, pet) => sum + petMaxDust(pet), 0);
  const label = main.querySelector<HTMLElement>('[data-dust-total]');
  if (label) label.textContent = `${total.toLocaleString()} dust`;
}

export function renderCalculators(): string {
  const tabs = CALCULATOR_TABS.map(([id, label]) =>
    `<button data-calc-tab="${id}" class="${id === calculatorTab ? 'active' : ''}">${label}</button>`).join('');
  const body = calculatorTab === 'granter' ? renderGranterCalculator() : calculatorTab === 'food' ? renderFoodCalculator() : renderDustCalculator();
  return `<div class="gc-calc-tabs">${tabs}</div>${body}`;
}

function renderDustCalculator(): string {
  const eggs = heldEggs();
  const eggRows = eggs.map(({ eggId, quantity }) => {
    const range = eggDustRange(eggId);
    const sprite = page.__gardenCompanionShopSprites?.[eggId];
    return `<tr><td><span class="gc-shop-sprite">${sprite ? `<img src="${escapeHtml(sprite)}" alt="">` : ''}</span>${escapeHtml(EGG_CATALOG[eggId]?.name || humanize(eggId))}</td><td>${quantity.toLocaleString()}</td><td>${Math.round(range.average).toLocaleString()}</td><td><b>${Math.round(range.average * quantity).toLocaleString()}</b><small>${Math.round(range.low * quantity).toLocaleString()} to ${Math.round(range.high * quantity).toLocaleString()}</small></td></tr>`;
  }).join('');
  const eggTotal = eggs.reduce((sum, { eggId, quantity }) => sum + eggDustRange(eggId).average * quantity, 0);
  const pets = petHelpers.allPets().map(pet => ({ pet, dust: petMaxDust(pet) })).sort((left, right) => right.dust - left.dust);
  const selectedTotal = pets.filter(row => dustSelection.has(row.pet.id)).reduce((sum, row) => sum + row.dust, 0);
  const petRows = pets.map(({ pet, dust }) => {
    const name = pet.name || PET_CATALOG[pet.petSpecies]?.name || humanize(pet.petSpecies);
    const metrics = petHelpers.petMetrics(pet);
    const mutations = (pet.mutations || []).filter(mutation => mutation === 'Gold' || mutation === 'Rainbow');
    return `<label class="gc-dust-row" data-filter-text="${escapeHtml(`${name} ${pet.petSpecies} ${pet.location}`.toLowerCase())}"><input type="checkbox" data-dust-pet="${escapeHtml(pet.id)}" ${dustSelection.has(pet.id) ? 'checked' : ''}>${petHelpers.petSprite(pet)}<span><b>${escapeHtml(name)}</b><small>${escapeHtml(pet.location)}${mutations.length ? ` | ${escapeHtml(mutations.join(' '))}` : ''}${metrics ? ` | max STR ${metrics.maxStrength}` : ''}</small></span><b class="gc-dust-value">${dust.toLocaleString()}</b></label>`;
  }).join('');
  return `<p class="gc-note">Dust values use your pets own sizes, so a sold pet at its maximum Strength is exact. Egg values are an estimate: a hatched pet rolls a random size, so the midpoint is shown with the full range beneath.</p>
<section class="gc-card"><div class="gc-row"><h3>Eggs you hold</h3><span class="gc-calc-total">${Math.round(eggTotal).toLocaleString()} dust</span></div>${eggs.length ? `<table class="gc-calc-table"><thead><tr><th>Egg</th><th>Held</th><th>Each</th><th>Total</th></tr></thead><tbody>${eggRows}</tbody></table>` : '<p class="gc-empty">No eggs in your inventory, storage, or garden.</p>'}</section>
<section class="gc-card"><div class="gc-row"><h3>Pets at maximum Strength</h3><span class="gc-calc-total" data-dust-total>${selectedTotal.toLocaleString()} dust</span></div><div class="gc-row"><input class="gc-search" data-dust-search placeholder="Filter by pet name, species, or location"><button data-dust-all>Select all</button><button data-dust-none>Clear</button></div><div class="gc-dust-list gc-filter-list">${petRows || '<p class="gc-empty">No pets found.</p>'}</div></section>`;
}

function granterOptions(): Array<{ id: string; label: string; probability: number }> {
  return Object.entries(ABILITY_DETAILS)
    .filter(([id, details]) => typeof details.baseProbability === 'number' && !EXCLUDED_TRACKED_ABILITIES.has(id))
    .map(([id, details]) => ({ id, label: details.name || humanize(id), probability: details.baseProbability as number }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

function granterPets(ability: string): Pet[] {
  return petHelpers.allPets()
    .filter(pet => (pet.abilities || []).includes(ability))
    .sort((left, right) => (petHelpers.petMetrics(right)?.maxStrength ?? 0) - (petHelpers.petMetrics(left)?.maxStrength ?? 0))
    .slice(0, 3);
}

function granterStrengthFor(index: number, pets: Pet[]): number {
  const pet = pets[index] as Pet | undefined;
  return granterStrengths[index] ?? (pet ? petHelpers.petMetrics(pet)?.maxStrength : undefined) ?? 100;
}

function granterRows(): string {
  const pets = granterPets(granterAbility);
  return [0, 1, 2].map(index => {
    const pet = pets[index];
    const name = pet ? pet.name || PET_CATALOG[pet.petSpecies]?.name || humanize(pet.petSpecies) : `Pet ${index + 1}`;
    const strength = granterStrengthFor(index, pets);
    const source = pet ? `${escapeHtml(humanize(pet.petSpecies))} | ${escapeHtml(pet.location || '')}` : 'Not owned - set a Strength to plan ahead';
    const sprite = pet ? petHelpers.petSprite(pet) : '<span class="gc-pet-sprite"><i>?</i></span>';
    return `<div class="gc-granter-row" data-active="${granterEnabled[index]}" data-owned="${Boolean(pet)}"><label class="gc-granter-head"><input type="checkbox" data-granter-on="${index}" ${granterEnabled[index] ? 'checked' : ''}>${sprite}<span><b>${escapeHtml(name)}</b><small>${source}</small></span></label><div class="gc-granter-slider"><input type="range" min="50" max="100" step="1" value="${strength}" data-granter-str="${index}"><b data-granter-value="${index}">${strength}</b></div></div>`;
  }).join('');
}

function renderGranterCalculator(): string {
  const options = granterOptions();
  const ability = options.find(option => option.id === granterAbility) || options[0];
  if (ability) granterAbility = ability.id;
  const select = options.map(option => `<option value="${escapeHtml(option.id)}" ${option.id === granterAbility ? 'selected' : ''}>${escapeHtml(option.label)}</option>`).join('');
  return `<p class="gc-note">The three strongest pets you own with this ability are filled in automatically. Any ability can be planned without owning a pet for it by setting the Strength sliders yourself.</p>
<section class="gc-card"><h3>Ability</h3><select class="gc-calc-select" data-granter-ability>${select}</select><p class="gc-calc-hint" data-granter-hint>${granterHint()}</p></section>
<section class="gc-card"><h3>Pets</h3><div class="gc-granter-list">${granterRows()}</div></section>
<section class="gc-card"><h3>Combined</h3><div data-granter-results>${granterResults()}</div></section>`;
}

function granterHint(): string {
  const ability = granterOptions().find(option => option.id === granterAbility);
  if (!ability) return 'No chance-based abilities found.';
  const owned = granterPets(granterAbility).length;
  const source = owned ? `${owned} owned pet${owned === 1 ? '' : 's'} filled in` : 'You own no pet with this ability, so the sliders are yours to set';
  return `${ability.probability}% per minute at STR 100, rolled every second - ${source}`;
}

function granterResults(): string {
  const ability = granterOptions().find(option => option.id === granterAbility);
  const pets = granterPets(granterAbility);
  const perSecond = [0, 1, 2]
    .filter(index => granterEnabled[index])
    .map(index => 1 - Math.pow(1 - (ability ? ability.probability * granterStrengthFor(index, pets) / 100 : 0) / 100, 1 / 60));
  const combined = 1 - perSecond.reduce((total, chance) => total * (1 - chance), 1);
  if (!(combined > 0)) return '<p class="gc-empty">Enable at least one pet to see proc estimates.</p>';
  const perMinute = (1 - Math.pow(1 - combined, 60)) * 100;
  return `<div class="gc-calc-grid"><div><small>Chance per minute</small><b>${perMinute.toFixed(2)}%</b></div><div><small>Average wait</small><b>${formatDuration(1000 / combined)}</b></div><div><small>95% within</small><b>${formatDuration(-Math.log(1 - .95) / combined * 1000)}</b></div><div><small>99% within</small><b>${formatDuration(-Math.log(1 - .99) / combined * 1000)}</b></div></div>`;
}

export function updateGranterResults(main: HTMLElement): void {
  const container = main.querySelector<HTMLElement>('[data-granter-results]');
  if (container) container.innerHTML = granterResults();
}

export function updateGranterSection(main: HTMLElement): void {
  const list = main.querySelector<HTMLElement>('.gc-granter-list');
  if (list) {
    list.innerHTML = granterRows();
    bindGranterRows(main);
  }
  const hint = main.querySelector<HTMLElement>('[data-granter-hint]');
  if (hint) hint.textContent = granterHint();
  updateGranterResults(main);
}

export function bindGranterRows(main: HTMLElement): void {
  main.querySelectorAll<HTMLInputElement>('[data-granter-on]').forEach(input => input.onchange = () => {
    granterEnabled[Number(input.dataset.granterOn)] = input.checked;
    input.closest('.gc-granter-row')?.setAttribute('data-active', String(input.checked));
    updateGranterResults(main);
  });
  main.querySelectorAll<HTMLInputElement>('[data-granter-str]').forEach(input => input.oninput = () => {
    const index = Number(input.dataset.granterStr);
    granterStrengths[index] = Number(input.value);
    const label = main.querySelector(`[data-granter-value="${index}"]`);
    if (label) label.textContent = input.value;
    updateGranterResults(main);
  });
}

export function foodSlotValue(index: number): { species: string; food: string } {
  const saved = foodSlots[index];
  if (saved) return saved;
  const pet = petHelpers.activePets()[index];
  const species = pet?.petSpecies || Object.keys(PET_CATALOG)[index] || 'Worm';
  const diet = petHelpers.petDiet(species);
  const choice = config.petFoodChoices?.[species] || '';
  return { species, food: diet.includes(choice) ? choice : diet[0] || '' };
}

function renderFoodCalculator(): string {
  const slots = [0, 1, 2].map(foodSlotValue);
  const demand = new Map<string, number>();
  for (const slot of slots) {
    const maxHunger = Number(PET_CATALOG[slot.species]?.maxHunger || 0);
    const minutes = HUNGER_MINUTES[slot.species];
    const value = Number(page.__gardenCompanionPlantPrice?.(slot.food) || 0);
    if (!maxHunger || !minutes || !value || !slot.food) continue;
    const perHour = maxHunger / minutes * 60 / Math.min(value, maxHunger);
    demand.set(slot.food, (demand.get(slot.food) || 0) + perHour);
  }
  const rows = [...demand].sort((left, right) => right[1] - left[1]).map(([crop, need]) => {
    const plant = __PLANT_CATALOG__[crop];
    const slotCount = Math.max(1, Number(plant?.slots || 1));
    const sprite = petHelpers.produceSprite(crop);
    let cover = 'Timing unknown';
    let output = '';
    if (plant?.regrows && CROP_REGROW[crop]) {
      const [first, step] = CROP_REGROW[crop];
      const cycle = first + step * (slotCount - 1);
      const perPlant = slotCount * (60 / cycle);
      const plants = Math.max(1, Math.ceil(need / perPlant));
      cover = `${plants} plant${plants === 1 ? '' : 's'}`;
      output = `${(plants * perPlant).toFixed(1)} fruit/hr from ${plants} plant${plants === 1 ? '' : 's'} (${perPlant.toFixed(1)} each)`;
    } else if (!plant?.regrows && CROP_GROW[crop]) {
      const perTile = 60 / CROP_GROW[crop];
      const tiles = Math.max(1, Math.ceil(need / perTile));
      cover = `${Math.ceil(need)} seeds/hr`;
      output = `${tiles} tile${tiles === 1 ? '' : 's'} replanted continuously`;
    }
    return `<tr><td><span class="gc-shop-sprite">${sprite ? `<img src="${escapeHtml(sprite)}" alt="">` : ''}</span>${escapeHtml(humanize(crop))}</td><td><b>${need.toFixed(1)}</b>/hr</td><td>${escapeHtml(cover)}<small>${escapeHtml(output)}</small></td></tr>`;
  }).join('');
  const petOptions = Object.keys(PET_CATALOG).filter(species => petHelpers.petDiet(species).length)
    .sort((left, right) => (PET_CATALOG[left]?.name || left).localeCompare(PET_CATALOG[right]?.name || right));
  const slotCards = slots.map((slot, index) => {
    const species = petOptions.map(name => `<option value="${escapeHtml(name)}" ${name === slot.species ? 'selected' : ''}>${escapeHtml(PET_CATALOG[name]?.name || humanize(name))}</option>`).join('');
    const foods = petHelpers.petDiet(slot.species).map(crop => `<option value="${escapeHtml(crop)}" ${crop === slot.food ? 'selected' : ''}>${escapeHtml(humanize(crop))}</option>`).join('');
    const minutes = HUNGER_MINUTES[slot.species];
    return `<div class="gc-food-slot"><select data-food-pet="${index}">${species}</select><select data-food-crop="${index}">${foods}</select><small>${minutes ? `Full hunger lasts ${minutes} min` : 'Hunger timing unknown'}</small></div>`;
  }).join('');
  return `<p class="gc-note">Pick three pets and what you feed them to see the produce needed each hour, and how many plants or seeds cover it. Crop values use base sell prices, so mutated fruit feeds for longer than shown.</p>
<section class="gc-card"><h3>Team</h3><div class="gc-food-slots">${slotCards}</div></section>
<section class="gc-card"><h3>Produce needed each hour</h3>${rows ? `<table class="gc-calc-table"><thead><tr><th>Produce</th><th>Need</th><th>Covered by</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="gc-empty">Choose pets with a food to see the demand.</p>'}</section>`;
}
