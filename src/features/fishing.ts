import { page } from '../page.js';
import { state } from '../state.js';
import { makeDraggable } from '../draggable.js';
import { createWorldScene, readyImage, type WorldBounds } from '../world-scene.js';
import { escapeHtml, loadLocal, NUMBER_LOCALE, saveLocal } from '../utils.js';
import { fishingMuted, playBite, playCast, playCatch, playEscape, playReelClick, primeFishingAudio, setFishingMuted } from './fishing-audio.js';

/**
 * A self-contained fishing minigame. It never talks to the game: no rewards are claimed, nothing is
 * sent over the connection, and the catch record lives only in this browser. The one thing it takes
 * from the game is the current weather, which shifts which fish are biting.
 */

const STYLE_ID = 'gc-fishing-style';
const PANEL_ID = 'gc-fishing-panel';
const RECORD_KEY = 'gardenCompanion.fishing.v1';
const POSITION_KEY = 'gardenCompanion.fishingPosition.v1';

type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary' | 'mythic';

interface RarityRule {
  label: string;
  colour: string;
  /** Relative chance of the tier being drawn before weather is taken into account. */
  weight: number;
  /** Height of the hook zone as a fraction of the track. */
  zone: number;
  /** How hard the fish pulls around the track. */
  speed: number;
  /** Progress gained and lost per second while the fish is inside or outside the zone. */
  fill: number;
  drain: number;
}

const RARITIES: Record<Rarity, RarityRule> = {
  common: { label: 'Common', colour: '#94a3b8', weight: 48, zone: .34, speed: .8, fill: .48, drain: .28 },
  uncommon: { label: 'Uncommon', colour: '#34d399', weight: 28, zone: .30, speed: .95, fill: .43, drain: .32 },
  rare: { label: 'Rare', colour: '#38bdf8', weight: 15, zone: .26, speed: 1.1, fill: .38, drain: .37 },
  epic: { label: 'Epic', colour: '#a78bfa', weight: 6, zone: .22, speed: 1.25, fill: .32, drain: .43 },
  legendary: { label: 'Legendary', colour: '#fbbf24', weight: 2.5, zone: .19, speed: 1.42, fill: .27, drain: .48 },
  mythic: { label: 'Mythic', colour: '#f472b6', weight: .5, zone: .15, speed: 1.7, fill: .21, drain: .58 },
};

const RARITY_ORDER: Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];
const WEATHER_FISH_WEIGHT = 2;
const WEATHER_MYTHIC_CHANCE = .015;

/** How long the float stays dipped. Long enough to react to without making the hook automatic. */
const BITE_WINDOW = 1500;
/**
 * Reeling is a stream of clicks, so the click that lands the fish is followed by more. The controls
 * ignore them for this long, otherwise the next cast starts before the catch has been read.
 */
const RESULT_LOCK = 1600;
/**
 * Fill and drain are both scaled by this, so a fight takes longer without becoming easier or
 * harder: the share of time a tier needs the fish inside the zone is the ratio between the two,
 * which a shared multiplier leaves untouched.
 */
const FIGHT_PACE = .5;
/** Where the bar starts, how far below empty it may go before the fish wins, and the hard cap. */
const START_PROGRESS = .2;
const LOSE_FLOOR = -.15;
const REEL_LIMIT = 45000;
/** Rod back-swing then forward whip. The flight lands as the cast splash in the audio plays. */
const CAST_WINDUP = 150;
const CAST_FLIGHT = 210;
/** Far above anything the game assigns, so the pond and rod always sort over the world. */
const WORLD_OVERLAY_Z_INDEX = 0xe8d4a51000;
/**
 * Hook zone control. Friction is what makes this steerable: without it, holding accelerates without
 * bound and the zone can only ever overshoot, so the smaller a zone gets the more it oscillates
 * past the fish. With it, holding settles at a terminal speed and releasing settles at another, so
 * tapping gives every speed in between and the zone can be parked on a fish rather than flung at it.
 */
const ZONE_LIFT = 11.5;
const ZONE_GRAVITY = 4.9;
/** Applied per second, expressed at 60fps. About a 0.14s time constant. */
const ZONE_FRICTION = .89;
/**
 * How hard a fish swims toward the spot it has picked. This is the real difficulty dial: a fish
 * that crosses the track faster than the zone can follow cannot be caught by playing well, only by
 * waiting for it to swim into a zone that happens to be parked.
 */
const FISH_PULL = 4.5;
/** Rate that friction sheds velocity, used to state the resulting terminal speeds on the bench. */
const ZONE_DRAG = -Math.log(ZONE_FRICTION) * 60;

/**
 * The fish speed the zone's own numbers were tuned against. Fixed rather than read from a tier, so
 * that retuning a tier's speed cannot quietly slow down every zone in the game.
 */
const SPEED_BASELINE = .55;

/**
 * How much faster the zone gets on a faster tier. Deliberately softened rather than matched: the
 * control needs to keep pace with the fish, but making it as twitchy as the fish costs more in
 * precision against a small zone than it gains in reach.
 */
function zoneAgility(speed: number): number {
  return 1 + (speed / SPEED_BASELINE - 1) * .6;
}

/**
 * How fast a tier's fish actually travels, in track fractions per second, once its own drag has
 * balanced the pull. Quoted for a fish half a track from where it is heading. This is the number
 * that has to stay under the zone's lift speed for a tier to be beatable by playing well.
 */
function fishTravelSpeed(speed: number): number {
  return .5 * FISH_PULL * speed / (-Math.log(.93) * 60) * 1.6;
}

interface FishDef {
  id: string;
  name: string;
  rarity: Rarity;
  /** Weight range in kilograms. */
  min: number;
  max: number;
  /** The only weather this fish bites in. Unset means it bites in any weather. */
  weather?: string;
  note: string;
}

/** Entirely invented - none of these exist in the game. */
const FISH: FishDef[] = [
  { id: 'pondMinnow', name: 'Pond Minnow', rarity: 'common', min: .1, max: .6, note: 'Travels in crowds and panics alone.' },
  { id: 'muddyBream', name: 'Muddy Bream', rarity: 'common', min: .4, max: 1.8, note: 'Tastes of the bottom it never leaves.' },
  { id: 'reedPerch', name: 'Reed Perch', rarity: 'common', min: .3, max: 1.4, note: 'Hides in the shallows, strikes at anything.' },
  { id: 'gardenGuppy', name: 'Garden Guppy', rarity: 'common', min: .1, max: .4, note: 'Somehow always in the watering can.' },
  { id: 'rainSilverfin', name: 'Rain Silverfin', rarity: 'common', min: .2, max: 1.1, weather: 'Rain', note: 'Rises the moment the first drop lands.' },
  { id: 'copperCarp', name: 'Copper Carp', rarity: 'uncommon', min: 1.2, max: 4.5, note: 'Old enough to have opinions about lures.' },
  { id: 'speckledTrout', name: 'Speckled Trout', rarity: 'uncommon', min: .8, max: 3.2, note: 'Fast, fussy, worth the trouble.' },
  { id: 'glassEel', name: 'Glass Eel', rarity: 'uncommon', min: .5, max: 2.4, note: 'You can read the riverbed through it.' },
  { id: 'mossBass', name: 'Moss Bass', rarity: 'uncommon', min: 1.5, max: 5, note: 'Wears its pond like a coat.' },
  { id: 'puddlePike', name: 'Puddle Pike', rarity: 'uncommon', min: 1.8, max: 6, weather: 'Rain', note: 'Appears in water far too small for it.' },
  { id: 'moonscaleKoi', name: 'Moonscale Koi', rarity: 'rare', min: 3, max: 9, note: 'Every scale holds a slightly different moon.' },
  { id: 'brambleRay', name: 'Bramble Ray', rarity: 'rare', min: 4, max: 12, note: 'Glides like a thrown blanket.' },
  { id: 'ironjawCatfish', name: 'Ironjaw Catfish', rarity: 'rare', min: 6, max: 16, note: 'Has taken three hooks and kept them.' },
  { id: 'lanternCod', name: 'Lantern Cod', rarity: 'rare', min: 3.5, max: 11, weather: 'Dawn', note: 'Carries its own small sunrise.' },
  { id: 'chillbackChar', name: 'Chillback Char', rarity: 'rare', min: 2.5, max: 8, weather: 'Frost', note: 'Warm to the touch, strangely.' },
  { id: 'amberfinTench', name: 'Amberfin Tench', rarity: 'rare', min: 3, max: 10, weather: 'AmberMoon', note: 'Slow, heavy, and the colour of old honey.' },
  { id: 'staticShiner', name: 'Static Shiner', rarity: 'rare', min: 2, max: 7, weather: 'Thunderstorm', note: 'Sets the hairs on your arm up before you see it.' },
  { id: 'mirrorfinArowana', name: 'Mirrorfin Arowana', rarity: 'epic', min: 9, max: 30, note: 'Turns without disturbing the water around it.' },
  { id: 'cloudburstSalmon', name: 'Cloudburst Salmon', rarity: 'epic', min: 10, max: 28, weather: 'Rain', note: 'Swims up the rain itself, given enough of it.' },
  { id: 'stormfinMarlin', name: 'Stormfin Marlin', rarity: 'epic', min: 12, max: 34, weather: 'Thunderstorm', note: 'Runs ahead of the weather front.' },
  { id: 'frostbellySturgeon', name: 'Frostbelly Sturgeon', rarity: 'epic', min: 15, max: 40, weather: 'Frost', note: 'Older than the pond it swims in.' },
  { id: 'dawnlitAngelfish', name: 'Dawnlit Angelfish', rarity: 'epic', min: 8, max: 22, weather: 'Dawn', note: 'Only surfaces while the light is thin.' },
  { id: 'amberscaleTuna', name: 'Amberscale Tuna', rarity: 'epic', min: 18, max: 46, weather: 'AmberMoon', note: 'Set solid in colour, still very much alive.' },
  { id: 'crownscaleArapaima', name: 'Crownscale Arapaima', rarity: 'legendary', min: 28, max: 82, note: 'The smaller fish follow it as if it knows the way.' },
  { id: 'thunderjawGar', name: 'Thunderjaw Gar', rarity: 'legendary', min: 30, max: 75, weather: 'Thunderstorm', note: 'The bite arrives before the fish does.' },
  { id: 'glacierLeviathan', name: 'Glacier Leviathan', rarity: 'legendary', min: 40, max: 95, weather: 'Frost', note: 'Mistaken for the far bank more than once.' },
  { id: 'sunspireSerpent', name: 'Sunspire Serpent', rarity: 'legendary', min: 25, max: 68, weather: 'Dawn', note: 'Coils around the light and holds it there.' },
  { id: 'harvestmoonWels', name: 'Harvestmoon Wels', rarity: 'legendary', min: 35, max: 88, weather: 'AmberMoon', note: 'Comes up once the whole pond has turned the same colour as it.' },
  { id: 'firstLightRay', name: 'First Light Ray', rarity: 'mythic', min: 55, max: 165, weather: 'Dawn', note: 'Seen only in the minute the sky decides on a colour.' },
  { id: 'oldRootmouth', name: 'Old Rootmouth', rarity: 'mythic', min: 60, max: 140, weather: 'AmberMoon', note: 'The garden grew around it, not the other way round.' },
  { id: 'rainbowWhiskerfish', name: 'Rainbow Whiskerfish', rarity: 'mythic', min: 70, max: 210, note: 'Nobody agrees on what colour it actually is.' },
];

const FISH_BY_ID = new Map(FISH.map(fish => [fish.id, fish]));

interface CatchRecord { count: number; best: number; first: number }
type EquipmentSlot = 'rod' | 'line' | 'tackle';
interface EquipmentDef {
  id: string;
  name: string;
  slot: EquipmentSlot;
  detail: string;
  price?: number;
  foundFrom?: string;
  dropChance?: number;
  zone?: number;
  fill?: number;
  start?: number;
  limit?: number;
  bite?: number;
}
interface FishingRecord {
  casts: number;
  caught: number;
  escaped: number;
  fish: Record<string, CatchRecord>;
  coins: number;
  xp: number;
  equipment: Record<string, number>;
  equipped: Record<EquipmentSlot, string>;
}

const EQUIPMENT: EquipmentDef[] = [
  { id: 'reedRod', name: 'Reed Rod', slot: 'rod', detail: 'A dependable first rod.' },
  { id: 'oakRod', name: 'Oak Rod', slot: 'rod', detail: '+2% catch zone and +5% progress.', price: 150, zone: .02, fill: 1.05 },
  { id: 'silverRod', name: 'Silver Rod', slot: 'rod', detail: '+3% catch zone and +10% progress.', price: 600, zone: .03, fill: 1.1 },
  { id: 'moonRod', name: 'Moon Rod', slot: 'rod', detail: '+4% catch zone and +16% progress.', price: 1800, zone: .04, fill: 1.16 },
  { id: 'braidedLine', name: 'Braided Line', slot: 'line', detail: '+5 seconds before the line breaks.', foundFrom: 'speckledTrout', dropChance: .1, limit: 5000 },
  { id: 'silkLine', name: 'Mirror Silk Line', slot: 'line', detail: '+10 seconds before the line breaks.', foundFrom: 'mirrorfinArowana', dropChance: .08, limit: 10000 },
  { id: 'reedFloat', name: 'Reed Float', slot: 'tackle', detail: '+300ms to set the hook.', foundFrom: 'reedPerch', dropChance: .14, bite: 300 },
  { id: 'barbedHook', name: 'Ironjaw Hook', slot: 'tackle', detail: 'Begin each fight with 7% more progress.', foundFrom: 'ironjawCatfish', dropChance: .1, start: .07 },
  { id: 'crownLure', name: 'Crownscale Lure', slot: 'tackle', detail: '+3% catch zone.', foundFrom: 'crownscaleArapaima', dropChance: .08, zone: .03 },
  { id: 'prismLure', name: 'Prismatic Lure', slot: 'tackle', detail: '+12% progress while the fish is controlled.', foundFrom: 'rainbowWhiskerfish', dropChance: .12, fill: 1.12 },
];
const EQUIPMENT_BY_ID = new Map(EQUIPMENT.map(item => [item.id, item]));
const RARITY_REWARDS: Record<Rarity, { coins: number; xp: number }> = {
  common: { coins: 5, xp: 8 }, uncommon: { coins: 11, xp: 14 }, rare: { coins: 24, xp: 26 },
  epic: { coins: 52, xp: 48 }, legendary: { coins: 110, xp: 90 }, mythic: { coins: 240, xp: 165 },
};

const EMPTY_RECORD: FishingRecord = {
  casts: 0, caught: 0, escaped: 0, fish: {}, coins: 0, xp: 0,
  equipment: { reedRod: 1 }, equipped: { rod: 'reedRod', line: '', tackle: '' },
};

function loadRecord(): FishingRecord {
  const stored = loadLocal<Partial<FishingRecord>>(RECORD_KEY, {});
  const finite = (value: unknown): number => {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : 0;
  };
  const equipment: Record<string, number> = { reedRod: 1 };
  if (stored.equipment && typeof stored.equipment === 'object') {
    for (const [id, count] of Object.entries(stored.equipment)) {
      if (EQUIPMENT_BY_ID.has(id) && finite(count) > 0) equipment[id] = finite(count);
    }
  }
  const equipped = { ...EMPTY_RECORD.equipped };
  for (const slot of ['rod', 'line', 'tackle'] as const) {
    const id = stored.equipped?.[slot];
    if (typeof id === 'string' && equipment[id] > 0 && EQUIPMENT_BY_ID.get(id)?.slot === slot) equipped[slot] = id;
  }
  return {
    casts: finite(stored.casts),
    caught: finite(stored.caught),
    escaped: finite(stored.escaped),
    fish: stored.fish && typeof stored.fish === 'object' ? stored.fish : {},
    coins: finite(stored.coins),
    xp: finite(stored.xp),
    equipment,
    equipped,
  };
}

function fishingLevel(xp: number): { level: number; current: number; needed: number } {
  let level = 1;
  let remaining = Number.isFinite(xp) ? Math.max(0, xp) : 0;
  let needed = 60;
  while (remaining >= needed) {
    remaining -= needed;
    level++;
    needed = Math.round(60 * Math.pow(level, 1.35));
  }
  return { level, current: remaining, needed };
}

function weightedPick<T>(items: T[], weight: (item: T) => number): T {
  const total = items.reduce((sum, item) => sum + weight(item), 0);
  let roll = Math.random() * total;
  for (const item of items) {
    roll -= weight(item);
    if (roll <= 0) return item;
  }
  return items[items.length - 1];
}

/**
 * Rarity is rolled before species, so adding another fish never makes its entire tier more common.
 * Matching-weather fish receive a modest boost inside their tier. Event mythics are handled first
 * at a fixed rate because their ten-minute weather occurs only once every eight hours on average.
 */
function pickFish(weather: string | null): FishDef {
  const eventMythics = FISH.filter(fish => fish.rarity === 'mythic' && fish.weather === weather);
  if (eventMythics.length && Math.random() < WEATHER_MYTHIC_CHANCE) {
    return eventMythics[Math.floor(Math.random() * eventMythics.length)];
  }

  const pool = FISH.filter(fish => (!fish.weather || fish.weather === weather) && !eventMythics.includes(fish));
  const rarities = RARITY_ORDER.filter(rarity => pool.some(fish => fish.rarity === rarity));
  const rarity = weightedPick(rarities, value => RARITIES[value].weight);
  const tier = pool.filter(fish => fish.rarity === rarity);
  return weightedPick(tier, fish => fish.weather ? WEATHER_FISH_WEIGHT : 1);
}

function weatherLabel(weather: string | null): string {
  if (!weather) return 'Clear skies';
  return weather === 'AmberMoon' ? 'Amber Moon' : weather;
}

function formatWeight(kilos: number): string {
  return kilos >= 10 ? `${kilos.toFixed(1)} kg` : `${kilos.toFixed(2)} kg`;
}

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${PANEL_ID}{position:fixed;inset:0;z-index:999993;pointer-events:none;color:var(--gc-text,#e4e4e7);font:12px/1.45 system-ui,sans-serif}
    #${PANEL_ID}[hidden]{display:none}
    #${PANEL_ID} .gf-card{position:fixed;right:14px;bottom:56px;width:min(780px,94vw);display:flex;flex-direction:column;overflow:hidden;pointer-events:auto;user-select:none;touch-action:none;border:1px solid var(--gc-line,rgba(255,255,255,.075));border-radius:12px;background:var(--gc-bg,#0c0c11);box-shadow:0 18px 50px rgba(0,0,0,.7),inset 0 1px rgba(255,255,255,.035)}
    #${PANEL_ID} .gf-card[data-view=game]{width:min(360px,calc(100vw - 24px))}
    #${PANEL_ID} header{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;color:#fafafa;background:linear-gradient(180deg,rgba(255,255,255,.035),transparent);border-bottom:1px solid var(--gc-line,rgba(255,255,255,.075));cursor:move}
    #${PANEL_ID} h2{margin:0;font:700 13px/1.2 system-ui,sans-serif;letter-spacing:.02em}
    #${PANEL_ID} header div{display:flex;align-items:center;gap:4px}
    #${PANEL_ID} button{padding:5px 9px;border:1px solid var(--gc-line,rgba(255,255,255,.075));border-radius:6px;background:rgba(255,255,255,.03);color:var(--gc-text,#e4e4e7);font:700 10px system-ui,sans-serif;cursor:pointer}
    #${PANEL_ID} button:hover{color:#ddd6fe;border-color:rgba(167,139,250,.3);background:rgba(167,139,250,.1)}
    #${PANEL_ID} button[data-active=true]{color:#ddd6fe;border-color:rgba(167,139,250,.5);background:rgba(167,139,250,.16)}
    #${PANEL_ID} header button{width:26px;min-width:26px;height:26px;padding:0;border-radius:7px;color:var(--gc-muted,rgba(255,255,255,.72));font-size:12px}
    #${PANEL_ID} header button[data-close]{border-radius:50%;background:transparent}
    #${PANEL_ID} .gf-pond-input{position:fixed;pointer-events:auto;touch-action:none;cursor:crosshair}
    #${PANEL_ID} .gf-game{padding:10px 12px 12px}
    #${PANEL_ID} .gf-game-main{display:flex;align-items:center;gap:10px}
    #${PANEL_ID} .gf-game-main button{min-width:92px;height:38px;font-size:11px}
    #${PANEL_ID} .gf-game-copy{flex:1;min-width:0}
    #${PANEL_ID} .gf-game-copy b{display:block;color:#f8fafc;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #${PANEL_ID} .gf-game-copy small{display:block;margin-top:2px;color:var(--gc-muted,rgba(255,255,255,.72));font-size:9px}
    #${PANEL_ID} .gf-fight{position:relative;height:12px;margin-top:9px;overflow:hidden;border-radius:6px;background:rgba(255,255,255,.06)}
    #${PANEL_ID} .gf-fight-progress{position:absolute;inset:0 auto 0 0;width:0;background:#34d399;opacity:.7}
    #${PANEL_ID} .gf-fight-zone{position:absolute;top:1px;bottom:1px;left:0;width:20%;border:1px solid rgba(255,255,255,.68);border-radius:5px;background:rgba(52,211,153,.18)}
    #${PANEL_ID} .gf-fight-fish{position:absolute;top:2px;left:50%;width:8px;height:8px;margin-left:-4px;border-radius:50%;background:#f8fafc;box-shadow:0 0 5px currentColor}
    #${PANEL_ID} .gf-catch{display:grid;grid-template-columns:58px 1fr;gap:10px;margin-bottom:10px;padding:10px;border:1px solid color-mix(in srgb,var(--catch-colour) 45%,transparent);border-radius:10px;background:color-mix(in srgb,var(--catch-colour) 10%,rgba(255,255,255,.025))}
    #${PANEL_ID} .gf-catch-fish{display:grid;place-items:center;width:58px;height:58px;border-radius:50%;color:var(--catch-colour);background:color-mix(in srgb,var(--catch-colour) 16%,#09090b);font-size:31px;filter:drop-shadow(0 0 8px color-mix(in srgb,var(--catch-colour) 55%,transparent))}
    #${PANEL_ID} .gf-catch h3{margin:0;color:#fff;font:800 15px/1.2 system-ui,sans-serif}
    #${PANEL_ID} .gf-catch p{margin:3px 0 0;color:var(--catch-colour);font:700 10px system-ui,sans-serif;text-transform:uppercase;letter-spacing:.08em}
    #${PANEL_ID} .gf-catch small{display:block;margin-top:5px;color:#e4e4e7;font-size:10px}
    #${PANEL_ID} .gf-catch-rewards{display:flex;gap:10px;margin-top:5px;color:#f8fafc;font-size:10px;font-weight:700}
    #${PANEL_ID} .gf-catch-item{color:#fbbf24!important}
    #${PANEL_ID} .gf-progress-line{height:7px;overflow:hidden;border-radius:4px;background:rgba(255,255,255,.07)}
    #${PANEL_ID} .gf-progress-line i{display:block;height:100%;background:#a78bfa}
    #${PANEL_ID} .gf-gear-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:6px}
    #${PANEL_ID} .gf-gear{display:flex;align-items:center;gap:8px;padding:8px;border:1px solid var(--gc-line,rgba(255,255,255,.075));border-radius:8px;background:var(--gc-soft,rgba(255,255,255,.035))}
    #${PANEL_ID} .gf-gear span{flex:1;min-width:0}
    #${PANEL_ID} .gf-gear b,#${PANEL_ID} .gf-gear small{display:block}
    #${PANEL_ID} .gf-gear small{color:var(--gc-muted,rgba(255,255,255,.72));font-size:9px}
    #${PANEL_ID} .gf-gear[data-locked=true]{opacity:.5}
    #${PANEL_ID} .gf-status{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 12px;border-top:1px solid var(--gc-line,rgba(255,255,255,.075))}
    #${PANEL_ID} .gf-status b{font:700 12px system-ui,sans-serif}
    #${PANEL_ID} .gf-status small{color:var(--gc-muted,rgba(255,255,255,.72));font-size:10px;white-space:nowrap}
    #${PANEL_ID} .gf-body{max-height:min(430px,calc(100vh - 150px));overflow:auto;padding:10px 12px 12px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.1) transparent}
    #${PANEL_ID} .gf-totals{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:10px}
    #${PANEL_ID} .gf-totals div{padding:7px 8px;border:1px solid var(--gc-line,rgba(255,255,255,.075));border-radius:8px;background:var(--gc-soft,rgba(255,255,255,.035))}
    #${PANEL_ID} .gf-totals small{display:block;color:var(--gc-muted,rgba(255,255,255,.72));font-size:9px;letter-spacing:.08em;text-transform:uppercase}
    #${PANEL_ID} .gf-totals b{font:700 15px/1.3 system-ui,sans-serif}
    #${PANEL_ID} .gf-tier{margin:11px 0 6px;display:flex;align-items:center;justify-content:space-between;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
    #${PANEL_ID} .gf-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--gc-line,rgba(255,255,255,.075));border-radius:8px;background:var(--gc-soft,rgba(255,255,255,.035))}
    #${PANEL_ID} .gf-row+.gf-row{margin-top:4px}
    #${PANEL_ID} .gf-row i{width:7px;height:7px;flex:0 0 auto;border-radius:50%}
    #${PANEL_ID} .gf-row span{flex:1;min-width:0}
    #${PANEL_ID} .gf-row b{display:block;font:700 12px system-ui,sans-serif}
    #${PANEL_ID} .gf-row small{display:block;color:var(--gc-muted,rgba(255,255,255,.72));font-size:10px}
    #${PANEL_ID} .gf-row em{flex:0 0 auto;font-style:normal;font-size:10px;color:var(--gc-muted,rgba(255,255,255,.72))}
    #${PANEL_ID} .gf-row[data-found=false]{opacity:.42}
    #${PANEL_ID} .gf-row[data-found=false] b{color:var(--gc-muted,rgba(255,255,255,.72))}
    #${PANEL_ID} .gf-note{margin:0 0 8px;color:var(--gc-muted,rgba(255,255,255,.72));font-size:11px}
    #${PANEL_ID} .gf-reset{margin-top:14px;padding-top:12px;border-top:1px solid var(--gc-line,rgba(255,255,255,.075))}
    #${PANEL_ID} .gf-reset button{width:100%;padding:8px}
    #${PANEL_ID} .gf-bench-stats{display:flex;flex-wrap:wrap;gap:4px 10px;margin-bottom:6px;color:var(--gc-muted,rgba(255,255,255,.72));font-size:10px}
    #${PANEL_ID} .gf-bench-stats b{color:var(--gc-text,#e4e4e7);font:700 10px system-ui,sans-serif}
    #${PANEL_ID} .gf-bench-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:4px}
    #${PANEL_ID} button.gf-bench-fish{display:flex;flex-direction:column;align-items:flex-start;gap:1px;padding:6px 8px;font:600 11px system-ui,sans-serif;text-align:left}
    #${PANEL_ID} button.gf-bench-fish small{color:var(--gc-muted,rgba(255,255,255,.72));font-size:9px;font-weight:400}
  `;
  document.head.appendChild(style);
}

type Phase = 'idle' | 'waiting' | 'bite' | 'reel' | 'result';

export function initFishing(): void {
  let record = loadRecord();
  let view: 'game' | 'collection' | 'equipment' | 'bench' = 'game';
  let phase: Phase = 'idle';
  let message = 'Click the pond to put a line in.';
  let holding = false;
  let frame: number | null = null;
  let pausedAt: number | null = null;
  let lastTime = 0;

  // Reel state, all in track fractions where 0 is the top of the track.
  let hooked: FishDef | null = null;
  let hookedWeight = 0;
  let biteAt = 0;
  let castAt = 0;
  let castDistance = .42;
  let hookDepth = .28;
  let waitUntil = 0;
  let reelEndsAt = 0;
  let fishAt = .5, fishVelocity = 0, fishTarget = .5, retargetAt = 0;
  let zoneAt = .5, zoneVelocity = 0, zoneHeight = .3;
  let progress = 0;
  let resultColour = 'rgba(255,255,255,.72)';
  let resultLockUntil = 0;
  let lastCatch: { fish: FishDef; weight: number; fresh: boolean; coins: number; xp: number; item?: EquipmentDef } | null = null;
  let testing = false;
  let reelStartedAt = 0;
  let fightEndedAt = 0;
  let draggableReady = false;
  let pondBounds: WorldBounds | null = null;
  let farmBounds: WorldBounds | null = null;
  let seatingPlaced = false;

  /**
   * The pond takes over the farm tiles: water and dock sit below the garden's own z range, the rod
   * is lifted above the player, and the active pets are penned onto the decking so they do not
   * wander out across the water.
   */
  const scene = createWorldScene({
    owner: 'fishing',
    layers: { pond: -999_000, fish: -998_999, dock: -998_998, rod: 999_000 },
    abovePlayer: ['rod'],
    onBuild(geometry, built) {
      farmBounds = { left: geometry.left, top: geometry.top, width: geometry.width, height: geometry.height };
      pondBounds = { left: geometry.left, top: geometry.top, width: geometry.width * .62, height: geometry.height };
      seatingPlaced = false;
      const pond = built.layer('pond');
      const dock = built.layer('dock');
      if (pond) drawPond(pond, farmBounds);
      if (dock) drawDock(dock, pondBounds);
    },
    petArea: geometry => {
      const left = geometry.left + geometry.width * .62 + 48;
      const top = geometry.top + 126;
      return {
        left,
        top,
        width: Math.max(0, geometry.left + geometry.width - 48 - left),
        height: Math.max(0, geometry.top + geometry.height - 48 - top),
      };
    },
  });

  function equippedEffects(): EquipmentDef[] {
    return Object.entries(record.equipped).map(([slot, id]) => {
      const item = EQUIPMENT_BY_ID.get(id);
      return item?.slot === slot && record.equipment[id] > 0 ? item : null;
    }).filter((item): item is EquipmentDef => Boolean(item));
  }

  function equipmentTotal(key: 'zone' | 'start' | 'limit' | 'bite'): number {
    return equippedEffects().reduce((total, item) => total + (item[key] ?? 0), 0);
  }

  function equipmentFill(): number {
    const levelBonus = 1 + Math.min(.12, (fishingLevel(record.xp).level - 1) * .005);
    return equippedEffects().reduce((total, item) => total * (item.fill ?? 1), levelBonus);
  }

  function catchRewards(fish: FishDef, weight: number): { coins: number; xp: number } {
    const base = RARITY_REWARDS[fish.rarity];
    const weightFactor = .7 + Math.max(0, Math.min(1, (weight - fish.min) / Math.max(.01, fish.max - fish.min))) * .8;
    return { coins: Math.max(1, Math.round(base.coins * weightFactor)), xp: Math.max(1, Math.round(base.xp * weightFactor)) };
  }

  function itemDrop(fish: FishDef): EquipmentDef | undefined {
    const item = EQUIPMENT.find(candidate => candidate.foundFrom === fish.id && !record.equipment[candidate.id]);
    return item && Math.random() < (item.dropChance ?? 0) ? item : undefined;
  }

  function drawPond(graphic: Record<string, any>, bounds: NonNullable<typeof farmBounds>): void {
    const { left, top, width, height } = bounds;
    const waterWidth = width * .62;
    const deckLeft = left + waterWidth + 20;
    graphic.clear();
    graphic.roundRect(left - 36, top - 36, width + 72, height + 72, 72).fill({ color: 0x173b27, alpha: 1 });
    graphic.roundRect(left - 18, top - 18, width + 36, height + 36, 58).stroke({ color: 0x3f6b39, width: 34, alpha: 1 });
    graphic.roundRect(left, top, waterWidth, height, 44).fill({ color: 0x226b79, alpha: 1 });
    graphic.roundRect(left + 10, top + 10, waterWidth - 20, height - 20, 36).stroke({ color: 0x63b8b1, width: 8, alpha: .28 });
    graphic.roundRect(deckLeft, top, Math.max(40, left + width - deckLeft), height, 30).fill({ color: 0x8b5a2b, alpha: 1 });
    for (let y = top + 22; y < top + height; y += 42) {
      graphic.moveTo(deckLeft + 8, y).lineTo(left + width - 8, y).stroke({ color: 0xc08346, width: 6, alpha: .58 });
    }
    graphic.moveTo(deckLeft - 10, top + 12).lineTo(deckLeft - 10, top + height - 12).stroke({ color: 0x5f3a20, width: 18, alpha: .9 });
    const hedgeCount = Math.max(8, Math.floor((width + height) / 180));
    for (let index = 0; index < hedgeCount; index++) {
      const fraction = index / hedgeCount;
      const horizontal = index % 2 === 0;
      const x = horizontal ? left + fraction * width : (index % 4 === 1 ? left - 27 : left + width + 27);
      const y = horizontal ? (index % 4 === 0 ? top - 27 : top + height + 27) : top + fraction * height;
      graphic.circle(x, y, 30 + index % 3 * 4).fill({ color: index % 2 ? 0x2f6b36 : 0x397a3f, alpha: 1 });
      graphic.circle(x - 7, y - 8, 12).fill({ color: 0x5b954c, alpha: .72 });
    }
    for (let index = 0; index < 7; index++) {
      const x = left + waterWidth * (.12 + (index * .137) % .76);
      const y = top + height * (.16 + (index * .223) % .66);
      graphic.ellipse(x, y, 29, 17).fill({ color: 0x4b8b4a, alpha: .9 });
      graphic.ellipse(x - 3, y - 3, 20, 10).fill({ color: 0x6ca65d, alpha: .34 });
      graphic.moveTo(x, y).lineTo(x + 24, y - 8).stroke({ color: 0x255f39, width: 3, alpha: .85 });
      if (index % 2 === 0) {
        for (let petal = 0; petal < 5; petal++) {
          const angle = petal * Math.PI * 2 / 5;
          graphic.ellipse(x + Math.cos(angle) * 8, y - 5 + Math.sin(angle) * 5, 7, 4).fill({ color: 0xf9a8d4, alpha: .95 });
        }
        graphic.circle(x, y - 5, 4).fill({ color: 0xfde68a, alpha: 1 });
      }
    }
  }

  function ensureSeating(bounds: WorldBounds): void {
    if (seatingPlaced) return;
    const benchImage = readyImage(page.__gardenCompanionShopSprites?.StoneBench);
    const stoolImage = readyImage(page.__gardenCompanionShopSprites?.WoodStoolShort);
    if (!benchImage || !stoolImage) return;
    const deckLeft = bounds.left + bounds.width * .62 + 20;
    const deckRight = bounds.left + bounds.width;
    const deckWidth = Math.max(1, deckRight - deckLeft);
    const benchCount = Math.max(2, Math.floor(deckWidth / 230));
    const seat = (image: HTMLImageElement, x: number, y: number, width: number) =>
      scene.addSprite(image, { x, y, width, zIndex: -998_997 });
    for (let index = 0; index < benchCount; index++) {
      const x = deckLeft + deckWidth * (index + .5) / benchCount;
      seat(benchImage, x, bounds.top + 118, 172);
      seat(benchImage, x, bounds.top + bounds.height - 18, 172);
    }
    const stoolTop = bounds.top + 190;
    const stoolBottom = bounds.top + bounds.height - 145;
    const stoolCount = Math.max(3, Math.floor(Math.max(1, stoolBottom - stoolTop) / 210));
    for (let index = 0; index < stoolCount; index++) {
      const y = stoolCount === 1 ? (stoolTop + stoolBottom) / 2 : stoolTop + (stoolBottom - stoolTop) * index / (stoolCount - 1);
      seat(stoolImage, deckRight - 72, y, 82);
    }
    seatingPlaced = true;
  }

  function drawDock(graphic: Record<string, any>, water: NonNullable<typeof pondBounds>): void {
    const tileSize = Math.min(256, water.width * .22, water.height * .24);
    const width = tileSize * 2;
    const height = tileSize * 2;
    const left = water.left + water.width - width;
    const top = water.top + (water.height - height) / 2;
    graphic.clear();
    graphic.roundRect(left - 10, top - 10, width + 20, height + 20, 14).fill({ color: 0x4a2b17, alpha: 1 });
    for (let row = 0; row < 2; row++) {
      for (let column = 0; column < 2; column++) {
        const x = left + column * tileSize;
        const y = top + row * tileSize;
        graphic.rect(x + 4, y + 4, tileSize - 8, tileSize - 8).fill({ color: (row + column) % 2 ? 0x996235 : 0xa86d3b, alpha: 1 });
        for (let plank = 1; plank < 4; plank++) {
          graphic.moveTo(x + 7, y + plank * tileSize / 4).lineTo(x + tileSize - 7, y + plank * tileSize / 4).stroke({ color: 0x60391f, width: 4, alpha: .7 });
        }
      }
    }
    for (const [x, y] of [[left, top], [left + width, top], [left, top + height], [left + width, top + height]]) {
      graphic.circle(x, y, 13).fill({ color: 0x372013, alpha: 1 });
      graphic.circle(x, y - 3, 7).fill({ color: 0x8b5a32, alpha: 1 });
    }
  }

  function positionPondInput(): void {
    const input = panel()?.querySelector<HTMLElement>('.gf-pond-input');
    if (!input) return;
    const rect = view === 'game' && pondBounds ? scene.project(pondBounds) : null;
    if (!rect) { input.hidden = true; return; }
    input.hidden = false;
    input.style.left = `${rect.left}px`;
    input.style.top = `${rect.top}px`;
    input.style.width = `${rect.width}px`;
    input.style.height = `${rect.height}px`;
  }

  function updateWorldScene(now: number): void {
    if (panel()?.hidden) return;
    const geometry = scene.sync();
    const fishGraphic = scene.layer('fish');
    const rodGraphic = scene.layer('rod');
    if (!geometry || !pondBounds || !farmBounds || !fishGraphic || !rodGraphic) return;
    ensureSeating(farmBounds);
    positionPondInput();
    const { left, top, width, height } = pondBounds;
    fishGraphic.clear();
    for (const swimmer of swimmers) {
      const direction = Math.sign(swimmer.speed) || 1;
      const size = swimmer.size * 3.1;
      const routeProgress = Math.max(0, Math.min(1, (swimmer.x + .15) / 1.3));
      const horizontalPadding = Math.min(width * .2, size * 1.35);
      const verticalPadding = Math.min(height * .2, size * .65);
      const x = left + horizontalPadding + routeProgress * Math.max(0, width - horizontalPadding * 2);
      const y = top + verticalPadding + swimmer.y * Math.max(0, height - verticalPadding * 2);
      const colour = Number.parseInt(swimmer.colour.slice(1), 16);
      fishGraphic.ellipse(x, y, size * 1.08, size * .56).fill({ color: 0xdbeafe, alpha: .13 });
      fishGraphic.ellipse(x, y, size, size * .48).fill({ color: colour, alpha: .88 });
      fishGraphic.ellipse(x, y, size, size * .48).stroke({ color: 0xe0f2fe, width: Math.max(2, size * .08), alpha: .48 });
      fishGraphic.moveTo(x - direction * size * .72, y)
        .lineTo(x - direction * size * 1.22, y - size * .5)
        .lineTo(x - direction * size * 1.22, y + size * .5)
        .lineTo(x - direction * size * .72, y)
        .fill({ color: colour, alpha: .82 });
      fishGraphic.circle(x + direction * size * .55, y - size * .1, Math.max(3, size * .09)).fill({ color: 0xf8fafc, alpha: 1 });
      fishGraphic.circle(x + direction * size * .57, y - size * .1, Math.max(1.5, size * .04)).fill({ color: 0x0f172a, alpha: .9 });
    }
    const targetX = left + width * castDistance;
    const targetY = top + height * hookDepth;
    const castElapsed = Math.max(0, now - castAt);
    const casting = phase === 'waiting' && castElapsed < CAST_WINDUP + CAST_FLIGHT;
    if (phase !== 'idle' && phase !== 'result' && !casting) {
      fishGraphic.circle(targetX, targetY, phase === 'bite' ? 18 : 12).fill({ color: phase === 'bite' ? 0xfbbf24 : 0xf8fafc, alpha: .92 });
      fishGraphic.circle(targetX, targetY, phase === 'bite' ? 30 + Math.sin(now / 90) * 7 : 22).stroke({ color: 0xdbeafe, width: 5, alpha: .32 });
    }
    rodGraphic.clear();
    const avatar = scene.avatar();
    if (avatar?.getGlobalPosition && geometry.system.worldContainer?.toLocal) {
      try {
        const player = geometry.system.worldContainer.toLocal(avatar.getGlobalPosition());
        const rodBaseX = player.x - 18;
        const rodBaseY = player.y - 76;
        let rodTipX = rodBaseX - 78;
        let rodTipY = rodBaseY - 66;
        if (casting && castElapsed < CAST_WINDUP) {
          const progress = castElapsed / CAST_WINDUP;
          const eased = progress * progress * (3 - 2 * progress);
          rodTipX += 118 * eased;
          rodTipY -= 22 * eased;
        } else if (casting) {
          const progress = (castElapsed - CAST_WINDUP) / CAST_FLIGHT;
          const eased = 1 - Math.pow(1 - progress, 3);
          rodTipX = rodBaseX + 40 - 132 * eased;
          rodTipY = rodBaseY - 88 + 20 * eased;
        }
        rodGraphic.moveTo(rodBaseX, rodBaseY).lineTo(rodTipX, rodTipY).stroke({ color: 0x70411f, width: 9, alpha: 1 });
        let lineEndX = targetX;
        let lineEndY = targetY;
        if (casting && castElapsed < CAST_WINDUP) {
          lineEndX = rodTipX;
          lineEndY = rodTipY;
        } else if (casting) {
          const progress = Math.max(0, Math.min(1, (castElapsed - CAST_WINDUP) / CAST_FLIGHT));
          lineEndX = rodTipX + (targetX - rodTipX) * progress;
          lineEndY = rodTipY + (targetY - rodTipY) * progress - Math.sin(Math.PI * progress) * 70;
          fishGraphic.circle(lineEndX, lineEndY, 10).fill({ color: 0xf8fafc, alpha: .92 });
        }
        rodGraphic.moveTo(rodTipX, rodTipY).lineTo(lineEndX, lineEndY).stroke({ color: 0xe2e8f0, width: 2, alpha: phase === 'idle' || phase === 'result' ? .35 : .85 });
        rodGraphic.circle(rodBaseX, rodBaseY, 7).fill({ color: 0xd6a15b, alpha: 1 });
      } catch {}
    }
  }

  function updateHud(): void {
    const host = panel();
    if (!host || host.hidden || view !== 'game') return;
    const status = host.querySelector<HTMLElement>('[data-fishing-status]');
    const weatherNode = host.querySelector<HTMLElement>('[data-fishing-weather]');
    const progressNode = host.querySelector<HTMLElement>('.gf-fight-progress');
    const zoneNode = host.querySelector<HTMLElement>('.gf-fight-zone');
    const fishNode = host.querySelector<HTMLElement>('.gf-fight-fish');
    if (status) { status.textContent = message; status.style.color = resultColour; }
    if (weatherNode) weatherNode.textContent = weatherLabel(weather());
    if (progressNode) {
      progressNode.style.width = `${Math.max(0, Math.min(1, progress)) * 100}%`;
      progressNode.style.background = hooked ? RARITIES[hooked.rarity].colour : '#34d399';
    }
    if (zoneNode) {
      zoneNode.style.left = `${Math.max(0, zoneAt - zoneHeight / 2) * 100}%`;
      zoneNode.style.width = `${zoneHeight * 100}%`;
      zoneNode.hidden = phase !== 'reel';
    }
    if (fishNode) {
      fishNode.style.left = `${fishAt * 100}%`;
      fishNode.style.color = hooked ? RARITIES[hooked.rarity].colour : '#f8fafc';
      fishNode.style.background = hooked ? RARITIES[hooked.rarity].colour : '#f8fafc';
      fishNode.hidden = phase !== 'reel';
    }
  }

  // Idle scenery: a few fish drifting through the water so the pond is never still.
  interface Swimmer { x: number; y: number; speed: number; size: number; colour: string; phase: number }
  const SWIMMER_COLOURS = ['#4b7f96', '#3f6f86', '#5b8f7a', '#6b7f9c', '#7a8fa0'];
  const swimmers: Swimmer[] = Array.from({ length: 9 }, () => spawnSwimmer(Math.random()));

  function spawnSwimmer(x = Math.random() < .5 ? -.1 : 1.1): Swimmer {
    const rightward = x < .5;
    return {
      x,
      y: .12 + Math.random() * .78,
      speed: (rightward ? 1 : -1) * (.035 + Math.random() * .075),
      size: 6 + Math.random() * 10,
      colour: SWIMMER_COLOURS[Math.floor(Math.random() * SWIMMER_COLOURS.length)],
      phase: Math.random() * Math.PI * 2,
    };
  }

  function panel(): HTMLElement | null { return document.getElementById(PANEL_ID); }

  function weather(): string | null {
    const value = state.game?.weather;
    return typeof value === 'string' && value ? value : null;
  }

  function save(): void { saveLocal(RECORD_KEY, record); }

  function setPhase(next: Phase, text: string, colour = 'rgba(255,255,255,.72)'): void {
    phase = next;
    message = text;
    resultColour = colour;
    if (next === 'result') resultLockUntil = performance.now() + RESULT_LOCK;
    renderChrome();
  }

  function cast(): void {
    if (phase !== 'idle' && phase !== 'result') return;
    record.casts++;
    save();
    hooked = null;
    testing = false;
    holding = false;
    lastCatch = null;
    progress = 0;
    castDistance = .28 + Math.random() * .5;
    hookDepth = .16 + Math.random() * .38;
    castAt = performance.now();
    // The bite can never land before the float does, whatever the wait rolls.
    waitUntil = castAt + CAST_WINDUP + CAST_FLIGHT + 1200 + Math.random() * 3600;
    setPhase('waiting', 'Line is out. Wait for the bob to dip.');
    playCast();
    resumeLoop();
  }

  /** Puts a fish on the hook and resets the fight, shared by a real bite and a bench fight. */
  function armFish(fish: FishDef, now: number): void {
    hooked = fish;
    hookedWeight = fish.min + Math.random() * (fish.max - fish.min);
    zoneHeight = Math.min(.42, RARITIES[fish.rarity].zone + equipmentTotal('zone'));
    zoneAt = .5;
    zoneVelocity = 0;
    fishAt = .5;
    fishVelocity = 0;
    fishTarget = .5;
    retargetAt = now;
    progress = Math.min(.5, START_PROGRESS + equipmentTotal('start'));
    lastCatch = null;
    fightEndedAt = 0;
  }

  function beginBite(now: number): void {
    armFish(pickFish(weather()), now);
    testing = false;
    biteAt = now;
    setPhase('bite', 'Bite! Click to set the hook.');
    playBite();
  }

  /**
   * Bench fights skip the cast entirely and never touch the record, so tuning a tier does not
   * quietly fill in a collection that is supposed to be earned.
   */
  function startBenchFight(fish: FishDef): void {
    const now = performance.now();
    pausedAt = null;
    armFish(fish, now);
    testing = true;
    holding = false;
    view = 'game';
    reelStartedAt = now;
    reelEndsAt = now + REEL_LIMIT + equipmentTotal('limit');
    setPhase('reel', `Test fight: ${fish.name}`);
    startLoop();
  }

  function beginReel(now: number): void {
    reelStartedAt = now;
    reelEndsAt = now + REEL_LIMIT + equipmentTotal('limit');
    // The click that set the hook is already a press, so it counts as the first pull.
    holding = true;
    setPhase('reel', 'Hold the mouse to lift, release to drop.');
  }

  /** Runs live during a fight and freezes once one ends, so the badge and the result agree. */
  function fightLength(): string {
    return `${(((fightEndedAt || performance.now()) - reelStartedAt) / 1000).toFixed(1)}s`;
  }

  function land(): void {
    if (!hooked) return;
    fightEndedAt = performance.now();
    const existing = record.fish[hooked.id];
    const reward = testing ? { coins: 0, xp: 0 } : catchRewards(hooked, hookedWeight);
    const droppedItem = testing ? undefined : itemDrop(hooked);
    if (!testing) {
      record.fish[hooked.id] = {
        count: (existing?.count ?? 0) + 1,
        best: Math.max(existing?.best ?? 0, hookedWeight),
        first: existing?.first ?? Date.now(),
      };
      record.caught++;
      record.coins += reward.coins;
      record.xp += reward.xp;
      if (droppedItem) record.equipment[droppedItem.id] = 1;
      save();
    }
    const rule = RARITIES[hooked.rarity];
    lastCatch = { fish: hooked, weight: hookedWeight, fresh: !testing && !existing, ...reward, item: droppedItem };
    playCatch(RARITY_ORDER.indexOf(hooked.rarity));
    const detail = testing
      ? `Test fight won in ${fightLength()} - not recorded`
      : `${hooked.name} landed in ${fightLength()}`;
    setPhase('result', detail, rule.colour);
  }

  function lose(text: string): void {
    fightEndedAt = performance.now();
    if (phase === 'reel' && testing) {
      playEscape();
      hooked = null;
      lastCatch = null;
      setPhase('result', `Test fight lost after ${fightLength()} - not recorded`, 'rgba(248,113,113,.85)');
      return;
    }
    if (phase === 'bite' || phase === 'reel') { record.escaped++; save(); playEscape(); }
    hooked = null;
    lastCatch = null;
    setPhase('result', text, 'rgba(248,113,113,.85)');
  }

  function press(): void {
    const now = performance.now();
    if (phase === 'result' && now < resultLockUntil) return;
    if (phase === 'idle' || phase === 'result') return cast();
    if (phase === 'waiting') return lose('Reeled in too early. Nothing there.');
    if (phase === 'bite') return beginReel(now);
    if (phase === 'reel') holding = true;
  }

  function release(): void { holding = false; }

  function shiftActiveTimers(duration: number): void {
    if (phase === 'waiting') { waitUntil += duration; castAt += duration; }
    else if (phase === 'bite') biteAt += duration;
    else if (phase === 'reel') {
      reelStartedAt += duration;
      reelEndsAt += duration;
      retargetAt += duration;
    }
  }

  function step(now: number): void {
    // Cleared first so a throw anywhere below leaves the loop restartable rather than wedged.
    frame = null;
    const gap = Math.max(0, now - lastTime);
    // Browsers stop requestAnimationFrame in hidden tabs. Treat any long gap as paused time so a
    // backgrounded tab, sleeping laptop, or blocked main thread cannot expire an active cast.
    if (gap > 1000) shiftActiveTimers(gap);
    const delta = Math.min(.05, gap / 1000 || 0);
    lastTime = now;
    if (phase === 'waiting' && now >= waitUntil) beginBite(now);
    else if (phase === 'bite' && now - biteAt > BITE_WINDOW + equipmentTotal('bite')) lose('The bite went slack. It let go.');
    else if (phase === 'reel' && hooked) {
      const rule = RARITIES[hooked.rarity];
      if (now >= retargetAt) {
        fishTarget = .06 + Math.random() * .88;
        retargetAt = now + 320 + Math.random() * 780 / rule.speed;
      }
      fishVelocity += (fishTarget - fishAt) * FISH_PULL * rule.speed * delta;
      // Damping has to be per second rather than per frame, or the fish behaves differently on a
      // 144Hz screen than on a 60Hz one and no amount of tuning holds.
      fishVelocity *= Math.pow(.93, delta * 60);
      fishAt = Math.max(.03, Math.min(.97, fishAt + fishVelocity * delta * 1.6));

      // Friction caps the zone at a terminal speed instead of a hard clamp, so the control settles
      // where you hold it rather than pinning itself to the limit and overshooting.
      const agility = zoneAgility(rule.speed);
      zoneVelocity += (holding ? -ZONE_LIFT : ZONE_GRAVITY) * agility * delta;
      zoneVelocity *= Math.pow(ZONE_FRICTION, delta * 60);
      zoneAt += zoneVelocity * delta;
      const half = zoneHeight / 2;
      if (zoneAt < half) { zoneAt = half; zoneVelocity = 0; }
      if (zoneAt > 1 - half) { zoneAt = 1 - half; zoneVelocity = 0; }

      const inside = Math.abs(fishAt - zoneAt) < half;
      progress += (inside ? rule.fill * equipmentFill() : -rule.drain) * FIGHT_PACE * delta;
      if (holding) playReelClick(inside);
      // Landing or losing only ends the cast, never the loop: the frame below must always be
      // queued, or the panel stops animating and no later cast can ever start.
      if (progress >= 1) land();
      else if (progress <= LOSE_FLOOR) lose('It threw the hook and was gone.');
      else if (now >= reelEndsAt) lose('The line gave out. It kept the hook.');
    }
    for (const swimmer of swimmers) {
      swimmer.x += swimmer.speed * delta;
      if (swimmer.x < -.15 || swimmer.x > 1.15) Object.assign(swimmer, spawnSwimmer());
    }
    try {
      updateWorldScene(now);
      updateHud();
    } catch (error) {
      scene.fail(error, 'Fishing pool could not be drawn.');
    }
    frame = requestAnimationFrame(step);
  }

  function startLoop(): void {
    lastTime = performance.now();
    if (frame === null) frame = requestAnimationFrame(step);
  }

  function stopLoop(): void {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  }

  function pauseLoop(): void {
    if (pausedAt === null) pausedAt = performance.now();
    holding = false;
    stopLoop();
  }

  function resumeLoop(): void {
    if (pausedAt !== null) {
      const pausedFor = performance.now() - pausedAt;
      shiftActiveTimers(pausedFor);
      pausedAt = null;
    }
    startLoop();
  }

  function collectionHtml(): string {
    const found = Object.keys(record.fish).length;
    const sections = RARITY_ORDER.map(rarity => {
      const rows = FISH.filter(fish => fish.rarity === rarity).map(fish => {
        const entry = record.fish[fish.id];
        const gate = fish.weather ? `${weatherLabel(fish.weather)} only` : '';
        const detail = entry ? [gate, fish.note].filter(Boolean).join(' · ') : gate || 'Not caught yet';
        return `<div class="gf-row" data-found="${Boolean(entry)}"><i style="background:${RARITIES[rarity].colour}"></i><span><b>${escapeHtml(fish.name)}</b><small>${escapeHtml(detail)}</small></span><em>${entry ? `${entry.count}x &middot; ${escapeHtml(formatWeight(entry.best))}` : '&mdash;'}</em></div>`;
      }).join('');
      const tierFound = FISH.filter(fish => fish.rarity === rarity && record.fish[fish.id]).length;
      const tierTotal = FISH.filter(fish => fish.rarity === rarity).length;
      return `<div class="gf-tier" style="color:${RARITIES[rarity].colour}"><span>${RARITIES[rarity].label}</span><span>${tierFound}/${tierTotal}</span></div>${rows}`;
    }).join('');
    return `<div class="gf-body"><p class="gf-note">Fish with a weather listed bite in that weather and no other. Caught fish are recorded in this browser only - nothing here touches your garden.</p><div class="gf-totals"><div><small>Caught</small><b>${record.caught.toLocaleString(NUMBER_LOCALE)}</b></div><div><small>Species</small><b>${found}/${FISH.length}</b></div><div><small>Casts</small><b>${record.casts.toLocaleString(NUMBER_LOCALE)}</b></div></div>${sections}<div class="gf-reset"><button data-reset>Reset record</button></div></div>`;
  }

  function equipmentHtml(): string {
    const level = fishingLevel(record.xp);
    const slotNames: Record<EquipmentSlot, string> = { rod: 'Rods', line: 'Lines', tackle: 'Tackle' };
    const sections = (Object.keys(slotNames) as EquipmentSlot[]).map(slot => {
      const rows = EQUIPMENT.filter(item => item.slot === slot).map(item => {
        const owned = Boolean(record.equipment[item.id]);
        const equipped = record.equipped[slot] === item.id;
        const sourceFish = item.foundFrom ? FISH_BY_ID.get(item.foundFrom)?.name : null;
        let action = '';
        if (equipped) action = '<button disabled>Equipped</button>';
        else if (owned) action = `<button data-equip="${item.id}">Equip</button>`;
        else if (item.price) action = `<button data-buy="${item.id}" ${record.coins < item.price ? 'disabled' : ''}>${item.price.toLocaleString(NUMBER_LOCALE)} coins</button>`;
        else action = `<button disabled>Find</button>`;
        const acquisition = sourceFish && !owned ? `Caught from ${sourceFish}` : item.detail;
        return `<div class="gf-gear" data-locked="${!owned && !item.price}"><span><b>${escapeHtml(item.name)}</b><small>${escapeHtml(acquisition)}</small></span>${action}</div>`;
      }).join('');
      return `<div class="gf-tier"><span>${slotNames[slot]}</span><span>${record.equipped[slot] ? escapeHtml(EQUIPMENT_BY_ID.get(record.equipped[slot])?.name ?? '') : 'Empty'}</span></div><div class="gf-gear-grid">${rows}</div>`;
    }).join('');
    return `<div class="gf-body"><div class="gf-totals"><div><small>Fishing level</small><b>${level.level}</b></div><div><small>Fishing XP</small><b>${record.xp.toLocaleString(NUMBER_LOCALE)}</b></div><div><small>Fishing coins</small><b>${record.coins.toLocaleString(NUMBER_LOCALE)}</b></div></div><div class="gf-progress-line"><i style="width:${level.current / level.needed * 100}%"></i></div><p class="gf-note" style="margin-top:8px">${level.current.toLocaleString(NUMBER_LOCALE)} / ${level.needed.toLocaleString(NUMBER_LOCALE)} XP to the next level. Each level adds 0.5% catch progress, up to 12%. Fishing coins, XP and equipment belong only to this minigame.</p>${sections}</div>`;
  }

  /**
   * The tuning bench. Every number here is derived from the rarity table rather than written down
   * beside it, so it cannot drift out of step with how a fight actually plays.
   */
  function benchHtml(): string {
    const tiers = RARITY_ORDER.map(rarity => {
      const rule = RARITIES[rarity];
      const fill = rule.fill * FIGHT_PACE;
      const drain = rule.drain * FIGHT_PACE;
      // Below this share of time inside the zone the bar loses ground and the fish eventually wins.
      const breakEven = Math.round(drain / (fill + drain) * 100);
      const perfect = ((1 - START_PROGRESS) / fill).toFixed(1);
      const buttons = FISH.filter(fish => fish.rarity === rarity).map(fish =>
        `<button class="gf-bench-fish" data-fight="${escapeHtml(fish.id)}">${escapeHtml(fish.name)}${fish.weather ? `<small>${escapeHtml(weatherLabel(fish.weather))}</small>` : ''}</button>`).join('');
      return `<div class="gf-tier" style="color:${rule.colour}"><span>${rule.label}</span><span>hold ${breakEven}% to break even</span></div><div class="gf-bench-stats"><span>Zone <b>${Math.round(rule.zone * 100)}%</b></span><span>Fish <b>${fishTravelSpeed(rule.speed).toFixed(2)}/s</b></span><span>Lift <b>${((ZONE_LIFT - ZONE_GRAVITY) / ZONE_DRAG * zoneAgility(rule.speed)).toFixed(2)}/s</b></span><span>Drop <b>${(ZONE_GRAVITY / ZONE_DRAG * zoneAgility(rule.speed)).toFixed(2)}/s</b></span><span>Fill <b>${fill.toFixed(3)}/s</b></span><span>Drain <b>${drain.toFixed(3)}/s</b></span><span>Flawless <b>${perfect}s</b></span></div><div class="gf-bench-grid">${buttons}</div>`;
    }).join('');
    return `<div class="gf-body"><p class="gf-note">Pick any fish to fight it straight away, skipping the cast and its weather. Bench fights are never added to your record. Pace ${FIGHT_PACE}, start ${START_PROGRESS}, floor ${LOSE_FLOOR}, limit ${REEL_LIMIT / 1000}s.</p>${tiers}<div class="gf-reset"><button data-view="bench">Back to the pond</button></div></div>`;
  }

  /** Both the world pond and compact action button use the same press and release controls. */
  function gameHtml(): string {
    const catchCard = phase === 'result' && lastCatch ? (() => {
      const rule = RARITIES[lastCatch.fish.rarity];
      const rewards = testing ? `<span>Bench catch</span>` : `<span>${lastCatch.coins} coins</span><span>${lastCatch.xp} XP</span>`;
      const item = lastCatch.item ? `<small class="gf-catch-item">Equipment found: ${escapeHtml(lastCatch.item.name)}</small>` : '';
      return `<div class="gf-catch" style="--catch-colour:${rule.colour}"><div class="gf-catch-fish">&#128031;</div><div><h3>${escapeHtml(lastCatch.fish.name)}</h3><p>${rule.label}${lastCatch.fresh ? ' - New species' : ''}</p><small>${escapeHtml(formatWeight(lastCatch.weight))} - ${escapeHtml(fightLength())}</small><div class="gf-catch-rewards">${rewards}</div>${item}</div></div>`;
    })() : '';
    return `<div class="gf-game">${catchCard}<div class="gf-game-main"><button data-reel>${phase === 'reel' ? 'Hold to reel' : phase === 'bite' ? 'Set hook' : phase === 'waiting' ? 'Reel in' : 'Cast line'}</button><div class="gf-game-copy"><b data-fishing-status style="color:${resultColour}">${escapeHtml(message)}</b><small data-fishing-weather>${escapeHtml(weatherLabel(weather()))}</small></div></div><div class="gf-fight"><i class="gf-fight-progress"></i><i class="gf-fight-zone"></i><i class="gf-fight-fish"></i></div></div>`;
  }

  function renderChrome(): void {
    const host = panel();
    if (!host || host.hidden) return;
    const card = host.querySelector<HTMLElement>('.gf-card');
    if (!card) return;
    const quiet = fishingMuted();
    const body = view === 'collection' ? collectionHtml() : view === 'equipment' ? equipmentHtml() : view === 'bench' ? benchHtml() : gameHtml();
    card.dataset.view = view;
    const pondInput = host.querySelector<HTMLElement>('.gf-pond-input');
    if (pondInput && view !== 'game') pondInput.hidden = true;
    card.innerHTML = `<header><h2>&#127907; Fishing</h2><div><button data-mute title="${quiet ? 'Sound off' : 'Sound on'}">${quiet ? '&#128263;' : '&#128266;'}</button><button data-view="equipment" data-active="${view === 'equipment'}" title="Equipment">&#129520;</button><button data-view="collection" data-active="${view === 'collection'}" title="Catch record">&#128220;</button><button data-close aria-label="Close">&#10005;</button></div></header>${body}`;
    card.querySelector<HTMLButtonElement>('[data-close]')!.onclick = close;
    card.querySelector<HTMLButtonElement>('[data-mute]')!.onclick = () => {
      setFishingMuted(!quiet);
      if (quiet) primeFishingAudio();
      renderChrome();
    };
    card.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(button => button.onclick = () => {
      const target = button.dataset.view as 'collection' | 'equipment' | 'bench';
      view = view === target ? 'game' : target;
      renderChrome();
    });
    card.querySelectorAll<HTMLButtonElement>('[data-fight]').forEach(button => button.onclick = () => {
      const fish = FISH_BY_ID.get(button.dataset.fight!);
      if (fish) startBenchFight(fish);
    });
    card.querySelectorAll<HTMLButtonElement>('[data-buy]').forEach(button => button.onclick = () => {
      const item = EQUIPMENT_BY_ID.get(button.dataset.buy!);
      if (!item?.price || record.equipment[item.id] || record.coins < item.price) return;
      record.coins -= item.price;
      record.equipment[item.id] = 1;
      record.equipped[item.slot] = item.id;
      save();
      renderChrome();
    });
    card.querySelectorAll<HTMLButtonElement>('[data-equip]').forEach(button => button.onclick = () => {
      const item = EQUIPMENT_BY_ID.get(button.dataset.equip!);
      if (!item || !record.equipment[item.id]) return;
      record.equipped[item.slot] = item.id;
      save();
      renderChrome();
    });
    card.querySelector<HTMLButtonElement>('[data-reset]')?.addEventListener('click', () => {
      if (!confirm('Clear your fishing record? Every catch is forgotten.')) return;
      record = { ...EMPTY_RECORD, fish: {}, equipment: { ...EMPTY_RECORD.equipment }, equipped: { ...EMPTY_RECORD.equipped } };
      save();
      renderChrome();
    });
    const element = card.querySelector<HTMLButtonElement>('[data-reel]');
    if (element) {
      element.onpointerdown = event => {
        event.preventDefault();
        if (event.button !== 0) return;
        try { element.setPointerCapture(event.pointerId); } catch {}
        press();
      };
      element.onpointerup = event => {
        try { element.releasePointerCapture(event.pointerId); } catch {}
        release();
      };
      element.onpointercancel = release;
      element.onpointerleave = release;
    }
    if (view === 'game') {
      updateWorldScene(performance.now());
      updateHud();
    }
  }

  function open(targetView: 'game' | 'bench' = 'game'): void {
    const host = panel();
    if (!host) return;
    view = targetView;
    host.hidden = false;
    scene.enter();
    primeFishingAudio();
    renderChrome();
    if (!draggableReady) {
      const card = host.querySelector<HTMLElement>('.gf-card');
      if (card) {
        makeDraggable(card, POSITION_KEY);
        draggableReady = true;
      }
    }
    resumeLoop();
  }

  function close(): void {
    const host = panel();
    if (host) host.hidden = true;
    pauseLoop();
    scene.exit();
    const input = host?.querySelector<HTMLElement>('.gf-pond-input');
    if (input) input.hidden = true;
  }

  function mount(): void {
    injectStyles();
    const host = document.createElement('div');
    host.id = PANEL_ID;
    host.hidden = true;
    // Marks everything inside as companion UI, so capture-phase game input handlers skip it.
    host.dataset.gcUi = 'fishing';
    const card = document.createElement('div');
    card.className = 'gf-card';
    const pondInput = document.createElement('div');
    pondInput.className = 'gf-pond-input';
    pondInput.hidden = true;
    pondInput.dataset.noDrag = '';
    host.appendChild(pondInput);
    host.appendChild(card);
    document.body.appendChild(host);
    // Everything inside the card is ours: no click, drag or scroll may reach the game beneath it,
    // so a stray reel does not move a plant or harvest a crop.
    for (const type of ['pointerdown', 'pointerup', 'pointermove', 'pointercancel', 'mousedown', 'mouseup', 'click', 'dblclick', 'wheel', 'contextmenu']) {
      card.addEventListener(type, event => event.stopPropagation());
      if (type !== 'wheel') pondInput.addEventListener(type, event => event.stopPropagation());
    }
    pondInput.onpointerdown = event => {
      event.preventDefault();
      if (event.button !== 0) return;
      try { pondInput.setPointerCapture(event.pointerId); } catch {}
      press();
    };
    pondInput.onpointerup = event => {
      try { pondInput.releasePointerCapture(event.pointerId); } catch {}
      release();
    };
    pondInput.onpointercancel = release;
    pondInput.addEventListener('wheel', event => {
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
    window.addEventListener('pointerup', release);
    page.__gardenCompanionToggleFishing = () => (panel()?.hidden ? open() : close());
    page.__gardenCompanionFishingOpen = () => panel()?.hidden === false;
    // Published so the bench can be reached from the console without a button in the panel.
    page.__gardenCompanionFishingBench = () => {
      open('bench');
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
}
