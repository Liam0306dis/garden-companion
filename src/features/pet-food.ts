import type { Pet, ProduceItem } from '../types.js';
import { config, saveConfig, feature } from '../config.js';
import { PET_CATALOG } from '../constants.js';
import { sendQuinoaCommand } from '../game-connection.js';
import { page } from '../page.js';
import { panelActions } from '../panel-actions.js';
import { activePets, allPets, heldProduce, heldToolCount, petDiet, petSprite, produceSprite, produceValue, useReplenishPotion } from '../pets.js';
import { type PixiSurface, findVisiblePixiNodes, pixiNodeVisible, pixiSurface } from '../pixi.js';
import { quinoaEngine } from '../quinoa-engine.js';
import { toast } from '../toast.js';
import { escapeHtml, humanize } from '../utils.js';

/**
 * Feed buttons docked to the game's own pet panel, one per active pet. The panel is drawn in PIXI,
 * so each row is located in the scene graph and a DOM button is positioned over it; the dock hides
 * whenever the game pops its own controls over the same space.
 */

let petFoodSignature = '';
/** Forces the next render to rebuild, used when sprites finish loading. */
export function resetPetFoodSignature(): void {
  petFoodSignature = '';
}

interface PetDockRow { left: number; right: number; centerY: number; height: number }

function screenRow(surface: PixiSurface, container: Record<string, any>): PetDockRow | null {
  if (!container || typeof container.getBounds !== 'function' || !pixiNodeVisible(container)) return null;
  try {
    const bounds = container.getBounds();
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) return null;
    return {
      left: surface.toScreenX(bounds.x),
      right: surface.toScreenX(bounds.x + bounds.width),
      centerY: surface.toScreenY(bounds.y + bounds.height / 2),
      height: bounds.height * surface.scaleY,
    };
  } catch { return null; }
}

function petSlotsView(): Record<string, any> | null {
  const view = quinoaEngine()?.getSystem?.('petSlots')?.view;
  return view?.itemViews instanceof Map ? view : null;
}

function findPetSlotDock(): { byPet: Map<string, PetDockRow> | null; rows: PetDockRow[]; blocked: boolean } | null {
  const surface = pixiSurface();
  if (!surface) return null;
  const view = petSlotsView();
  if (view) {
    if (view.isVisible === false) return null;
    const byPet = new Map<string, PetDockRow>();
    for (const [petId, itemView] of view.itemViews as Map<string, Record<string, any>>) {
      const row = screenRow(surface, itemView?.container);
      if (row) byPet.set(String(petId), row);
    }
    const rows = [...byPet.values()].sort((left, right) => left.centerY - right.centerY);
    return { byPet, rows, blocked: Boolean(view.actionButtonGroup) || view.selectedPetSlotId != null };
  }
  const found = findVisiblePixiNodes(surface, ['PetSlots', 'PetActionButtons']);
  const slots = found.get('PetSlots');
  if (!slots || !Array.isArray(slots.children)) return null;
  const rows = slots.children
    .flatMap((child: Record<string, any>) => { const row = screenRow(surface, child); return row ? [row] : []; })
    .sort((left: PetDockRow, right: PetDockRow) => left.centerY - right.centerY);
  const shortest = Math.min(...rows.map((row: PetDockRow) => row.height));
  return { byPet: null, rows: rows.filter((row: PetDockRow) => row.height <= shortest * 1.5), blocked: found.has('PetActionButtons') };
}

/** Fills a bar outright rather than feeding it, so it is offered to every species alongside crops. */
export const HUNGER_POTION = 'ReplenishPotion';

interface PetFoodRow {
  pet: Pet;
  choice: string;
  count: number;
  cropItemId: string;
  potion: boolean;
}

/** A stored choice is only honoured if it is still something this species can be given. */
function chosenFood(species: string): string {
  const stored = config.petFoodChoices?.[species] || '';
  return stored === HUNGER_POTION || petDiet(species).includes(stored) ? stored : '';
}

function petFoodRows(): PetFoodRow[] {
  const produce = heldProduce();
  return activePets().filter(pet => pet?.id).map(pet => {
    const choice = chosenFood(pet.petSpecies);
    const potion = choice === HUNGER_POTION;
    const matching = choice && !potion ? produce.filter(item => item.species === choice) : [];
    const best = matching.reduce<ProduceItem | null>((chosen, item) => !chosen || produceValue(item) > produceValue(chosen) ? item : chosen, null);
    // Potions live in the tool inventory and are interchangeable, so the count is a plain tally
    // rather than the pick-the-biggest-crop search a food needs.
    return { pet, choice, count: potion ? heldToolCount(HUNGER_POTION) : matching.length, cropItemId: best?.id || '', potion };
  });
}

export function feedPet(petItemId: string, cropItemId: string): void {
  try {
    sendQuinoaCommand({ type: 'FeedPet', petItemId, cropItemId });
  } catch (error) {
    toast((error as Error).message, 'error');
  }
}

function createPetFoodPanel(): HTMLElement {
  const panel = document.createElement('div');
  panel.id = 'gc-petfood';
  panel.innerHTML = '<div class="gc-petfood-list"></div><button class="gc-petfood-options" data-food-options title="Choose preferred foods">Foods</button>';
  document.body.appendChild(panel);
  panel.querySelector<HTMLButtonElement>('[data-food-options]')!.onclick = () => panelActions.openPanel('petFood');
  panel.querySelector('.gc-petfood-list')!.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-feed-pet]');
    if (!button || button.disabled) return;
    // A potion is spent on the pet rather than fed to it, so it takes the tool route instead.
    if (button.dataset.potion === 'true') {
      // Held disabled for the wait, since fetching one from the Tool Shack is not instant and a
      // second press would spend a second potion.
      button.disabled = true;
      void useReplenishPotion(button.dataset.feedPet!)
        .catch(error => toast((error as Error).message, 'error'))
        .finally(() => { button.disabled = false; });
      return;
    }
    feedPet(button.dataset.feedPet!, button.dataset.cropItem!);
  });
  return panel;
}

export function renderPetFood(): void {
  if (!document.body) return;
  const existing = document.getElementById('gc-petfood');
  const rows = feature('petFood') ? petFoodRows() : [];
  if (!rows.length) {
    existing?.remove();
    petFoodSignature = '';
    return;
  }
  const signature = JSON.stringify(rows.map(row => [row.pet.id, row.pet.name, row.pet.petSpecies, row.choice, row.count, row.cropItemId, Boolean(produceSprite(row.choice))]));
  const panel = existing || createPetFoodPanel();
  if (!existing || signature !== petFoodSignature) {
    petFoodSignature = signature;
    panel.querySelector('.gc-petfood-list')!.innerHTML = rows.map(row => {
      const name = row.pet.name || PET_CATALOG[row.pet.petSpecies]?.name || humanize(row.pet.petSpecies);
      const sprite = produceSprite(row.choice);
      const ready = Boolean(row.choice) && row.count > 0;
      const label = !row.choice
        ? `Pick a food for ${humanize(row.pet.petSpecies)} in the Pet Food tab`
        : row.count === 0 ? `No ${humanize(row.choice)} in your inventory`
        : row.potion ? `Fill ${name}'s hunger with a ${humanize(row.choice)}`
        : `Feed ${humanize(row.choice)} to ${name}`;
      const icon = row.choice
        ? sprite ? `<img src="${escapeHtml(sprite)}" alt="${escapeHtml(row.choice)}">` : `<i>${escapeHtml(humanize(row.choice).slice(0, 1))}</i>`
        : '<i>?</i>';
      return `<button data-food-row data-feed-pet="${escapeHtml(row.pet.id)}" data-crop-item="${escapeHtml(row.cropItemId)}" data-potion="${row.potion}" title="${escapeHtml(label)}" ${ready ? '' : 'disabled'}>${icon}${row.choice ? `<span class="gc-petfood-count">${row.count}</span>` : ''}</button>`;
    }).join('');
  }
  positionPetFood();
}

/**
 * True when a page overlay (the game menu, a modal) covers the pet panel. The docked
 * buttons are plain DOM above the canvas, so they would otherwise float over it.
 */
function petPanelCovered(anchor: PetDockRow): boolean {
  const sampleX = Math.round((anchor.left + anchor.right) / 2);
  const sampleY = Math.round(anchor.centerY);
  if (sampleX < 0 || sampleY < 0 || sampleX > innerWidth || sampleY > innerHeight) return false;
  const top = document.elementFromPoint(sampleX, sampleY);
  if (!top) return false;
  return !top.closest('.QuinoaCanvas') && !top.closest('#gc-petfood');
}

export function positionPetFood(): void {
  const panel = document.getElementById('gc-petfood');
  if (!panel) return;
  const buttons = [...panel.querySelectorAll<HTMLElement>('[data-food-row]')];
  const options = panel.querySelector<HTMLElement>('.gc-petfood-options')!;
  const dock = findPetSlotDock();
  const paired = dock ? buttons.map((button, index) => dock.byPet ? dock.byPet.get(button.dataset.feedPet || '') ?? null : dock.rows[index] ?? null) : [];
  const anchors = paired.filter((anchor): anchor is PetDockRow => Boolean(anchor));
  if (!dock || dock.blocked || !anchors.length || petPanelCovered(anchors[0])) {
    panel.hidden = true;
    return;
  }
  const dockRight = anchors.reduce((total, row) => total + row.right, 0) / anchors.length < innerWidth / 2;
  const size = Math.round(Math.max(32, Math.min(72, anchors[0].height * .78)));
  const iconSize = Math.round(size * .78);
  const gap = 8;
  panel.hidden = false;
  buttons.forEach((button, index) => {
    const anchor = paired[index];
    if (!anchor) { button.style.display = 'none'; return; }
    button.style.display = '';
    button.style.width = `${size}px`;
    button.style.height = `${size}px`;
    button.style.left = `${Math.round(dockRight ? anchor.right + gap : anchor.left - gap - size)}px`;
    button.style.top = `${Math.round(anchor.centerY - size / 2)}px`;
    const icon = button.querySelector('img');
    if (icon) {
      icon.style.width = `${iconSize}px`;
      icon.style.height = `${iconSize}px`;
    }
  });
  const last = anchors.reduce((lowest, row) => row.centerY > lowest.centerY ? row : lowest, anchors[0]);
  options.style.left = `${Math.round(dockRight ? last.right + gap : last.left - gap - size)}px`;
  options.style.top = `${Math.round(last.centerY + last.height / 2 + gap)}px`;
  options.style.minWidth = `${size}px`;
}


export function renderPetFoodTab() {
  const produce = heldProduce();
  const counts = new Map<string, number>();
  for (const item of produce) counts.set(item.species, (counts.get(item.species) || 0) + 1);
  const activeSpecies = new Set(activePets().map(pet => pet.petSpecies));
  const species = [...new Set(allPets().map(pet => pet.petSpecies))]
    .filter(name => petDiet(name).length)
    .sort((left, right) => Number(activeSpecies.has(right)) - Number(activeSpecies.has(left)) || humanize(left).localeCompare(humanize(right)));
  // Offered to every species: a potion fills the bar outright, so it is not tied to any diet.
  const potionsHeld = heldToolCount(HUNGER_POTION);
  const cards = species.map(name => {
    const chosen = chosenFood(name);
    const option = (id: string, held: number) => {
      const sprite = produceSprite(id);
      // Foods share one row, so the longest names ellipsise and lean on the tooltip.
      const label = humanize(id);
      return `<button data-food-choice="${escapeHtml(name)}" data-food-crop="${escapeHtml(id)}" data-active="${id === chosen}" title="${escapeHtml(label)} - ${held} held"><span class="gc-shop-sprite">${sprite ? `<img src="${escapeHtml(sprite)}" alt="">` : ''}</span><span><b>${escapeHtml(label)}</b><small>${held} held</small></span></button>`;
    };
    const options = [
      ...petDiet(name).map(crop => option(crop, counts.get(crop) || 0)),
      option(HUNGER_POTION, potionsHeld),
    ].join('');
    return `<article class="gc-card gc-food-card"><div class="gc-food-head"><h3>${escapeHtml(PET_CATALOG[name]?.name || humanize(name))}</h3><span>${activeSpecies.has(name) ? 'Active' : 'Owned'}</span></div><div class="gc-food-options">${options}</div></article>`;
  }).join('');
  return `<p class="gc-note">Pick one food per species. The feed button on the pet food panel spends the largest crop of that type you are holding, and stays disabled when you have none. Every species can also be given a Hunger Potion, which fills the bar outright instead. Click a selected food again to clear it.</p><section class="gc-stack">${cards || '<p class="gc-empty">No pet data yet.</p>'}</section>`;
}

export function bindPetFoodEvents(main: HTMLElement): void {
  main.querySelectorAll<HTMLButtonElement>('[data-food-choice]').forEach(button => button.onclick = () => {
    const species = button.dataset.foodChoice!;
    const crop = button.dataset.foodCrop!;
    const choices = { ...config.petFoodChoices };
    if (choices[species] === crop) delete choices[species];
    else choices[species] = crop;
    config.petFoodChoices = choices;
    saveConfig();
    panelActions.renderPanelPreservingScroll();
    renderPetFood();
  });
}
