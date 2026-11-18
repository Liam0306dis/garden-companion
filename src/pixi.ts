import { page } from './page.js';

/** Reaching into the game's PIXI scene graph, so panels can be anchored to what it draws. */

export interface PixiSurface {
  stage: Record<string, any>;
  scaleX: number;
  scaleY: number;
  toScreenX(value: number): number;
  toScreenY(value: number): number;
}

type PixiCapture = NonNullable<typeof page.__GARDEN_COMPANION_PIXI__>;

/**
 * Notes the container the renderer last drew to the screen. Other mods draw with the game's renderer
 * too - QPM renders pet sprites and textures into offscreen targets every frame - and each of those
 * becomes the renderer's lastObjectRendered, so that alone flips between the game's stage and
 * something of theirs. A draw with no target is the one that reaches the screen.
 */
function watchScreenRenders(store: PixiCapture): void {
  const renderer = store.renderer as Record<string, any> | null;
  if (!renderer || typeof renderer.render !== 'function' || renderer.__gardenCompanionScreenWatched) return;
  const original = renderer.render;
  renderer.__gardenCompanionScreenWatched = true;
  renderer.render = function(this: unknown, options: any, ...rest: any[]) {
    try {
      // render({ container, target }) or the older render(container, target).
      const named = options && typeof options === 'object' && 'container' in options;
      const container = named ? options.container : options;
      const target = named ? options.target : rest[0];
      if (!target && container && typeof container === 'object') store.screenStage = container;
    } catch { /* never in the way of a frame */ }
    return original.call(this, options, ...rest);
  };
}

export function installPixiCapture() {
  const store = page.__GARDEN_COMPANION_PIXI__ ||= { app: null, renderer: null };
  for (const name of ['__PIXI_APP_INIT__', '__PIXI_RENDERER_INIT__']) {
    const previous = page[name];
    page[name] = function(this: unknown, value: any, ...args: unknown[]) {
      if (name.includes('APP') && value) { store.app = value; store.renderer = value.renderer || store.renderer; }
      else if (value) store.renderer = value;
      watchScreenRenders(store);
      if (typeof previous === 'function') return previous.call(this, value, ...args);
    };
  }
}

function liveNode(node: unknown): Record<string, any> | null {
  return node && typeof node === 'object' && !(node as Record<string, any>).destroyed ? node as Record<string, any> : null;
}

/**
 * The game's scene root. The game can rebuild its scene without the init hooks firing again, which
 * leaves the captured app holding a destroyed stage; the last container drawn to the screen is the
 * live one then. The renderer's lastObjectRendered is only a last resort, being whatever anyone drew.
 */
export function pixiStage(): Record<string, any> | null {
  const capture = page.__GARDEN_COMPANION_PIXI__;
  if (!capture) return null;
  watchScreenRenders(capture);
  const app = capture.app as { stage?: unknown } | null;
  const renderer = (capture.renderer ?? (app as { renderer?: unknown } | null)?.renderer) as Record<string, any> | undefined;
  return liveNode(app?.stage) || liveNode(capture.screenStage) || liveNode(renderer?.lastObjectRendered) || (app?.stage as Record<string, any> | undefined) || null;
}

export function pixiSurface(): PixiSurface | null {
  const capture = page.__GARDEN_COMPANION_PIXI__;
  const app = capture?.app as { stage?: Record<string, any>; renderer?: Record<string, any> } | undefined;
  const renderer = capture?.renderer as Record<string, any> | undefined || app?.renderer;
  const stage = pixiStage();
  const canvas = document.querySelector('.QuinoaCanvas canvas') || renderer?.canvas || renderer?.view;
  if (!stage || !renderer || !(canvas instanceof HTMLCanvasElement)) return null;
  const rect = canvas.getBoundingClientRect();
  const screen = renderer.screen || { width: canvas.width, height: canvas.height };
  if (![rect.width, rect.height, screen.width, screen.height].every(value => Number.isFinite(value) && value > 0)) return null;
  const scaleX = rect.width / screen.width;
  const scaleY = rect.height / screen.height;
  return { stage, scaleX, scaleY, toScreenX: value => rect.left + value * scaleX, toScreenY: value => rect.top + value * scaleY };
}

export function pixiNodeVisible(node: Record<string, any>): boolean {
  return node.visible !== false && node.renderable !== false && node.worldVisible !== false &&
    !(typeof node.alpha === 'number' && node.alpha <= .001) && !(typeof node.worldAlpha === 'number' && node.worldAlpha <= .001);
}

export function findVisiblePixiNodes(surface: PixiSurface, labels: string[]): Map<string, Record<string, any>> {
  const found = new Map<string, Record<string, any>>();
  const wanted = new Set(labels);
  const stack = [surface.stage];
  const seen = new WeakSet();
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object' || seen.has(node) || !pixiNodeVisible(node)) continue;
    seen.add(node);
    if (typeof node.label === 'string' && wanted.has(node.label) && !found.has(node.label)) found.set(node.label, node);
    if (found.size === wanted.size) break;
    if (Array.isArray(node.children)) stack.push(...node.children);
  }
  return found;
}

export function findPixiCard() {
  const surface = pixiSurface();
  const node = surface ? findVisiblePixiNodes(surface, ['GardenInfoCardSystem']).get('GardenInfoCardSystem') : null;
  if (!surface || !node || typeof node.getBounds !== 'function') return null;
  try {
    const bounds = node.getBounds();
    const card = typeof node.getChildByLabel === 'function' ? node.getChildByLabel('GardenInfoObjectCard', true) : null;
    const cardBounds = typeof card?.getBounds === 'function' ? card.getBounds() : null;
    const position = typeof node.getGlobalPosition === 'function' ? node.getGlobalPosition() : null;
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) return null;
    const centerX = Number.isFinite(position?.x) ? position.x : bounds.x + bounds.width / 2;
    const cardTop = Number.isFinite(cardBounds?.y) ? cardBounds.y : bounds.y;
    return { centerX: surface.toScreenX(centerX), top: surface.toScreenY(cardTop) };
  } catch { return null; }
}
