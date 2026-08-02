import type { Pet, ProduceItem } from './types.js';
import { PET_CATALOG } from './constants.js';
import { mutationMultiplier } from './mutation-value.js';
import { send } from './game-connection.js';
import { page } from './page.js';
import { state } from './state.js';
import { escapeHtml, humanize } from './utils.js';

/** Everything derived from the player's pets: where they are, how they look, and how strong they are. */

export function allPets() {
  const data = state.slot?.data || {};
  const active = (data.petSlots || []).map(pet => ({ ...pet, location: 'Active' }));
  const inventory = (data.inventory?.items || []).filter(item => item.itemType === 'Pet').map(pet => ({ ...pet, location: 'Inventory' }));
  const stored = (data.inventory?.storages || []).flatMap(storage => (storage.items || []).filter(item => item.itemType === 'Pet').map(pet => ({ ...pet, location: humanize(storage.decorId || 'Storage') })));
  const seen = new Set();
  return [...active, ...inventory, ...stored].filter(pet => pet.id && !seen.has(pet.id) && seen.add(pet.id));
}

export function activePets(): Pet[] {
  return state.slot?.data?.petSlots || [];
}

export function heldProduce(): ProduceItem[] {
  const items = (state.slot?.data?.inventory?.items || []) as unknown as ProduceItem[];
  return items.filter(item => item?.itemType === 'Produce' && item.species && item.id);
}

export function produceValue(item: ProduceItem): number {
  const base = Number(page.__gardenCompanionPlantPrice?.(item.species) || 0) || 1;
  return base * Number(item.scale || 1) * mutationMultiplier([...(item.mutations || [])]);
}

export function petDiet(species: string): string[] {
  return PET_CATALOG[species]?.diet || [];
}

export function produceSprite(species: string): string {
  return page.__gardenCompanionProduceSprites?.[species] || page.__gardenCompanionShopSprites?.[species] || '';
}

/** The game's own mutation icon, keyed by mutation id. Empty until the sprite atlases finish. */
export function mutationSprite(mutation: string): string {
  return page.__gardenCompanionMutationSprites?.[mutation] || '';
}

const mutatedPetSprites = new Map<string, string>();
const pendingPetSprites = new Set<string>();

/**
 * The game ships one sprite per species, so Gold and Rainbow pets are tinted here on a canvas and
 * cached. Rendering is async, so any sprite already on the page is swapped in when it finishes.
 */
function renderMutatedPetSprite(key: string, source: string, mutation: string): void {
  if (mutatedPetSprites.has(key) || pendingPetSprites.has(key)) return;
  pendingPetSprites.add(key);
  const image = new Image();
  image.onload = () => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      if (!context) return;
      context.drawImage(image, 0, 0);
      if (mutation === 'gold') {
        context.globalCompositeOperation = 'source-atop';
        context.globalAlpha = .7;
        context.fillStyle = 'rgb(235,200,0)';
        context.fillRect(0, 0, canvas.width, canvas.height);
      } else {
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let minimum = canvas.width + canvas.height;
        let maximum = 0;
        for (let y = 0; y < canvas.height; y += 2) for (let x = 0; x < canvas.width; x += 2) {
          if (pixels[(y * canvas.width + x) * 4 + 3] < 8) continue;
          minimum = Math.min(minimum, x + y);
          maximum = Math.max(maximum, x + y);
        }
        if (maximum <= minimum) { minimum = 0; maximum = canvas.width + canvas.height; }
        const gradient = context.createLinearGradient(minimum / 2, minimum / 2, maximum / 2, maximum / 2);
        ['#ff1744', '#ff9100', '#ffea00', '#00e676', '#2979ff', '#d500f9'].forEach((color, index, colors) => gradient.addColorStop(index / (colors.length - 1), color));
        context.globalCompositeOperation = 'color';
        context.globalAlpha = 1;
        context.fillStyle = gradient;
        context.fillRect(0, 0, canvas.width, canvas.height);
      }
      context.globalAlpha = 1;
      context.globalCompositeOperation = 'destination-in';
      context.drawImage(image, 0, 0);
      const result = canvas.toDataURL('image/png');
      mutatedPetSprites.set(key, result);
      document.querySelectorAll<HTMLImageElement>('img[data-pet-mutation-key]').forEach(element => {
        if (element.dataset.petMutationKey === key) element.src = result;
      });
    } finally {
      pendingPetSprites.delete(key);
    }
  };
  image.onerror = () => pendingPetSprites.delete(key);
  image.src = source;
}

/** A pet carries at most one colour mutation, and Rainbow wins when both are somehow present. */
function petOverlay(pet: Pet): string {
  const mutations = pet.mutations || [];
  return mutations.includes('Rainbow') ? 'rainbow' : mutations.includes('Gold') ? 'gold' : '';
}

/**
 * The sprite URL for a pet, tinted for its colour mutation once that render finishes. Callers that
 * draw rather than emit markup use this, since the tint is cached asynchronously and the plain
 * sprite is the right thing to show until it lands.
 */
export function petSpriteSource(pet: Pet): string | undefined {
  const source = page.__gardenCompanionPetSprites?.[pet.petSpecies];
  const overlay = petOverlay(pet);
  if (!source || !overlay) return source;
  const key = `${pet.petSpecies}:${overlay}`;
  renderMutatedPetSprite(key, source, overlay);
  return mutatedPetSprites.get(key) || source;
}

export function petSprite(pet: Pet): string {
  const source = page.__gardenCompanionPetSprites?.[pet.petSpecies];
  const overlay = petOverlay(pet);
  const mutationKey = source && overlay ? `${pet.petSpecies}:${overlay}` : '';
  if (source && overlay) renderMutatedPetSprite(mutationKey, source, overlay);
  const displayedSource = mutationKey ? mutatedPetSprites.get(mutationKey) || source : source;
  return `<span class="gc-pet-sprite">${displayedSource ? `<img src="${escapeHtml(displayedSource)}" alt="${escapeHtml(pet.petSpecies)}"${mutationKey ? ` data-pet-mutation-key="${escapeHtml(mutationKey)}"` : ''}>` : `<i>${escapeHtml((PET_CATALOG[pet.petSpecies]?.name || pet.petSpecies || '?').slice(0, 1))}</i>`}</span>`;
}

export function hungerDisplay(pet: Pet): string {
  const maximum = Number(PET_CATALOG[pet.petSpecies]?.maxHunger || 0);
  const value = Math.max(0, Number(pet.hunger || 0));
  const percent = maximum > 0 ? Math.min(100, value / maximum * 100) : value > 0 ? 100 : 0;
  const tone = percent < 20 ? 'low' : percent < 50 ? 'medium' : 'good';
  return `<div class="gc-hunger" title="${value.toLocaleString()} / ${maximum.toLocaleString()}"><div><span>Hunger</span><b>${Math.round(percent)}%</b></div><i><u data-tone="${tone}" style="width:${percent.toFixed(2)}%"></u></i></div>`;
}

export function petMetrics(pet: Pet | undefined): { strength: number; maxStrength: number; xpPerLevel: number; xpToMax: number } | null {
  const info = PET_CATALOG[pet?.petSpecies || ''];
  if (!pet) return null;
  if (!info?.maxScale || info.maxScale <= 1 || !info.hoursToMature || !pet.targetScale) return null;
  const xpPerLevel = Math.floor(3600 * info.hoursToMature / 30);
  const maxStrength = Math.floor(((pet.targetScale - 1) / (info.maxScale - 1)) * 20 + 80);
  if (maxStrength < 80 || maxStrength > 100) return null;
  const levelProgress = Math.min(30, Math.floor(Number(pet.xp ?? 0) / xpPerLevel));
  const strength = maxStrength - 30 + levelProgress;
  const xpIntoLevel = Number(pet.xp ?? 0) % xpPerLevel;
  const xpToMax = strength >= maxStrength ? 0 : xpPerLevel - xpIntoLevel + xpPerLevel * (maxStrength - strength - 1);
  return { strength, maxStrength, xpPerLevel, xpToMax };
}

const XP_ABILITY_REGISTRY: Record<string, { baseChance: number; baseXp: number }> = {
  PetXpBoost: { baseChance: 30, baseXp: 300 },
  PetXpBoostI: { baseChance: 30, baseXp: 300 },
  PetXpBoostII: { baseChance: 35, baseXp: 400 },
};

function abilityXpPerHour(strength: number, baseChance: number, baseXp: number): number {
  const multiplier = Math.max(.25, strength / 100);
  const chancePerSecond = Math.min(.95 / 60, baseChance / 60 / 100 * multiplier);
  return 3600 * chancePerSecond * baseXp * multiplier;
}

export function teamXpPerHour(pets: Pet[]): number {
  let total = 3600;
  for (const pet of pets) {
    if (pet.hunger <= 0) continue;
    const strength = petMetrics(pet)?.strength ?? 100;
    for (const ability of pet.abilities ?? []) {
      const xpAbility = XP_ABILITY_REGISTRY[ability];
      if (xpAbility) total += abilityXpPerHour(strength, xpAbility.baseChance, xpAbility.baseXp);
    }
  }
  return total;
}

export function formatEstimate(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'Ready';
  const minutes = Math.ceil(seconds / 60);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes % 1440 / 60);
  const remainder = minutes % 60;
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${remainder}m` : `${minutes}m`;
}

/** How many of a tool the player is holding, across the inventory and its storages. */
export function heldToolCount(toolId: string): number {
  const data = state.slot?.data;
  const rows = [
    ...(data?.inventory?.items || []),
    ...((data?.inventory?.storages || []).flatMap(storage => storage.items || [])),
  ] as unknown as Array<{ itemType?: string; toolId?: string; quantity?: number }>;
  return rows
    .filter(item => item?.itemType === 'Tool' && item.toolId === toolId)
    .reduce((total, item) => total + Number(item.quantity || 0), 0);
}

interface Tile { x: number; y: number }

/** Where a pet currently stands. Walking pets interpolate along their path by elapsed time. */
function petTileFromMotion(motion: unknown): Tile | null {
  if (!motion || typeof motion !== 'object') return null;
  const value = motion as Record<string, unknown>;
  const round = (tile: unknown): Tile | null => {
    const point = tile as Record<string, unknown> | undefined;
    const x = Number(point?.x), y = Number(point?.y);
    return Number.isFinite(x) && Number.isFinite(y) ? { x: Math.round(x), y: Math.round(y) } : null;
  };
  if (value.kind === 'idle') return round(value.at);
  if (value.kind === 'walking' && Array.isArray(value.path) && value.path.length) {
    const step = Number(value.stepDurationMs) || 0;
    const started = Number(value.startedAtMs) || 0;
    const elapsed = Math.max(0, Date.now() - started);
    const index = step > 0 ? Math.min(value.path.length - 1, Math.floor(elapsed / step)) : 0;
    return round(value.path[index]);
  }
  return null;
}

export function petTile(petItemId: string): Tile | null {
  const infos = (state.slot as unknown as { petSlotInfos?: Record<string, { motion?: unknown }> })?.petSlotInfos;
  return petTileFromMotion(infos?.[petItemId]?.motion);
}

/**
 * Spends one XP Potion on a pet. The server only accepts it while the player stands on the pet, so
 * the player is moved onto its tile first. The game applies the catalog xpAmount, so no value is sent.
 */
export function useXpPotion(petItemId: string): void {
  const tile = petTile(petItemId);
  if (!tile) throw new Error('The pet position is not available yet. Try again in a moment.');
  send({ type: 'PlayerPosition', position: tile });
  send({ type: 'XPPotion', petItemId });
}
