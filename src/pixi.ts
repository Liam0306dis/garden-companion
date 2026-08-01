import { page } from './page.js';

/** Reaching into the game's PIXI scene graph, so panels can be anchored to what it draws. */

export interface PixiSurface {
  stage: Record<string, any>;
  scaleX: number;
  scaleY: number;
  toScreenX(value: number): number;
  toScreenY(value: number): number;
}

export function installPixiCapture() {
  const store = page.__GARDEN_COMPANION_PIXI__ ||= { app: null, renderer: null };
  for (const name of ['__PIXI_APP_INIT__', '__PIXI_RENDERER_INIT__']) {
    const previous = page[name];
    page[name] = function(value, ...args) {
      if (name.includes('APP') && value) { store.app = value; store.renderer = value.renderer || store.renderer; }
      else if (value) store.renderer = value;
      if (typeof previous === 'function') return previous.call(this, value, ...args);
    };
  }
}

export function pixiSurface(): PixiSurface | null {
  const capture = page.__GARDEN_COMPANION_PIXI__;
  const app = capture?.app as { stage?: Record<string, any>; renderer?: Record<string, any> } | undefined;
  const renderer = capture?.renderer as Record<string, any> | undefined || app?.renderer;
  const stage = app?.stage || renderer?.lastObjectRendered;
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
