import { generateCelestialLayout, type CelestialGoal, type CelestialSpecies } from '../celestial-layout.js';
import { makeDraggable } from '../draggable.js';
import { page } from '../page.js';
import { pixiSurface, type PixiSurface } from '../pixi.js';
import { state } from '../state.js';
import type { GardenTile } from '../types.js';

type FarmSide = 'left' | 'right';

interface DirtTileRef {
  localIndex: string;
  globalIndex: number;
  x: number;
  y: number;
}

interface GuideState {
  open: boolean;
  side: FarmSide | null;
  goal: CelestialGoal;
  plan: Map<string, CelestialSpecies>;
  covered: Map<string, boolean>;
  message: string;
  tone: 'normal' | 'error';
}

interface GhostTemplate {
  texture: Record<string, any>;
  Sprite: new (...args: any[]) => Record<string, any>;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}

const CELESTIAL_SPECIES = new Set<CelestialSpecies>(['MoonCelestial', 'DawnCelestial', 'Dawnbreaker', 'Starweaver']);
const SPECIES_LABELS: Record<CelestialSpecies, string> = {
  MoonCelestial: 'Moonbinder',
  DawnCelestial: 'Dawnbinder',
  Dawnbreaker: 'Dawnbreaker',
  Starweaver: 'Starweaver',
};
const TILE_SIZE = 256;
const POSITION_KEY = 'gardenCompanion.celestialLayoutPosition.v1';

function placementType(species: CelestialSpecies): 'moon' | 'dawn' | 'other' {
  if (species === 'MoonCelestial') return 'moon';
  if (species === 'DawnCelestial') return 'dawn';
  return 'other';
}

export function initCelestialLayoutGuide(): void {
  const guide: GuideState = {
    open: false,
    side: null,
    goal: 'both',
    plan: new Map(),
    covered: new Map(),
    message: 'Choose the left or right side to generate a guide.',
    tone: 'normal',
  };
  const originalStyles = new WeakMap<Record<string, any>, { tint: unknown; alpha: number }>();
  const styled = new Set<Record<string, any>>();
  const ghostTemplates = new Map<CelestialSpecies, GhostTemplate>();
  const ghosts = new Map<string, Record<string, any>>();
  let mappedTiles = new Map<string, DirtTileRef>();
  let animationFrame = 0;
  let lastStateAt = 0;

  function systems() {
    return page.__gardenCompanionFarmSystems ?? null;
  }

  function tileSystem(): Record<string, any> | null {
    const system = systems()?.tileSystem;
    return system?.map && system?.worldContainer ? system : null;
  }

  function ownSlotIndex(): number | null {
    const captured = systems()?.ownUserSlotIdx;
    if (typeof captured === 'number') return captured;
    return typeof state.slotIndex === 'number' ? state.slotIndex : null;
  }

  function liveTiles(): Record<string, GardenTile> {
    return state.slot?.data?.garden?.tileObjects ?? {};
  }

  function isPreserved(tile: GardenTile | undefined): boolean {
    return tile?.objectType === 'plant' && Boolean(tile.slots?.some(slot => slot.preserved === true));
  }

  function dirtTiles(): DirtTileRef[] {
    const system = tileSystem();
    const slotIndex = ownSlotIndex();
    if (!system || slotIndex === null) return [];
    const mapping = system.map.userSlotIdxAndDirtTileIdxToGlobalTileIdx?.[slotIndex];
    if (!mapping) return [];
    return Object.entries(mapping).map(([localIndex, value]) => {
      const globalIndex = Number(value);
      return {
        localIndex,
        globalIndex,
        x: globalIndex % system.map.cols,
        y: Math.floor(globalIndex / system.map.cols),
      };
    }).filter(tile => Number.isInteger(tile.globalIndex));
  }

  function sideTiles(side: FarmSide, tiles: DirtTileRef[]): DirtTileRef[] {
    const columns = [...new Set(tiles.map(tile => tile.x))].sort((left, right) => left - right);
    const split = Math.floor(columns.length / 2);
    const selectedColumns = new Set(side === 'left' ? columns.slice(0, split) : columns.slice(split));
    return tiles.filter(tile => selectedColumns.has(tile.x)).sort((left, right) => left.y - right.y || left.x - right.x);
  }

  function currentCelestials(): CelestialSpecies[] {
    return Object.values(liveTiles()).flatMap(tile =>
      tile?.objectType === 'plant' && !isPreserved(tile) && CELESTIAL_SPECIES.has(tile.species as CelestialSpecies)
        ? [tile.species as CelestialSpecies]
        : []);
  }

  function status(message: string, tone: GuideState['tone'] = 'normal'): void {
    guide.message = message;
    guide.tone = tone;
    const element = document.querySelector<HTMLElement>('#gc-celestial-layout [data-celestial-status]');
    if (element) {
      element.textContent = message;
      element.dataset.tone = tone;
    }
  }

  function clearPlan(): void {
    restoreStyles();
    destroyGhosts();
    guide.plan.clear();
    guide.covered.clear();
    mappedTiles.clear();
    document.getElementById('gc-celestial-overlay')?.replaceChildren();
  }

  function generate(): void {
    clearPlan();
    if (!guide.side) {
      status('Choose the left or right side to generate a guide.');
      return;
    }
    const allTiles = dirtTiles();
    const tiles = sideTiles(guide.side, allTiles);
    mappedTiles = new Map(allTiles.map(tile => [tile.localIndex, tile]));
    const rows = new Set(tiles.map(tile => tile.y)).size;
    const columns = new Set(tiles.map(tile => tile.x)).size;
    if (!tiles.length || rows * columns !== tiles.length) {
      status('The selected farm side could not be mapped yet. Enter your garden and try Refresh.', 'error');
      return;
    }
    const plants = currentCelestials();
    const current = liveTiles();
    const unavailable = tiles.map(tile => isPreserved(current[tile.localIndex]));
    const blocked = tiles.map(tile => {
      const occupant = current[tile.localIndex];
      return Boolean(occupant && !(occupant.objectType === 'plant' && CELESTIAL_SPECIES.has(occupant.species as CelestialSpecies)));
    });
    const result = generateCelestialLayout(plants, rows, columns, guide.goal, blocked, unavailable);
    if (!result.cells.length) {
      status(result.error, 'error');
      return;
    }
    result.cells.forEach((cell, index) => {
      const tile = tiles[index];
      if (!tile || !cell.species) return;
      guide.plan.set(tile.localIndex, cell.species);
      guide.covered.set(tile.localIndex, cell.met);
    });
    const buff = guide.goal === 'both' ? 'both buffs' : guide.goal === 'amber' ? 'Amberbound' : 'Dawnbound';
    status(result.error || `${result.met} of ${result.required} celestial plants receive ${buff}.` , result.error ? 'error' : 'normal');
    new Set(guide.plan.values()).forEach(species => templateFor(species));
    updateOverlay();
  }

  function templateFor(species: CelestialSpecies): GhostTemplate | null {
    const cached = ghostTemplates.get(species);
    if (cached) return cached;
    const system = tileSystem();
    const renderer = (page.__GARDEN_COMPANION_PIXI__?.renderer as Record<string, any>)
      ?? (page.__GARDEN_COMPANION_PIXI__?.app as Record<string, any>)?.renderer;
    if (!system?.worldContainer || typeof renderer?.textureGenerator?.generateTexture !== 'function') return null;
    const current = liveTiles();
    const sourceRef = [...mappedTiles.values()].find(tile => current[tile.localIndex]?.objectType === 'plant' && current[tile.localIndex]?.species === species);
    if (!sourceRef) return null;
    const display = system.tileViews?.get?.(sourceRef.globalIndex)?.childView?.plantVisual?.container;
    if (!display || typeof display.getBounds !== 'function') return null;
    const stack = [display];
    let spriteNode: Record<string, any> | null = null;
    while (stack.length && !spriteNode) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (node.renderPipeId === 'sprite' && node.texture && !('textures' in node) && typeof node.constructor === 'function') spriteNode = node;
      else if (Array.isArray(node.children)) stack.push(...node.children);
    }
    if (!spriteNode) return null;
    restoreStyle(display);
    try {
      const texture = renderer.textureGenerator.generateTexture({ target: display, resolution: 1 });
      if (!texture) return null;
      const bounds = display.getBounds();
      const topLeft = system.worldContainer.toLocal({ x: bounds.x, y: bounds.y });
      const bottomRight = system.worldContainer.toLocal({ x: bounds.x + bounds.width, y: bounds.y + bounds.height });
      const template = {
        texture,
        Sprite: spriteNode.constructor as GhostTemplate['Sprite'],
        offsetX: topLeft.x - sourceRef.x * TILE_SIZE,
        offsetY: topLeft.y - sourceRef.y * TILE_SIZE,
        width: bottomRight.x - topLeft.x,
        height: bottomRight.y - topLeft.y,
      };
      ghostTemplates.set(species, template);
      return template;
    } catch { return null; }
  }

  function destroyGhost(ghost: Record<string, any>): void {
    try { ghost.destroy?.({ children: true, texture: false, textureSource: false }); }
    catch { try { ghost.parent?.removeChild?.(ghost); } catch {} }
  }

  function destroyGhosts(except = new Set<string>()): void {
    for (const [localIndex, ghost] of ghosts) {
      if (except.has(localIndex)) continue;
      destroyGhost(ghost);
      ghosts.delete(localIndex);
    }
  }

  function showGhost(ref: DirtTileRef, species: CelestialSpecies): boolean {
    const system = tileSystem();
    const template = templateFor(species);
    if (!system?.worldContainer || !template) return false;
    let ghost = ghosts.get(ref.localIndex);
    if (ghost?.__celestialSpecies !== species || ghost?.destroyed || ghost?.parent !== system.worldContainer) {
      if (ghost) destroyGhost(ghost);
      try { ghost = new template.Sprite({ texture: template.texture }); }
      catch { return false; }
      ghost.__celestialSpecies = species;
      ghost.eventMode = 'none';
      ghost.interactive = false;
      ghost.zIndex = 999_000;
      system.worldContainer.addChild(ghost);
      ghosts.set(ref.localIndex, ghost);
    }
    ghost.position?.set?.(ref.x * TILE_SIZE + template.offsetX, ref.y * TILE_SIZE + template.offsetY);
    ghost.width = template.width;
    ghost.height = template.height;
    ghost.tint = 0xd8c8ff;
    ghost.alpha = 0.46;
    return true;
  }

  function overlayRoot(): HTMLElement {
    let root = document.getElementById('gc-celestial-overlay');
    if (!root) {
      root = document.createElement('div');
      root.id = 'gc-celestial-overlay';
      document.body.appendChild(root);
    }
    return root;
  }

  function worldBounds(system: Record<string, any>, surface: PixiSurface, x: number, y: number, width: number, height: number): { left: number; top: number; width: number; height: number } | null {
    if (!system.worldContainer?.toGlobal) return null;
    try {
      const corners = [
        system.worldContainer.toGlobal({ x, y }),
        system.worldContainer.toGlobal({ x: x + width, y }),
        system.worldContainer.toGlobal({ x, y: y + height }),
        system.worldContainer.toGlobal({ x: x + width, y: y + height }),
      ];
      const xs = corners.map(point => surface.toScreenX(point.x));
      const ys = corners.map(point => surface.toScreenY(point.y));
      const left = Math.min(...xs);
      const right = Math.max(...xs);
      const top = Math.min(...ys);
      const bottom = Math.max(...ys);
      if (![left, right, top, bottom].every(Number.isFinite) || right <= left || bottom <= top) return null;
      return { left, top, width: right - left, height: bottom - top };
    } catch { return null; }
  }

  function tileBounds(system: Record<string, any>, surface: PixiSurface, tile: DirtTileRef): { left: number; top: number; width: number; height: number } | null {
    return worldBounds(system, surface, tile.x * TILE_SIZE, tile.y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
  }

  function positionElement(element: HTMLElement, bounds: { left: number; top: number; width: number; height: number } | null): void {
    element.hidden = !bounds;
    if (!bounds) return;
    element.style.left = `${bounds.left}px`;
    element.style.top = `${bounds.top}px`;
    element.style.width = `${bounds.width}px`;
    element.style.height = `${bounds.height}px`;
  }

  function positionOverlay(): void {
    if (!guide.open || !guide.plan.size) return;
    const system = tileSystem();
    const surface = pixiSurface();
    if (!system || !surface) return;
    document.querySelectorAll<HTMLElement>('#gc-celestial-overlay [data-celestial-tile]').forEach(element => {
      const ref = mappedTiles.get(element.dataset.celestialTile!);
      positionElement(element, ref ? tileBounds(system, surface, ref) : null);
    });
  }

  function restoreStyle(display: Record<string, any>): void {
    const original = originalStyles.get(display);
    if (!original) return;
    try {
      if (original.tint === undefined) delete display.tint;
      else display.tint = original.tint;
      display.alpha = original.alpha;
    } catch {}
    originalStyles.delete(display);
    styled.delete(display);
  }

  function restoreStyles(except = new Set<Record<string, any>>()): void {
    [...styled].forEach(display => { if (!except.has(display)) restoreStyle(display); });
  }

  function stylePlant(tile: DirtTileRef, tint: number, alpha: number, seen: Set<Record<string, any>>): void {
    const view = tileSystem()?.tileViews?.get?.(tile.globalIndex);
    const display = view?.childView?.plantVisual?.container;
    if (!display || display.destroyed) return;
    if (!originalStyles.has(display)) {
      originalStyles.set(display, {
        tint: 'tint' in display ? display.tint : undefined,
        alpha: Number.isFinite(display.alpha) ? display.alpha : 1,
      });
    }
    const original = originalStyles.get(display)!;
    display.tint = tint;
    display.alpha = original.alpha * alpha;
    styled.add(display);
    seen.add(display);
  }

  function tileElement(root: HTMLElement, localIndex: string): HTMLElement {
    let element = root.querySelector<HTMLElement>(`[data-celestial-tile="${CSS.escape(localIndex)}"]`);
    if (!element) {
      element = document.createElement('div');
      element.className = 'gc-celestial-tile';
      element.dataset.celestialTile = localIndex;
      root.appendChild(element);
    }
    return element;
  }

  function updateOverlay(): void {
    if (!guide.open || !guide.plan.size) {
      restoreStyles();
      destroyGhosts();
      return;
    }
    const root = overlayRoot();
    const current = liveTiles();
    const wanted = new Set<string>(guide.plan.keys());
    for (const [localIndex, tile] of Object.entries(current)) {
      if (tile?.objectType === 'plant' && !isPreserved(tile) && CELESTIAL_SPECIES.has(tile.species as CelestialSpecies)) wanted.add(localIndex);
    }
    root.querySelectorAll<HTMLElement>('[data-celestial-tile]').forEach(element => {
      if (!wanted.has(element.dataset.celestialTile!)) element.remove();
    });

    const seenStyles = new Set<Record<string, any>>();
    const seenGhosts = new Set<string>();
    let correctCount = 0;
    for (const localIndex of wanted) {
      const ref = mappedTiles.get(localIndex);
      if (!ref) continue;
      const planned = guide.plan.get(localIndex) ?? null;
      const actualTile = current[localIndex];
      const actual = actualTile?.objectType === 'plant' && !isPreserved(actualTile) && CELESTIAL_SPECIES.has(actualTile.species as CelestialSpecies)
        ? actualTile.species as CelestialSpecies
        : null;
      const covered = guide.covered.get(localIndex) !== false;
      const compatible = Boolean(planned && actual && placementType(planned) === placementType(actual));
      const correct = compatible && covered;
      if (correct) correctCount++;
      const wrong = Boolean(actual || planned && actualTile?.objectType);
      const element = tileElement(root, localIndex);
      element.dataset.state = correct ? 'correct' : wrong || !covered ? 'wrong' : 'empty';
      element.title = planned
        ? `${correct && actual ? SPECIES_LABELS[actual] : SPECIES_LABELS[planned]}${correct ? ' - correct' : actual ? ` - replace ${SPECIES_LABELS[actual]}` : ' - move here'}`
        : actual ? `${SPECIES_LABELS[actual]} - move this plant` : '';
      element.replaceChildren();
      if (planned && !compatible) {
        if (showGhost(ref, planned)) seenGhosts.add(localIndex);
        else {
          const label = document.createElement('span');
          label.textContent = SPECIES_LABELS[planned];
          element.appendChild(label);
        }
      }
      if (actual) stylePlant(ref, correct ? 0x66ff8c : 0xff5265, 1, seenStyles);
    }
    destroyGhosts(seenGhosts);
    restoreStyles(seenStyles);
    const progress = document.querySelector<HTMLElement>('#gc-celestial-layout [data-celestial-placement]');
    if (progress) progress.textContent = `${correctCount} of ${guide.plan.size} plants in position`;
    positionOverlay();
  }

  function frame(now: number): void {
    if (!guide.open) return;
    if (now - lastStateAt >= 250) {
      lastStateAt = now;
      updateOverlay();
    } else positionOverlay();
    animationFrame = requestAnimationFrame(frame);
  }

  function renderPanel(): void {
    if (!guide.open) return;
    let panel = document.getElementById('gc-celestial-layout');
    let needsDraggable = false;
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'gc-celestial-layout';
      document.body.appendChild(panel);
      panel.addEventListener('pointerdown', event => event.stopPropagation());
      needsDraggable = true;
    }
    const counts = currentCelestials().reduce<Record<string, number>>((totals, species) => {
      totals[species] = (totals[species] ?? 0) + 1;
      return totals;
    }, {});
    panel.innerHTML = `<header><b>Celestial layout</b><button data-celestial-close>Close</button></header>
<div class="gc-celestial-body"><small>Choose a farm side and the buffs every celestial plant should receive. The guide never moves plants.</small>
<div class="gc-celestial-label">Farm side</div><div class="gc-celestial-segments"><button data-celestial-side="left" data-active="${guide.side === 'left'}">Left</button><button data-celestial-side="right" data-active="${guide.side === 'right'}">Right</button></div>
<div class="gc-celestial-label">Every plant needs</div><div class="gc-celestial-segments"><button data-celestial-goal="amber" data-active="${guide.goal === 'amber'}">Amberbound</button><button data-celestial-goal="dawn" data-active="${guide.goal === 'dawn'}">Dawnbound</button><button data-celestial-goal="both" data-active="${guide.goal === 'both'}">Both</button></div>
<small class="gc-celestial-sources">Moonbinder grants Amberbound. Dawnbinder grants Dawnbound.</small>
<div class="gc-celestial-counts">${([...CELESTIAL_SPECIES] as CelestialSpecies[]).map(species => `<span><b>${counts[species] ?? 0}</b>${SPECIES_LABELS[species]}</span>`).join('')}</div>
<p data-celestial-status data-tone="${guide.tone}">${guide.message}</p>
<div class="gc-celestial-placement" data-celestial-placement>${guide.plan.size ? `0 of ${guide.plan.size} plants in position` : 'No guide placed'}</div>
<div class="gc-celestial-legend"><span data-kind="ghost">Faded guide</span><span data-kind="correct">Correct</span><span data-kind="wrong">Move</span></div>
<button class="gc-celestial-refresh" data-celestial-refresh ${guide.side ? '' : 'disabled'}>Refresh from garden</button></div>`;
    if (needsDraggable) makeDraggable(panel, POSITION_KEY);
    panel.querySelector<HTMLButtonElement>('[data-celestial-close]')!.onclick = close;
    panel.querySelectorAll<HTMLButtonElement>('[data-celestial-side]').forEach(button => button.onclick = () => {
      guide.side = button.dataset.celestialSide as FarmSide;
      renderPanel();
      generate();
    });
    panel.querySelectorAll<HTMLButtonElement>('[data-celestial-goal]').forEach(button => button.onclick = () => {
      guide.goal = button.dataset.celestialGoal as CelestialGoal;
      renderPanel();
      if (guide.side) generate();
    });
    panel.querySelector<HTMLButtonElement>('[data-celestial-refresh]')!.onclick = () => {
      renderPanel();
      generate();
    };
  }

  function open(): void {
    // Decor and growing-plant artwork is only decoded on demand, and the celestial guide draws full plants.
    page.__gardenCompanionLoadSpriteGroup?.('deferred');
    if (guide.open) return;
    guide.open = true;
    renderPanel();
    animationFrame = requestAnimationFrame(frame);
  }

  function close(): void {
    if (!guide.open) return;
    guide.open = false;
    cancelAnimationFrame(animationFrame);
    clearPlan();
    document.getElementById('gc-celestial-overlay')?.remove();
    document.getElementById('gc-celestial-layout')?.remove();
  }

  page.__gardenCompanionToggleCelestialLayout = () => guide.open ? close() : open();
}
