import { page } from '../page.js';
import { makeDraggable } from '../draggable.js';
import { createWorldScene, readyImage, type WorldBounds, type WorldGeometry } from '../world-scene.js';
import { PLANT_CATALOG } from '../constants.js';
import { escapeHtml, loadLocal, saveLocal } from '../utils.js';

/**
 * A lane defence minigame played on the player's own farm tiles. Like fishing it never talks to the
 * game: no plant is placed, nothing is spent, and the only state that survives a reload is a local
 * high score. The garden is hidden and redrawn as a lawn by the shared world scene, so closing the
 * panel always puts the real garden back exactly as it was.
 */

const PANEL_ID = 'gc-garden-defence';
const RECORD_KEY = 'gardenDefence.record';
const POSITION_KEY = 'gardenDefence.position';

/** Classic five lanes and nine columns, trimmed to whatever the farm can actually fit. */
const MAX_LANES = 5;
const MAX_COLUMNS = 9;
const STARTING_SUN = 50;
/** Sky sun is the trickle that keeps a stalled board alive; sunflowers are the real economy. */
const SKY_SUN_INTERVAL = 11;
const SUN_VALUE = 25;
const SUN_LIFETIME = 14;
const FIRST_WAVE_DELAY = 18;
const WAVE_INTERVAL = 26;

type PlantKind = 'shooter' | 'producer' | 'wall';

interface PlantDef {
  /** Matches the game's own plant id, so the real crop sprite can be used for the tower. */
  id: string;
  name: string;
  kind: PlantKind;
  cost: number;
  hp: number;
  detail: string;
  /** Most towers read best as their crop; some only look like themselves as the growing plant. */
  art?: 'crop' | 'plant';
  /**
   * Draws the crop over the plant, for towers whose fruit is the recognisable half. It is hung on
   * the game's own slot offset for that plant, so only the size is ours to choose.
   */
  fruit?: { scale: number };
  /** Seconds between shots or sun. */
  interval?: number;
  damage?: number;
  /** Columns travelled per second. */
  shotSpeed?: number;
  /** Fraction of normal speed a hit pest is slowed to, for one slowDuration. */
  slow?: number;
  slowDuration?: number;
  /** How many pests one shot passes through before it is spent. */
  pierce?: number;
  /** Splash radius in columns. */
  splash?: number;
  /** Shots fired per volley. */
  volley?: number;
  sun?: number;
}

/**
 * Every tower is a real Magic Garden plant, picked so the game's own crop sprite reads as the role:
 * a sunflower makes sun, a starweaver snares, a pumpkin is the thing you hide behind.
 */
const PLANTS: PlantDef[] = [
  { id: 'Sunflower', name: 'Sunflower', kind: 'producer', cost: 50, hp: 120, interval: 14, sun: SUN_VALUE, detail: 'Makes 25 sun every 14s.' },
  { id: 'Saffron', name: 'Saffron', kind: 'shooter', cost: 100, hp: 140, interval: 1.4, damage: 22, shotSpeed: 5.5, detail: 'Fires a thread down its lane.' },
  { id: 'Pumpkin', name: 'Pumpkin', kind: 'wall', cost: 50, hp: 900, detail: 'Soaks damage. Does not attack.' },
  { id: 'Cactus', name: 'Cactus', kind: 'shooter', cost: 125, hp: 140, interval: 1.6, damage: 20, shotSpeed: 6.5, pierce: 3, detail: 'Spines pass through three pests.' },
  { id: 'Starweaver', name: 'Starweaver', kind: 'shooter', cost: 175, hp: 140, interval: 1.5, damage: 18, shotSpeed: 5.5, slow: .45, slowDuration: 4, art: 'plant', fruit: { scale: .5 }, detail: 'Snares what it hits to half speed.' },
  { id: 'Cardoon', name: 'Cardoon', kind: 'shooter', cost: 200, hp: 140, interval: 1.5, damage: 20, shotSpeed: 5.5, volley: 3, detail: 'Throws three barbs a volley.' },
  { id: 'Milkcap', name: 'Milkcap', kind: 'shooter', cost: 300, hp: 160, interval: 2.6, damage: 42, shotSpeed: 3.4, splash: 1.1, detail: 'Lobs a cap that bursts on impact.' },
];
const PLANT_BY_ID = new Map(PLANTS.map(plant => [plant.id, plant]));

interface PestDef {
  id: string;
  name: string;
  hp: number;
  /** Columns crossed per second. */
  speed: number;
  /** Damage per second dealt to whatever it is eating. */
  bite: number;
  /** Multiplies the Worm sprite so the tiers read apart at a glance. */
  colour: number;
  /** Cycles the tint through the hue wheel instead, for the rare tier. */
  rainbow?: boolean;
  size: number;
  /** Relative spawn weight, before the wave ramp. */
  weight: number;
  /** Waves before this pest starts appearing. */
  from: number;
}

/**
 * Every pest is the game's own Worm sprite, tinted and scaled per tier. Using real art rather than
 * drawn shapes keeps the board looking like the game it is played on, and the tint is what tells a
 * fat slow worm apart from a fast thin one.
 */
const PEST_SPECIES = 'Worm';
const PESTS: PestDef[] = [
  { id: 'worm', name: 'Worm', hp: 100, speed: .17, bite: 46, colour: 0xf0a8a0, size: .34, weight: 60, from: 1 },
  { id: 'wriggler', name: 'Wriggler', hp: 70, speed: .34, bite: 38, colour: 0xbde36f, size: .28, weight: 22, from: 2 },
  { id: 'huskworm', name: 'Husk Worm', hp: 240, speed: .13, bite: 58, colour: 0xffcf4d, size: .40, weight: 26, from: 3 },
  { id: 'bloatworm', name: 'Bloat Worm', hp: 460, speed: .085, bite: 70, colour: 0xc79bd8, rainbow: true, size: .48, weight: 16, from: 5 },
];

interface Plant { def: PlantDef; lane: number; column: number; hp: number; timer: number; sprite: Record<string, any> | null; fruitSprite: Record<string, any> | null }
/** maxHp is captured at spawn: the wave ramp moves on, and a health bar must not move with it. */
interface Pest { def: PestDef; lane: number; x: number; hp: number; maxHp: number; slowUntil: number; eating: Plant | null; sprite: Record<string, any> | null }
interface Shot { lane: number; x: number; speed: number; damage: number; slow?: number; slowDuration?: number; pierce: number; splash: number; hit: Set<Pest> }
interface Sun { x: number; y: number; targetY: number; value: number; expires: number }
interface Record_ { best: number; runs: number; sun: number }

const EMPTY_RECORD: Record_ = { best: 0, runs: 0, sun: 0 };

function loadRecord(): Record_ {
  const stored = loadLocal<Partial<Record_>>(RECORD_KEY, {});
  const positive = (value: unknown) => {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
  };
  return { best: positive(stored.best), runs: positive(stored.runs), sun: positive(stored.sun) };
}

/** The harvested crop, whatever the tower's own art is set to. */
function cropSpriteSource(def: PlantDef): string {
  return page.__gardenCompanionProduceSprites?.[def.id] || page.__gardenCompanionShopSprites?.[def.id] || '';
}

function towerSpriteSource(def: PlantDef): string {
  const plant = page.__gardenCompanionPlantSprites?.[def.id];
  if (def.art === 'plant' && plant) return plant;
  return page.__gardenCompanionProduceSprites?.[def.id] || plant || page.__gardenCompanionShopSprites?.[def.id] || '';
}

/**
 * A sprite tint is one multiply colour, so a true left-to-right rainbow would need a custom shader.
 * Cycling the hue instead reads as rainbow in motion and costs nothing beyond the tint already set.
 */
function hueTint(hue: number, saturation = .85, lightness = .66): number {
  const channel = (offset: number) => {
    const k = (offset + hue * 12) % 12;
    const a = saturation * Math.min(lightness, 1 - lightness);
    return Math.round(255 * (lightness - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return (channel(0) << 16) | (channel(8) << 8) | channel(4);
}

function weightedPest(wave: number): PestDef {
  const pool = PESTS.filter(pest => wave >= pest.from);
  const total = pool.reduce((sum, pest) => sum + pest.weight, 0);
  let roll = Math.random() * total;
  for (const pest of pool) {
    roll -= pest.weight;
    if (roll <= 0) return pest;
  }
  return pool[0] ?? PESTS[0];
}

function injectStyles(): void {
  if (document.getElementById(`${PANEL_ID}-styles`)) return;
  const style = document.createElement('style');
  style.id = `${PANEL_ID}-styles`;
  style.textContent = `
    #${PANEL_ID}{position:fixed;inset:0;z-index:999993;pointer-events:none;color:var(--gc-text,#e4e4e7);font:12px/1.45 system-ui,sans-serif}
    #${PANEL_ID}[hidden]{display:none}
    #${PANEL_ID} .gd-card{position:fixed;right:14px;bottom:56px;width:min(430px,calc(100vw - 24px));display:flex;flex-direction:column;overflow:hidden;pointer-events:auto;user-select:none;touch-action:none;border:1px solid var(--gc-line,rgba(255,255,255,.075));border-radius:12px;background:var(--gc-bg,#0c0c11);box-shadow:0 18px 50px rgba(0,0,0,.7),inset 0 1px rgba(255,255,255,.035)}
    #${PANEL_ID} header{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;color:#fafafa;background:linear-gradient(180deg,rgba(255,255,255,.035),transparent);border-bottom:1px solid var(--gc-line,rgba(255,255,255,.075));cursor:move}
    #${PANEL_ID} h2{margin:0;font:700 13px/1.2 system-ui,sans-serif;letter-spacing:.02em}
    #${PANEL_ID} button{padding:5px 9px;border:1px solid var(--gc-line,rgba(255,255,255,.075));border-radius:7px;color:var(--gc-text,#e4e4e7);background:var(--gc-soft,rgba(255,255,255,.035));font:600 11px system-ui,sans-serif;cursor:pointer}
    #${PANEL_ID} button:disabled{opacity:.4;cursor:default}
    #${PANEL_ID} header button{width:26px;min-width:26px;height:26px;padding:0;border-radius:7px;color:var(--gc-muted,rgba(255,255,255,.72));font-size:12px}
    #${PANEL_ID} header button[data-close]{border-radius:50%;background:transparent}
    #${PANEL_ID} .gd-lawn-input{position:fixed;pointer-events:auto;touch-action:none;cursor:crosshair}
    #${PANEL_ID} .gd-body{padding:10px 12px 12px}
    #${PANEL_ID} .gd-top{display:flex;align-items:center;gap:8px;margin-bottom:9px}
    #${PANEL_ID} .gd-sun{display:flex;align-items:center;gap:5px;padding:4px 9px;border:1px solid rgba(251,191,36,.4);border-radius:8px;background:rgba(251,191,36,.12);color:#fde68a;font:800 13px system-ui,sans-serif}
    #${PANEL_ID} .gd-wave{color:var(--gc-muted,rgba(255,255,255,.72));font-size:10px}
    #${PANEL_ID} .gd-top div:last-child{margin-left:auto;display:flex;gap:5px}
    #${PANEL_ID} .gd-seeds{display:grid;grid-template-columns:repeat(auto-fill,minmax(62px,1fr));gap:5px}
    #${PANEL_ID} .gd-seed{display:flex;flex-direction:column;align-items:center;gap:2px;padding:5px 3px;border:1px solid var(--gc-line,rgba(255,255,255,.075));border-radius:8px;background:var(--gc-soft,rgba(255,255,255,.035));cursor:pointer}
    #${PANEL_ID} .gd-seed[data-selected=true]{border-color:rgba(167,139,250,.65);background:rgba(167,139,250,.16)}
    #${PANEL_ID} .gd-seed[data-afford=false]{opacity:.42;cursor:default}
    #${PANEL_ID} .gd-seed img{width:26px;height:26px;object-fit:contain;image-rendering:auto}
    #${PANEL_ID} .gd-seed b{color:#f8fafc;font:700 9px system-ui,sans-serif;text-align:center;line-height:1.15}
    #${PANEL_ID} .gd-seed small{color:#fde68a;font:700 9px system-ui,sans-serif}
    #${PANEL_ID} .gd-seed i{display:block;width:100%;height:2px;border-radius:1px;background:rgba(255,255,255,.1)}
    #${PANEL_ID} .gd-dev{margin-top:9px;padding:8px 9px;border:1px dashed rgba(167,139,250,.5);border-radius:9px;background:rgba(167,139,250,.08)}
    #${PANEL_ID} .gd-dev > b{display:block;margin-bottom:6px;color:#ddd6fe;font:800 10px system-ui,sans-serif;text-transform:uppercase;letter-spacing:.08em}
    #${PANEL_ID} .gd-dev-row{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:4px}
    #${PANEL_ID} .gd-dev-row button{font-size:10px;padding:4px 7px}
    #${PANEL_ID} .gd-dev-row button[data-active=true]{color:#ddd6fe;border-color:rgba(167,139,250,.55);background:rgba(167,139,250,.18)}
    #${PANEL_ID} .gd-dev > small{display:block;margin-top:5px;color:var(--gc-muted,rgba(255,255,255,.72));font-size:9px}
    #${PANEL_ID} .gd-status{margin-top:9px;color:var(--gc-muted,rgba(255,255,255,.72));font-size:10px;min-height:14px}
    #${PANEL_ID} .gd-detail{margin-top:3px;color:#c7d2fe;font-size:10px;min-height:13px}
    #${PANEL_ID} .gd-over{margin-bottom:9px;padding:9px 10px;border:1px solid rgba(248,113,113,.4);border-radius:9px;background:rgba(248,113,113,.1)}
    #${PANEL_ID} .gd-over b{display:block;color:#fecaca;font:800 13px system-ui,sans-serif}
    #${PANEL_ID} .gd-over small{display:block;margin-top:3px;color:#e4e4e7;font-size:10px}
  `;
  document.head.appendChild(style);
}

export function initGardenDefence(): void {
  let record = loadRecord();
  let running = false;
  let over = false;
  let sun = STARTING_SUN;
  let wave = 0;
  let waveTimer = FIRST_WAVE_DELAY;
  let skyTimer = SKY_SUN_INTERVAL;
  let queued: PestDef[] = [];
  let spawnTimer = 0;
  let selected: string | null = null;
  let shovel = false;
  /**
   * Tuning mode: towers are free and the waves can be held off, so a single plant can be watched
   * against a single pest. A dev run is never written to the record, the same way a bench fight in
   * fishing is never added to the catch log.
   */
  let dev = false;
  let wavesHeld = false;
  let status = 'Pick a seed, then click a tile to plant it.';
  let lanes = MAX_LANES;
  let columns = MAX_COLUMNS;
  let lawn: WorldBounds | null = null;
  let cellWidth = 0;
  let cellHeight = 0;
  let draggableReady = false;
  let frame: number | null = null;
  let lastTime = 0;
  let chromeAt = 0;

  const plants: Plant[] = [];
  let pests: Pest[] = [];
  let shots: Shot[] = [];
  let suns: Sun[] = [];

  /**
   * The lawn sits to the right of a strip standing in for the house, which is both where the pets
   * are penned and the line the pests must not cross.
   */
  const scene = createWorldScene({
    owner: 'gardenDefence',
    layers: { lawn: -999_000, plantShadow: -998_990, entities: -998_900 },
    onBuild(geometry, built) {
      layOutLawn(geometry);
      const grass = built.layer('lawn');
      if (grass && lawn) drawLawn(grass, geometry, lawn);
      // Sprites are destroyed with the old scene, so everything standing needs a fresh one.
      for (const plant of plants) plant.sprite = plant.fruitSprite = null;
      for (const pest of pests) pest.sprite = null;
    },
    petArea: geometry => ({
      left: geometry.left + 8,
      top: geometry.top + 20,
      width: Math.max(0, houseWidth(geometry) - 40),
      height: Math.max(0, geometry.height - 40),
    }),
  });

  function houseWidth(geometry: WorldGeometry): number {
    return Math.min(190, Math.max(90, geometry.width * .12));
  }

  function layOutLawn(geometry: WorldGeometry): void {
    lanes = Math.max(3, Math.min(MAX_LANES, geometry.rows));
    columns = Math.max(5, Math.min(MAX_COLUMNS, geometry.cols));
    const house = houseWidth(geometry);
    lawn = {
      left: geometry.left + house,
      top: geometry.top,
      width: Math.max(1, geometry.width - house),
      height: geometry.height,
    };
    cellWidth = lawn.width / columns;
    cellHeight = lawn.height / lanes;
  }

  function cellCentreX(column: number): number {
    return (lawn?.left ?? 0) + (column + .5) * cellWidth;
  }

  function laneCentreY(lane: number): number {
    return (lawn?.top ?? 0) + (lane + .5) * cellHeight;
  }

  /** Pest x is measured in columns from the left edge of the lawn, so it survives a farm resize. */
  function pestX(pest: Pest): number {
    return (lawn?.left ?? 0) + pest.x * cellWidth;
  }

  function drawLawn(graphic: Record<string, any>, geometry: WorldGeometry, area: WorldBounds): void {
    graphic.clear();
    graphic.roundRect(geometry.left - 30, geometry.top - 30, geometry.width + 60, geometry.height + 60, 46)
      .fill({ color: 0x2f5d34, alpha: 1 });
    const house = houseWidth(geometry);
    graphic.roundRect(geometry.left - 10, geometry.top - 10, house + 4, geometry.height + 20, 22)
      .fill({ color: 0x6b4a2f, alpha: 1 });
    graphic.roundRect(geometry.left + 6, geometry.top + 6, Math.max(10, house - 28), geometry.height - 12, 16)
      .fill({ color: 0x8a6340, alpha: 1 });
    for (let lane = 0; lane < lanes; lane++) {
      for (let column = 0; column < columns; column++) {
        const dark = (lane + column) % 2 === 0;
        graphic.rect(area.left + column * cellWidth, area.top + lane * cellHeight, cellWidth, cellHeight)
          .fill({ color: dark ? 0x4e8b46 : 0x599a4f, alpha: 1 });
      }
    }
    graphic.rect(area.left, area.top, area.width, area.height)
      .stroke({ color: 0x2f5d34, width: 6, alpha: .6 });
    // The strip the pests walk in from, so the danger side reads at a glance.
    graphic.rect(area.left + area.width, area.top, 26, area.height)
      .fill({ color: 0x7a5230, alpha: .85 });
  }

  function panel(): HTMLElement | null { return document.getElementById(PANEL_ID); }

  function save(): void { saveLocal(RECORD_KEY, record); }

  function reset(): void {
    plants.length = 0;
    pests = [];
    shots = [];
    suns = [];
    scene.clearSprites();
    sun = STARTING_SUN;
    wave = 0;
    waveTimer = FIRST_WAVE_DELAY;
    skyTimer = SKY_SUN_INTERVAL;
    queued = [];
    spawnTimer = 0;
    over = false;
    running = true;
    selected = null;
    shovel = false;
    status = dev ? 'Tuning mode: towers are free.' : 'Pick a seed, then click a tile to plant it.';
    if (!dev) {
      record.runs++;
      save();
    }
  }

  function endRun(): void {
    running = false;
    over = true;
    if (!dev && wave > record.best) {
      record.best = wave;
      save();
    }
    renderChrome();
  }

  function plantAt(lane: number, column: number): Plant | undefined {
    return plants.find(plant => plant.lane === lane && plant.column === column);
  }

  function place(lane: number, column: number): void {
    if (!running || over) return;
    const existing = plantAt(lane, column);
    if (shovel) {
      if (!existing) return;
      removePlant(existing);
      status = `Dug up the ${existing.def.name}.`;
      shovel = false;
      renderChrome();
      return;
    }
    if (!selected) { status = 'Pick a seed first.'; renderChrome(); return; }
    const def = PLANT_BY_ID.get(selected);
    if (!def) return;
    if (existing) { status = 'That tile is already planted.'; renderChrome(); return; }
    if (!dev && sun < def.cost) { status = `Not enough sun for a ${def.name}.`; renderChrome(); return; }
    if (!dev) sun -= def.cost;
    plants.push({ def, lane, column, hp: def.hp, timer: def.interval ?? 0, sprite: null, fruitSprite: null });
    // Keeping the seed selected in dev mode makes filling a lane with one tower a single click each.
    if (!dev) selected = null;
    status = `Planted a ${def.name}.`;
    renderChrome();
  }

  function removePlant(plant: Plant): void {
    const index = plants.indexOf(plant);
    if (index >= 0) plants.splice(index, 1);
    scene.removeSprite(plant.sprite);
    scene.removeSprite(plant.fruitSprite);
    plant.sprite = null;
    plant.fruitSprite = null;
    for (const pest of pests) if (pest.eating === plant) pest.eating = null;
  }

  function collectSunAt(x: number, y: number): boolean {
    const radius = Math.max(26, cellWidth * .34);
    const index = suns.findIndex(token => Math.hypot(token.x - x, token.y - y) <= radius);
    if (index < 0) return false;
    sun += suns[index].value;
    if (!dev) {
      record.sun += suns[index].value;
      save();
    }
    suns.splice(index, 1);
    renderChrome();
    return true;
  }

  function handleLawnClick(clientX: number, clientY: number): void {
    const point = scene.toWorld(clientX, clientY);
    if (!point || !lawn) return;
    if (collectSunAt(point.x, point.y)) return;
    const column = Math.floor((point.x - lawn.left) / cellWidth);
    const lane = Math.floor((point.y - lawn.top) / cellHeight);
    if (column < 0 || column >= columns || lane < 0 || lane >= lanes) return;
    place(lane, column);
  }

  function startWave(): void {
    wave++;
    const count = Math.min(24, 2 + Math.floor(wave * 1.35));
    queued = Array.from({ length: count }, () => weightedPest(wave));
    spawnTimer = 0;
    status = `Wave ${wave} incoming.`;
    renderChrome();
  }

  /** Health scales with the wave so late pests stay threatening without new definitions. */
  function waveHp(def: PestDef): number {
    return Math.round(def.hp * (1 + (Math.max(1, wave) - 1) * .16));
  }

  function spawnPest(def: PestDef, lane = Math.floor(Math.random() * lanes)): void {
    const hp = waveHp(def);
    pests.push({ def, lane, x: columns + .35, hp, maxHp: hp, slowUntil: 0, eating: null, sprite: null });
  }

  function removePest(pest: Pest): void {
    scene.removeSprite(pest.sprite);
    pest.sprite = null;
  }

  function dropSkySun(): void {
    if (!lawn) return;
    const x = lawn.left + Math.random() * lawn.width;
    suns.push({ x, y: lawn.top - 40, targetY: lawn.top + Math.random() * lawn.height, value: SUN_VALUE, expires: 0 });
  }

  function damagePest(pest: Pest, amount: number, now: number, slow?: number, slowDuration?: number): void {
    pest.hp -= amount;
    if (slow && slowDuration) pest.slowUntil = Math.max(pest.slowUntil, now + slowDuration);
  }

  function advance(delta: number, now: number): void {
    if (!running || over || !lawn) return;

    skyTimer -= delta;
    if (skyTimer <= 0) { dropSkySun(); skyTimer = SKY_SUN_INTERVAL; }

    if (!wavesHeld) {
      waveTimer -= delta;
      if (waveTimer <= 0 && !queued.length) { startWave(); waveTimer = WAVE_INTERVAL; }
    }

    if (queued.length) {
      spawnTimer -= delta;
      if (spawnTimer <= 0) {
        spawnPest(queued.shift()!);
        spawnTimer = Math.max(.5, 2.4 - wave * .08);
      }
    }

    for (const token of suns) {
      if (token.y < token.targetY) token.y = Math.min(token.targetY, token.y + 70 * delta);
      else token.expires += delta;
    }
    suns = suns.filter(token => token.expires < SUN_LIFETIME);

    for (const plant of plants) {
      if (plant.def.kind === 'wall') continue;
      plant.timer -= delta;
      if (plant.timer > 0) continue;
      plant.timer = plant.def.interval ?? 1;
      if (plant.def.kind === 'producer') {
        suns.push({
          x: cellCentreX(plant.column),
          y: laneCentreY(plant.lane) - 30,
          targetY: laneCentreY(plant.lane) + 12,
          value: plant.def.sun ?? SUN_VALUE,
          expires: 0,
        });
        continue;
      }
      // Shooters only fire when something in the lane is actually ahead of them.
      const target = pests.some(pest => pest.lane === plant.lane && pest.x > plant.column);
      if (!target) { plant.timer = .2; continue; }
      for (let index = 0; index < (plant.def.volley ?? 1); index++) {
        shots.push({
          lane: plant.lane,
          x: plant.column + .4 + index * .28,
          speed: plant.def.shotSpeed ?? 5,
          damage: plant.def.damage ?? 10,
          slow: plant.def.slow,
          slowDuration: plant.def.slowDuration,
          pierce: plant.def.pierce ?? 1,
          splash: plant.def.splash ?? 0,
          hit: new Set<Pest>(),
        });
      }
    }

    for (const shot of shots) {
      shot.x += shot.speed * delta;
      for (const pest of pests) {
        if (pest.lane !== shot.lane || shot.hit.has(pest) || Math.abs(pest.x - shot.x) > .34) continue;
        shot.hit.add(pest);
        damagePest(pest, shot.damage, now, shot.slow, shot.slowDuration);
        if (shot.splash > 0) {
          for (const other of pests) {
            if (other === pest || other.lane !== shot.lane || Math.abs(other.x - pest.x) > shot.splash) continue;
            damagePest(other, shot.damage * .5, now, shot.slow, shot.slowDuration);
          }
        }
        if (shot.hit.size >= shot.pierce) break;
      }
    }
    shots = shots.filter(shot => shot.x <= columns + .6 && shot.hit.size < shot.pierce);

    for (const pest of pests) {
      const blocker = plants.find(plant => plant.lane === pest.lane && Math.abs(plant.column + .5 - pest.x) < .45);
      pest.eating = blocker ?? null;
      if (blocker) {
        blocker.hp -= pest.def.bite * delta;
        continue;
      }
      const speed = pest.def.speed * (now < pest.slowUntil ? .5 : 1);
      pest.x -= speed * delta;
    }

    for (const plant of [...plants]) if (plant.hp <= 0) removePlant(plant);
    for (const pest of pests) if (pest.hp <= 0) removePest(pest);
    pests = pests.filter(pest => pest.hp > 0);

    if (pests.some(pest => pest.x <= -.3)) endRun();
  }

  function ensurePlantSprites(): void {
    for (const plant of plants) {
      const width = Math.min(cellWidth, cellHeight) * .78;
      const x = cellCentreX(plant.column);
      const base = laneCentreY(plant.lane) + cellHeight * .34;
      // Four z slots per lane leaves room for a fruit above its own plant without reaching the next.
      const zIndex = -998_950 + plant.lane * 4;
      if (!plant.sprite) {
        const image = readyImage(towerSpriteSource(plant.def));
        if (image) plant.sprite = scene.addSprite(image, { x, y: base, width, zIndex });
      }
      // The fruit is a second sprite rather than part of the first, so it can be sized and lifted
      // onto the plant independently of however tall that plant's own art happens to be.
      // Waits for the plant, because the mount point is measured against its drawn height: the
      // game's offsets are fractions of a tile from the plant's centre, not of our cell.
      if (plant.def.fruit && plant.sprite && !plant.fruitSprite) {
        const fruit = readyImage(cropSpriteSource(plant.def));
        const offset = PLANT_CATALOG[plant.def.id]?.slotOffset;
        const height = Number(plant.sprite.height) || width;
        if (fruit) plant.fruitSprite = scene.addSprite(fruit, {
          x: x + (offset?.x ?? 0) * height,
          y: base - height / 2 + (offset?.y ?? 0) * height,
          width: width * plant.def.fruit.scale,
          anchorY: .5,
          zIndex: zIndex + 1,
        });
      }
    }
  }

  function pestSize(pest: Pest): number {
    return Math.min(cellWidth, cellHeight) * pest.def.size * 2.1;
  }

  /**
   * Pests are the Worm sprite rather than drawn shapes, so each one owns a sprite that has to be
   * created late (the atlas loads well after the first frame) and destroyed the moment it dies.
   */
  function updatePestSprites(now: number): void {
    const image = readyImage(page.__gardenCompanionPetSprites?.[PEST_SPECIES]);
    for (const pest of pests) {
      const size = pestSize(pest);
      if (!pest.sprite && image) {
        pest.sprite = scene.addSprite(image, {
          x: pestX(pest),
          y: laneCentreY(pest.lane),
          width: size,
          anchorY: .5,
          zIndex: -998_920 + pest.lane,
        });
        // The worm art faces left; the pests walk left, so it is the default orientation that is
        // wrong for this board and the sprite has to be mirrored back.
        if (pest.sprite?.scale) pest.sprite.scale.x = Math.abs(Number(pest.sprite.scale.x) || 1);
      }
      const sprite = pest.sprite;
      if (!sprite || sprite.destroyed) continue;
      // Eating worms rear up; walking worms bob. Both come from the same wobble.
      const wobble = Math.sin(now * (pest.eating ? 11 : 6) + pest.lane) * size * (pest.eating ? .07 : .045);
      sprite.position.set(pestX(pest), laneCentreY(pest.lane) + wobble);
      // A snare has to stay visible, so the chill tint wins over the rainbow.
      sprite.tint = now < pest.slowUntil ? 0x8ec5e8
        : pest.def.rainbow ? hueTint((now * .34 + pest.lane * .13) % 1)
        : pest.def.colour;
      sprite.zIndex = -998_920 + pest.lane;
    }
  }

  /**
   * The worm itself is a sprite; only what a sprite cannot show is drawn here. The shadow is what
   * stops a tinted worm floating over the grass, and the health bar is the read on a long fight.
   */
  function drawPestOverlay(graphic: Record<string, any>, pest: Pest, now: number): void {
    const x = pestX(pest);
    const y = laneCentreY(pest.lane);
    const size = pestSize(pest) * .5;
    graphic.ellipse(x, y + size * .78, size * .8, size * .2).fill({ color: 0x14351a, alpha: .32 });
    if (pest.eating) {
      // A chewing pulse in front of the head, so a stalled lane is obvious without watching HP.
      const pulse = .55 + .45 * Math.abs(Math.sin(now * 9 + pest.lane));
      graphic.circle(x - size * .78, y, Math.max(3, size * .17 * pulse)).fill({ color: 0xfca5a5, alpha: .85 });
    }
    if (pest.hp < pest.maxHp) {
      const barWidth = size * 1.5;
      const barHeight = Math.max(4, size * .13);
      const top = y - size * 1.05;
      graphic.rect(x - barWidth / 2, top, barWidth, barHeight).fill({ color: 0x0f172a, alpha: .68 });
      graphic.rect(x - barWidth / 2, top, barWidth * Math.max(0, pest.hp / pest.maxHp), barHeight)
        .fill({ color: 0xf87171, alpha: .95 });
    }
  }

  function render(now: number): void {
    const geometry = scene.sync();
    const entities = scene.layer('entities');
    if (!geometry || !lawn || !entities) return;
    ensurePlantSprites();
    updatePestSprites(now / 1000);
    positionLawnInput();
    entities.clear();

    for (const plant of plants) {
      // Plants are sprites, but their health has to be legible without one.
      if (plant.hp >= plant.def.hp) continue;
      const width = Math.min(cellWidth, cellHeight) * .62;
      const x = cellCentreX(plant.column);
      const y = laneCentreY(plant.lane) - cellHeight * .34;
      entities.rect(x - width / 2, y, width, 6).fill({ color: 0x0f172a, alpha: .6 });
      entities.rect(x - width / 2, y, width * Math.max(0, plant.hp / plant.def.hp), 6).fill({ color: 0x4ade80, alpha: .95 });
    }

    for (const shot of shots) {
      const x = (lawn?.left ?? 0) + shot.x * cellWidth;
      const y = laneCentreY(shot.lane) - cellHeight * .06;
      const radius = Math.max(5, Math.min(cellWidth, cellHeight) * (shot.splash > 0 ? .16 : .1));
      entities.circle(x, y, radius).fill({ color: shot.slow ? 0xbae6fd : shot.splash > 0 ? 0xfda4af : 0xbbf7d0, alpha: .95 });
      entities.circle(x, y, radius).stroke({ color: 0x14532d, width: 2, alpha: .5 });
    }

    for (const pest of pests) drawPestOverlay(entities, pest, now / 1000);

    for (const token of suns) {
      const fade = token.expires > SUN_LIFETIME - 3 ? .35 + .65 * Math.max(0, (SUN_LIFETIME - token.expires) / 3) : 1;
      const radius = Math.max(16, cellWidth * .22);
      entities.circle(token.x, token.y, radius * 1.25).fill({ color: 0xfde68a, alpha: .22 * fade });
      entities.circle(token.x, token.y, radius).fill({ color: 0xfbbf24, alpha: .95 * fade });
      entities.circle(token.x - radius * .25, token.y - radius * .3, radius * .3).fill({ color: 0xfffbeb, alpha: .8 * fade });
    }
  }

  function positionLawnInput(): void {
    const input = panel()?.querySelector<HTMLElement>('.gd-lawn-input');
    if (!input) return;
    const rect = lawn ? scene.project(lawn) : null;
    if (!rect) { input.hidden = true; return; }
    input.hidden = false;
    input.style.left = `${rect.left}px`;
    input.style.top = `${rect.top}px`;
    input.style.width = `${rect.width}px`;
    input.style.height = `${rect.height}px`;
  }

  function step(now: number): void {
    const gap = lastTime ? now - lastTime : 16;
    lastTime = now;
    const delta = Math.min(.05, gap / 1000 || 0);
    try {
      advance(delta, now / 1000);
      render(now);
      // The HUD only needs a few updates a second, and rebuilding it every frame kills a click.
      if (now - chromeAt > 250) { chromeAt = now; renderStatus(); }
    } catch (error) {
      scene.fail(error, 'Garden defence could not be drawn.');
    }
    frame = requestAnimationFrame(step);
  }

  function startLoop(): void {
    lastTime = 0;
    if (frame === null) frame = requestAnimationFrame(step);
  }

  function stopLoop(): void {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  }

  function affordable(plant: PlantDef): boolean {
    return running && !over && (dev || sun >= plant.cost);
  }

  function seedsHtml(): string {
    return PLANTS.map(plant => {
      const sprite = towerSpriteSource(plant);
      const afford = affordable(plant);
      const icon = sprite
        ? `<img src="${sprite}" alt="">`
        : `<i style="height:26px;background:none"></i>`;
      return `<button class="gd-seed" data-seed="${plant.id}" data-selected="${selected === plant.id}" data-afford="${afford}" ${afford ? '' : 'disabled'} title="${escapeHtml(plant.detail)}">${icon}<b>${escapeHtml(plant.name)}</b><small>${dev ? 'free' : plant.cost}</small></button>`;
    }).join('');
  }

  function renderStatus(): void {
    const host = panel();
    if (!host || host.hidden) return;
    const sunNode = host.querySelector<HTMLElement>('[data-sun]');
    const waveNode = host.querySelector<HTMLElement>('[data-wave]');
    const statusNode = host.querySelector<HTMLElement>('[data-status]');
    if (sunNode) sunNode.textContent = String(sun);
    if (waveNode) {
      waveNode.textContent = over
        ? `Overrun on wave ${wave}`
        : wave === 0
          ? `First wave in ${Math.max(0, Math.ceil(waveTimer))}s`
          : queued.length ? `Wave ${wave} - ${queued.length} left to arrive` : `Wave ${wave} - next in ${Math.max(0, Math.ceil(waveTimer))}s`;
    }
    if (statusNode) statusNode.textContent = status;
    for (const button of host.querySelectorAll<HTMLButtonElement>('[data-seed]')) {
      const plant = PLANT_BY_ID.get(button.dataset.seed!);
      const afford = Boolean(plant && affordable(plant));
      button.dataset.afford = String(afford);
      button.dataset.selected = String(selected === button.dataset.seed);
      button.disabled = !afford;
    }
  }

  function devHtml(): string {
    if (!dev) return '';
    const spawns = PESTS.map(pest =>
      `<button data-spawn="${pest.id}">${escapeHtml(pest.name)}</button>`).join('');
    return `<div class="gd-dev"><b>Tuning mode</b>` +
      `<div class="gd-dev-row">${spawns}<button data-spawn-lane>Fill a lane</button><button data-clear-pests>Clear pests</button></div>` +
      `<div class="gd-dev-row"><button data-hold data-active="${wavesHeld}">${wavesHeld ? 'Waves held' : 'Hold waves'}</button><button data-next-wave>Next wave</button><button data-add-sun>+500 sun</button><button data-clear-plants>Clear plants</button></div>` +
      `<small>Towers are free and this run is not recorded. Call __gardenCompanionGardenDefenceDev(false) to leave.</small></div>`;
  }

  function renderChrome(): void {
    const host = panel();
    if (!host || host.hidden) return;
    const card = host.querySelector<HTMLElement>('.gd-card');
    if (!card) return;
    const overCard = over
      ? `<div class="gd-over"><b>The garden was overrun</b><small>You held ${wave} wave${wave === 1 ? '' : 's'}.${dev ? ' Tuning runs are not recorded.' : ` Best is ${record.best}.`}</small></div>`
      : '';
    card.innerHTML = `<header><h2>&#127807; Garden Defence</h2><div><button data-close aria-label="Close">&#10005;</button></div></header>` +
      `<div class="gd-body">${overCard}` +
      `<div class="gd-top"><span class="gd-sun">&#9728; <span data-sun>${dev ? '&#8734;' : sun}</span></span><span class="gd-wave" data-wave></span>` +
      `<div><button data-shovel data-active="${shovel}">${shovel ? 'Digging' : 'Shovel'}</button><button data-restart>${over || !running ? 'Start' : 'Restart'}</button></div></div>` +
      `<div class="gd-seeds">${seedsHtml()}</div>` +
      devHtml() +
      `<div class="gd-status" data-status></div>` +
      `<div class="gd-detail">Best wave ${record.best} - runs ${record.runs} - sun collected ${record.sun.toLocaleString()}</div>` +
      `</div>`;
    bindDevButtons(card);
    card.querySelector<HTMLButtonElement>('[data-close]')!.onclick = close;
    card.querySelector<HTMLButtonElement>('[data-restart]')!.onclick = () => { reset(); renderChrome(); };
    card.querySelector<HTMLButtonElement>('[data-shovel]')!.onclick = () => {
      shovel = !shovel;
      if (shovel) selected = null;
      status = shovel ? 'Click a plant to dig it up.' : 'Shovel put away.';
      renderChrome();
    };
    for (const button of card.querySelectorAll<HTMLButtonElement>('[data-seed]')) {
      button.onclick = () => {
        const id = button.dataset.seed!;
        selected = selected === id ? null : id;
        shovel = false;
        const def = PLANT_BY_ID.get(id);
        status = selected && def ? `${def.name}: ${def.detail}` : 'Pick a seed, then click a tile to plant it.';
        renderChrome();
      };
    }
    renderStatus();
  }

  function bindDevButtons(card: HTMLElement): void {
    if (!dev) return;
    for (const button of card.querySelectorAll<HTMLButtonElement>('[data-spawn]')) {
      button.onclick = () => {
        const def = PESTS.find(pest => pest.id === button.dataset.spawn);
        if (!def) return;
        spawnPest(def);
        status = `Spawned a ${def.name}.`;
        renderStatus();
      };
    }
    card.querySelector<HTMLButtonElement>('[data-spawn-lane]')!.onclick = () => {
      const def = PESTS[0];
      for (let lane = 0; lane < lanes; lane++) spawnPest(def, lane);
      status = `Spawned a ${def.name} in all ${lanes} lanes.`;
      renderStatus();
    };
    card.querySelector<HTMLButtonElement>('[data-clear-pests]')!.onclick = () => {
      for (const pest of pests) removePest(pest);
      pests = [];
      queued = [];
      status = 'Cleared every pest.';
      renderStatus();
    };
    card.querySelector<HTMLButtonElement>('[data-clear-plants]')!.onclick = () => {
      for (const plant of [...plants]) removePlant(plant);
      status = 'Cleared the board.';
      renderStatus();
    };
    card.querySelector<HTMLButtonElement>('[data-hold]')!.onclick = () => {
      wavesHeld = !wavesHeld;
      status = wavesHeld ? 'Waves held. Spawn pests by hand.' : 'Waves running again.';
      renderChrome();
    };
    card.querySelector<HTMLButtonElement>('[data-next-wave]')!.onclick = () => {
      startWave();
      waveTimer = WAVE_INTERVAL;
    };
    card.querySelector<HTMLButtonElement>('[data-add-sun]')!.onclick = () => {
      sun += 500;
      renderStatus();
    };
  }

  function open(): void {
    const host = panel();
    if (!host) return;
    host.hidden = false;
    scene.enter();
    if (!running && !over) reset();
    renderChrome();
    if (!draggableReady) {
      const card = host.querySelector<HTMLElement>('.gd-card');
      if (card) {
        makeDraggable(card, POSITION_KEY);
        draggableReady = true;
      }
    }
    startLoop();
  }

  function close(): void {
    const host = panel();
    if (host) host.hidden = true;
    stopLoop();
    scene.exit();
    const input = host?.querySelector<HTMLElement>('.gd-lawn-input');
    if (input) input.hidden = true;
  }

  function mount(): void {
    if (panel()) return;
    injectStyles();
    const host = document.createElement('div');
    host.id = PANEL_ID;
    host.hidden = true;
    host.dataset.gcUi = 'gardenDefence';
    const card = document.createElement('div');
    card.className = 'gd-card';
    const lawnInput = document.createElement('div');
    lawnInput.className = 'gd-lawn-input';
    lawnInput.hidden = true;
    lawnInput.dataset.noDrag = '';
    host.appendChild(lawnInput);
    host.appendChild(card);
    document.body.appendChild(host);
    // Everything inside our surfaces is ours: no click may reach the game beneath and move a plant.
    for (const type of ['pointerdown', 'pointerup', 'pointermove', 'pointercancel', 'mousedown', 'mouseup', 'click', 'dblclick', 'wheel', 'contextmenu']) {
      card.addEventListener(type, event => event.stopPropagation());
      if (type !== 'wheel') lawnInput.addEventListener(type, event => event.stopPropagation());
    }
    lawnInput.onpointerdown = event => {
      event.preventDefault();
      if (event.button !== 0) return;
      handleLawnClick(event.clientX, event.clientY);
    };
    // Zoom still belongs to the game, so the wheel is forwarded rather than swallowed.
    lawnInput.addEventListener('wheel', event => {
      const gameCanvas = document.querySelector<HTMLCanvasElement>('.QuinoaCanvas canvas');
      if (!gameCanvas) return;
      event.preventDefault();
      event.stopPropagation();
      gameCanvas.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        clientX: event.clientX,
        clientY: event.clientY,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaZ: event.deltaZ,
        deltaMode: event.deltaMode,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
      }));
    }, { passive: false });
    page.__gardenCompanionToggleGardenDefence = () => (panel()?.hidden ? open() : close());
    // Published rather than shown, so tuning controls stay out of a normal player's panel.
    page.__gardenCompanionGardenDefenceDev = (enabled = !dev) => {
      dev = enabled;
      if (!dev) wavesHeld = false;
      // Switching modes always starts a clean run: a scored run must not gain free towers, and a
      // tuning run must never be scored. Resetting first leaves open() nothing to reset, so the
      // run counter cannot tick twice.
      reset();
      if (panel()?.hidden !== false) open();
      else renderChrome();
      return dev;
    };
  }

  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
}
