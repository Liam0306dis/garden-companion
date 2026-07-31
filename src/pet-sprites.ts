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

const TRANSCODER_URL = 'https://unpkg.com/@h00w/basis-universal-transcoder?module';

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

async function atlasPaths(assetsBase: string): Promise<string[]> {
  try {
    const response = await fetch(`${assetsBase}manifest.json`);
    if (!response.ok) return [];
    const manifest = await response.json() as { bundles?: Array<{ assets?: Array<{ src?: string[] }> }> };
    const paths = new Set<string>();
    for (const bundle of manifest.bundles ?? []) {
      for (const asset of bundle.assets ?? []) {
        for (const source of asset.src ?? []) {
          if (source.startsWith('atlases/') && source.endsWith('.json')) paths.add(source);
        }
      }
    }
    return [...paths];
  } catch {
    return [];
  }
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
  const paths = await atlasPaths(assetsBase);
  if (!paths.length) return;
  const species = Object.keys(__PET_CATALOG__);
  const shopCandidates = Object.fromEntries(Object.entries(SHOP_SPRITE_GROUPS).flatMap(([group, itemIds]) =>
    itemIds.map(itemId => [itemId, shopSpriteCandidates(group, itemId)]),
  ));
  const produceCandidates = Object.fromEntries(Object.keys(__PLANT_CATALOG__).map(name => [name, produceSpriteCandidates(name)]));
  const wanted = new Set([
    ...species.map(name => normaliseKey(`sprite/pet/${name}`)),
    ...Object.values(shopCandidates).flat().map(normaliseKey),
  ]);
  const emblemCandidates = Object.fromEntries(Object.entries(EMBLEM_ICON_SPRITES).map(([icon, name]) => [icon, `sprite/ui/${name}`]));
  const trimmedWanted = new Set([
    ...Object.values(produceCandidates).flat().map(normaliseKey),
    ...Object.values(emblemCandidates).map(normaliseKey),
  ]);
  try {
    const { frames, trimmed } = await loadPetFrames(assetsBase, paths, wanted, trimmedWanted);
    page.__gardenCompanionPetSprites = Object.fromEntries(species.flatMap(name => {
      const image = frames.get(normaliseKey(`sprite/pet/${name}`));
      return image ? [[name, image]] : [];
    }));
    page.__gardenCompanionShopSprites = Object.fromEntries(Object.entries(shopCandidates).flatMap(([itemId, candidates]) => {
      const image = candidates.map(normaliseKey).map(key => frames.get(key)).find(Boolean);
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
    page.__gardenCompanionPetSpritesReady?.();
  } catch (error) {
    console.warn('[Garden Companion] Pet sprites could not be loaded.', error);
  }
}
