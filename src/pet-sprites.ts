import type { CompanionPage } from './types.js';

interface AtlasFrame {
  frame: { x: number; y: number; w: number; h: number };
  spriteSourceSize?: { x: number; y: number; w: number; h: number };
  sourceSize?: { w: number; h: number };
  rotated?: boolean | number;
}

interface AtlasJson {
  frames: Record<string, AtlasFrame>;
  meta: { image: string; related_multi_packs?: string[] };
}

interface BasisTranscoder {
  init(bytes: Uint8Array): boolean;
  startTranscoding(): boolean;
  transcodeImageLevel(options: { format: number; level: number; layer: number; face: number }): { data: ArrayBuffer; width: number; height: number } | null;
}

interface BasisInstance {
  createKTX2Transcoder(): BasisTranscoder;
}

interface BasisModule {
  BasisUniversal: { getInstance(factory: (imports: unknown) => Promise<unknown>): Promise<BasisInstance> };
  TranscoderTextureFormat: { cTFRGBA32: number };
}

interface RiveRuntime {
  Rive: new (options: Record<string, unknown>) => {
    resizeDrawingSurfaceToCanvas(): void;
    cleanup(): void;
  };
  Layout: new (options: Record<string, unknown>) => unknown;
  Fit: { Contain: unknown };
  Alignment: { Center: unknown };
}

interface AssetManifest {
  bundles?: Array<{ assets?: Array<{ alias?: string[]; src?: string[] }> }>;
}

const TRANSCODER_URL = 'https://unpkg.com/@h00w/basis-universal-transcoder?module';
const RIVE_RUNTIME_URL = 'https://unpkg.com/@rive-app/canvas-single@2.38.5/rive.js';

const DECOR_IDS = Object.keys(__DECOR_CATALOG__);

const SHOP_SPRITE_GROUPS: Record<string, string[]> = {
  decor: DECOR_IDS,
  seed: [
    'Carrot', 'Cabbage', 'Strawberry', 'Aloe', 'Beet', 'FavaBean', 'Blueberry', 'Apple', 'OrangeTulip', 'Tomato',
    'Daffodil', 'Corn', 'Watermelon', 'Pumpkin', 'Echeveria', 'Pear', 'Gentian', 'Coconut', 'Banana', 'Lily', 'Camellia',
    'Peach', 'BurrosTail', 'Mushroom', 'Cactus', 'Bamboo', 'VioletCort', 'Chrysanthemum', 'Grape', 'Pepper', 'Lemon',
    'PassionFruit', 'DragonFruit', 'Cacao', 'Lychee', 'Sunflower', 'Starweaver', 'DawnCelestial', 'MoonCelestial', 'Daisy',
    'Lavender', 'Saffron', 'Eggplant', 'Ube', 'Dawnbreaker', 'Snowdrop', 'PineTree', 'Leek', 'Squash', 'Poinsettia',
    'Cattail', 'Cardoon', 'PricklyPear', 'Milkcap', 'ThunderCelestial',
  ],
  egg: ['CommonEgg', 'UncommonEgg', 'RareEgg', 'LegendaryEgg', 'HorseEgg', 'MythicalEgg', 'DawnEgg', 'SnowEgg', 'ThunderEgg'],
  tool: ['PlanterPot', 'WateringCan', 'CropCleanser', 'XPPotion', 'ReplenishPotion', 'ChilledPotion', 'FrozenPotion'],
};

function shopSpriteCandidates(group: string, itemId: string): string[] {
  if (itemId === 'OrangeTulip') return ['sprite/seed/Tulip', 'sprite/plant/Tulip'];
  if (itemId === 'WoodBirdhouse') return ['sprite/decor/Birdhouse'];
  if (itemId === 'SnowEgg') return ['sprite/pet/SnowEgg', 'sprite/pet/WinterEgg'];
  if (group === 'seed') return [`sprite/seed/${itemId}`, `sprite/plant/${itemId}`];
  if (group === 'egg') return [`sprite/pet/${itemId}`];
  if (group === 'tool') return [`sprite/item/${itemId}`, `sprite/tool/${itemId}`];
  const decorSprite = __DECOR_CATALOG__[itemId]?.sprite;
  return [...(decorSprite ? [`sprite/decor/${decorSprite}`] : []), `sprite/decor/${itemId}`];
}

// Mutation badge icons, the same art the game shows on a crop card.
const MUTATION_ICON_CANDIDATES = Object.fromEntries(Object.entries(__MUTATION_CATALOG__)
  .map(([id, mutation]) => [id, `sprite/ui/Mutation${mutation.sprite}`]));

const EMBLEM_ICON_SPRITES: Record<string, string> = {
  rainbow: 'MutationRainbow', gold: 'MutationGold', thunder: 'MutationThundercharged',
  dawn: 'MutationDawnlit', amber: 'MutationAmberlit', wet: 'MutationWet',
  chilled: 'MutationChilled', frozen: 'MutationFrozen', coin: 'Coin', egg: 'EggsRestocked',
};

function produceSpriteCandidates(species: string): string[] {
  const cropSprite = __PLANT_CATALOG__[species]?.crop?.sprite;
  return [...(cropSprite ? [`sprite/plant/${cropSprite}`] : []), `sprite/plant/${species}`, `sprite/seed/${species}`];
}

function normaliseKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9/]/g, '');
}

async function detectAssetsBase(): Promise<string | null> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const sources = [
      ...Array.from(document.scripts).map(script => script.src),
      ...Array.from(document.querySelectorAll<HTMLLinkElement>('link[href]')).map(link => link.href),
    ];
    for (const source of sources) {
      const match = source.match(/\/version\/([^/]+)\//);
      if (match?.[1]) return `https://magicgarden.gg/version/${match[1]}/assets/`;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return null;
}

async function assetSources(assetsBase: string): Promise<{ atlasPaths: string[]; petRiveUrl: string | null }> {
  try {
    const response = await fetch(`${assetsBase}manifest.json`);
    if (!response.ok) return { atlasPaths: [], petRiveUrl: null };
    const manifest = await response.json() as AssetManifest;
    const paths = new Set<string>();
    let petRiveUrl: string | null = null;
    for (const bundle of manifest.bundles ?? []) {
      for (const asset of bundle.assets ?? []) {
        for (const source of asset.src ?? []) {
          if (source.startsWith('atlases/') && source.endsWith('.json')) paths.add(source);
          if (asset.alias?.some(alias => alias === 'rive/pets.riv' || alias === 'rive/pets')) {
            petRiveUrl = new URL(source, assetsBase).href;
          }
        }
      }
    }
    return { atlasPaths: [...paths], petRiveUrl };
  } catch {
    return { atlasPaths: [], petRiveUrl: null };
  }
}

let riveRuntimePromise: Promise<RiveRuntime> | null = null;

function riveRuntime(): Promise<RiveRuntime> {
  const existing = (window as unknown as { rive?: RiveRuntime }).rive;
  if (existing?.Rive) return Promise.resolve(existing);
  if (riveRuntimePromise) return riveRuntimePromise;
  riveRuntimePromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = RIVE_RUNTIME_URL;
    script.onload = () => {
      const runtime = (window as unknown as { rive?: RiveRuntime }).rive;
      runtime?.Rive ? resolve(runtime) : reject(new Error('Rive runtime did not initialise.'));
    };
    script.onerror = () => reject(new Error('Rive runtime could not be loaded.'));
    (document.head || document.documentElement).appendChild(script);
  });
  return riveRuntimePromise;
}

function imageFromDataUrl(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Rendered pet image could not be read.'));
    image.src = source;
  });
}

async function trimTransparentImage(source: string): Promise<string> {
  const image = await imageFromDataUrl(source);
  const scan = document.createElement('canvas');
  scan.width = image.naturalWidth;
  scan.height = image.naturalHeight;
  const context = scan.getContext('2d');
  if (!context) return source;
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, scan.width, scan.height).data;
  let minX = scan.width;
  let minY = scan.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < scan.height; y++) {
    for (let x = 0; x < scan.width; x++) {
      if (pixels[(y * scan.width + x) * 4 + 3] < 8) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX || maxY < minY) return source;
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const padding = Math.max(4, Math.ceil(Math.max(width, height) * 0.06));
  const size = Math.max(width, height) + padding * 2;
  const output = document.createElement('canvas');
  output.width = size;
  output.height = size;
  output.getContext('2d')?.drawImage(scan, minX, minY, width, height, (size - width) / 2, (size - height) / 2, width, height);
  return output.toDataURL('image/png');
}

async function renderRivePet(runtime: RiveRuntime, buffer: ArrayBuffer, species: string): Promise<string | null> {
  const canvas = document.createElement('canvas');
  canvas.width = 360;
  canvas.height = 510;
  canvas.style.cssText = 'position:fixed;left:-10000px;top:0;width:180px;height:255px;opacity:0;pointer-events:none';
  (document.body || document.documentElement).appendChild(canvas);
  return new Promise(resolve => {
    let settled = false;
    let instance: InstanceType<RiveRuntime['Rive']> | null = null;
    const finish = async (source: string | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      try { instance?.cleanup(); } catch {}
      canvas.remove();
      if (!source) return resolve(null);
      try { resolve(await trimTransparentImage(source)); }
      catch { resolve(source); }
    };
    const timeout = window.setTimeout(() => void finish(null), 4_000);
    try {
      instance = new runtime.Rive({
        buffer: buffer.slice(0),
        canvas,
        artboard: species,
        stateMachines: 'Pet State Machine',
        autoplay: true,
        layout: new runtime.Layout({ fit: runtime.Fit.Contain, alignment: runtime.Alignment.Center }),
        onLoad: () => {
          instance?.resizeDrawingSurfaceToCanvas();
          window.setTimeout(() => void finish(canvas.toDataURL('image/png')), 100);
        },
        onLoadError: () => void finish(null),
      });
    } catch {
      void finish(null);
    }
  });
}

async function loadRivePetFrames(url: string, species: string[]): Promise<Map<string, string>> {
  const [runtime, response] = await Promise.all([riveRuntime(), fetch(url)]);
  if (!response.ok) throw new Error('Pet animation file could not be loaded.');
  const buffer = await response.arrayBuffer();
  const frames = new Map<string, string>();
  for (const name of species) {
    const image = await renderRivePet(runtime, buffer, name);
    if (image) frames.set(normaliseKey(`sprite/pet/${name}`), image);
  }
  return frames;
}

async function basisDecoder(): Promise<{ basis: BasisInstance; rgbaFormat: number }> {
  const binary = atob(__PET_WASM_B64__.replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  const module = await import(TRANSCODER_URL) as BasisModule;
  const basis = await module.BasisUniversal.getInstance(imports => WebAssembly.instantiate(bytes.buffer, imports as WebAssembly.Imports));
  return { basis, rgbaFormat: module.TranscoderTextureFormat.cTFRGBA32 };
}

async function decodeSheet(url: string, basis: BasisInstance, rgbaFormat: number): Promise<HTMLCanvasElement | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const transcoder = basis.createKTX2Transcoder();
    if (!transcoder.init(new Uint8Array(await response.arrayBuffer())) || !transcoder.startTranscoding()) return null;
    const decoded = transcoder.transcodeImageLevel({ format: rgbaFormat, level: 0, layer: 0, face: 0 });
    if (!decoded) return null;
    const canvas = document.createElement('canvas');
    canvas.width = decoded.width;
    canvas.height = decoded.height;
    canvas.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(decoded.data), decoded.width, decoded.height), 0, 0);
    return canvas;
  } catch {
    return null;
  }
}

function cropFrames(atlas: AtlasJson, sheet: HTMLCanvasElement, wanted: Set<string>, output: Map<string, string>, trimmed = false): void {
  for (const [name, descriptor] of Object.entries(atlas.frames ?? {})) {
    const key = normaliseKey(name);
    if (!wanted.has(key) || output.has(key)) continue;
    const frame = descriptor.frame;
    const trim = trimmed ? { x: 0, y: 0, w: frame.w, h: frame.h } : null;
    const placement = trim ?? descriptor.spriteSourceSize ?? { x: 0, y: 0, w: frame.w, h: frame.h };
    const source = trim ?? descriptor.sourceSize ?? { w: placement.x + frame.w, h: placement.y + frame.h };
    const canvas = document.createElement('canvas');
    canvas.width = source.w;
    canvas.height = source.h;
    const context = canvas.getContext('2d');
    if (!context) continue;
    context.imageSmoothingEnabled = false;
    if (descriptor.rotated) {
      context.save();
      context.translate(placement.x + frame.w / 2, placement.y + frame.h / 2);
      context.rotate(-Math.PI / 2);
      context.drawImage(sheet, frame.x, frame.y, frame.h, frame.w, -frame.h / 2, -frame.w / 2, frame.h, frame.w);
      context.restore();
    } else {
      context.drawImage(sheet, frame.x, frame.y, frame.w, frame.h, placement.x, placement.y, frame.w, frame.h);
    }
    output.set(key, canvas.toDataURL('image/png'));
  }
}

async function loadPetFrames(assetsBase: string, initialPaths: string[], wanted: Set<string>, trimmedWanted: Set<string>): Promise<{ frames: Map<string, string>; trimmed: Map<string, string> }> {
  const output = new Map<string, string>();
  const trimmedOutput = new Map<string, string>();
  const pending = new Set(initialPaths);
  const seen = new Set<string>();
  const { basis, rgbaFormat } = await basisDecoder();
  while (pending.size && (output.size < wanted.size || trimmedOutput.size < trimmedWanted.size)) {
    const jsonPath = pending.values().next().value as string;
    pending.delete(jsonPath);
    if (seen.has(jsonPath)) continue;
    seen.add(jsonPath);
    try {
      const jsonUrl = `${assetsBase}${jsonPath}`;
      const response = await fetch(jsonUrl);
      if (!response.ok) continue;
      const atlas = await response.json() as AtlasJson;
      const imageUrl = atlas.meta?.image ? new URL(atlas.meta.image, jsonUrl).href : jsonUrl.replace(/\.json$/, '.ktx2');
      const sheet = await decodeSheet(imageUrl, basis, rgbaFormat);
      if (sheet) {
        cropFrames(atlas, sheet, wanted, output);
        cropFrames(atlas, sheet, trimmedWanted, trimmedOutput, true);
      }
      for (const related of atlas.meta?.related_multi_packs ?? []) {
        const relatedPath = jsonPath.replace(/[^/]+$/, '') + related.replace(/\.json$/, '') + '.json';
        if (!seen.has(relatedPath)) pending.add(relatedPath);
      }
    } catch {}
  }
  return { frames: output, trimmed: trimmedOutput };
}

export async function initPetSprites(): Promise<void> {
  const page = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window) as unknown as CompanionPage;
  const assetsBase = await detectAssetsBase();
  if (!assetsBase) return;
  const { atlasPaths: paths, petRiveUrl } = await assetSources(assetsBase);
  if (!paths.length && !petRiveUrl) return;
  const species = Object.keys(__PET_CATALOG__);
  const shopCandidates = Object.fromEntries(Object.entries(SHOP_SPRITE_GROUPS).flatMap(([group, itemIds]) =>
    itemIds.map(itemId => [itemId, shopSpriteCandidates(group, itemId)]),
  ));
  const produceCandidates = Object.fromEntries(Object.keys(__PLANT_CATALOG__).map(name => [name, produceSpriteCandidates(name)]));
  const decorIds = new Set(SHOP_SPRITE_GROUPS.decor);
  const wanted = new Set([
    ...species.map(name => normaliseKey(`sprite/pet/${name}`)),
    ...Object.entries(shopCandidates).filter(([itemId]) => !decorIds.has(itemId)).flatMap(([, candidates]) => candidates).map(normaliseKey),
  ]);
  const emblemCandidates = Object.fromEntries(Object.entries(EMBLEM_ICON_SPRITES).map(([icon, name]) => [icon, `sprite/ui/${name}`]));
  const trimmedWanted = new Set([
    ...Object.values(produceCandidates).flat().map(normaliseKey),
    ...Object.values(emblemCandidates).map(normaliseKey),
    ...Object.values(MUTATION_ICON_CANDIDATES).map(normaliseKey),
    ...Object.entries(shopCandidates).filter(([itemId]) => decorIds.has(itemId)).flatMap(([, candidates]) => candidates).map(normaliseKey),
  ]);
  try {
    const atlasResult = paths.length
      ? await loadPetFrames(assetsBase, paths, wanted, trimmedWanted)
      : { frames: new Map<string, string>(), trimmed: new Map<string, string>() };
    const { frames, trimmed } = atlasResult;
    if (petRiveUrl) {
      try {
        const riveFrames = await loadRivePetFrames(petRiveUrl, species);
        for (const [key, image] of riveFrames) frames.set(key, image);
      } catch (error) {
        console.warn('[Garden Companion] Current pet animations could not be rendered.', error);
      }
    }
    page.__gardenCompanionPetSprites = Object.fromEntries(species.flatMap(name => {
      const image = frames.get(normaliseKey(`sprite/pet/${name}`));
      return image ? [[name, image]] : [];
    }));
    page.__gardenCompanionShopSprites = Object.fromEntries(Object.entries(shopCandidates).flatMap(([itemId, candidates]) => {
      const source = decorIds.has(itemId) ? trimmed : frames;
      const image = candidates.map(normaliseKey).map(key => source.get(key)).find(Boolean);
      return image ? [[itemId, image]] : [];
    }));
    page.__gardenCompanionProduceSprites = Object.fromEntries(Object.entries(produceCandidates).flatMap(([name, candidates]) => {
      const image = candidates.map(normaliseKey).map(key => trimmed.get(key)).find(Boolean);
      return image ? [[name, image]] : [];
    }));
    page.__gardenCompanionEmblemSprites = Object.fromEntries(Object.entries(emblemCandidates).flatMap(([icon, candidate]) => {
      const image = trimmed.get(normaliseKey(candidate));
      return image ? [[icon, image]] : [];
    }));
    page.__gardenCompanionMutationSprites = Object.fromEntries(Object.entries(MUTATION_ICON_CANDIDATES).flatMap(([id, candidate]) => {
      const image = trimmed.get(normaliseKey(candidate));
      return image ? [[id, image]] : [];
    }));
    page.__gardenCompanionPetSpritesReady?.();
  } catch (error) {
    console.warn('[Garden Companion] Pet sprites could not be loaded.', error);
  }
}
