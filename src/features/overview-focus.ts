import type { CompanionPage, PlantSlot } from '../types.js';
import { PLANT_CATALOG } from '../constants.js';
import { slotIsMaxSize } from '../crop-size.js';
import { createTicker } from '../ticker.js';
import type { OverviewRuntimeState } from './garden-overview.js';

/**
 * Plant focus for the Garden Overview: fading the plants and crops that do not match the chosen
 * species and mutations, and the saved focus settings and presets behind it.
 */

const FOCUS_KEY = 'gardenCompanion.overviewFocus.v1';
const FOCUS_PRESETS_KEY = 'gardenCompanion.overviewFocusPresets.v1';

export interface FocusConfig {
  enabled: boolean;
  scope: string;
  mutations: string[];
  mutationRule: 'all' | 'any' | 'none';
  maxSize: boolean;
  mode: 'highlight' | 'hide';
  opacity: number;
}

export function focusDefaults(): FocusConfig {
  return { enabled: false, scope: 'tracked', mutations: [], mutationRule: 'all', maxSize: false, mode: 'highlight', opacity: .2 };
}

export function loadFocus(): FocusConfig {
  try {
    // `invert` was the old name for hide mode; migrate it so existing setups keep behaving the same.
    const stored = JSON.parse(localStorage.getItem(FOCUS_KEY) || '{}');
    const migrating = stored.mode === undefined && Boolean(stored.invert);
    const config = { ...focusDefaults(), ...stored, mode: stored.mode ?? (stored.invert ? 'hide' : 'highlight') } as FocusConfig & { invert?: boolean };
    // An inverted setup with nothing selected used to mean "fade the unmutated crops". Under the
    // current matcher no conditions means no filter, so carrying it straight over to hide would dim
    // the entire garden on first load. Only the migration is clamped: choosing Faded out with no
    // conditions afterwards is a deliberate way to dim one species.
    if (migrating && !config.mutations.length && !config.maxSize) config.mode = 'highlight';
    delete config.invert;
    return config;
  } catch { return focusDefaults(); }
}

export function saveFocus(config: FocusConfig): void {
  try { localStorage.setItem(FOCUS_KEY, JSON.stringify(config)); } catch {}
}

/** Everything but `enabled`: loading a preset changes what focus looks for, not whether it is on. */
export type FocusPresetConfig = Omit<FocusConfig, 'enabled'>;
export interface FocusPreset { name: string; config: FocusPresetConfig }

export const PRESET_NAME_LIMIT = 28;
export const PRESET_LIMIT = 24;

export function presetConfigOf(config: FocusConfig): FocusPresetConfig {
  const { enabled, ...rest } = config;
  void enabled;
  return { ...rest, mutations: [...rest.mutations] };
}

/**
 * Rebuilt field by field rather than trusted wholesale: these come back from storage, where a half
 * written entry or an older shape would otherwise flow straight into the matcher.
 */
export function loadFocusPresets(): FocusPreset[] {
  try {
    const stored = JSON.parse(localStorage.getItem(FOCUS_PRESETS_KEY) || '[]');
    if (!Array.isArray(stored)) return [];
    const seen = new Set<string>();
    return stored.flatMap((entry: unknown) => {
      const row = entry as { name?: unknown; config?: Partial<FocusConfig> } | null;
      const name = typeof row?.name === 'string' ? row.name.trim().slice(0, PRESET_NAME_LIMIT) : '';
      if (!name || seen.has(name)) return [];
      seen.add(name);
      return [{ name, config: presetConfigOf({ ...focusDefaults(), ...(row?.config ?? {}) }) }];
    }).slice(0, PRESET_LIMIT);
  } catch { return []; }
}

export function saveFocusPresets(presets: readonly FocusPreset[]): void {
  try { localStorage.setItem(FOCUS_PRESETS_KEY, JSON.stringify(presets)); } catch {}
}

export function installPlantFocus(
  page: CompanionPage,
  runtime: () => OverviewRuntimeState & { slotIndex?: number | null },
  selectedSpecies: () => Set<string> | null,
  focusConfig: () => FocusConfig,
  ignorePreserved: () => boolean,
): () => void {
  let tileSystem: any = null;
  const originalAlpha = new WeakMap<object, number>();
  const desiredAlpha = new WeakMap<object, number>();
  const managed = new Set<any>();
  const systemsByViews = new WeakMap<object, any>();

  function restore(display: any): void {
    if (!display || !originalAlpha.has(display)) return;
    if (!display.destroyed) display.alpha = originalAlpha.get(display);
    originalAlpha.delete(display);
    desiredAlpha.delete(display);
    managed.delete(display);
  }

  function restoreAll(): void {
    [...managed].forEach(restore);
  }

  function fade(display: any, opacity: number, seen: Set<any>): void {
    if (!display) return;
    if (!originalAlpha.has(display)) originalAlpha.set(display, Number.isFinite(display.alpha) ? display.alpha : 1);
    managed.add(display);
    const alpha = (originalAlpha.get(display) ?? 1) * opacity;
    desiredAlpha.set(display, alpha);
    display.alpha = alpha;
    seen.add(display);
  }

  function enforce(display: any): void {
    if (!display || !managed.has(display)) return;
    if (display.destroyed) {
      originalAlpha.delete(display);
      desiredAlpha.delete(display);
      managed.delete(display);
      return;
    }
    const alpha = desiredAlpha.get(display);
    if (Number.isFinite(alpha) && display.alpha !== alpha) display.alpha = alpha;
  }

  function cropContainer(crop: any): any {
    return crop?.cropVisual?.container || crop?.container || null;
  }

  function armView(view: any): void {
    if (!view || typeof view.draw !== 'function' || view.__gardenCompanionFocusDrawWrapped) return;
    const originalDraw = view.draw;
    view.__gardenCompanionFocusDrawWrapped = true;
    view.draw = function(...args: any[]) {
      const result = originalDraw.apply(this, args);
      enforce(view.childView?.plantVisual?.container);
      const crops = view.childView?.plantVisual?.getCropVisuals?.() || [];
      crops.forEach((crop: any) => enforce(cropContainer(crop)));
      return result;
    };
  }

  function matches(tile: any, slot: PlantSlot, config: FocusConfig): boolean {
    if (ignorePreserved() && slot.preserved) return false;
    const selected = selectedSpecies();
    // Rare variants live on the slot, so a Purple Daisy inside a Daisy patch is matched by its own
    // name rather than the patch it grew in.
    const slotSpecies = slot.species ?? tile.species;
    const scopeMatches = config.scope === 'all' || config.scope === 'tracked' && (!selected || selected.has(slotSpecies)) || config.scope === slotSpecies;
    const mutations = slot.mutations || [];
    const conditions = config.mutations.map(name => mutations.includes(name));
    if (config.maxSize) conditions.push(slotIsMaxSize(PLANT_CATALOG[slotSpecies ?? '']?.crop, slot));
    // No conditions picked means the scope is the only filter — not "unmutated crops only".
    const ruleMatches = !conditions.length
      || (config.mutationRule === 'none' ? conditions.every(match => !match)
        : config.mutationRule === 'any' ? conditions.some(Boolean)
          : conditions.every(Boolean));
    const result = scopeMatches && ruleMatches;
    return config.mode === 'hide' ? !result : result;
  }

  function capture(system: any): void {
    if (!system?.tileViews || !system?.map?.globalTileIdxToDirtTile || system === tileSystem) return;
    restoreAll();
    tileSystem = system;
    if (typeof system.destroy === 'function' && !system.__gardenCompanionFocusDestroyWrapped) {
      const originalDestroy = system.destroy;
      system.__gardenCompanionFocusDestroyWrapped = true;
      system.destroy = function(...args: any[]) {
        if (tileSystem === system) {
          restoreAll();
          tileSystem = null;
          setTimeout(armTileViewsCapture, 0);
        }
        return originalDestroy.apply(this, args);
      };
    }
    setTimeout(apply, 0);
  }

  const PageMap = page.Map as MapConstructor;
  const PageObject = page.Object as ObjectConstructor & { __gardenCompanionFocusDefineWrapped?: boolean };

  function armTileViewsCapture(): void {
    if (tileSystem) return;
    const prototype = PageObject.prototype as object;
    const existing = PageObject.getOwnPropertyDescriptor(prototype, 'tileViews');
    const existingGetter = existing?.get as (() => unknown) & { __gardenCompanionFocusTrap?: boolean } | undefined;
    if (existingGetter?.__gardenCompanionFocusTrap || existing && !existing.configurable) return;
    let storedValue: unknown;
    const getter = function(this: any) { return existingGetter ? existingGetter.call(this) : storedValue; } as (() => unknown) & { __gardenCompanionFocusTrap?: boolean };
    getter.__gardenCompanionFocusTrap = true;
    PageObject.defineProperty(prototype, 'tileViews', {
      configurable: true,
      get: getter,
      set: function(this: any, value: unknown) {
        if (existing?.set) existing.set.call(this, value);
        else PageObject.defineProperty(this, 'tileViews', { configurable: true, enumerable: true, writable: true, value });
        if (this?.name === 'tileObject' && value instanceof PageMap) capture(this);
      },
    });
  }

  const mapPrototype = PageMap?.prototype as Map<unknown, unknown> & { set: (...args: any[]) => any; __gardenCompanionFocusWrapped?: boolean };
  if (mapPrototype && !mapPrototype.__gardenCompanionFocusWrapped) {
    const originalSet = mapPrototype.set;
    mapPrototype.set = function(key: unknown, value: any) {
      const result = originalSet.call(this, key, value);
      try {
        const map = value?.map;
        const looksLikeTileView = Number.isInteger(key) && value?.globalTileIdx === key && value?.displayObject &&
          'tileObject' in value && typeof value.onDataChanged === 'function' && map?.globalTileIdxToDirtTile && map?.globalTileIdxToBoardwalk;
        if (looksLikeTileView && tileSystem?.tileViews !== this) {
          let system = systemsByViews.get(this);
          if (!system) { system = { name: 'tileObject', tileViews: this, map }; systemsByViews.set(this, system); }
          capture(system);
        }
      } catch {}
      return result;
    };
    mapPrototype.__gardenCompanionFocusWrapped = true;
  }

  if (!PageObject.__gardenCompanionFocusDefineWrapped) {
    const originalDefineProperty = PageObject.defineProperty;
    const wrappedDefineProperty = function(this: ObjectConstructor, target: object, property: PropertyKey, attributes: PropertyDescriptor & ThisType<any>): object {
      const result = originalDefineProperty(target, property, attributes) as object;
      try {
        if (property === 'tileViews' && (target as any)?.name === 'tileObject' && attributes?.value instanceof PageMap) capture(target);
      } catch {}
      return result;
    };
    PageObject.defineProperty = wrappedDefineProperty as typeof Object.defineProperty;
    PageObject.__gardenCompanionFocusDefineWrapped = true;
  }

  armTileViewsCapture();

  /**
   * Growing plants cross into maturity on their own and the game redraws tiles whenever it likes,
   * so while focus is on it is reapplied on a tick. With focus off there is nothing to keep up, and
   * the tick stops once everything has been put back.
   */
  const focusTicker = createTicker(() => apply(), 600);

  function apply(): void {
    const config = focusConfig();
    focusTicker.sync(config.enabled);
    const slotIndex = runtime().slotIndex;
    const views = tileSystem?.tileViews;
    const dirtMap = tileSystem?.map?.globalTileIdxToDirtTile;
    if (!config.enabled || slotIndex == null || !(views instanceof PageMap) || !dirtMap) {
      restoreAll();
      return;
    }
    const seen = new Set<any>();
    const now = Date.now();
    views.forEach((view: any, globalIndex: number) => {
      const dirt = typeof dirtMap.get === 'function' ? dirtMap.get(globalIndex) : dirtMap[globalIndex];
      const tile = view?.tileObject;
      if (!dirt || dirt.userSlotIdx !== slotIndex || tile?.objectType !== 'plant') return;
      const slots: PlantSlot[] = tile.slots || [];
      const plantVisual = view.childView?.plantVisual;
      const crops = plantVisual?.getCropVisuals?.() || [];
      armView(view);
      if (Number(tile.maturedAt ?? 0) > now) {
        fade(plantVisual?.container, config.opacity, seen);
        crops.forEach((crop: any) => fade(cropContainer(crop), config.opacity, seen));
        return;
      }
      const visible = new Map(slots.map(slot => [slot.slotId, matches(tile, slot, config)]));
      if (![...visible.values()].some(Boolean)) {
        fade(plantVisual?.container, config.opacity, seen);
        crops.forEach((crop: any) => restore(cropContainer(crop)));
      } else {
        restore(plantVisual?.container);
        crops.forEach((crop: any) => visible.get(crop?.slotId) === false ? fade(cropContainer(crop), config.opacity, seen) : restore(cropContainer(crop)));
      }
    });
    [...managed].forEach(display => { if (!seen.has(display)) restore(display); });
  }

  apply();
  return apply;
}
