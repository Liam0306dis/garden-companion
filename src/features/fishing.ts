import { page } from '../page.js';
import { state } from '../state.js';
import { makeDraggable } from '../draggable.js';
import { petSpriteSource } from '../pets.js';
import { escapeHtml, loadLocal, saveLocal } from '../utils.js';
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
type FishingSceneWeather = 'Clear' | 'Rain' | 'Frost' | 'Dawn' | 'AmberMoon' | 'Thunderstorm';

const WEATHER_TRANSITION = 1600;

function fishingSceneWeather(value: string | null): FishingSceneWeather {
  switch (value) {
    case 'Rain':
    case 'Frost':
    case 'Dawn':
    case 'AmberMoon':
    case 'Thunderstorm':
      return value;
    default:
      return 'Clear';
  }
}

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
  common: { label: 'Common', colour: '#94a3b8', weight: 48, zone: .26, speed: 1, fill: .40, drain: .38 },
  uncommon: { label: 'Uncommon', colour: '#34d399', weight: 28, zone: .26, speed: 1.02, fill: .39, drain: .38 },
  rare: { label: 'Rare', colour: '#38bdf8', weight: 15, zone: .25, speed: 1.08, fill: .37, drain: .375 },
  epic: { label: 'Epic', colour: '#a78bfa', weight: 6, zone: .24, speed: 1.15, fill: .34, drain: .37 },
  legendary: { label: 'Legendary', colour: '#fbbf24', weight: 2.5, zone: .24, speed: 1.15, fill: .34, drain: .37 },
  mythic: { label: 'Mythic', colour: '#f472b6', weight: .5, zone: .22, speed: 1.3, fill: .30, drain: .37 },
};

const RARITY_ORDER: Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];
const WEATHER_FISH_WEIGHT = 2;
const WEATHER_MYTHIC_CHANCE = .015;

/** How long the float stays dipped. Long enough to react to without making the hook automatic. */
const BITE_WINDOW = 1500;
/**
 * Reeling is a stream of clicks, so the click that lands the fish is followed by more. The canvas
 * ignores them for this long, otherwise the next cast starts before the catch has been read.
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

/**
 * The player's own blobbling, drawn as the four cosmetic layers the game stores on them. In world
 * the game renders these through Rive, where only bottom, mid and top are images and the expression
 * drives a state machine input. A still composite of all four is close enough for a figure this
 * size and costs nothing beyond four image loads.
 */
const AVATAR_COLOURS = new Set(['Black', 'Blue', 'Gray', 'Green', 'Pink', 'Purple', 'Red', 'Yellow']);

function defaultAvatar(colour: string | undefined): string[] {
  const shade = colour && AVATAR_COLOURS.has(colour) ? colour : 'Gray';
  return [`Bottom_Default${shade}.png`, `Mid_Default${shade}.png`, `Top_Default${shade}.png`, 'Expression_Default.png'];
}

/** The game serves its assets from a versioned path, so the version is read from its own tags. */
let assetsBase: string | null = null;

function detectAssetsBase(): string | null {
  if (assetsBase) return assetsBase;
  const sources = [
    ...Array.from(document.scripts).map(script => script.src),
    ...Array.from(document.querySelectorAll<HTMLLinkElement>('link[href]')).map(link => link.href),
  ];
  for (const source of sources) {
    const match = source.match(/\/version\/([^/]+)\//);
    if (match?.[1]) return assetsBase = `https://magicgarden.gg/version/${match[1]}/assets/`;
  }
  return null;
}

const images = new Map<string, HTMLImageElement>();

/** Returns the image only once it can actually be drawn, so a pending load simply renders nothing. */
function readyImage(source: string): HTMLImageElement | null {
  let image = images.get(source);
  if (!image) {
    image = new Image();
    image.src = source;
    images.set(source, image);
  }
  return image.complete && image.naturalWidth > 0 ? image : null;
}

const footInsets = new Map<string, number>();

/**
 * How much transparent padding sits below the artwork, as a fraction of the image height. Sprites
 * are padded to their own frames, so standing one on the ground by its image box leaves it hovering.
 * Measuring the lowest opaque row is exact and self-correcting, where a fixed nudge is a guess that
 * only suits one sprite. Everything here is served from the game's own origin, so reading pixels
 * back is allowed; a failure just falls back to the image box.
 */
function footInset(image: HTMLImageElement, source: string): number {
  const cached = footInsets.get(source);
  if (cached !== undefined) return cached;
  let inset = 0;
  try {
    const probe = document.createElement('canvas');
    probe.width = image.naturalWidth;
    probe.height = image.naturalHeight;
    const context = probe.getContext('2d', { willReadFrequently: true });
    if (context) {
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, probe.width, probe.height).data;
      rows: for (let y = probe.height - 1; y >= 0; y--) {
        for (let x = 0; x < probe.width; x++) {
          if (pixels[(y * probe.width + x) * 4 + 3] > 8) {
            inset = (probe.height - 1 - y) / probe.height;
            break rows;
          }
        }
      }
    }
  } catch { inset = 0; }
  footInsets.set(source, inset);
  return inset;
}

/** Draws a sprite standing on `groundY`, centred on `x`, scaled so its artwork is `height` tall. */
function drawStanding(context: CanvasRenderingContext2D, image: HTMLImageElement, source: string, x: number, groundY: number, height: number, facing = 1): number {
  const inset = footInset(image, source);
  // `height` describes the visible artwork, so the whole frame has to be scaled up to compensate.
  const frameHeight = height / Math.max(.2, 1 - inset);
  const frameWidth = image.naturalWidth / image.naturalHeight * frameHeight;
  context.save();
  context.translate(x, groundY + frameHeight * inset);
  context.scale(facing < 0 ? -1 : 1, 1);
  context.drawImage(image, -frameWidth / 2, -frameHeight, frameWidth, frameHeight);
  context.restore();
  return frameWidth;
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
interface FishingRecord { casts: number; caught: number; escaped: number; fish: Record<string, CatchRecord> }

const EMPTY_RECORD: FishingRecord = { casts: 0, caught: 0, escaped: 0, fish: {} };

function loadRecord(): FishingRecord {
  const stored = loadLocal<Partial<FishingRecord>>(RECORD_KEY, {});
  return {
    casts: Number(stored.casts) || 0,
    caught: Number(stored.caught) || 0,
    escaped: Number(stored.escaped) || 0,
    fish: stored.fish && typeof stored.fish === 'object' ? stored.fish : {},
  };
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
    #${PANEL_ID} .gf-card{position:fixed;right:14px;bottom:56px;width:min(780px,94vw);display:flex;flex-direction:column;overflow:hidden;pointer-events:auto;user-select:none;touch-action:none;border:1px solid var(--gc-line,rgba(255,255,255,.075));border-radius:12px;background:var(--gc-bg,#0c0c11);box-shadow:0 30px 90px rgba(0,0,0,.8),inset 0 1px rgba(255,255,255,.035)}
    #${PANEL_ID} header{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;color:#fafafa;background:linear-gradient(180deg,rgba(255,255,255,.035),transparent);border-bottom:1px solid var(--gc-line,rgba(255,255,255,.075));cursor:move}
    #${PANEL_ID} h2{margin:0;font:700 13px/1.2 system-ui,sans-serif;letter-spacing:.02em}
    #${PANEL_ID} header div{display:flex;align-items:center;gap:4px}
    #${PANEL_ID} button{padding:5px 9px;border:1px solid var(--gc-line,rgba(255,255,255,.075));border-radius:6px;background:rgba(255,255,255,.03);color:var(--gc-text,#e4e4e7);font:700 10px system-ui,sans-serif;cursor:pointer}
    #${PANEL_ID} button:hover{color:#ddd6fe;border-color:rgba(167,139,250,.3);background:rgba(167,139,250,.1)}
    #${PANEL_ID} button[data-active=true]{color:#ddd6fe;border-color:rgba(167,139,250,.5);background:rgba(167,139,250,.16)}
    #${PANEL_ID} header button{width:26px;min-width:26px;height:26px;padding:0;border-radius:7px;color:var(--gc-muted,rgba(255,255,255,.72));font-size:12px}
    #${PANEL_ID} header button[data-close]{border-radius:50%;background:transparent}
    #${PANEL_ID} canvas{display:block;width:100%;height:min(420px,calc(100vh - 150px));cursor:pointer}
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

function centreOf(left: number, right: number): number {
  return (left + right) / 2;
}

/** A side-on fish: body, wagging tail, and an eye. Used for the scenery and the hooked fish alike. */
function drawSwimmer(context: CanvasRenderingContext2D, x: number, y: number, size: number, direction: number, colour: string, alpha: number, time: number): void {
  const wag = Math.sin(time / 170) * size * .3;
  context.save();
  context.translate(x, y);
  context.scale(direction < 0 ? -1 : 1, 1);
  context.globalAlpha = alpha;
  context.fillStyle = colour;
  context.beginPath();
  context.ellipse(0, 0, size, size * .54, 0, 0, Math.PI * 2);
  context.fill();
  context.beginPath();
  context.moveTo(-size * .8, 0);
  context.lineTo(-size * 1.7, -size * .52 + wag);
  context.lineTo(-size * 1.7, size * .52 + wag);
  context.closePath();
  context.fill();
  context.globalAlpha = alpha * .55;
  context.beginPath();
  context.moveTo(-size * .1, -size * .5);
  context.lineTo(size * .2, -size * .95);
  context.lineTo(size * .45, -size * .48);
  context.closePath();
  context.fill();
  context.globalAlpha = alpha;
  context.fillStyle = 'rgba(255,255,255,.8)';
  context.beginPath();
  context.arc(size * .48, -size * .13, Math.max(1, size * .11), 0, Math.PI * 2);
  context.fill();
  context.restore();
}

type Phase = 'idle' | 'waiting' | 'bite' | 'reel' | 'result';

export function initFishing(): void {
  let record = loadRecord();
  let view: 'game' | 'collection' | 'bench' = 'game';
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
  let lastCatch: { fish: FishDef; weight: number; fresh: boolean } | null = null;
  let testing = false;
  let reelStartedAt = 0;
  let fightEndedAt = 0;
  let draggableReady = false;
  let currentSceneWeather: FishingSceneWeather = 'Clear';
  let previousSceneWeather: FishingSceneWeather = 'Clear';
  let sceneWeatherChangedAt = 0;
  let sceneWeatherReady = false;

  // Idle scenery: a few fish drifting through the water so the pond is never still.
  interface Swimmer { x: number; y: number; speed: number; size: number; colour: string; phase: number }
  const SWIMMER_COLOURS = ['#4b7f96', '#3f6f86', '#5b8f7a', '#6b7f9c', '#7a8fa0'];
  const swimmers: Swimmer[] = Array.from({ length: 9 }, () => spawnSwimmer(Math.random()));

  // The player's active pets, milling about on the bank behind them.
  interface Walker { id: string; x: number; target: number; facing: number; phase: number; depth: number }
  let walkers: Walker[] = [];
  let walkerSignature = '';

  /** Looked up fresh each frame: the slot array is replaced wholesale on every game patch. */
  function walkerPet(id: string) {
    return (state.slot?.data?.petSlots ?? []).find(pet => pet.id === id);
  }

  function syncWalkers(): void {
    const pets = state.slot?.data?.petSlots ?? [];
    const signature = pets.map(pet => `${pet.id}:${pet.petSpecies}`).join(',');
    if (signature === walkerSignature) return;
    walkerSignature = signature;
    walkers = pets.filter(pet => pet.petSpecies && pet.id).map((pet, index) => ({
      id: pet.id,
      x: .12 + (index + .5) / Math.max(1, pets.length) * .7,
      target: .1 + Math.random() * .8,
      facing: 1,
      phase: Math.random() * Math.PI * 2,
      depth: Math.random(),
    }));
  }

  /**
   * The four cosmetic layers for our own player, falling back to the plain blobbling. The resolved
   * player id is used rather than the room's own field, which is not always populated.
   */
  function avatarLayers(): string[] {
    const room = state.room;
    const id = state.playerId || room?.selfPlayerId;
    const self = room?.players?.find(player => player.id === id);
    const avatar = self?.cosmetic?.avatar;
    return Array.isArray(avatar) && avatar.length === 4 && avatar.every(layer => typeof layer === 'string')
      ? avatar
      : defaultAvatar(self?.cosmetic?.color);
  }

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
  function canvas(): HTMLCanvasElement | null { return panel()?.querySelector('canvas') ?? null; }

  function weather(): string | null {
    const value = state.game?.weather;
    return typeof value === 'string' && value ? value : null;
  }

  function sceneWeatherLayers(now: number): Array<[FishingSceneWeather, number]> {
    if (!sceneWeatherReady && !state.game) return [['Clear', 1]];
    const live = fishingSceneWeather(weather());
    if (!sceneWeatherReady) {
      currentSceneWeather = live;
      previousSceneWeather = live;
      sceneWeatherChangedAt = now - WEATHER_TRANSITION;
      sceneWeatherReady = true;
    } else if (live !== currentSceneWeather) {
      previousSceneWeather = currentSceneWeather;
      currentSceneWeather = live;
      sceneWeatherChangedAt = now;
    }
    const progress = Math.min(1, Math.max(0, (now - sceneWeatherChangedAt) / WEATHER_TRANSITION));
    const blend = progress * progress * (3 - 2 * progress);
    return blend >= 1 || previousSceneWeather === currentSceneWeather
      ? [[currentSceneWeather, 1]]
      : [[previousSceneWeather, 1 - blend], [currentSceneWeather, blend]];
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
    zoneHeight = RARITIES[fish.rarity].zone;
    zoneAt = .5;
    zoneVelocity = 0;
    fishAt = .5;
    fishVelocity = 0;
    fishTarget = .5;
    retargetAt = now;
    progress = START_PROGRESS;
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
    reelEndsAt = now + REEL_LIMIT;
    setPhase('reel', `Test fight: ${fish.name}`);
    startLoop();
  }

  function beginReel(now: number): void {
    reelStartedAt = now;
    reelEndsAt = now + REEL_LIMIT;
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
    if (!testing) {
      record.fish[hooked.id] = {
        count: (existing?.count ?? 0) + 1,
        best: Math.max(existing?.best ?? 0, hookedWeight),
        first: existing?.first ?? Date.now(),
      };
      record.caught++;
      save();
    }
    const rule = RARITIES[hooked.rarity];
    lastCatch = { fish: hooked, weight: hookedWeight, fresh: !testing && !existing };
    playCatch(RARITY_ORDER.indexOf(hooked.rarity));
    const detail = testing
      ? `Test fight won in ${fightLength()} - not recorded`
      : `Landed a ${hooked.name}, ${formatWeight(hookedWeight)} in ${fightLength()}${existing ? '' : ' - new to your record!'}`;
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
    else if (phase === 'bite' && now - biteAt > BITE_WINDOW) lose('The bite went slack. It let go.');
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
      progress += (inside ? rule.fill : -rule.drain) * FIGHT_PACE * delta;
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
    syncWalkers();
    for (const walker of walkers) {
      const stride = walker.target - walker.x;
      // Close enough counts as arrived, otherwise a pet jitters on the spot forever.
      if (Math.abs(stride) < .012) {
        if (Math.random() < delta * .6) walker.target = .08 + Math.random() * .82;
      } else {
        const move = Math.sign(stride) * Math.min(Math.abs(stride), .11 * delta);
        walker.x += move;
        walker.facing = move > 0 ? 1 : -1;
      }
    }
    draw();
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

  function drawWeatherSky(
    context: CanvasRenderingContext2D,
    kind: FishingSceneWeather,
    opacity: number,
    now: number,
    left: number,
    right: number,
    top: number,
    surface: number,
  ): void {
    if (opacity <= 0) return;
    const width = right - left;
    const height = surface - top;
    context.save();
    context.globalAlpha = opacity;

    if (kind === 'Clear') {
      const x = left + width * .78;
      const y = top + 48;
      const glow = context.createRadialGradient(x, y, 2, x, y, 54);
      glow.addColorStop(0, 'rgba(226,232,240,.24)');
      glow.addColorStop(1, 'rgba(226,232,240,0)');
      context.fillStyle = glow;
      context.fillRect(x - 54, y - 54, 108, 108);
      context.fillStyle = 'rgba(226,232,240,.12)';
      context.beginPath();
      context.arc(x, y, 12, 0, Math.PI * 2);
      context.fill();
    } else if (kind === 'Dawn') {
      const dawn = context.createLinearGradient(0, top, 0, surface);
      dawn.addColorStop(0, 'rgba(84,62,108,.72)');
      dawn.addColorStop(.55, 'rgba(190,91,111,.55)');
      dawn.addColorStop(1, 'rgba(255,184,105,.68)');
      context.fillStyle = dawn;
      context.fillRect(left, top, width, height);
      const x = left + width * .76;
      const y = surface - 10;
      const glow = context.createRadialGradient(x, y, 2, x, y, 70);
      glow.addColorStop(0, 'rgba(255,238,173,.8)');
      glow.addColorStop(1, 'rgba(255,177,101,0)');
      context.fillStyle = glow;
      context.fillRect(x - 70, y - 70, 140, 100);
      context.fillStyle = '#ffe5a3';
      context.beginPath();
      context.arc(x, y, 14, Math.PI, Math.PI * 2);
      context.fill();
    } else if (kind === 'AmberMoon') {
      context.fillStyle = 'rgba(28,20,55,.72)';
      context.fillRect(left, top, width, height);
      context.fillStyle = 'rgba(255,231,171,.42)';
      for (let star = 0; star < 14; star++) {
        const x = left + 18 + (star * 67) % Math.max(20, width - 36);
        const y = top + 15 + (star * 29) % Math.max(20, height - 34);
        context.fillRect(x, y, star % 4 === 0 ? 1.5 : 1, star % 4 === 0 ? 1.5 : 1);
      }
      const x = left + width * .77;
      const y = top + 45;
      const glow = context.createRadialGradient(x, y, 4, x, y, 70);
      glow.addColorStop(0, 'rgba(251,191,36,.46)');
      glow.addColorStop(1, 'rgba(251,146,60,0)');
      context.fillStyle = glow;
      context.fillRect(x - 70, y - 70, 140, 140);
      context.fillStyle = '#e6a83c';
      context.beginPath();
      context.arc(x, y, 19, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = 'rgba(111,63,36,.24)';
      context.beginPath();
      context.arc(x - 6, y - 4, 4, 0, Math.PI * 2);
      context.arc(x + 7, y + 5, 3, 0, Math.PI * 2);
      context.fill();
    } else if (kind === 'Frost') {
      const frost = context.createLinearGradient(0, top, 0, surface);
      frost.addColorStop(0, 'rgba(118,151,177,.5)');
      frost.addColorStop(1, 'rgba(202,226,232,.44)');
      context.fillStyle = frost;
      context.fillRect(left, top, width, height);
      const x = left + width * .76;
      const y = top + 42;
      const glow = context.createRadialGradient(x, y, 2, x, y, 48);
      glow.addColorStop(0, 'rgba(240,249,255,.35)');
      glow.addColorStop(1, 'rgba(240,249,255,0)');
      context.fillStyle = glow;
      context.fillRect(x - 48, y - 48, 96, 96);
    } else {
      const thunder = kind === 'Thunderstorm';
      context.fillStyle = thunder ? 'rgba(5,11,25,.7)' : 'rgba(18,31,48,.48)';
      context.fillRect(left, top, width, height);
      context.fillStyle = thunder ? 'rgba(10,13,24,.82)' : 'rgba(42,53,66,.62)';
      const drift = now * (thunder ? .012 : .006);
      for (let cloud = 0; cloud < (thunder ? 5 : 4); cloud++) {
        const x = left - 60 + (cloud * 103 + drift) % (width + 120);
        const y = top + 18 + (cloud % 3) * 17;
        const size = 78 + (cloud % 2) * 24;
        context.beginPath();
        context.ellipse(x, y, size * .42, 13, 0, 0, Math.PI * 2);
        context.ellipse(x - size * .28, y + 5, size * .3, 10, 0, 0, Math.PI * 2);
        context.ellipse(x + size * .3, y + 4, size * .34, 11, 0, 0, Math.PI * 2);
        context.fill();
      }
    }
    context.restore();
  }

  function drawWeatherWater(
    context: CanvasRenderingContext2D,
    kind: FishingSceneWeather,
    opacity: number,
    now: number,
    left: number,
    right: number,
    surface: number,
    bottom: number,
  ): void {
    if (opacity <= 0 || kind === 'Clear') return;
    const width = right - left;
    context.save();
    context.globalAlpha = opacity;
    if (kind === 'Dawn' || kind === 'AmberMoon') {
      context.fillStyle = kind === 'Dawn' ? 'rgba(244,126,93,.16)' : 'rgba(230,168,60,.14)';
      context.fillRect(left, surface, width, bottom - surface);
      const centre = left + width * .76;
      context.fillStyle = kind === 'Dawn' ? 'rgba(255,211,145,.34)' : 'rgba(251,191,36,.3)';
      for (let reflection = 0; reflection < 9; reflection++) {
        const y = surface + 8 + reflection * 17;
        const span = 48 - reflection * 2 + Math.sin(now / 420 + reflection) * 9;
        context.fillRect(centre - span / 2, y, span, 1.5);
      }
    } else if (kind === 'Frost') {
      context.fillStyle = 'rgba(180,221,232,.18)';
      context.fillRect(left, surface, width, bottom - surface);
      context.strokeStyle = 'rgba(226,247,250,.58)';
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(left, surface + 1);
      for (let x = left; x <= right; x += 18) context.lineTo(x, surface + 1 + Math.sin(x * .1) * 1.5);
      context.stroke();
    } else {
      const thunder = kind === 'Thunderstorm';
      context.fillStyle = thunder ? 'rgba(2,10,20,.32)' : 'rgba(9,26,41,.2)';
      context.fillRect(left, surface, width, bottom - surface);
      context.strokeStyle = thunder ? 'rgba(174,210,224,.24)' : 'rgba(174,210,224,.14)';
      context.lineWidth = thunder ? 1.5 : 1;
      for (let wave = 0; wave < (thunder ? 10 : 7); wave++) {
        const y = surface + 10 + wave * 21;
        const x = left - 45 + (wave * 57 + now * (thunder ? .025 : .014)) % (width + 45);
        context.beginPath();
        context.moveTo(x, y);
        context.quadraticCurveTo(x + 24, y - (thunder ? 4 : 2), x + 52, y);
        context.stroke();
      }
    }
    context.restore();
  }

  function drawWeatherCliff(
    context: CanvasRenderingContext2D,
    kind: FishingSceneWeather,
    opacity: number,
    cliff: Path2D,
  ): void {
    if (opacity <= 0 || kind === 'Clear') return;
    context.save();
    context.globalAlpha = opacity;
    context.fillStyle = kind === 'Frost'
      ? 'rgba(188,221,225,.22)'
      : kind === 'Rain' || kind === 'Thunderstorm'
        ? 'rgba(5,18,28,.24)'
        : kind === 'Dawn'
          ? 'rgba(196,97,65,.09)'
          : 'rgba(191,116,35,.1)';
    context.fill(cliff);
    context.restore();
  }

  function drawWeatherForeground(
    context: CanvasRenderingContext2D,
    kind: FishingSceneWeather,
    opacity: number,
    now: number,
    left: number,
    right: number,
    top: number,
    bottom: number,
  ): void {
    if (opacity <= 0) return;
    const width = right - left;
    const height = bottom - top;
    context.save();

    if (kind === 'Thunderstorm') {
      const cycle = now % 7200;
      const flash = cycle < 110 ? 1 - cycle / 110 : cycle > 190 && cycle < 270 ? 1 - (cycle - 190) / 80 : 0;
      if (flash > 0) {
        context.globalAlpha = opacity * flash * .16;
        context.fillStyle = '#dbeafe';
        context.fillRect(left, top, width, height);
        context.globalAlpha = opacity * flash * .82;
        context.strokeStyle = '#eef6ff';
        context.lineWidth = 2;
        const x = left + width * .72;
        context.beginPath();
        context.moveTo(x, top + 8);
        context.lineTo(x - 10, top + 35);
        context.lineTo(x + 2, top + 32);
        context.lineTo(x - 13, top + 64);
        context.stroke();
      }
    }

    if (kind === 'Rain' || kind === 'Thunderstorm') {
      const thunder = kind === 'Thunderstorm';
      context.globalAlpha = opacity;
      context.strokeStyle = thunder ? 'rgba(203,225,239,.42)' : 'rgba(186,220,237,.3)';
      context.lineWidth = thunder ? 1.2 : 1;
      const count = thunder ? 52 : 34;
      for (let drop = 0; drop < count; drop++) {
        const x = left + (drop * 71 + now * (thunder ? .028 : .018)) % width;
        const y = top + (drop * 37 + now * (thunder ? .36 : .24)) % height;
        context.beginPath();
        context.moveTo(x, y);
        context.lineTo(x - (thunder ? 6 : 4), y + (thunder ? 15 : 11));
        context.stroke();
      }
    } else if (kind === 'Frost') {
      context.globalAlpha = opacity;
      context.fillStyle = 'rgba(240,249,255,.72)';
      for (let flake = 0; flake < 28; flake++) {
        const x = left + (flake * 53 + now * (.006 + (flake % 3) * .002)) % width;
        const y = top + (flake * 31 + now * (.018 + (flake % 4) * .004)) % height;
        const size = .8 + (flake % 3) * .45;
        context.beginPath();
        context.arc(x + Math.sin(now / 900 + flake) * 5, y, size, 0, Math.PI * 2);
        context.fill();
      }
    }
    context.restore();
  }

  function draw(): void {
    const element = canvas();
    const context = element?.getContext('2d');
    if (!element || !context) return;
    const ratio = Math.min(3, window.devicePixelRatio || 1);
    const width = element.clientWidth;
    const height = element.clientHeight;
    if (element.width !== Math.round(width * ratio) || element.height !== Math.round(height * ratio)) {
      element.width = Math.round(width * ratio);
      element.height = Math.round(height * ratio);
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    const now = performance.now();
    const atmosphereLayers = sceneWeatherLayers(now);
    const top = 12;
    const bottom = height - 12;
    const trackHeight = bottom - top;
    const sceneLeft = 12;
    const trackX = width - 64;
    const trackWidth = 26;
    const barX = width - 28;
    // The gauges get their own column so a fight is never read against moving water.
    const sceneRight = trackX - 14;

    // Side-on lake: a bank on the left and a dock reaching out over the water.
    const surface = Math.round(top + trackHeight * .39);
    const bankRight = Math.round(sceneLeft + (sceneRight - sceneLeft) * .32);
    const ground = surface - 3;
    const shoreEdge = bankRight - 34;
    const dockStart = shoreEdge - 34;
    const dockEnd = bankRight + 38;
    const deckTop = ground - 7;

    context.save();
    context.beginPath();
    context.roundRect(sceneLeft, top, sceneRight - sceneLeft, trackHeight, 8);
    context.clip();

    const sky = context.createLinearGradient(0, top, 0, surface);
    sky.addColorStop(0, '#141420');
    sky.addColorStop(1, '#243044');
    context.fillStyle = sky;
    context.fillRect(sceneLeft, top, sceneRight - sceneLeft, surface - top);

    // Slow clouds give the base sky depth while the live weather supplies its light and colour.
    const sceneWidth = sceneRight - sceneLeft;
    context.fillStyle = 'rgba(203,213,225,.07)';
    for (const [cloudX, cloudY, cloudWidth] of [[.45, .2, 74], [.68, .38, 92]] as const) {
      const x = sceneLeft + sceneWidth * cloudX;
      const y = top + (surface - top) * cloudY;
      context.beginPath();
      context.ellipse(x, y, cloudWidth * .34, 8, 0, 0, Math.PI * 2);
      context.ellipse(x - cloudWidth * .22, y + 2, cloudWidth * .25, 6, 0, 0, Math.PI * 2);
      context.ellipse(x + cloudWidth * .25, y + 2, cloudWidth * .28, 7, 0, 0, Math.PI * 2);
      context.fill();
    }
    for (const [kind, opacity] of atmosphereLayers) {
      drawWeatherSky(context, kind, opacity, now, sceneLeft, sceneRight, top, surface);
    }

    // Two distant ridges sit behind the far shore and fade into the evening haze.
    context.fillStyle = 'rgba(35,49,65,.62)';
    context.beginPath();
    context.moveTo(sceneLeft, surface);
    context.lineTo(sceneLeft, surface - 14);
    context.lineTo(sceneLeft + sceneWidth * .18, surface - 58);
    context.lineTo(sceneLeft + sceneWidth * .34, surface - 24);
    context.lineTo(sceneLeft + sceneWidth * .53, surface - 72);
    context.lineTo(sceneLeft + sceneWidth * .72, surface - 20);
    context.lineTo(sceneRight, surface - 46);
    context.lineTo(sceneRight, surface);
    context.closePath();
    context.fill();
    context.fillStyle = 'rgba(18,34,43,.7)';
    context.beginPath();
    context.moveTo(sceneLeft, surface);
    context.lineTo(sceneLeft + sceneWidth * .16, surface - 24);
    context.lineTo(sceneLeft + sceneWidth * .31, surface - 10);
    context.lineTo(sceneLeft + sceneWidth * .48, surface - 35);
    context.lineTo(sceneLeft + sceneWidth * .66, surface - 12);
    context.lineTo(sceneLeft + sceneWidth * .84, surface - 30);
    context.lineTo(sceneRight, surface - 12);
    context.lineTo(sceneRight, surface);
    context.closePath();
    context.fill();

    // A low treeline so the far side of the lake reads as distance rather than a flat edge.
    context.fillStyle = 'rgba(14,26,30,.85)';
    context.beginPath();
    context.moveTo(sceneLeft, surface);
    for (let x = sceneLeft; x <= sceneRight; x += 14) {
      const roll = Math.sin(x * .07) + Math.sin(x * .017 + 2.1);
      context.lineTo(x, surface - 9 - roll * 4);
    }
    context.lineTo(sceneRight, surface);
    context.closePath();
    context.fill();

    const water = context.createLinearGradient(0, surface, 0, bottom);
    water.addColorStop(0, '#12455e');
    water.addColorStop(.35, '#0c3145');
    water.addColorStop(1, '#05121b');
    context.fillStyle = water;
    context.fillRect(sceneLeft, surface, sceneRight - sceneLeft, bottom - surface);
    context.fillStyle = 'rgba(148,210,226,.08)';
    for (let line = 0; line < 6; line++) {
      const y = surface + 18 + line * 31;
      const x = dockEnd + 20 + (line % 2) * 27;
      context.fillRect(x, y, Math.max(24, sceneRight - x - 38 - line * 8), 1);
    }
    for (const [kind, opacity] of atmosphereLayers) {
      drawWeatherWater(context, kind, opacity, now, sceneLeft, sceneRight, surface, bottom);
    }

    // The bank and dock are drawn later, so fish pass beneath the dock and disappear naturally
    // behind the irregular shoreline instead of being cut off by a straight clipping boundary.
    for (const swimmer of swimmers) {
      const x = shoreEdge + swimmer.x * (sceneRight - shoreEdge);
      const y = surface + 16 + swimmer.y * (bottom - surface - 26) + Math.sin(now / 900 + swimmer.phase) * 3;
      drawSwimmer(context, x, y, swimmer.size, Math.sign(swimmer.speed), swimmer.colour, .45, now + swimmer.phase * 400);
    }

    // Everything hanging off the line shares these, so the float, hook and fish stay attached.
    const safeCastDistance = Math.max(0, Math.min(1, castDistance));
    const safeHookDepth = Math.max(0, Math.min(1, hookDepth));
    const anchorX = Math.round(dockEnd + (sceneRight - dockEnd) * safeCastDistance);
    const castElapsed = now - castAt;
    const casting = phase === 'waiting' && castElapsed < CAST_WINDUP + CAST_FLIGHT;
    const hooking = phase === 'reel' && Boolean(hooked);
    const fishSize = hooked ? 12 + RARITY_ORDER.indexOf(hooked.rarity) * 3.5 : 12;
    const fishFacing = Math.cos(now / 640) > 0 ? 1 : -1;
    const fishX = hooking ? anchorX + Math.sin(now / 640) * (sceneRight - dockEnd) * .13 : anchorX;
    const fishY = hooking ? surface + 22 + fishAt * (bottom - surface - 40) : surface + 58;
    // The hook rides in the fish's mouth during a fight, so the whole line follows the fish.
    const hookX = hooking ? fishX + fishFacing * fishSize * .95 : anchorX;
    const hookY = hooking
      ? fishY
      : surface + 18 + safeHookDepth * (bottom - surface - 36) + Math.sin(now / 1100) * 3;
    // A fought fish drags the float toward it rather than leaving it parked mid-lake.
    const floatX = hooking ? Math.round(anchorX + (fishX - anchorX) * .5) : anchorX;
    const bobBase = surface + (phase === 'bite' ? 7 : 0);
    const bob = phase === 'waiting' ? Math.sin(now / 420) * 2 : phase === 'bite' ? Math.sin(now / 55) * 3 : 0;

    if (phase !== 'idle' && phase !== 'result' && !casting) {
      // Tippet from the float down to the hook, then the hook itself.
      context.strokeStyle = 'rgba(255,255,255,.3)';
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(floatX, bobBase + bob);
      context.quadraticCurveTo((floatX + hookX) / 2, (bobBase + hookY) / 2, hookX, hookY);
      context.stroke();
      context.strokeStyle = 'rgba(226,232,240,.85)';
      context.lineWidth = 1.6;
      context.beginPath();
      context.moveTo(hookX, hookY - 7);
      context.lineTo(hookX, hookY);
      context.arc(hookX - 2.6, hookY, 2.6, 0, Math.PI * .9, false);
      context.stroke();
    }

    if (hooking && hooked) {
      // The fight in the water mirrors the track, so the fish you are pulling on is visible.
      drawSwimmer(context, fishX, fishY, fishSize, fishFacing, RARITIES[hooked.rarity].colour, .85, now);
    } else if (phase === 'bite') {
      // Something has come up to take it: a dark shape nosing the hook, not yet identifiable.
      const nose = Math.sin(now / 90) * 4;
      drawSwimmer(context, hookX + 16 + nose, hookY + 3, 13, -1, 'rgba(12,26,34,.95)', .9, now);
    } else if (phase === 'waiting' && !casting) {
      context.fillStyle = 'rgba(255,255,255,.35)';
      context.beginPath();
      context.arc(hookX - 1, hookY + 1, 1.6, 0, Math.PI * 2);
      context.fill();
    }

    // The natural bank ends behind the dock, leaving open water beneath the angler.
    const cliff = new Path2D();
    cliff.moveTo(sceneLeft, ground - 6);
    for (let x = sceneLeft; x <= shoreEdge; x += 10) {
      cliff.lineTo(x, ground - 6 + Math.sin(x * .05) * 1.6 + (x - sceneLeft) / (shoreEdge - sceneLeft) * 5);
    }
    cliff.lineTo(shoreEdge + 3, ground + 4);
    cliff.bezierCurveTo(shoreEdge - 2, ground + 18, shoreEdge - 20, ground + 32, shoreEdge - 24, ground + 58);
    cliff.bezierCurveTo(shoreEdge - 36, ground + 92, shoreEdge - 20, bottom - 30, shoreEdge - 30, bottom);
    cliff.lineTo(sceneLeft, bottom);
    cliff.closePath();
    const bank = context.createLinearGradient(0, ground - 10, 0, bottom);
    bank.addColorStop(0, '#36532f');
    bank.addColorStop(.13, '#2a3f25');
    bank.addColorStop(.28, '#3a3025');
    bank.addColorStop(.62, '#251b14');
    bank.addColorStop(1, '#120d09');
    context.fillStyle = bank;
    context.fill(cliff);
    context.save();
    context.clip(cliff);
    context.strokeStyle = 'rgba(152,119,82,.16)';
    context.lineWidth = 2;
    for (let ledge = 0; ledge < 5; ledge++) {
      const y = ground + 30 + ledge * 42;
      context.beginPath();
      context.moveTo(sceneLeft + 18 + (ledge % 2) * 12, y);
      context.bezierCurveTo(shoreEdge - 55, y - 9, shoreEdge - 34, y + 10, shoreEdge - 12, y - 4);
      context.stroke();
    }
    context.restore();
    context.strokeStyle = 'rgba(120,180,110,.35)';
    context.lineWidth = 1.5;
    context.beginPath();
    for (let x = sceneLeft; x <= shoreEdge; x += 10) {
      const y = ground - 6 + Math.sin(x * .05) * 1.6 + (x - sceneLeft) / (shoreEdge - sceneLeft) * 5;
      if (x === sceneLeft) context.moveTo(x, y); else context.lineTo(x, y);
    }
    context.stroke();
    // Grass softens the shoreline behind the dock without hiding the pets.
    context.strokeStyle = 'rgba(134,190,112,.42)';
    context.lineWidth = 1;
    for (let x = sceneLeft + 8; x < shoreEdge; x += 13) {
      const y = ground - 7 + Math.sin(x * .05) * 1.6 + (x - sceneLeft) / (shoreEdge - sceneLeft) * 5;
      context.beginPath();
      context.moveTo(x, y);
      context.lineTo(x - 2, y - 5 - (x % 3));
      context.moveTo(x, y);
      context.lineTo(x + 3, y - 4);
      context.stroke();
    }
    for (const [kind, opacity] of atmosphereLayers) drawWeatherCliff(context, kind, opacity, cliff);

    // Timber posts disappear into the lake, then the deck and individual planks sit over them.
    const postBottom = Math.max(deckTop + 14, bottom - 20);
    context.fillStyle = '#3a281b';
    for (const postX of [shoreEdge + 14, dockEnd - 14]) {
      context.fillRect(postX - 4, deckTop + 8, 8, postBottom - deckTop - 8);
      context.fillStyle = 'rgba(10,18,20,.28)';
      context.fillRect(postX - 4, surface + 20, 8, Math.max(0, postBottom - surface - 20));
      context.fillStyle = '#3a281b';
    }
    context.fillStyle = 'rgba(11,18,20,.42)';
    context.fillRect(dockStart, deckTop + 8, dockEnd - dockStart, 6);
    const timber = context.createLinearGradient(0, deckTop, 0, deckTop + 12);
    timber.addColorStop(0, '#9a7045');
    timber.addColorStop(.55, '#765132');
    timber.addColorStop(1, '#51351f');
    context.fillStyle = timber;
    context.fillRect(dockStart, deckTop, dockEnd - dockStart, 11);
    context.strokeStyle = 'rgba(35,22,13,.55)';
    context.lineWidth = 1;
    for (let plank = dockStart + 15; plank < dockEnd; plank += 17) {
      context.beginPath();
      context.moveTo(plank, deckTop);
      context.lineTo(plank, deckTop + 11);
      context.stroke();
    }
    context.strokeStyle = 'rgba(242,196,125,.2)';
    context.beginPath();
    context.moveTo(dockStart, deckTop + 2);
    context.lineTo(dockEnd, deckTop + 2);
    context.stroke();
    for (const [kind, opacity] of atmosphereLayers) {
      if (kind === 'Clear') continue;
      context.save();
      context.globalAlpha = opacity;
      context.fillStyle = kind === 'Frost'
        ? 'rgba(218,239,239,.38)'
        : kind === 'Rain' || kind === 'Thunderstorm'
          ? 'rgba(9,21,29,.28)'
          : kind === 'Dawn'
            ? 'rgba(211,111,70,.14)'
            : 'rgba(207,136,41,.16)';
      context.fillRect(dockStart, deckTop, dockEnd - dockStart, kind === 'Frost' ? 4 : 11);
      context.restore();
    }

    const anglerX = Math.round(dockEnd - 26);
    const anglerY = deckTop + 1;
    const petLeft = sceneLeft + 18;
    const petClearance = 18;
    const petRight = Math.min(dockStart, anglerX) - petClearance;

    // Active pets wander behind the angler, with their range ending before they can crowd them.
    for (const walker of [...walkers].sort((a, b) => a.depth - b.depth)) {
      const pet = walkerPet(walker.id);
      const source = pet ? petSpriteSource(pet) : undefined;
      const image = source ? readyImage(source) : null;
      if (!image || !source) continue;
      const x = petLeft + walker.x * Math.max(1, petRight - petLeft);
      const y = ground + 4 + walker.depth * 16;
      const height = 32 + walker.depth * 7;
      context.save();
      context.globalAlpha = .32;
      context.fillStyle = '#000';
      context.beginPath();
      context.ellipse(x, y, height * .34, 3, 0, 0, Math.PI * 2);
      context.fill();
      context.restore();
      context.save();
      context.translate(0, Math.sin(now / 500 + walker.phase) * 1.5);
      drawStanding(context, image, source, x, y, height, walker.facing);
      context.restore();
    }

    // The angler: our own blobbling, with a rod arcing out over the water.
    const sway = Math.sin(now / 1100) * 1.5;
    const layers = avatarLayers();
    const base = detectAssetsBase();
    const avatarHeight = 68;
    if (base) {
      context.save();
      context.globalAlpha = .35;
      context.fillStyle = '#000';
      context.beginPath();
      context.ellipse(anglerX, anglerY, 17, 4, 0, 0, Math.PI * 2);
      context.fill();
      context.restore();
      // Every layer is drawn into the same frame with the same anchor. Scaling each to its own
      // height would let a hat or an expression drift out of register with the body beneath it.
      const bottomSource = `${base}cosmetic/${layers[0]}`;
      const bottomImage = readyImage(bottomSource);
      if (bottomImage) {
        const inset = footInset(bottomImage, bottomSource);
        const frameHeight = avatarHeight / Math.max(.2, 1 - inset);
        const frameTop = anglerY + frameHeight * inset - frameHeight + sway;
        for (const layer of layers) {
          const image = readyImage(`${base}cosmetic/${layer}`);
          if (!image) continue;
          const frameWidth = image.naturalWidth / image.naturalHeight * frameHeight;
          context.drawImage(image, anglerX - frameWidth / 2, frameTop, frameWidth, frameHeight);
        }
      }
    }

    // Rod and line. The rod loads toward the water while a fish is on.
    const handX = anglerX + 14;
    const handY = anglerY - avatarHeight * .52 + sway;
    const load = phase === 'reel' ? 16 : phase === 'bite' ? 8 : 0;
    let tipX = dockEnd + 34 + load;
    let tipY = top + 34 + load * 1.4;
    // The cast: the rod is taken back, whipped forward past its rest, then settles.
    if (casting) {
      const back = castElapsed < CAST_WINDUP
        ? castElapsed / CAST_WINDUP
        : 1 - (1 - Math.pow(1 - (castElapsed - CAST_WINDUP) / CAST_FLIGHT, 3));
      const whip = castElapsed < CAST_WINDUP ? 0 : Math.sin(Math.PI * (castElapsed - CAST_WINDUP) / CAST_FLIGHT);
      tipX += -52 * back + 20 * whip;
      tipY += 34 * back - 12 * whip;
    }
    context.strokeStyle = '#c8a06a';
    context.lineWidth = 2.5;
    context.beginPath();
    context.moveTo(handX, handY);
    context.quadraticCurveTo(handX + (tipX - handX) * .4, handY - 46 - load * .4, tipX, tipY);
    context.stroke();

    if (casting) {
      // Mid-cast the float is in the air, so the line runs taut to it rather than sagging to water.
      const travel = Math.max(0, (castElapsed - CAST_WINDUP) / CAST_FLIGHT);
      const flyX = tipX + (anchorX - tipX) * travel;
      const flyY = tipY + (surface - tipY) * travel - Math.sin(Math.PI * travel) * 52;
      context.strokeStyle = 'rgba(255,255,255,.4)';
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(tipX, tipY);
      context.lineTo(flyX, flyY);
      context.stroke();
      context.fillStyle = '#e4e4e7';
      context.beginPath();
      context.arc(flyX, flyY, 4.5, 0, Math.PI * 2);
      context.fill();
    } else if (phase !== 'idle' && phase !== 'result') {
      context.strokeStyle = 'rgba(255,255,255,.4)';
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(tipX, tipY);
      context.quadraticCurveTo((tipX + floatX) / 2, (tipY + bobBase) / 2 + 12, floatX, bobBase + bob);
      context.stroke();
      for (let ring = 0; ring < 3; ring++) {
        const wave = (now / 900 + ring / 3) % 1;
        context.strokeStyle = `rgba(255,255,255,${(.2 * (1 - wave)).toFixed(3)})`;
        context.beginPath();
        context.ellipse(floatX, bobBase + bob + 2, 6 + wave * 40, 2 + wave * 7, 0, 0, Math.PI * 2);
        context.stroke();
      }
      context.fillStyle = phase === 'bite' ? '#f87171' : '#e4e4e7';
      context.beginPath();
      context.arc(floatX, bobBase + bob, 5, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = 'rgba(0,0,0,.35)';
      context.beginPath();
      context.arc(floatX, bobBase + bob + 2, 5, 0, Math.PI);
      context.fill();
    }
    for (const [kind, opacity] of atmosphereLayers) {
      drawWeatherForeground(context, kind, opacity, now, sceneLeft, sceneRight, top, bottom);
    }
    context.restore();

    context.strokeStyle = 'rgba(255,255,255,.09)';
    context.lineWidth = 1;
    context.beginPath();
    context.roundRect(sceneLeft + .5, top + .5, sceneRight - sceneLeft - 1, trackHeight - 1, 8);
    context.stroke();

    const centre = centreOf(sceneLeft, trackX);

    // The catch stays on screen until the next cast, so a fast reeler still sees what they landed.
    if (phase === 'result' && lastCatch) {
      const rule = RARITIES[lastCatch.fish.rarity];
      const cardWidth = Math.min(250, sceneRight - 40);
      const cardHeight = 96;
      const cardX = centre - cardWidth / 2;
      const cardY = Math.round(top + (trackHeight - cardHeight) / 2);
      context.fillStyle = 'rgba(8,8,12,.9)';
      context.strokeStyle = rule.colour;
      context.lineWidth = 1.5;
      context.beginPath();
      context.roundRect(cardX, cardY, cardWidth, cardHeight, 10);
      context.fill();
      context.stroke();
      drawSwimmer(context, cardX + 34, cardY + 34, 15, 1, rule.colour, 1, now);
      context.textAlign = 'left';
      context.fillStyle = rule.colour;
      context.font = '700 9px system-ui,sans-serif';
      context.fillText(rule.label.toUpperCase(), cardX + 62, cardY + 22);
      context.fillStyle = '#fafafa';
      context.font = '700 14px system-ui,sans-serif';
      context.fillText(lastCatch.fish.name, cardX + 62, cardY + 40);
      context.fillStyle = 'rgba(255,255,255,.72)';
      context.font = '600 12px system-ui,sans-serif';
      context.fillText(formatWeight(lastCatch.weight), cardX + 62, cardY + 58);
      if (lastCatch.fresh) {
        context.fillStyle = '#34d399';
        context.font = '700 9px system-ui,sans-serif';
        context.fillText('NEW SPECIES', cardX + 62, cardY + 74);
      }
      context.textAlign = 'center';
      context.fillStyle = 'rgba(255,255,255,.4)';
      context.font = '400 10px system-ui,sans-serif';
      context.fillText(now < resultLockUntil ? 'Reading the tape...' : 'Click to cast again', centre, cardY + cardHeight + 18);
    }

    // The status sits in its own corner of the sky, where nothing in the scene can run into it.
    context.textAlign = 'left';
    context.font = '700 11px system-ui,sans-serif';
    context.fillStyle = phase === 'bite' ? '#fca5a5' : 'rgba(255,255,255,.62)';
    const heading = phase === 'idle' ? 'Click to cast' : phase === 'waiting' ? 'Waiting...' : phase === 'bite' ? 'BITE!' : phase === 'reel' ? 'Hold to reel' : 'Click to cast again';
    context.fillText(heading, sceneLeft + 14, top + 22);

    // A draining bar during the bite, so the window you have to react in is something you can see.
    if (phase === 'bite') {
      const left = Math.max(0, 1 - (now - biteAt) / BITE_WINDOW);
      const barWidth = 86;
      context.fillStyle = 'rgba(255,255,255,.12)';
      context.beginPath();
      context.roundRect(sceneLeft + 14, top + 28, barWidth, 4, 2);
      context.fill();
      context.fillStyle = '#f87171';
      context.beginPath();
      context.roundRect(sceneLeft + 14, top + 28, barWidth * left, 4, 2);
      context.fill();
    }

    // A bench fight is marked on the canvas itself, so a test can never be mistaken for a catch.
    if (testing && (phase === 'reel' || phase === 'result')) {
      const label = hooked ? `TEST  ${hooked.name}  ${fightLength()}` : 'TEST';
      context.font = '700 9px system-ui,sans-serif';
      const badgeWidth = context.measureText(label).width + 16;
      context.fillStyle = 'rgba(251,191,36,.16)';
      context.strokeStyle = 'rgba(251,191,36,.5)';
      context.lineWidth = 1;
      context.beginPath();
      context.roundRect(trackX - badgeWidth - 14, top + 10, badgeWidth, 18, 5);
      context.fill();
      context.stroke();
      context.fillStyle = '#fbbf24';
      context.fillText(label, trackX - badgeWidth - 6, top + 22);
    }
    context.textAlign = 'center';

    // Track: the fish runs up and down it, the hook zone is what you steer.
    context.fillStyle = 'rgba(255,255,255,.02)';
    context.strokeStyle = 'rgba(255,255,255,.07)';
    context.lineWidth = 1;
    context.beginPath();
    context.roundRect(trackX - 8.5, top + .5, barX - trackX + 28, trackHeight - 1, 8);
    context.fill();
    context.stroke();
    context.fillStyle = 'rgba(255,255,255,.05)';
    context.beginPath();
    context.roundRect(trackX, top, trackWidth, trackHeight, 8);
    context.fill();
    if (phase === 'reel' && hooked) {
      const rule = RARITIES[hooked.rarity];
      const half = zoneHeight / 2;
      const inside = Math.abs(fishAt - zoneAt) < half;
      context.fillStyle = inside ? 'rgba(52,211,153,.28)' : 'rgba(255,255,255,.10)';
      context.beginPath();
      context.roundRect(trackX + 2, top + (zoneAt - half) * trackHeight, trackWidth - 4, zoneHeight * trackHeight, 6);
      context.fill();
      context.fillStyle = rule.colour;
      context.beginPath();
      context.arc(trackX + trackWidth / 2, top + fishAt * trackHeight, 6, 0, Math.PI * 2);
      context.fill();
    }

    context.fillStyle = 'rgba(255,255,255,.05)';
    context.beginPath();
    context.roundRect(barX, top, 12, trackHeight, 6);
    context.fill();
    const filled = Math.max(0, Math.min(1, progress));
    if (phase === 'reel' && filled > 0) {
      context.fillStyle = hooked ? RARITIES[hooked.rarity].colour : '#34d399';
      context.beginPath();
      context.roundRect(barX, bottom - filled * trackHeight, 12, filled * trackHeight, 6);
      context.fill();
    }
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
    return `<div class="gf-body"><p class="gf-note">Fish with a weather listed bite in that weather and no other. Caught fish are recorded in this browser only - nothing here touches your garden.</p><div class="gf-totals"><div><small>Caught</small><b>${record.caught.toLocaleString()}</b></div><div><small>Species</small><b>${found}/${FISH.length}</b></div><div><small>Casts</small><b>${record.casts.toLocaleString()}</b></div></div>${sections}<div class="gf-reset"><button data-reset>Reset record</button></div></div>`;
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

  /**
   * The canvas is the only control. A separate Cast button invites the reader to hold it to reel,
   * which it could never do, so casting lives on the same surface as everything else.
   */
  function gameHtml(): string {
    return `<canvas data-no-drag></canvas><div class="gf-status"><b style="color:${resultColour}">${escapeHtml(message)}</b><small>${escapeHtml(weatherLabel(weather()))}</small></div>`;
  }

  function renderChrome(): void {
    const host = panel();
    if (!host || host.hidden) return;
    const card = host.querySelector<HTMLElement>('.gf-card');
    if (!card) return;
    const quiet = fishingMuted();
    const body = view === 'collection' ? collectionHtml() : view === 'bench' ? benchHtml() : gameHtml();
    card.innerHTML = `<header><h2>&#127907; Fishing</h2><div><button data-mute title="${quiet ? 'Sound off' : 'Sound on'}">${quiet ? '&#128263;' : '&#128266;'}</button><button data-view="collection" data-active="${view === 'collection'}" title="Catch record">&#128220;</button><button data-close aria-label="Close">&#10005;</button></div></header>${body}`;
    card.querySelector<HTMLButtonElement>('[data-close]')!.onclick = close;
    card.querySelector<HTMLButtonElement>('[data-mute]')!.onclick = () => {
      setFishingMuted(!quiet);
      if (quiet) primeFishingAudio();
      renderChrome();
    };
    card.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(button => button.onclick = () => {
      const target = button.dataset.view as 'collection' | 'bench';
      view = view === target ? 'game' : target;
      renderChrome();
      if (view === 'game') resumeLoop();
      else pauseLoop();
    });
    card.querySelectorAll<HTMLButtonElement>('[data-fight]').forEach(button => button.onclick = () => {
      const fish = FISH_BY_ID.get(button.dataset.fight!);
      if (fish) startBenchFight(fish);
    });
    card.querySelector<HTMLButtonElement>('[data-reset]')?.addEventListener('click', () => {
      if (!confirm('Clear your fishing record? Every catch is forgotten.')) return;
      record = { ...EMPTY_RECORD, fish: {} };
      save();
      renderChrome();
    });
    const element = card.querySelector<HTMLCanvasElement>('canvas');
    if (element) {
      // The pointer is captured for the whole pull, so sliding off the canvas mid-reel does not
      // silently drop the hold and hand the fish back.
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
    if (view === 'game') draw();
  }

  function open(): void {
    const host = panel();
    if (!host) return;
    host.hidden = false;
    primeFishingAudio();
    renderChrome();
    if (!draggableReady) {
      const card = host.querySelector<HTMLElement>('.gf-card');
      if (card) {
        makeDraggable(card, POSITION_KEY);
        draggableReady = true;
      }
    }
    if (view === 'game') resumeLoop();
    else pauseLoop();
  }

  function close(): void {
    const host = panel();
    if (host) host.hidden = true;
    pauseLoop();
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
    host.appendChild(card);
    document.body.appendChild(host);
    // Everything inside the card is ours: no click, drag or scroll may reach the game beneath it,
    // so a stray reel does not move a plant or harvest a crop.
    for (const type of ['pointerdown', 'pointerup', 'pointermove', 'pointercancel', 'mousedown', 'mouseup', 'click', 'dblclick', 'wheel', 'contextmenu']) {
      card.addEventListener(type, event => event.stopPropagation());
    }
    window.addEventListener('pointerup', release);
    page.__gardenCompanionToggleFishing = () => (panel()?.hidden ? open() : close());
    // Published so the bench can be reached from the console without a button in the panel.
    page.__gardenCompanionFishingBench = () => {
      view = 'bench';
      open();
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
}
