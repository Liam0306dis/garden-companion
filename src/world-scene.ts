import { page } from './page.js';
import { state } from './state.js';
import { pixiSurface } from './pixi.js';

/**
 * Shared plumbing for minigames that borrow the player's own farm tiles and draw something else on
 * them. Hiding the garden, suppressing native tile redraws, owning cinematic mode, putting layers
 * into the world and herding the active pets out of the way are identical for all of them, and a
 * teardown that misses a step leaves the player staring at an invisible garden. So it lives here
 * once, and a scene only supplies what is actually different: its art and its rules.
 *
 * Nothing in here talks to the game. It reads the tile map and moves display objects around; no
 * message is ever sent, so a minigame can never change the real garden.
 */

/** Every farm tile is this many world units square. */
export const TILE_SIZE = 256;

/** Above the game's own world overlay, so a scene can draw in front of the player. */
const WORLD_OVERLAY_Z_INDEX = 0xe8d4a51000;

export interface WorldBounds { left: number; top: number; width: number; height: number }

export interface WorldGeometry extends WorldBounds {
  system: Record<string, any>;
  /** Global tile indices the local player owns, dirt and boardwalk alike. */
  globals: number[];
  cols: number;
  rows: number;
}

export interface WorldSceneConfig {
  /** Separates this scene's cinematic claim and render layer from every other scene's. */
  owner: string;
  /**
   * Layer name to z-index. The garden sits near zero, so scenery needs a large negative index and
   * anything drawn over the player needs `abovePlayer` instead of a large positive one.
   */
  layers: Record<string, number>;
  /** Layers lifted into a dedicated render layer that sorts above the player avatar. */
  abovePlayer?: string[];
  /** Draws the scene's static art. Called once per farm shape, not once per frame. */
  onBuild?(geometry: WorldGeometry, scene: WorldScene): void;
  /** Where the active pets are penned while the scene is up. Omit to leave them where they are. */
  petArea?(geometry: WorldGeometry): WorldBounds | null;
}

export interface WorldScene {
  /** Takes over the farm. Safe to call repeatedly. */
  enter(): void;
  /** Hands the farm back. Safe to call when it was never entered. */
  exit(): void;
  entered(): boolean;
  /**
   * Per-frame upkeep: builds the scene if needed, keeps the garden hidden and returns the geometry
   * to draw against, or null when the farm cannot be read yet.
   */
  sync(): WorldGeometry | null;
  geometry(): WorldGeometry | null;
  layer(name: string): Record<string, any> | null;
  /** World rectangle to a screen rectangle, for positioning a DOM input surface over the scene. */
  project(bounds: WorldBounds): ScreenRect | null;
  /** Screen point to world coordinates, for hit-testing a click against the scene. */
  toWorld(clientX: number, clientY: number): { x: number; y: number } | null;
  /** The local player's avatar node, cached until it is replaced. */
  avatar(): Record<string, any> | null;
  /** Adds an image to the world under the scene's ownership, destroyed on exit. */
  addSprite(image: HTMLImageElement, options: SpriteOptions): Record<string, any> | null;
  /** Destroys one sprite early, for scenes whose pieces come and go during play. */
  removeSprite(sprite: Record<string, any> | null): void;
  clearSprites(): void;
  /** Records a failure, tears the scene down and stops it retrying until the next enter(). */
  fail(error: unknown, message: string): void;
  failed(): boolean;
}

export interface ScreenRect { left: number; top: number; width: number; height: number }

export interface SpriteOptions {
  x: number;
  y: number;
  width: number;
  zIndex: number;
  anchorX?: number;
  anchorY?: number;
}

/**
 * Owners of every scene currently holding the farm. Features outside a scene read this to stand
 * down while one is up, rather than each knowing about all the others.
 */
const activeScenes = new Set<string>();

export function worldSceneActive(): boolean {
  return activeScenes.size > 0;
}

export function createWorldScene(config: WorldSceneConfig): WorldScene {
  const hiddenTiles = new Map<Record<string, any>, NodeState>();
  const hiddenEffects = new Map<Record<string, any>, NodeState>();
  const wrappedTileViews = new Map<Record<string, any>, (...args: any[]) => unknown>();
  const graphics = new Map<string, Record<string, any>>();
  let sprites: Record<string, any>[] = [];
  let renderLayer: Record<string, any> | null = null;
  let currentGeometry: WorldGeometry | null = null;
  let signature = '';
  let active = false;
  let broken = false;
  let warned = false;
  let cinematicApplied = false;
  let penArea: WorldBounds | null = null;
  /**
   * Read by every wrapped tile draw, so it stays a plain flag. A DOM or geometry lookup here would
   * run once per tile per frame.
   */
  let suppressTileDraw = false;
  let cachedOverlay: Record<string, any> | null = null;
  let cachedAvatar: Record<string, any> | null = null;
  let cachedAvatarId = '';
  let cachedGraphic: (new (...args: any[]) => Record<string, any>) | null = null;
  let cachedSprite: Record<string, any> | null = null;
  let cachedRenderLayer: (new (options?: Record<string, unknown>) => Record<string, any>) | null = null;

  interface NodeState { alpha: number; visible: boolean; renderable: boolean }

  function findNode(predicate: (node: Record<string, any>) => boolean): Record<string, any> | null {
    const surface = pixiSurface();
    if (!surface) return null;
    const stack = [surface.stage];
    const seen = new WeakSet<object>();
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      if (predicate(node)) return node;
      if (Array.isArray(node.children)) stack.push(...node.children);
    }
    return null;
  }

  function graphicConstructor(): (new (...args: any[]) => Record<string, any>) | null {
    if (cachedGraphic) return cachedGraphic;
    const marker = page.__gardenCompanionFarmSystems?.tapToMove?.hoverMarker;
    const constructor = marker?.constructor ?? findNode(node => node.renderPipeId === 'graphics' && typeof node.clear === 'function')?.constructor;
    return cachedGraphic = (constructor as (new (...args: any[]) => Record<string, any>) | undefined) ?? null;
  }

  function spriteConstructor(): Record<string, any> | null {
    if (cachedSprite) return cachedSprite;
    return cachedSprite = findNode(node => node.texture && node.anchor && typeof (node.constructor as any)?.from === 'function')?.constructor as Record<string, any> ?? null;
  }

  function renderLayerConstructor(): (new (options?: Record<string, unknown>) => Record<string, any>) | null {
    if (cachedRenderLayer) return cachedRenderLayer;
    const aboveGround = findNode(node => node.label === 'AboveGround');
    return cachedRenderLayer = (aboveGround?.constructor as (new (options?: Record<string, unknown>) => Record<string, any>) | undefined) ?? null;
  }

  function readGeometry(): WorldGeometry | null {
    const systems = page.__gardenCompanionFarmSystems;
    const system = systems?.tileSystem;
    const slotIndex = systems?.ownUserSlotIdx;
    const dirtMapping = slotIndex == null ? null : system?.map?.userSlotIdxAndDirtTileIdxToGlobalTileIdx?.[slotIndex];
    const boardwalkMapping = slotIndex == null ? null : system?.map?.userSlotIdxAndBoardwalkTileIdxToGlobalTileIdx?.[slotIndex];
    if (!system?.worldContainer || !dirtMapping) return null;
    const globals = [...Object.values(dirtMapping), ...Object.values(boardwalkMapping ?? {})].map(Number).filter(Number.isFinite);
    const cols = Number(system.map?.cols);
    if (!globals.length || !Number.isFinite(cols) || cols <= 0) return null;
    const xs = globals.map(index => index % cols);
    const ys = globals.map(index => Math.floor(index / cols));
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const inset = 24;
    return {
      system,
      globals,
      cols: maxX - minX + 1,
      rows: maxY - minY + 1,
      left: minX * TILE_SIZE + inset,
      top: minY * TILE_SIZE + inset,
      width: (maxX - minX + 1) * TILE_SIZE - inset * 2,
      height: (maxY - minY + 1) * TILE_SIZE - inset * 2,
    };
  }

  function captureState(node: Record<string, any>): NodeState {
    return { alpha: Number(node.alpha), visible: node.visible !== false, renderable: node.renderable !== false };
  }

  function hideNode(node: Record<string, any>, into: Map<Record<string, any>, NodeState>): void {
    if (!into.has(node)) into.set(node, captureState(node));
    node.alpha = 0;
    node.visible = false;
    node.renderable = false;
  }

  function restoreNodes(from: Map<Record<string, any>, NodeState>): void {
    for (const [node, saved] of from) {
      if (node.destroyed) continue;
      node.alpha = Number.isFinite(saved.alpha) ? saved.alpha : 1;
      node.visible = saved.visible;
      node.renderable = saved.renderable;
    }
    from.clear();
  }

  function hideGarden(geometry: WorldGeometry): void {
    suppressTileDraw = true;
    for (const index of geometry.globals) {
      const node = geometry.system.tileViews?.get?.(index)?.displayObject;
      if (node && !node.destroyed) hideNode(node, hiddenTiles);
    }
  }

  /** The game's standing-on-plant effects draw over anything a scene puts on the ground. */
  function hideStandingEffects(): void {
    if (cachedOverlay?.destroyed) cachedOverlay = null;
    const overlay = cachedOverlay || findNode(node => node.label === 'WorldOverlay');
    if (!overlay || overlay.destroyed) return;
    cachedOverlay = overlay;
    hideNode(overlay, hiddenEffects);
  }

  /**
   * Tiles are suppressed by wrapping their draw, so the wrappers have to be removable: left in
   * place they cost a lookup per tile per frame forever, and after a scene fails they would keep
   * blanking the garden with nothing drawn over it.
   */
  function suppressTileDraws(system: Record<string, any>): void {
    for (const tileView of system.tileViews?.values?.() ?? []) {
      if (!tileView || wrappedTileViews.has(tileView) || typeof tileView.draw !== 'function') continue;
      const originalDraw = tileView.draw;
      wrappedTileViews.set(tileView, originalDraw);
      tileView.draw = function(...args: any[]) {
        if (suppressTileDraw) return;
        return originalDraw.apply(this, args);
      };
    }
  }

  function restoreTileDraws(): void {
    for (const [tileView, originalDraw] of wrappedTileViews) {
      if (!tileView.destroyed) tileView.draw = originalDraw;
    }
    wrappedTileViews.clear();
  }

  function destroyNode(node: Record<string, any> | null): void {
    if (!node) return;
    try { node.destroy?.({ children: true }); }
    catch { try { node.parent?.removeChild?.(node); } catch {} }
  }

  function teardown(): void {
    suppressTileDraw = false;
    restoreTileDraws();
    restoreNodes(hiddenTiles);
    restoreNodes(hiddenEffects);
    for (const graphic of graphics.values()) destroyNode(graphic);
    graphics.clear();
    clearSprites();
    destroyNode(renderLayer);
    renderLayer = null;
    currentGeometry = null;
    penArea = null;
    signature = '';
  }

  function clearSprites(): void {
    for (const sprite of sprites) destroyNode(sprite);
    sprites = [];
  }

  function build(geometry: WorldGeometry): boolean {
    const Graphic = graphicConstructor();
    if (!Graphic) return false;
    teardown();
    suppressTileDraw = true;
    for (const [name, zIndex] of Object.entries(config.layers)) {
      const graphic = new Graphic();
      graphic.eventMode = 'none';
      graphic.interactive = false;
      graphic.zIndex = zIndex;
      graphics.set(name, graphic);
      geometry.system.worldContainer.addChild(graphic);
    }
    const lifted = (config.abovePlayer ?? []).map(name => graphics.get(name)).filter(Boolean);
    const RenderLayer = lifted.length ? renderLayerConstructor() : null;
    if (RenderLayer && lifted.length) {
      renderLayer = new RenderLayer({ sortableChildren: true });
      renderLayer.label = `GardenCompanionScene:${config.owner}`;
      renderLayer.zIndex = WORLD_OVERLAY_Z_INDEX + 1;
      geometry.system.worldContainer.addChild(renderLayer);
      for (const graphic of lifted) renderLayer.attach?.(graphic);
    }
    currentGeometry = geometry;
    penArea = config.petArea?.(geometry) ?? null;
    config.onBuild?.(geometry, scene);
    return true;
  }

  function penActivePets(system: Record<string, any>): void {
    if (!active || !currentGeometry || !penArea) return;
    const activeIds = new Set((state.slot?.data?.petSlots ?? []).map(pet => pet.id));
    const area = penArea;
    const farm = currentGeometry;
    for (const [id, petView] of system.views ?? []) {
      if (!activeIds.has(id) || system.petInfoById?.get?.(id)?.riddenByPlayerId) continue;
      const display = petView?.displayObject;
      if (!display?.position || display.destroyed) continue;
      const xProgress = Math.max(0, Math.min(1, (Number(display.x) - farm.left) / Math.max(1, farm.width)));
      const yProgress = Math.max(0, Math.min(1, (Number(display.y) - farm.top) / Math.max(1, farm.height)));
      display.position.set(area.left + xProgress * Math.max(0, area.width), area.top + yProgress * Math.max(0, area.height));
    }
  }

  /**
   * Pets are repositioned after the game has drawn them, so the constraint has to run inside the
   * pet system's own draw rather than on our frame, or they visibly snap back between frames.
   */
  function installPetConstraint(): void {
    const system = page.__gardenCompanionFarmSystems?.petSystem;
    const flag = `__gardenCompanionPen_${config.owner}`;
    if (!system || system[flag] || typeof system.draw !== 'function') return;
    const originalDraw = system.draw;
    system.draw = function(...args: any[]) {
      const result = originalDraw.apply(this, args);
      penActivePets(this);
      return result;
    };
    system[flag] = true;
  }

  function applyCinematic(): void {
    if (!cinematicApplied && page.__gardenCompanionSetCinematic?.(true, config.owner)) cinematicApplied = true;
  }

  function releaseCinematic(): void {
    if (!cinematicApplied) return;
    page.__gardenCompanionSetCinematic?.(false, config.owner);
    cinematicApplied = false;
  }

  const scene: WorldScene = {
    enter(): void {
      active = true;
      broken = false;
      warned = false;
      activeScenes.add(config.owner);
      applyCinematic();
    },

    exit(): void {
      active = false;
      activeScenes.delete(config.owner);
      teardown();
      releaseCinematic();
    },

    entered: () => active,
    failed: () => broken,
    geometry: () => currentGeometry,
    layer: name => graphics.get(name) ?? null,

    sync(): WorldGeometry | null {
      if (!active || broken) return null;
      applyCinematic();
      const geometry = readGeometry();
      if (!geometry) return null;
      const next = `${geometry.globals.join(',')}:${geometry.left}:${geometry.top}:${geometry.width}:${geometry.height}`;
      if (signature !== next || !graphics.size) {
        if (!build(geometry)) return null;
        signature = next;
      } else {
        currentGeometry = geometry;
      }
      hideGarden(geometry);
      suppressTileDraws(geometry.system);
      hideStandingEffects();
      installPetConstraint();
      return geometry;
    },

    project(bounds: WorldBounds): ScreenRect | null {
      const surface = pixiSurface();
      const container = currentGeometry?.system?.worldContainer;
      if (!surface || typeof container?.toGlobal !== 'function') return null;
      try {
        const corners = [
          container.toGlobal({ x: bounds.left, y: bounds.top }),
          container.toGlobal({ x: bounds.left + bounds.width, y: bounds.top }),
          container.toGlobal({ x: bounds.left, y: bounds.top + bounds.height }),
          container.toGlobal({ x: bounds.left + bounds.width, y: bounds.top + bounds.height }),
        ];
        const xs = corners.map(point => surface.toScreenX(point.x));
        const ys = corners.map(point => surface.toScreenY(point.y));
        const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
        if (![left, right, top, bottom].every(Number.isFinite)) return null;
        return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
      } catch { return null; }
    },

    toWorld(clientX: number, clientY: number): { x: number; y: number } | null {
      const surface = pixiSurface();
      const container = currentGeometry?.system?.worldContainer;
      if (!surface || typeof container?.toLocal !== 'function' || !surface.scaleX || !surface.scaleY) return null;
      try {
        // toScreenX/Y map a renderer point onto the page, so undo exactly that to get back.
        const stageX = (clientX - surface.toScreenX(0)) / surface.scaleX;
        const stageY = (clientY - surface.toScreenY(0)) / surface.scaleY;
        const point = container.toLocal({ x: stageX, y: stageY });
        return Number.isFinite(point?.x) && Number.isFinite(point?.y) ? { x: point.x, y: point.y } : null;
      } catch { return null; }
    },

    avatar(): Record<string, any> | null {
      const id = state.playerId || state.room?.selfPlayerId;
      if (!id) return null;
      if (cachedAvatarId !== id || cachedAvatar?.destroyed) {
        cachedAvatarId = id;
        cachedAvatar = findNode(node => node.label === `AvatarContainer (${id})`);
      }
      return cachedAvatar;
    },

    addSprite(image: HTMLImageElement, options: SpriteOptions): Record<string, any> | null {
      const Sprite = spriteConstructor();
      const container = currentGeometry?.system?.worldContainer;
      if (!Sprite || !container?.addChild) return null;
      try {
        const sprite = Sprite.from(image);
        sprite.anchor?.set?.(options.anchorX ?? .5, options.anchorY ?? 1);
        const ratio = Number(sprite.texture?.height) > 0 ? Number(sprite.texture.width) / Number(sprite.texture.height) : 1;
        sprite.width = options.width;
        sprite.height = options.width / Math.max(.2, ratio);
        if (sprite.texture?.source) sprite.texture.source.scaleMode = 'linear';
        sprite.position.set(options.x, options.y);
        sprite.eventMode = 'none';
        sprite.interactive = false;
        sprite.zIndex = options.zIndex;
        container.addChild(sprite);
        sprites.push(sprite);
        return sprite;
      } catch { return null; }
    },

    removeSprite(sprite: Record<string, any> | null): void {
      if (!sprite) return;
      const index = sprites.indexOf(sprite);
      if (index >= 0) sprites.splice(index, 1);
      destroyNode(sprite);
    },

    clearSprites,

    /**
     * A failed scene must not retry: rebuilding every frame allocates and destroys the whole world
     * scene sixty times a second while logging nothing after the first warning.
     */
    fail(error: unknown, message: string): void {
      broken = true;
      if (!warned) console.warn(`[Garden Companion] ${message}`, error);
      warned = true;
      teardown();
    },
  };

  return scene;
}

/** Decodes an injected sprite data URL, or null while it is still loading. */
export function readyImage(source: string | undefined): HTMLImageElement | null {
  if (!source) return null;
  const cached = imageCache.get(source);
  if (cached) return cached.complete && cached.naturalWidth > 0 ? cached : null;
  const image = new Image();
  image.src = source;
  imageCache.set(source, image);
  return image.complete && image.naturalWidth > 0 ? image : null;
}

const imageCache = new Map<string, HTMLImageElement>();
