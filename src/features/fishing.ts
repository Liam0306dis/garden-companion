import { page } from '../page.js';
import { state } from '../state.js';
import { makeDraggable } from '../draggable.js';
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
  common: { label: 'Common', colour: '#94a3b8', weight: 100, zone: .26, speed: 1, fill: .40, drain: .38 },
  uncommon: { label: 'Uncommon', colour: '#34d399', weight: 58, zone: .26, speed: 1.02, fill: .39, drain: .38 },
  rare: { label: 'Rare', colour: '#38bdf8', weight: 26, zone: .25, speed: 1.08, fill: .37, drain: .375 },
  epic: { label: 'Epic', colour: '#a78bfa', weight: 10, zone: .24, speed: 1.15, fill: .34, drain: .37 },
  legendary: { label: 'Legendary', colour: '#fbbf24', weight: 3.2, zone: .24, speed: 1.15, fill: .34, drain: .37 },
  mythic: { label: 'Mythic', colour: '#f472b6', weight: .8, zone: .22, speed: 1.3, fill: .30, drain: .37 },
};

const RARITY_ORDER: Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];

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
  { id: 'stormfinMarlin', name: 'Stormfin Marlin', rarity: 'epic', min: 12, max: 34, weather: 'Thunderstorm', note: 'Runs ahead of the weather front.' },
  { id: 'frostbellySturgeon', name: 'Frostbelly Sturgeon', rarity: 'epic', min: 15, max: 40, weather: 'Frost', note: 'Older than the pond it swims in.' },
  { id: 'dawnlitAngelfish', name: 'Dawnlit Angelfish', rarity: 'epic', min: 8, max: 22, weather: 'Dawn', note: 'Only surfaces while the light is thin.' },
  { id: 'amberscaleTuna', name: 'Amberscale Tuna', rarity: 'epic', min: 18, max: 46, weather: 'AmberMoon', note: 'Set solid in colour, still very much alive.' },
  { id: 'thunderjawGar', name: 'Thunderjaw Gar', rarity: 'legendary', min: 30, max: 75, weather: 'Thunderstorm', note: 'The bite arrives before the fish does.' },
  { id: 'glacierLeviathan', name: 'Glacier Leviathan', rarity: 'legendary', min: 40, max: 95, weather: 'Frost', note: 'Mistaken for the far bank more than once.' },
  { id: 'sunspireSerpent', name: 'Sunspire Serpent', rarity: 'legendary', min: 25, max: 68, weather: 'Dawn', note: 'Coils around the light and holds it there.' },
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

/**
 * A weather fish bites in its own weather and nowhere else, so a storm is the only way to see a
 * Thunderjaw Gar. The boost is what makes the visit worth it: while its weather holds, it competes
 * well above its tier rather than being buried under the fish that bite in everything.
 */
function pickFish(weather: string | null): FishDef {
  const pool = FISH.filter(fish => !fish.weather || fish.weather === weather);
  const weights = pool.map(fish => RARITIES[fish.rarity].weight * (fish.weather ? 7 : 1));
  const total = weights.reduce((sum, value) => sum + value, 0);
  let roll = Math.random() * total;
  for (let index = 0; index < pool.length; index++) {
    roll -= weights[index];
    if (roll <= 0) return pool[index];
  }
  return pool[pool.length - 1];
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
    #${PANEL_ID} .gf-card{position:fixed;right:14px;bottom:56px;width:min(470px,94vw);display:flex;flex-direction:column;overflow:hidden;pointer-events:auto;user-select:none;touch-action:none;border:1px solid var(--gc-line,rgba(255,255,255,.075));border-radius:12px;background:var(--gc-bg,#0c0c11);box-shadow:0 30px 90px rgba(0,0,0,.8),inset 0 1px rgba(255,255,255,.035)}
    #${PANEL_ID} header{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;color:#fafafa;background:linear-gradient(180deg,rgba(255,255,255,.035),transparent);border-bottom:1px solid var(--gc-line,rgba(255,255,255,.075));cursor:move}
    #${PANEL_ID} h2{margin:0;font:700 13px/1.2 system-ui,sans-serif;letter-spacing:.02em}
    #${PANEL_ID} header div{display:flex;align-items:center;gap:4px}
    #${PANEL_ID} button{padding:5px 9px;border:1px solid var(--gc-line,rgba(255,255,255,.075));border-radius:6px;background:rgba(255,255,255,.03);color:var(--gc-text,#e4e4e7);font:700 10px system-ui,sans-serif;cursor:pointer}
    #${PANEL_ID} button:hover{color:#ddd6fe;border-color:rgba(167,139,250,.3);background:rgba(167,139,250,.1)}
    #${PANEL_ID} button[data-active=true]{color:#ddd6fe;border-color:rgba(167,139,250,.5);background:rgba(167,139,250,.16)}
    #${PANEL_ID} header button{width:26px;min-width:26px;height:26px;padding:0;border-radius:7px;color:var(--gc-muted,rgba(255,255,255,.72));font-size:12px}
    #${PANEL_ID} header button[data-close]{border-radius:50%;background:transparent}
    #${PANEL_ID} canvas{display:block;width:100%;height:310px;cursor:pointer}
    #${PANEL_ID} .gf-status{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 12px;border-top:1px solid var(--gc-line,rgba(255,255,255,.075))}
    #${PANEL_ID} .gf-status b{font:700 12px system-ui,sans-serif}
    #${PANEL_ID} .gf-status small{color:var(--gc-muted,rgba(255,255,255,.72));font-size:10px;white-space:nowrap}
    #${PANEL_ID} .gf-body{max-height:430px;overflow:auto;padding:10px 12px 12px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.1) transparent}
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
  let lastTime = 0;

  // Reel state, all in track fractions where 0 is the top of the track.
  let hooked: FishDef | null = null;
  let hookedWeight = 0;
  let biteAt = 0;
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
  function canvas(): HTMLCanvasElement | null { return panel()?.querySelector('canvas') ?? null; }

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
    waitUntil = performance.now() + 1200 + Math.random() * 3600;
    setPhase('waiting', 'Line is out. Wait for the bob to dip.');
    playCast();
    startLoop();
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

  function step(now: number): void {
    // Cleared first so a throw anywhere below leaves the loop restartable rather than wedged.
    frame = null;
    const delta = Math.min(.05, (now - lastTime) / 1000 || 0);
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
    draw();
    frame = requestAnimationFrame(step);
  }

  function startLoop(): void {
    if (frame !== null) return;
    lastTime = performance.now();
    frame = requestAnimationFrame(step);
  }

  function stopLoop(): void {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
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
    const trackX = width - 62;
    const trackWidth = 26;
    const barX = width - 28;
    const top = 12;
    const bottom = height - 12;
    const trackHeight = bottom - top;

    // Scene: sky over water, with the float sitting on the surface.
    const sceneRight = trackX - 12;
    const surface = top + 52;
    const sky = context.createLinearGradient(0, top, 0, surface);
    sky.addColorStop(0, '#12121b');
    sky.addColorStop(1, '#1b2233');
    context.fillStyle = sky;
    context.beginPath();
    context.roundRect(12, top, sceneRight - 12, surface - top, [8, 8, 0, 0]);
    context.fill();
    const water = context.createLinearGradient(0, surface, 0, bottom);
    water.addColorStop(0, '#0e3245');
    water.addColorStop(1, '#06151f');
    context.fillStyle = water;
    context.beginPath();
    context.roundRect(12, surface, sceneRight - 12, bottom - surface, [0, 0, 8, 8]);
    context.fill();
    context.strokeStyle = 'rgba(255,255,255,.09)';
    context.lineWidth = 1;
    context.beginPath();
    context.roundRect(12.5, top + .5, sceneRight - 13, trackHeight - 1, 8);
    context.stroke();

    // Scenery fish, clipped to the water so they slide in and out of the pond edges.
    context.save();
    context.beginPath();
    context.roundRect(12, surface, sceneRight - 12, bottom - surface, [0, 0, 8, 8]);
    context.clip();
    for (const swimmer of swimmers) {
      const x = 12 + swimmer.x * (sceneRight - 12);
      const y = surface + 10 + swimmer.y * (bottom - surface - 20) + Math.sin(now / 900 + swimmer.phase) * 3;
      drawSwimmer(context, x, y, swimmer.size, Math.sign(swimmer.speed), swimmer.colour, .5, now + swimmer.phase * 400);
    }
    if (phase === 'reel' && hooked) {
      // The fight in the water mirrors the track, so the fish you are pulling on is visible.
      const rule = RARITIES[hooked.rarity];
      const size = 11 + RARITY_ORDER.indexOf(hooked.rarity) * 3.5;
      const y = surface + 16 + fishAt * (bottom - surface - 32);
      const drift = Math.sin(now / 640) * (sceneRight - 12) * .16;
      drawSwimmer(context, centreOf(12, sceneRight) + drift, y, size, Math.cos(now / 640) > 0 ? 1 : -1, rule.colour, .85, now);
    }
    context.restore();

    const centre = centreOf(12, sceneRight);
    const bobBase = surface + (phase === 'waiting' ? 0 : phase === 'bite' ? 7 : 0);
    const bob = phase === 'waiting' ? Math.sin(now / 420) * 2 : phase === 'bite' ? Math.sin(now / 55) * 3 : 0;
    if (phase !== 'idle' && phase !== 'result') {
      context.strokeStyle = 'rgba(255,255,255,.35)';
      context.beginPath();
      context.moveTo(centre, top + 8);
      context.lineTo(centre, bobBase + bob);
      context.stroke();
      context.fillStyle = phase === 'bite' ? '#f87171' : '#e4e4e7';
      context.beginPath();
      context.arc(centre, bobBase + bob, 4.5, 0, Math.PI * 2);
      context.fill();
      for (let ring = 0; ring < 3; ring++) {
        const wave = (now / 900 + ring / 3) % 1;
        context.strokeStyle = `rgba(255,255,255,${(.22 * (1 - wave)).toFixed(3)})`;
        context.beginPath();
        context.ellipse(centre, bobBase + bob + 2, 6 + wave * 34, 2 + wave * 8, 0, 0, Math.PI * 2);
        context.stroke();
      }
    }

    // The catch stays on screen until the next cast, so a fast reeler still sees what they landed.
    if (phase === 'result' && lastCatch) {
      const rule = RARITIES[lastCatch.fish.rarity];
      const cardWidth = Math.min(250, sceneRight - 40);
      const cardHeight = 96;
      const cardX = centre - cardWidth / 2;
      const cardY = surface - 30;
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

    context.textAlign = 'center';
    context.font = '700 11px system-ui,sans-serif';
    context.fillStyle = phase === 'bite' ? '#fca5a5' : 'rgba(255,255,255,.62)';
    const heading = phase === 'idle' ? 'Click to cast' : phase === 'waiting' ? 'Waiting...' : phase === 'bite' ? 'BITE!' : phase === 'reel' ? 'Hold to reel' : 'Click to cast again';
    context.fillText(heading, centre, bottom - 12);

    // A bench fight is marked on the canvas itself, so a test can never be mistaken for a catch.
    if (testing && (phase === 'reel' || phase === 'result')) {
      const label = hooked ? `TEST  ${hooked.name}  ${fightLength()}` : 'TEST';
      context.font = '700 9px system-ui,sans-serif';
      const badgeWidth = context.measureText(label).width + 16;
      context.fillStyle = 'rgba(251,191,36,.16)';
      context.strokeStyle = 'rgba(251,191,36,.5)';
      context.lineWidth = 1;
      context.beginPath();
      context.roundRect(20, top + 8, badgeWidth, 18, 5);
      context.fill();
      context.stroke();
      context.fillStyle = '#fbbf24';
      context.textAlign = 'left';
      context.fillText(label, 28, top + 20);
      context.textAlign = 'center';
    }
    // A draining bar during the bite, so the window you have to react in is something you can see.
    if (phase === 'bite') {
      const left = Math.max(0, 1 - (now - biteAt) / BITE_WINDOW);
      const barWidth = 76;
      context.fillStyle = 'rgba(255,255,255,.12)';
      context.beginPath();
      context.roundRect(centre - barWidth / 2, bottom - 8, barWidth, 4, 2);
      context.fill();
      context.fillStyle = '#f87171';
      context.beginPath();
      context.roundRect(centre - barWidth / 2, bottom - 8, barWidth * left, 4, 2);
      context.fill();
    }

    // Track: the fish runs up and down it, the hook zone is what you steer.
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
    startLoop();
  }

  function close(): void {
    const host = panel();
    if (host) host.hidden = true;
    holding = false;
    stopLoop();
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
    makeDraggable(card, POSITION_KEY);
    // Everything inside the card is ours: no click, drag or scroll may reach the game beneath it,
    // so a stray reel does not move a plant or harvest a crop.
    for (const type of ['pointerdown', 'pointerup', 'pointermove', 'pointercancel', 'mousedown', 'mouseup', 'click', 'dblclick', 'wheel', 'contextmenu']) {
      card.addEventListener(type, event => event.stopPropagation());
    }
    window.addEventListener('pointerup', release);
    page.__gardenCompanionToggleFishing = () => (panel()?.hidden ? open() : close());
    // Published so the bench can be reached from the console without a button in the panel.
    page.__gardenCompanionFishingBench = () => {
      open();
      view = 'bench';
      renderChrome();
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
}
