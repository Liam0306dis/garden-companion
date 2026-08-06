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

/** The growing plant rather than its harvested crop, which for some species look nothing alike. */
function plantSpriteCandidates(species: string): string[] {
  const plantSprite = __PLANT_CATALOG__[species]?.plantSprite;
  return plantSprite ? [`sprite/plant/${plantSprite}`] : [];
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

/**
 * Decoded sprites are cached in IndexedDB against the game's asset version. Decoding a few hundred
 * PNGs costs a noticeable chunk of the main thread, and it produces the same bytes every time, so
 * paying it once per game release rather than once per page load is the whole point. A new asset
 * version simply misses the cache and rebuilds.
 *
 * localStorage would be the obvious home and the wrong one: a few hundred PNG data URLs run to many
 * megabytes and would blow its quota.
 */
const CACHE_DB = 'gardenCompanionSprites';
const CACHE_STORE = 'maps';

type SpriteMap = Record<string, string>;
type SpriteBundle = Record<string, SpriteMap>;

function openCache(): Promise<IDBDatabase | null> {
  return new Promise(resolve => {
    try {
      const request = indexedDB.open(CACHE_DB, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(CACHE_STORE)) request.result.createObjectStore(CACHE_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

async function readCache(key: string): Promise<SpriteBundle | null> {
  const db = await openCache();
  if (!db) return null;
  return new Promise(resolve => {
    try {
      const request = db.transaction(CACHE_STORE, 'readonly').objectStore(CACHE_STORE).get(key);
      request.onsuccess = () => resolve((request.result as SpriteBundle) ?? null);
      request.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

/**
 * Writes this fingerprint's bundle and drops every other one's, so the cache cannot grow forever.
 *
 * Eviction only happens when the atlases were actually identified. A load that fell back to the
 * asset version does not know what the artwork is, and letting it sweep would mean one slow request
 * deleted a good bundle and forced a rebuild on the next load as well as its own.
 */
async function writeCache(key: string, value: SpriteBundle, fingerprint: string, evict: boolean): Promise<void> {
  const db = await openCache();
  if (!db) return;
  try {
    const store = db.transaction(CACHE_STORE, 'readwrite').objectStore(CACHE_STORE);
    store.put(value, key);
    if (!evict) return;
    const keys = store.getAllKeys();
    keys.onsuccess = () => {
      for (const existing of keys.result) {
        if (typeof existing === 'string' && !existing.startsWith(`${fingerprint}:`)) store.delete(existing);
      }
    };
  } catch {}
}

/**
 * What the cache is really keyed on. The game ships an update most days, but its sprite atlases
 * change far less often, and their filenames are stable rather than content-hashed - so the asset
 * version says nothing about whether the pixels moved. The server does: a HEAD on each atlas gives
 * an ETag or a last-modified date, and hashing those together identifies the artwork itself. An
 * update that only changes code then reuses every decoded sprite.
 *
 * Falls back to the asset version when the headers are unavailable, which is the old behaviour.
 */
async function atlasFingerprint(assetsBase: string, atlasPaths: string[], version: string): Promise<string> {
  if (!atlasPaths.length) return version;
  // Only the atlas JSON is HEADed: the manifest guarantees that path exists, where the image name
  // lives inside the file. A repack changes both, so the JSON is a faithful stand-in for the sheet.
  const stamp = async (path: string): Promise<string> => {
    const response = await fetch(`${assetsBase}${path}`, { method: 'HEAD' });
    if (!response.ok) return '';
    const etag = response.headers.get('etag') ?? '';
    const modified = response.headers.get('last-modified') ?? '';
    const length = response.headers.get('content-length') ?? '';
    return etag || modified ? `${path}|${etag}|${modified}|${length}` : '';
  };
  try {
    const stamps = await Promise.all([...atlasPaths].sort().map(path => stamp(path).catch(() => '')));
    if (stamps.some(value => !value)) return version;
    return `a${hashText(stamps.join('\n'))}`;
  } catch {
    return version;
  }
}

/**
 * The fingerprint only decides which cache key to look under, so it must never be what keeps
 * sprites off the screen. A slow or hanging request falls back to the asset version and carries on.
 */
function withTimeout(work: Promise<string>, fallback: string, ms: number): Promise<string> {
  let timer = 0;
  return Promise.race([
    work.catch(() => fallback),
    new Promise<string>(resolve => { timer = window.setTimeout(() => resolve(fallback), ms); }),
  ]).finally(() => window.clearTimeout(timer));
}

/** FNV-1a. The fingerprint only has to change when the inputs do, not resist anything. */
function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(36);
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

/**
 * How long a single slice of sprite decoding may hold the main thread. One frame at 60fps is 16ms,
 * so half of that leaves room for the game to keep drawing while sprites are built.
 */
const SLICE_BUDGET_MS = 8;

/**
 * Hands the thread back between slices. `scheduler.postTask` at background priority is the right
 * tool where it exists: it lets anything the player can see go first.
 */
function yieldToBrowser(): Promise<void> {
  return new Promise(resolve => {
    const scheduler = (window as unknown as { scheduler?: { postTask?: (callback: () => void, options?: { priority: string }) => unknown } }).scheduler;
    if (typeof scheduler?.postTask === 'function') scheduler.postTask(() => resolve(), { priority: 'background' });
    else setTimeout(resolve, 0);
  });
}

/**
 * Every sprite is cut from the atlas and encoded to a PNG, and there are a few hundred of them.
 * Encoding is synchronous, so doing the lot in one loop blocks the main thread for well over a
 * second - which lands squarely on the game's own startup. The work is the same either way; slicing
 * it just stops any single burst of it holding a frame.
 */
async function cropFrames(atlas: AtlasJson, sheet: HTMLCanvasElement, wanted: Set<string>, output: Map<string, string>, trimmed = false): Promise<void> {
  let sliceStarted = performance.now();
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
    if (performance.now() - sliceStarted >= SLICE_BUDGET_MS) {
      await yieldToBrowser();
      sliceStarted = performance.now();
    }
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
        await cropFrames(atlas, sheet, wanted, output);
        await cropFrames(atlas, sheet, trimmedWanted, trimmedOutput, true);
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
  const version = assetsBase.match(/\/version\/([^/]+)\//)?.[1] ?? 'unknown';
  const species = Object.keys(__PET_CATALOG__);
  const shopCandidates = Object.fromEntries(Object.entries(SHOP_SPRITE_GROUPS).flatMap(([group, itemIds]) =>
    itemIds.map(itemId => [itemId, shopSpriteCandidates(group, itemId)]),
  ));
  const produceCandidates = Object.fromEntries(Object.keys(__PLANT_CATALOG__).map(name => [name, produceSpriteCandidates(name)]));
  const plantCandidates = Object.fromEntries(Object.keys(__PLANT_CATALOG__).map(name => [name, plantSpriteCandidates(name)]));
  const emblemCandidates = Object.fromEntries(Object.entries(EMBLEM_ICON_SPRITES).map(([icon, name]) => [icon, `sprite/ui/${name}`]));
  const decorIds = new Set(SHOP_SPRITE_GROUPS.decor);

  function pick(candidates: string[], source: Map<string, string>): string | undefined {
    return candidates.map(normaliseKey).map(key => source.get(key)).find(Boolean);
  }

  function mapFrom<T extends string>(entries: Record<T, string[]>, source: Map<string, string>): SpriteMap {
    return Object.fromEntries(Object.entries<string[]>(entries).flatMap(([name, candidates]) => {
      const image = pick(candidates, source);
      return image ? [[name, image]] : [];
    }));
  }

  /** Assigning rather than replacing, so a later stage cannot wipe an earlier one's sprites. */
  function publish(bundle: SpriteBundle): void {
    if (bundle.pet) page.__gardenCompanionPetSprites = { ...page.__gardenCompanionPetSprites, ...bundle.pet };
    if (bundle.produce) page.__gardenCompanionProduceSprites = { ...page.__gardenCompanionProduceSprites, ...bundle.produce };
    if (bundle.shop) page.__gardenCompanionShopSprites = { ...page.__gardenCompanionShopSprites, ...bundle.shop };
    if (bundle.plant) page.__gardenCompanionPlantSprites = { ...page.__gardenCompanionPlantSprites, ...bundle.plant };
    if (bundle.emblem) page.__gardenCompanionEmblemSprites = { ...page.__gardenCompanionEmblemSprites, ...bundle.emblem };
    if (bundle.mutation) page.__gardenCompanionMutationSprites = { ...page.__gardenCompanionMutationSprites, ...bundle.mutation };
    page.__gardenCompanionPetSpritesReady?.();
  }

  let sources: { atlasPaths: string[]; petRiveUrl: string | null } | null = null;
  async function loadSources(): Promise<{ atlasPaths: string[]; petRiveUrl: string | null }> {
    return sources ??= await assetSources(assetsBase!);
  }

  /**
   * Both stages share one fingerprint, so the HEAD requests are made once per page load. `identified`
   * is false when we fell back to the asset version, which is what keeps a degraded load from
   * evicting a bundle it cannot prove is stale.
   */
  let fingerprint: Promise<{ key: string; identified: boolean }> | null = null;
  function loadFingerprint(): Promise<{ key: string; identified: boolean }> {
    return fingerprint ??= (async () => {
      const key = await withTimeout(
        (async () => atlasFingerprint(assetsBase!, (await loadSources()).atlasPaths, version))(),
        version,
        2_000,
      );
      return { key, identified: key !== version };
    })();
  }

  /**
   * Only the player's own pets and the crops they grow are wanted while the game is starting. Shop
   * icons, decor, growing plants and the panel's own iconography are not on screen until a panel is
   * opened, so they are a second stage that nothing pays for unless it is asked for.
   */
  async function decodeEssential(): Promise<SpriteBundle> {
    const { atlasPaths, petRiveUrl } = await loadSources();
    const wanted = new Set(species.map(name => normaliseKey(`sprite/pet/${name}`)));
    const trimmedWanted = new Set(Object.values(produceCandidates).flat().map(normaliseKey));
    const { frames, trimmed } = atlasPaths.length
      ? await loadPetFrames(assetsBase!, atlasPaths, wanted, trimmedWanted)
      : { frames: new Map<string, string>(), trimmed: new Map<string, string>() };
    if (petRiveUrl) {
      try {
        for (const [key, image] of await loadRivePetFrames(petRiveUrl, species)) frames.set(key, image);
      } catch (error) {
        console.warn('[Garden Companion] Current pet animations could not be rendered.', error);
      }
    }
    return {
      pet: Object.fromEntries(species.flatMap(name => {
        const image = frames.get(normaliseKey(`sprite/pet/${name}`));
        return image ? [[name, image]] : [];
      })),
      produce: mapFrom(produceCandidates, trimmed),
    };
  }

  async function decodeDeferred(): Promise<SpriteBundle> {
    const { atlasPaths } = await loadSources();
    const wanted = new Set(Object.entries(shopCandidates)
      .filter(([itemId]) => !decorIds.has(itemId)).flatMap(([, candidates]) => candidates).map(normaliseKey));
    const trimmedWanted = new Set([
      ...Object.values(plantCandidates).flat().map(normaliseKey),
      ...Object.values(emblemCandidates).map(normaliseKey),
      ...Object.values(MUTATION_ICON_CANDIDATES).map(normaliseKey),
      ...Object.entries(shopCandidates).filter(([itemId]) => decorIds.has(itemId)).flatMap(([, candidates]) => candidates).map(normaliseKey),
    ]);
    const { frames, trimmed } = atlasPaths.length
      ? await loadPetFrames(assetsBase!, atlasPaths, wanted, trimmedWanted)
      : { frames: new Map<string, string>(), trimmed: new Map<string, string>() };
    return {
      shop: Object.fromEntries(Object.entries(shopCandidates).flatMap(([itemId, candidates]) => {
        const image = pick(candidates, decorIds.has(itemId) ? trimmed : frames);
        return image ? [[itemId, image]] : [];
      })),
      plant: mapFrom(plantCandidates, trimmed),
      emblem: mapFrom(Object.fromEntries(Object.entries(emblemCandidates).map(([icon, candidate]) => [icon, [candidate]])), trimmed),
      mutation: mapFrom(Object.fromEntries(Object.entries(MUTATION_ICON_CANDIDATES).map(([id, candidate]) => [id, [candidate]])), trimmed),
    };
  }

  const stages: Record<string, () => Promise<SpriteBundle>> = { essential: decodeEssential, deferred: decodeDeferred };
  const running = new Map<string, Promise<void>>();

  function runStage(stage: string): Promise<void> {
    const existing = running.get(stage);
    if (existing) return existing;
    const task = (async () => {
      try {
        const { key: fingerprintKey, identified } = await loadFingerprint();
        const key = `${fingerprintKey}:${stage}`;
        // A cache hit skips the atlas fetch, the transcode and every PNG encode outright.
        const cached = await readCache(key);
        if (cached) { publish(cached); return; }
        const bundle = await stages[stage]();
        publish(bundle);
        void writeCache(key, bundle, fingerprintKey, identified);
      } catch (error) {
        running.delete(stage);
        console.warn(`[Garden Companion] ${stage} sprites could not be loaded.`, error);
      }
    })();
    running.set(stage, task);
    return task;
  }

  page.__gardenCompanionLoadSpriteGroup = (group?: string) => void runStage(group === 'essential' ? 'essential' : 'deferred');
  await runStage('essential');
}
