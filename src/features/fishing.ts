import { page } from '../page.js';
import { state } from '../state.js';
import { makeDraggable } from '../draggable.js';
import { createWorldScene, TILE_SIZE, type WorldBounds, type WorldGeometry } from '../world-scene.js';
import { escapeHtml, loadLocal, NUMBER_LOCALE, saveLocal } from '../utils.js';
import { isTyping } from '../keybinds.js';
import {
  createFight, FIGHT_PACE, FIGHT_STYLES, FISH, FISH_BY_ID, fishTravelSpeed, LOSE_FLOOR, PERFECT_BONUS, RARITIES, RARITY_ORDER,
  REEL_LIMIT, START_PROGRESS, TROPHY_BONUS, TROPHY_SHARE, ZONE_DRAG, ZONE_GRAVITY,
  ZONE_LIFT, zoneAgility, catchRewards, EQUIPMENT, EQUIPMENT_BY_ID, fishingLevel, pickFish,
  type EquipmentDef, type EquipmentSlot, type Fight, type FishDef, type Rarity,
} from './fishing-rules.js';
import { fishingMuted, playBite, playCast, playCatch, playEscape, playNibble, playReelClick, primeFishingAudio, setFishingMuted } from './fishing-audio.js';

/**
 * A self-contained fishing minigame. It never talks to the game: no rewards are claimed, nothing is
 * sent over the connection, and the catch record lives only in this browser. The one thing it takes
 * from the game is the current weather, which shifts which fish are biting.
 */

const STYLE_ID = 'gc-fishing-style';
const PANEL_ID = 'gc-fishing-panel';
const RECORD_KEY = 'gardenCompanion.fishing.v1';
const POSITION_KEY = 'gardenCompanion.fishingPosition.v1';

/** How long the float stays dipped. Long enough to react to without making the hook automatic. */
const BITE_WINDOW = 1500;
/**
 * Reeling is a stream of clicks, so the click that lands the fish is followed by more. The controls
 * ignore them for this long, otherwise the next cast starts before the catch has been read.
 */
const RESULT_LOCK = 1600;
/** Rod back-swing then forward whip. The flight lands as the cast splash in the audio plays. */
const CAST_WINDUP = 150;
const CAST_FLIGHT = 210;

interface CatchRecord { count: number; best: number; first: number }
interface FishingRecord {
  casts: number;
  caught: number;
  escaped: number;
  perfects: number;
  fish: Record<string, CatchRecord>;
  coins: number;
  xp: number;
  equipment: Record<string, number>;
  equipped: Record<EquipmentSlot, string>;
  /** Bait held, by id, and the one put on the hook each cast. */
  baits: Record<string, number>;
  bait: string;
}

interface BaitDef {
  id: string;
  name: string;
  icon: string;
  detail: string;
  /** Shown while the bait is on the hook. */
  flavour: string;
  /** Price of one pack. */
  price: number;
  /** Tier weights are multiplied by these before the tier is rolled. */
  rarity?: Partial<Record<Rarity, number>>;
  /** Multiplies the in-tier boost for fish of the current weather, and doubles weather mythics. */
  weatherBoost?: number;
  /** Multiplies the wait for a bite. */
  wait?: number;
}

const BAIT_PACK = 5;
/** One piece goes on the hook per bite, so a cast reeled in early keeps its bait. */
const BAITS: BaitDef[] = [
  {
    id: 'breadcrumbs', name: 'Breadcrumbs', icon: '&#127838;', detail: 'Bites come twice as fast.', price: 20, wait: .5,
    flavour: "Yesterday's loaf, crumbled small. The ducks will never forgive you.",
  },
  {
    id: 'gardenWorms', name: 'Garden Worms', icon: '&#129713;', detail: 'Uncommon and rare fish bite 50% more often.', price: 30, rarity: { uncommon: 1.5, rare: 1.5 },
    flavour: 'Dug fresh from under the carrots. Still wriggling with ambition.',
  },
  {
    id: 'stormFlies', name: 'Storm Flies', icon: '&#129712;', detail: 'Weather fish bite three times as often, weather mythics twice.', price: 70, weatherBoost: 3,
    flavour: 'Netted in the last thunderclap. They hum faintly and taste of static.',
  },
  {
    id: 'glowGrubs', name: 'Glow Grubs', icon: '&#128027;', detail: 'Rare and better fish bite far more often.', price: 90, rarity: { rare: 1.6, epic: 1.8, legendary: 1.8, mythic: 1.5 },
    flavour: 'They light the jar up at night. Fish swim the length of the pond to stare.',
  },
  {
    id: 'shimmerPaste', name: 'Shimmer Paste', icon: '&#10024;', detail: 'Epic, legendary and mythic fish bite 2.5-3x as often.', price: 260, rarity: { epic: 2.5, legendary: 3, mythic: 3 },
    flavour: "Nobody will say what's in it. The big ones don't seem to care.",
  },
];
const BAIT_BY_ID = new Map(BAITS.map(bait => [bait.id, bait]));


const EMPTY_RECORD: FishingRecord = {
  casts: 0, caught: 0, escaped: 0, perfects: 0, fish: {}, coins: 0, xp: 0,
  equipment: { reedRod: 1 }, equipped: { rod: 'reedRod', line: '', tackle: '' },
  baits: {}, bait: '',
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
  const baits: Record<string, number> = {};
  if (stored.baits && typeof stored.baits === 'object') {
    for (const [id, count] of Object.entries(stored.baits)) {
      if (BAIT_BY_ID.has(id) && finite(count) > 0) baits[id] = Math.floor(finite(count));
    }
  }
  return {
    casts: finite(stored.casts),
    caught: finite(stored.caught),
    escaped: finite(stored.escaped),
    perfects: finite(stored.perfects),
    fish: stored.fish && typeof stored.fish === 'object' ? stored.fish : {},
    coins: finite(stored.coins),
    xp: finite(stored.xp),
    equipment,
    equipped,
    baits,
    bait: typeof stored.bait === 'string' && baits[stored.bait] > 0 ? stored.bait : '',
  };
}

function isTrophy(fish: FishDef, weight: number): boolean {
  return weight >= fish.min + (fish.max - fish.min) * TROPHY_SHARE;
}

/** A side-on fish for the catch card, sized by where the catch sits in its species' weight range. */
function fishSvg(colour: string, share: number): string {
  const scale = .62 + Math.max(0, Math.min(1, share)) * .38;
  return `<svg viewBox="0 0 64 40" width="${Math.round(52 * scale)}" height="${Math.round(33 * scale)}" aria-hidden="true"><path d="M3 7 L19 20 L3 33 Z" fill="${colour}" opacity=".8"/><path d="M28 9 Q37 1 46 10" fill="${colour}" opacity=".7"/><ellipse cx="37" cy="20" rx="23" ry="12.5" fill="${colour}"/><ellipse cx="37" cy="24" rx="17" ry="5" fill="#fff" opacity=".2"/><path d="M44 12 Q41 20 44 28" stroke="#0f172a" stroke-width="1.4" fill="none" opacity=".35"/><circle cx="52" cy="17" r="3.2" fill="#fff"/><circle cx="53" cy="17" r="1.6" fill="#0f172a"/></svg>`;
}




/** Tints laid over the water so the pond itself says what the weather is doing. */
const WEATHER_TINT: Record<string, { color: number; alpha: number }> = {
  Rain: { color: 0x1e3a5f, alpha: .22 },
  Thunderstorm: { color: 0x0f172a, alpha: .32 },
  Frost: { color: 0xbfe3ff, alpha: .2 },
  Dawn: { color: 0xfda4af, alpha: .14 },
  AmberMoon: { color: 0xf59e0b, alpha: .18 },
};
/** Raindrop rings per second across the whole pond. */
const RAIN_RATE: Record<string, number> = { Rain: 7, Thunderstorm: 11 };

const WEATHER_ICONS: Record<string, string> = {
  Rain: '&#127783;&#65039;', Thunderstorm: '&#9928;&#65039;', Frost: '&#10052;&#65039;', Dawn: '&#127749;', AmberMoon: '&#127765;',
};

function weatherIcon(weather: string | null): string {
  return (weather && WEATHER_ICONS[weather]) || '&#9728;&#65039;';
}

const SLOT_ICONS: Record<EquipmentSlot, string> = { rod: '&#127907;', line: '&#129525;', tackle: '&#129693;' };

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
    #${PANEL_ID}{position:fixed;inset:0;z-index:999993;pointer-events:none;color:var(--gf-text);font:12px/1.45 system-ui,sans-serif;
      --gf-bg:#0b171b;--gf-bg-2:#11262d;--gf-panel:rgba(255,255,255,.035);--gf-line:rgba(125,211,252,.1);--gf-line-2:rgba(125,211,252,.2);
      --gf-text:#e3eef0;--gf-strong:#f8fafc;--gf-muted:#89a5ac;--gf-accent-rgb:45,212,191;--gf-gold:#f5c04a;--gf-danger:#f87171}
    #${PANEL_ID}[hidden]{display:none}
    #${PANEL_ID} .gf-card{position:fixed;right:14px;bottom:56px;width:min(560px,94vw);display:flex;flex-direction:column;overflow:hidden;pointer-events:auto;user-select:none;touch-action:none;border:1px solid var(--gf-line-2);border-radius:16px;background:linear-gradient(180deg,var(--gf-bg-2),var(--gf-bg) 150px);box-shadow:0 22px 60px rgba(0,0,0,.65),inset 0 1px rgba(255,255,255,.05)}
    #${PANEL_ID} .gf-card[data-view=game]{width:min(400px,calc(100vw - 24px))}
    #${PANEL_ID} button{padding:5px 10px;border:1px solid var(--gf-line-2);border-radius:8px;background:var(--gf-panel);color:var(--gf-text);font:700 10px system-ui,sans-serif;cursor:pointer;transition:background .12s,border-color .12s,color .12s,transform .08s,filter .12s}
    #${PANEL_ID} button:not(.gf-action):hover:not(:disabled){border-color:rgba(var(--gf-accent-rgb),.45);background:rgba(var(--gf-accent-rgb),.1);color:#ccfbf1}
    #${PANEL_ID} button:active:not(:disabled){transform:translateY(1px)}
    #${PANEL_ID} button:disabled{opacity:.45;cursor:default}
    #${PANEL_ID} button[data-active=true]{border-color:rgba(var(--gf-accent-rgb),.55);background:rgba(var(--gf-accent-rgb),.16);color:#ccfbf1}
    #${PANEL_ID} header{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 12px 12px 14px;cursor:move;background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='60' height='6'%3E%3Cpath d='M0 4 Q15 0 30 4 T60 4' fill='none' stroke='rgba(125,211,252,0.16)' stroke-width='1.4'/%3E%3C/svg%3E") left bottom/60px 6px repeat-x}
    #${PANEL_ID} .gf-title{display:flex;align-items:center;gap:10px;min-width:0}
    #${PANEL_ID} .gf-logo{display:grid;place-items:center;flex:0 0 auto;width:34px;height:34px;border-radius:11px;background:linear-gradient(145deg,#17666b,#0d363c);box-shadow:inset 0 1px rgba(255,255,255,.14),0 4px 12px rgba(0,0,0,.35);font-size:18px}
    #${PANEL_ID} h2{margin:0;color:var(--gf-strong);font:800 14px/1.1 system-ui,sans-serif;letter-spacing:.01em}
    #${PANEL_ID} .gf-level{display:flex;align-items:center;gap:6px;margin-top:4px;color:var(--gf-muted);font-size:9px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}
    #${PANEL_ID} .gf-level i{display:block;width:74px;height:4px;overflow:hidden;border-radius:2px;background:rgba(255,255,255,.08)}
    #${PANEL_ID} .gf-level i b{display:block;height:100%;border-radius:2px;background:linear-gradient(90deg,#2dd4bf,#a78bfa)}
    #${PANEL_ID} .gf-head-actions{display:flex;align-items:center;gap:4px}
    #${PANEL_ID} .gf-coins{display:flex;align-items:center;gap:5px;height:26px;margin-right:2px;padding:0 10px 0 5px;border:1px solid rgba(245,192,74,.28);border-radius:13px;background:rgba(245,192,74,.08);color:#fde68a;font-size:11px;font-weight:800;font-variant-numeric:tabular-nums}
    #${PANEL_ID} .gf-coins i{width:15px;height:15px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#fff5cc,#f5c04a 48%,#b7791f);box-shadow:inset 0 0 0 1.5px rgba(146,94,20,.55)}
    #${PANEL_ID} button.gf-icon{width:26px;height:26px;padding:0;border-color:transparent;border-radius:8px;background:transparent;color:var(--gf-muted);font-size:12px}
    #${PANEL_ID} .gf-tabs{display:flex;gap:3px;margin:0 12px;padding:3px;border:1px solid var(--gf-line);border-radius:11px;background:rgba(0,0,0,.24)}
    #${PANEL_ID} .gf-tabs button{flex:1;padding:6px 8px;border-color:transparent;border-radius:8px;background:transparent;color:var(--gf-muted);font-size:11px}
    #${PANEL_ID} .gf-tabs button[data-active=true]{border-color:rgba(var(--gf-accent-rgb),.35);background:rgba(var(--gf-accent-rgb),.15);color:#ccfbf1}
    #${PANEL_ID} .gf-pond-input{position:fixed;pointer-events:auto;touch-action:none;cursor:crosshair}
    #${PANEL_ID} .gf-game{padding:12px}
    #${PANEL_ID} .gf-stage{display:flex;gap:12px}
    #${PANEL_ID} .gf-stage-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:10px}
    #${PANEL_ID} .gf-status{padding:10px 12px;border:1px solid var(--gf-line);border-radius:12px;background:var(--gf-panel);transition:border-color .15s,background .15s}
    #${PANEL_ID} .gf-status[data-phase=bite]{border-color:rgba(245,192,74,.5);background:rgba(245,192,74,.08)}
    #${PANEL_ID} .gf-phase{display:inline-flex;align-items:center;gap:6px;color:var(--gf-muted);font-size:9px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}
    #${PANEL_ID} .gf-phase::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;box-shadow:0 0 6px currentColor}
    #${PANEL_ID} .gf-status[data-phase=waiting] .gf-phase{color:#7dd3fc}
    #${PANEL_ID} .gf-status[data-phase=bite] .gf-phase{color:var(--gf-gold)}
    #${PANEL_ID} .gf-status[data-phase=reel] .gf-phase{color:#2dd4bf}
    #${PANEL_ID} .gf-status b{display:block;margin-top:5px;color:var(--gf-strong);font:700 12px/1.35 system-ui,sans-serif}
    #${PANEL_ID} .gf-status small{display:block;margin-top:4px;color:var(--gf-muted);font-size:10px}
    #${PANEL_ID} button.gf-action{height:44px;border:0;border-radius:12px;background:linear-gradient(180deg,#2dd4bf,#0d9488);color:#042f2e;font:800 12px system-ui,sans-serif;letter-spacing:.03em;box-shadow:0 6px 16px rgba(13,148,136,.3),inset 0 1px rgba(255,255,255,.35)}
    #${PANEL_ID} button.gf-action:hover{filter:brightness(1.1)}
    #${PANEL_ID} button.gf-action[data-phase=waiting]{background:rgba(255,255,255,.05);color:var(--gf-text);box-shadow:inset 0 0 0 1px var(--gf-line-2)}
    #${PANEL_ID} button.gf-action[data-phase=bite]{background:linear-gradient(180deg,#fcd34d,#f59e0b);color:#451a03;animation:gf-pulse .45s ease-in-out infinite alternate}
    #${PANEL_ID} button.gf-action[data-phase=reel]{background:linear-gradient(180deg,#38bdf8,#0369a1);color:#f0f9ff;box-shadow:0 6px 16px rgba(3,105,161,.35),inset 0 1px rgba(255,255,255,.3)}
    @keyframes gf-pulse{to{box-shadow:0 0 0 4px rgba(245,158,11,.25),0 6px 20px rgba(245,158,11,.5)}}
    #${PANEL_ID} .gf-label{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;color:var(--gf-muted);font-size:9px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}
    #${PANEL_ID} .gf-biting{display:flex;flex-wrap:wrap;gap:4px}
    #${PANEL_ID} .gf-biting span{padding:2px 8px;border:1px solid color-mix(in srgb,currentColor 45%,transparent);border-radius:10px;background:color-mix(in srgb,currentColor 10%,transparent);font-size:10px;font-weight:700}
    #${PANEL_ID} .gf-biting p{margin:0;color:var(--gf-muted);font-size:10px}
    #${PANEL_ID} .gf-bait{padding:10px;border:1px solid var(--gf-line);border-radius:12px;background:var(--gf-panel)}
    #${PANEL_ID} .gf-bait-head{display:flex;align-items:center;gap:10px}
    #${PANEL_ID} .gf-bait-icon{display:grid;place-items:center;flex:0 0 auto;width:34px;height:34px;border-radius:10px;background:rgba(0,0,0,.25);box-shadow:inset 0 0 0 1px var(--gf-line);font-size:18px}
    #${PANEL_ID} .gf-bait-text{flex:1;min-width:0}
    #${PANEL_ID} .gf-bait-text b{display:block;color:var(--gf-strong);font-size:12px}
    #${PANEL_ID} .gf-bait-text small{display:block;margin-top:1px;color:var(--gf-muted);font-size:10px;line-height:1.3}
    #${PANEL_ID} .gf-flavour{margin:9px 0 0;padding:1px 0 1px 10px;border-left:2px solid rgba(var(--gf-accent-rgb),.45);color:#b6d0d5;font:italic 11.5px/1.45 Georgia,'Times New Roman',serif}
    #${PANEL_ID} .gf-meter{display:flex;flex-direction:column;align-items:center;gap:6px;flex:0 0 auto;transition:opacity .2s}
    #${PANEL_ID} .gf-meter[data-live=false]{opacity:.4}
    #${PANEL_ID} .gf-meter-bars{display:flex;gap:6px;height:220px}
    #${PANEL_ID} .gf-meter small{color:var(--gf-muted);font-size:8px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}
    #${PANEL_ID} .gf-track{position:relative;width:38px;overflow:hidden;border-radius:19px;background:repeating-linear-gradient(180deg,transparent 0 21px,rgba(255,255,255,.07) 21px 22px),linear-gradient(180deg,#22808d,#0d3a46 65%,#082a33);box-shadow:inset 0 0 0 1px rgba(255,255,255,.13),inset 7px 0 10px rgba(255,255,255,.06),0 4px 14px rgba(0,0,0,.35);transition:box-shadow .12s}
    #${PANEL_ID} .gf-track[data-slip=true]{box-shadow:inset 0 0 0 1.5px rgba(248,113,113,.8),0 0 12px rgba(248,113,113,.35)}
    #${PANEL_ID} .gf-track-zone{position:absolute;left:3px;right:3px;top:35%;height:30%;min-height:14px;box-sizing:border-box;border:2px solid rgba(255,255,255,.92);border-radius:14px;background:rgba(52,211,153,.28);box-shadow:0 0 10px rgba(52,211,153,.5);transition:background .12s}
    #${PANEL_ID} .gf-track-zone[data-inside=true]{background:rgba(52,211,153,.58)}
    #${PANEL_ID} .gf-track-fish{position:absolute;left:50%;top:50%;width:22px;height:12px;margin:-6px 0 0 -11px;border:1.5px solid #fff;border-radius:50% 40% 40% 50%;background:#f8fafc;box-shadow:0 0 9px currentColor}
    #${PANEL_ID} .gf-meter-progress{position:relative;width:11px;overflow:hidden;border-radius:6px;background:rgba(0,0,0,.3);box-shadow:inset 0 0 0 1px rgba(255,255,255,.08)}
    #${PANEL_ID} .gf-meter-progress i{position:absolute;left:0;right:0;bottom:0;height:0;border-radius:6px;background:#34d399;box-shadow:0 0 8px currentColor}
    #${PANEL_ID} .gf-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 14px;border-top:1px solid var(--gf-line);color:var(--gf-muted);font-size:10px}
    #${PANEL_ID} kbd{padding:0 5px;border:1px solid var(--gf-line-2);border-bottom-width:2px;border-radius:4px;color:var(--gf-text);font:700 9px/1.5 system-ui,sans-serif}
    #${PANEL_ID} .gf-catch{position:relative;display:grid;grid-template-columns:64px 1fr;gap:12px;margin-bottom:12px;padding:12px;overflow:hidden;border:1px solid color-mix(in srgb,var(--catch-colour) 50%,transparent);border-radius:14px;background:radial-gradient(circle at 0 0,color-mix(in srgb,var(--catch-colour) 22%,transparent),transparent 70%),rgba(255,255,255,.03);animation:gf-rise .35s ease-out}
    @keyframes gf-rise{from{opacity:0;transform:translateY(6px)}}
    #${PANEL_ID} .gf-catch-fish{display:grid;place-items:center;width:64px;height:64px;border-radius:50%;background:radial-gradient(circle,color-mix(in srgb,var(--catch-colour) 26%,#06141a),#06141a 72%);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--catch-colour) 40%,transparent);filter:drop-shadow(0 0 10px color-mix(in srgb,var(--catch-colour) 45%,transparent))}
    #${PANEL_ID} .gf-catch h3{margin:0;color:#fff;font:800 16px/1.2 system-ui,sans-serif}
    #${PANEL_ID} .gf-catch p{margin:3px 0 0;color:var(--catch-colour);font:800 9px system-ui,sans-serif;text-transform:uppercase;letter-spacing:.12em}
    #${PANEL_ID} .gf-catch small{display:block;margin-top:5px;color:#d7e6e9;font-size:10px}
    #${PANEL_ID} .gf-catch-new{position:absolute;top:10px;right:-26px;padding:2px 30px;background:var(--catch-colour);color:#06141a;font:900 8px system-ui,sans-serif;letter-spacing:.14em;transform:rotate(35deg)}
    #${PANEL_ID} .gf-catch-rewards{display:flex;gap:6px;margin-top:7px}
    #${PANEL_ID} .gf-catch-rewards span{padding:2px 8px;border-radius:10px;background:rgba(255,255,255,.07);color:var(--gf-strong);font-size:10px;font-weight:800}
    #${PANEL_ID} .gf-catch-rewards span:first-child{background:rgba(245,192,74,.14);color:#fde68a}
    #${PANEL_ID} .gf-catch-tags{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}
    #${PANEL_ID} .gf-catch-tags span{padding:1px 7px;border:1px solid rgba(245,192,74,.35);border-radius:9px;color:#fde68a;font-size:9px;font-weight:800;letter-spacing:.04em}
    #${PANEL_ID} .gf-catch-item{color:var(--gf-gold)!important;font-weight:700}
    #${PANEL_ID} .gf-body{max-height:min(460px,calc(100vh - 170px));overflow:auto;padding:12px 12px 14px;scrollbar-width:thin;scrollbar-color:rgba(125,211,252,.18) transparent}
    #${PANEL_ID} .gf-totals{display:grid;grid-template-columns:repeat(auto-fit,minmax(90px,1fr));gap:6px;margin-bottom:10px}
    #${PANEL_ID} .gf-totals div{padding:8px 10px;border:1px solid var(--gf-line);border-radius:10px;background:var(--gf-panel)}
    #${PANEL_ID} .gf-totals small{display:block;color:var(--gf-muted);font-size:9px;font-weight:700;letter-spacing:.1em;text-transform:uppercase}
    #${PANEL_ID} .gf-totals b{color:var(--gf-strong);font:800 16px/1.3 system-ui,sans-serif;font-variant-numeric:tabular-nums}
    #${PANEL_ID} .gf-progress-line{height:6px;overflow:hidden;border-radius:3px;background:rgba(255,255,255,.07)}
    #${PANEL_ID} .gf-progress-line i{display:block;height:100%;border-radius:3px;background:linear-gradient(90deg,#2dd4bf,#a78bfa)}
    #${PANEL_ID} .gf-tier{margin:16px 0 7px;display:flex;align-items:center;justify-content:space-between;color:var(--gf-muted);font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase}
    #${PANEL_ID} .gf-tier span:last-child{font-weight:700;letter-spacing:.04em;text-transform:none;opacity:.85}
    #${PANEL_ID} .gf-gear-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:6px}
    #${PANEL_ID} .gf-gear{display:flex;flex-wrap:wrap;align-items:center;gap:6px 9px;padding:9px;border:1px solid var(--gf-line);border-radius:11px;background:var(--gf-panel)}
    #${PANEL_ID} .gf-gear[data-active=true]{border-color:rgba(var(--gf-accent-rgb),.45);background:rgba(var(--gf-accent-rgb),.07)}
    #${PANEL_ID} .gf-gear-icon{display:grid;place-items:center;flex:0 0 auto;width:30px;height:30px;border-radius:9px;background:rgba(0,0,0,.25);box-shadow:inset 0 0 0 1px var(--gf-line);font-size:15px}
    #${PANEL_ID} .gf-gear-text{flex:1;min-width:0}
    #${PANEL_ID} .gf-gear-text b{display:block;color:var(--gf-strong);font-size:11.5px}
    #${PANEL_ID} .gf-gear-text small{display:block;color:var(--gf-muted);font-size:9.5px;line-height:1.3}
    #${PANEL_ID} .gf-gear .gf-flavour{flex-basis:100%;margin:0}
    #${PANEL_ID} .gf-gear[data-locked=true]{opacity:.5}
    #${PANEL_ID} .gf-row{display:flex;align-items:center;gap:9px;padding:7px 9px;border:1px solid var(--gf-line);border-radius:10px;background:var(--gf-panel)}
    #${PANEL_ID} .gf-row+.gf-row{margin-top:4px}
    #${PANEL_ID} .gf-row i{width:8px;height:8px;flex:0 0 auto;border-radius:50%;box-shadow:0 0 6px currentColor}
    #${PANEL_ID} .gf-row span{flex:1;min-width:0}
    #${PANEL_ID} .gf-row b{display:block;color:var(--gf-strong);font:700 12px system-ui,sans-serif}
    #${PANEL_ID} .gf-row small{display:block;color:var(--gf-muted);font-size:10px}
    #${PANEL_ID} .gf-row em{flex:0 0 auto;font-style:normal;font-size:10px;color:var(--gf-muted);font-variant-numeric:tabular-nums}
    #${PANEL_ID} .gf-row[data-found=false]{opacity:.45}
    #${PANEL_ID} .gf-row[data-found=false] b{color:var(--gf-muted)}
    #${PANEL_ID} .gf-note{margin:0 0 8px;color:var(--gf-muted);font-size:11px}
    #${PANEL_ID} .gf-reset{margin-top:16px;padding-top:12px;border-top:1px solid var(--gf-line)}
    #${PANEL_ID} .gf-reset button{width:100%;padding:8px}
    #${PANEL_ID} .gf-bench-stats{display:flex;flex-wrap:wrap;gap:4px 10px;margin-bottom:6px;color:var(--gf-muted);font-size:10px}
    #${PANEL_ID} .gf-bench-stats b{color:var(--gf-text);font:700 10px system-ui,sans-serif}
    #${PANEL_ID} .gf-bench-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:4px}
    #${PANEL_ID} button.gf-bench-fish{display:flex;flex-direction:column;align-items:flex-start;gap:1px;padding:6px 8px;font:600 11px system-ui,sans-serif;text-align:left}
    #${PANEL_ID} button.gf-bench-fish small{color:var(--gf-muted);font-size:9px;font-weight:400}
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
  /** The fight in progress; the fields below are copied out of it each frame for drawing. */
  let fight: Fight | null = null;
  let fishAt = .5, fishVelocity = 0;
  let zoneAt = .5, zoneHeight = .3;
  let progress = 0;
  let resultColour = 'rgba(255,255,255,.72)';
  let resultLockUntil = 0;
  let lastCatch: {
    fish: FishDef; weight: number; fresh: boolean; coins: number; xp: number; item?: EquipmentDef;
    perfect: boolean; trophy: boolean; sizeRecord: boolean;
  } | null = null;
  let testing = false;
  let reelStartedAt = 0;
  let fightEndedAt = 0;
  let draggableReady = false;
  let pondBounds: WorldBounds | null = null;
  let farmBounds: WorldBounds | null = null;
  let dockBounds: WorldBounds | null = null;
  let firePits: { x: number; y: number }[] = [];
  /** Whether the game's own fire pits stand at `firePits`, leaving only their glow for us to draw. */
  let nativeFirePits = false;
  let renderedWeather: string | null = null;

  // Nibbles are false alarms before the real bite: the float twitches, and striking at one loses the cast.
  let nibbles: number[] = [];
  let nibbleAt = -Infinity;
  let landedSplash = false;
  // Whether the fish is in the zone, and whether it has ever left it.
  let fishInside = true;
  let fightSlipped = false;
  /** Progress the fight began at, which is where the fish sits at the cast spot. */
  let fightStartProgress = START_PROGRESS;

  // Water effects, all in pond fractions so they survive the farm being rebuilt at another size.
  interface Ripple { x: number; y: number; at: number; size: number; life: number; alpha: number }
  let ripples: Ripple[] = [];
  let lastThrashAt = 0;
  let lastBiteRingAt = 0;
  /** Where the float or hooked fish last was, for splashes when a fight ends. */
  let hookedPos = { x: .5, y: .5 };
  let leap: { at: number; x: number; y: number; colour: number; size: number } | null = null;
  let flashAt = -Infinity;
  let nextFlashAt = 0;

  /**
   * The pond takes over the farm tiles: water and dock sit below the garden's own z range, the rod
   * is lifted above the player, and the active pets are penned onto the decking so they do not
   * wander out across the water.
   */
  const scene = createWorldScene({
    owner: 'fishing',
    // Fish swim under the lily pads; the float, ripples and lightning sit on the surface above them.
    layers: { pond: -999_000, fish: -998_999, lilies: -998_998, surface: -998_997, dock: -998_996, fire: -998_995, rod: 999_000 },
    abovePlayer: ['rod'],
    showcase: geometry => campDecor(geometry),
    onBuild(geometry, built) {
      farmBounds = { left: geometry.left, top: geometry.top, width: geometry.width, height: geometry.height };
      pondBounds = { left: geometry.left, top: geometry.top, width: geometry.width * .62, height: geometry.height };
      const pond = built.layer('pond');
      const dock = built.layer('dock');
      const lilies = built.layer('lilies');
      if (lilies) drawLilies(lilies, farmBounds);
      if (pond) drawPond(pond, farmBounds);
      if (dock) drawDock(dock, pondBounds);
      // Stand-in pits until the camp decor claims its tiles, which happens straight after this.
      firePits = placeFirePits(farmBounds);
      nativeFirePits = false;
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

  function equipmentTotal(key: 'zone' | 'start' | 'bite'): number {
    return equippedEffects().reduce((total, item) => total + (item[key] ?? 0), 0);
  }

  function equipmentDrain(): number {
    return equippedEffects().reduce((total, item) => total * (item.drain ?? 1), 1);
  }

  function activeBait(): BaitDef | undefined {
    return record.baits[record.bait] > 0 ? BAIT_BY_ID.get(record.bait) : undefined;
  }

  function equipmentFill(): number {
    const levelBonus = 1 + Math.min(.12, (fishingLevel(record.xp).level - 1) * .005);
    return equippedEffects().reduce((total, item) => total * (item.fill ?? 1), levelBonus);
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
    drawDecking(graphic, deckLeft, top, Math.max(40, left + width - deckLeft), height, waterWidth);
    const hedgeCount = Math.max(8, Math.floor((width + height) / 180));
    for (let index = 0; index < hedgeCount; index++) {
      const fraction = index / hedgeCount;
      const horizontal = index % 2 === 0;
      const x = horizontal ? left + fraction * width : (index % 4 === 1 ? left - 27 : left + width + 27);
      const y = horizontal ? (index % 4 === 0 ? top - 27 : top + height + 27) : top + fraction * height;
      graphic.circle(x, y, 30 + index % 3 * 4).fill({ color: index % 2 ? 0x2f6b36 : 0x397a3f, alpha: 1 });
      graphic.circle(x - 7, y - 8, 12).fill({ color: 0x5b954c, alpha: .72 });
    }
  }

  /** Lily pads on their own layer, above the fish, so the fish swim underneath them. */
  function drawLilies(graphic: Record<string, any>, bounds: WorldBounds): void {
    const { left, top, width, height } = bounds;
    const waterWidth = width * .62;
    graphic.clear();
    // Lily pads scattered over the water on a low-discrepancy (R2) sequence, so they spread evenly without a grid.
    // The dock and a margin round the float's usual landing band are left open.
    const dockTile = Math.min(256, waterWidth * .22, height * .24);
    const dockLeft = left + waterWidth - dockTile * 2 - 60;
    const dockTop = top + (height - dockTile * 2) / 2 - 60;
    const dockBottom = dockTop + dockTile * 2 + 120;
    const padCount = Math.max(14, Math.min(42, Math.round(waterWidth * height / 55000)));
    let placed = 0;
    for (let index = 0; placed < padCount && index < padCount * 4; index++) {
      const x = left + 50 + (waterWidth - 100) * ((index * .7548777 + .5) % 1);
      const y = top + 50 + (height - 100) * ((index * .5698403 + .5) % 1);
      if (x > dockLeft && y > dockTop && y < dockBottom) continue;
      placed++;
      const size = 26 + (index * 37 % 23) * 1.6;
      const pads = index % 5 === 0 ? 3 : index % 3 === 0 ? 2 : 1;
      for (let pad = 0; pad < pads; pad++) {
        const padX = x + (pad === 0 ? 0 : Math.cos(index + pad * 2.1) * size * 1.35);
        const padY = y + (pad === 0 ? 0 : Math.sin(index + pad * 2.1) * size * .9);
        const padSize = pad === 0 ? size : size * (.55 + (index + pad) % 3 * .12);
        const green = [0x4b8b4a, 0x3f7d45, 0x5a9a4f][(index + pad) % 3];
        graphic.ellipse(padX + padSize * .12, padY + padSize * .16, padSize * 1.02, padSize * .62).fill({ color: 0x0b3a44, alpha: .35 });
        graphic.ellipse(padX, padY, padSize, padSize * .6).fill({ color: green, alpha: .95 });
        graphic.ellipse(padX - padSize * .12, padY - padSize * .1, padSize * .66, padSize * .34).fill({ color: 0x7ab86a, alpha: .28 });
        // The notch, cut toward a different edge on each pad.
        const angle = (index * 1.7 + pad) % (Math.PI * 2);
        graphic.moveTo(padX, padY).lineTo(padX + Math.cos(angle) * padSize, padY + Math.sin(angle) * padSize * .6).stroke({ color: 0x255f39, width: Math.max(3, padSize * .09), alpha: .85 });
        for (let vein = 0; vein < 4; vein++) {
          const veinAngle = angle + (vein + 1) * Math.PI * 2 / 5;
          graphic.moveTo(padX, padY).lineTo(padX + Math.cos(veinAngle) * padSize * .7, padY + Math.sin(veinAngle) * padSize * .42).stroke({ color: 0x2f6b3c, width: 1.5, alpha: .4 });
        }
      }
      if (index % 3 === 0) {
        const petalColour = index % 2 ? 0xf9a8d4 : 0xfdf2f8;
        const bloom = size * .32;
        for (let petal = 0; petal < 7; petal++) {
          const angle = petal * Math.PI * 2 / 7 + index;
          graphic.ellipse(x + Math.cos(angle) * bloom * .6, y - bloom * .5 + Math.sin(angle) * bloom * .4, bloom * .55, bloom * .3).fill({ color: petalColour, alpha: .95 });
        }
        graphic.circle(x, y - bloom * .5, bloom * .3).fill({ color: 0xfde68a, alpha: 1 });
      }
    }
  }

  /** Fire pits down the middle of the decking, clear of the benches along the top and bottom rows and the stools on the right. */
  function placeFirePits(bounds: WorldBounds): { x: number; y: number }[] {
    const deckLeft = bounds.left + bounds.width * .62 + 20;
    const deckRight = bounds.left + bounds.width - 110;
    if (deckRight - deckLeft < 220) return [];
    const x = (deckLeft + deckRight) / 2;
    const count = bounds.height > 900 ? 2 : 1;
    return Array.from({ length: count }, (_, index) => ({ x, y: bounds.top + bounds.height * (count === 1 ? .5 : .36 + index * .3) }));
  }

  /** Warm glow round each fire pit, plus a drawn pit with sparks where the game's own could not go. Redrawn every frame. */
  function drawFirePits(graphic: Record<string, any>, now: number): void {
    graphic.clear();
    firePits.forEach((pit, pitIndex) => {
      const { x, y } = pit;
      // Sized against the benches: a pit about as wide as one of them.
      const k = 1.7;
      const flicker = Math.sin(now / 90 + pitIndex) * .5 + Math.sin(now / 53 + pitIndex * 2) * .5;
      graphic.circle(x, y, 150 * k).fill({ color: 0xfb923c, alpha: .06 + flicker * .015 });
      graphic.circle(x, y, 90 * k).fill({ color: 0xfdba74, alpha: .08 + flicker * .02 });
      // The game's own fire pit stands here when the deck is big enough to hold the camp; otherwise draw one.
      if (nativeFirePits) return;
      {
        graphic.circle(x, y + 6 * k, 52 * k).fill({ color: 0x1c1917, alpha: .35 });
        for (let stone = 0; stone < 11; stone++) {
          const angle = stone * Math.PI * 2 / 11 + pitIndex;
          const stoneX = x + Math.cos(angle) * 44 * k;
          const stoneY = y + Math.sin(angle) * 36 * k;
          const radius = (11 + stone % 3 * 2) * k;
          graphic.circle(stoneX, stoneY + 3 * k, radius).fill({ color: 0x292524, alpha: .6 });
          graphic.circle(stoneX, stoneY, radius).fill({ color: [0x78716c, 0x8a817a, 0x6b645e][stone % 3], alpha: 1 });
          graphic.circle(stoneX - radius * .3, stoneY - radius * .3, radius * .45).fill({ color: 0xa8a29e, alpha: .45 });
        }
        graphic.ellipse(x, y + 2 * k, 32 * k, 25 * k).fill({ color: 0x1c1410, alpha: 1 });
        graphic.ellipse(x, y + 4 * k, 20 * k, 13 * k).fill({ color: 0xc2410c, alpha: .55 + flicker * .15 });
        for (const [dx, dy, ex, ey] of [[-24, 10, 22, -6], [-20, -8, 24, 10], [-4, 16, 6, -16]]) {
          graphic.moveTo(x + dx * k, y + dy * k).lineTo(x + ex * k, y + ey * k).stroke({ color: 0x5b3a1e, width: 9 * k, alpha: 1 });
          graphic.moveTo(x + dx * k, y + (dy - 2) * k).lineTo(x + ex * k, y + (ey - 2) * k).stroke({ color: 0x8b5a2b, width: 3 * k, alpha: .7 });
        }
        // Three layers of flame, each leaning and stretching on its own rhythm.
        for (const [width, height, colour, alpha, speed] of [[22, 70, 0xea580c, .85, 1], [15, 52, 0xfbbf24, .9, 1.3], [8, 30, 0xfef3c7, .95, 1.7]] as const) {
          const reach = height * k * (1 + Math.sin(now / (80 / speed) + pitIndex) * .12 + Math.sin(now / (47 / speed)) * .08);
          const lean = Math.sin(now / 210 + pitIndex * 3) * width * k * .45;
          graphic.moveTo(x - width * k, y + 4 * k)
            .quadraticCurveTo(x - width * k * 1.05, y - reach * .45, x + lean, y - reach)
            .quadraticCurveTo(x + width * k * 1.05, y - reach * .45, x + width * k, y + 4 * k)
            .closePath()
            .fill({ color: colour, alpha });
        }
      }
      for (let spark = 0; spark < 6; spark++) {
        const life = (now / 1500 + spark * .173 + pitIndex * .31) % 1;
        const sparkX = x + (Math.sin(life * 7 + spark * 1.9) * 16 + (spark - 2.5) * 5) * k;
        const sparkY = y - (34 + life * 130) * k;
        graphic.circle(sparkX, sparkY, 2.6 * k * (1 - life * .6)).fill({ color: spark % 2 ? 0xfde68a : 0xfb923c, alpha: (1 - life) * .9 });
      }
    });
  }

  /**
   * Dresses the decking as a lakeside camp with the game's own decor, placed on the deck's tiles
   * so the game draws it itself: animated torches, fire pits and windmill at their true size.
   */
  function campDecor(geometry: WorldGeometry): Map<number, Record<string, unknown>> {
    const placed = new Map<number, Record<string, unknown>>();
    const mapCols = Number(geometry.system.map?.cols);
    if (!Number.isFinite(mapCols) || mapCols <= 0) return placed;
    const owned = new Set(geometry.globals);
    const deckLeft = geometry.left + geometry.width * .62 + 20;
    const cols = [...new Set(geometry.globals.map(index => index % mapCols))]
      .filter(col => col * TILE_SIZE + TILE_SIZE / 2 > deckLeft + 40).sort((a, b) => a - b);
    const rows = [...new Set(geometry.globals.map(index => Math.floor(index / mapCols)))].sort((a, b) => a - b);
    if (cols.length < 2 || rows.length < 3) return placed;
    /** `rotation` is the game's own: 90-degree turns for decor that has them. */
    const put = (col: number | undefined, row: number | undefined, decorId: string, rotation = 0) => {
      if (col === undefined || row === undefined) return;
      const index = row * mapCols + col;
      if (owned.has(index) && !placed.has(index)) placed.set(index, { objectType: 'decor', decorId, rotation });
    };
    // Everything is laid out round the deck's centre column, which stays clear as an aisle down to
    // the fires. A torch stands in each of the four corners,
    // with benches filling the rows between them.
    const first = cols[0];
    const last = cols[cols.length - 1];
    const top = rows[0];
    const bottom = rows[rows.length - 1];
    const centre = cols[Math.floor(cols.length / 2)];
    put(first, top, 'StoneTorch');
    put(last, top, 'StoneTorch');
    put(first, bottom, 'StoneTorch');
    put(last, bottom, 'StoneTorch');
    for (const col of cols.slice(1, -1)) {
      if (col === centre) continue;
      put(col, top, 'WoodBench');
      // Turned round so the bottom row faces into the camp, like the top row does.
      put(col, bottom, 'WoodBench', 180);
    }
    // Ornaments down the far edge, a tile apart so the tall windmill has room to stand.
    const ornaments = ['WoodBirdhouse', 'WoodWindmill', 'WoodFrog', 'PaperLantern', 'WoodOwl'];
    const edgeRows = rows.slice(2, -2).filter((_, index) => index % 2 === 0);
    edgeRows.forEach((row, index) => put(last, row, ornaments[index % ornaments.length]));

    // A fire pit on the aisle with a stool either side, one or two depending on the deck's length.
    const inner = rows.slice(1, -1);
    const pitRows = inner.length >= 5 ? [inner[Math.floor(inner.length * .3)], inner[Math.floor(inner.length * .72)]] : [inner[Math.floor(inner.length / 2)]];
    const centreIndex = cols.indexOf(centre);
    firePits = [];
    for (const row of pitRows) {
      put(centre, row, 'StoneFirepit');
      if (centreIndex - 1 > 0) put(cols[centreIndex - 1], row, 'WoodStoolShort');
      if (centreIndex + 1 < cols.length - 1) put(cols[centreIndex + 1], row, 'WoodStoolShort');
      if (placed.has(row * mapCols + centre)) firePits.push({ x: centre * TILE_SIZE + TILE_SIZE / 2, y: row * TILE_SIZE + TILE_SIZE / 2 });
    }
    nativeFirePits = firePits.length > 0;
    return placed;
  }

  /** Cheap stable hash to [0, 1), so the timber weathers the same way on every build. */
  function grain(seed: number): number {
    const value = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
    return value - Math.floor(value);
  }

  const PLANK_TONES = [0x9a6334, 0x8f5a2e, 0xa56b39, 0x94602f, 0x9f6838];

  /**
   * Boardwalk planks filling a strip, with staggered butt joints, nail heads and streaks of
   * weathering. `along` is the direction the planks run.
   */
  function drawPlanks(graphic: Record<string, any>, left: number, top: number, width: number, height: number, along: 'x' | 'y', seed: number): void {
    const across = along === 'x' ? height : width;
    const length = along === 'x' ? width : height;
    const count = Math.max(1, Math.round(across / 32));
    const size = across / count;
    // Coordinates are given as (distance along the plank, distance across the strip).
    const at = (a: number, b: number): [number, number] => along === 'x' ? [left + a, top + b] : [left + b, top + a];
    const line = (a1: number, b1: number, a2: number, b2: number) => graphic.moveTo(...at(a1, b1)).lineTo(...at(a2, b2));
    for (let index = 0; index < count; index++) {
      const offset = index * size;
      const tone = PLANK_TONES[Math.floor(grain(seed + index) * PLANK_TONES.length)];
      const [x, y] = at(0, offset);
      if (along === 'x') graphic.rect(x, y, length, size).fill({ color: tone, alpha: 1 });
      else graphic.rect(x, y, size, length).fill({ color: tone, alpha: 1 });
      line(length * .05, offset + size * (.25 + grain(seed + index + 50) * .5), length * .95, offset + size * (.3 + grain(seed + index + 60) * .4))
        .stroke({ color: 0xc9925a, width: 2, alpha: .22 });
      line(length * .1, offset + size * .7, length * .85, offset + size * .72).stroke({ color: 0x5a3519, width: 1.5, alpha: .18 });
      // Butt joints every few metres, staggered plank to plank, each held by four nails.
      const spacing = 420;
      for (let joint = grain(seed + index + 90) * spacing + 40; joint < length - 30; joint += spacing) {
        line(joint, offset + 2, joint, offset + size - 2).stroke({ color: 0x4a2b17, width: 3, alpha: .75 });
        for (const side of [-7, 7]) {
          for (const across of [.28, .72]) graphic.circle(...at(joint + side, offset + size * across), 2.2).fill({ color: 0x3b2413, alpha: .8 });
        }
      }
      if (index > 0) line(0, offset, length, offset).stroke({ color: 0x4a2b17, width: 3, alpha: .85 });
    }
  }

  /** A mooring post from above: shadow, dark sides, a cut top with growth rings. */
  function drawPost(graphic: Record<string, any>, x: number, y: number, radius: number, inWater: boolean): void {
    if (inWater) graphic.ellipse(x + 4, y + 6, radius * 1.9, radius * 1.3).stroke({ color: 0xcfeef0, width: 2, alpha: .22 });
    graphic.circle(x + radius * .35, y + radius * .5, radius).fill({ color: 0x0b1f22, alpha: .35 });
    graphic.circle(x, y, radius).fill({ color: 0x4a2b17, alpha: 1 });
    graphic.circle(x - radius * .12, y - radius * .15, radius * .78).fill({ color: 0x8b5a32, alpha: 1 });
    graphic.circle(x - radius * .12, y - radius * .15, radius * .45).stroke({ color: 0x5f3a20, width: 1.5, alpha: .7 });
    graphic.circle(x - radius * .3, y - radius * .35, radius * .2).fill({ color: 0xc9925a, alpha: .5 });
  }

  /** Rope slung between two posts. `sagX`/`sagY` push the middle out, a dark underside makes it read as round. */
  function drawRope(graphic: Record<string, any>, x1: number, y1: number, x2: number, y2: number, sagX: number, sagY: number): void {
    const cx = (x1 + x2) / 2 + sagX;
    const cy = (y1 + y2) / 2 + sagY;
    graphic.moveTo(x1, y1 + 3).quadraticCurveTo(cx, cy + 3, x2, y2 + 3).stroke({ color: 0x0b1f22, width: 5, alpha: .3 });
    graphic.moveTo(x1, y1).quadraticCurveTo(cx, cy, x2, y2).stroke({ color: 0x8c7a4f, width: 5, alpha: 1 });
    graphic.moveTo(x1, y1 - 1).quadraticCurveTo(cx, cy - 1, x2, y2 - 1).stroke({ color: 0xe0cf9d, width: 1.8, alpha: .8 });
  }

  /** Where the jetty sits, shared by the decking (to leave a gap in its rail) and the jetty itself. */
  function jettyRect(water: WorldBounds): WorldBounds {
    const tileSize = Math.min(256, water.width * .22, water.height * .24);
    const size = tileSize * 2;
    return { left: water.left + water.width - size, top: water.top + (water.height - size) / 2, width: size, height: size };
  }

  /** Decking down the right: planks along its length, a timber edge, and posts and rope on the water side. */
  function drawDecking(graphic: Record<string, any>, deckLeft: number, top: number, deckWidth: number, height: number, waterWidth: number): void {
    graphic.roundRect(deckLeft - 4, top - 4, deckWidth + 8, height + 8, 16).fill({ color: 0x3b2413, alpha: 1 });
    drawPlanks(graphic, deckLeft + 6, top + 6, deckWidth - 12, height - 12, 'y', 7);
    graphic.rect(deckLeft - 18, top + 4, 24, height - 8).fill({ color: 0x5f3a20, alpha: 1 });
    graphic.rect(deckLeft - 18, top + 4, 24, 5).fill({ color: 0x8b5a32, alpha: .6 });
    const jetty = jettyRect({ left: deckLeft - 20 - waterWidth, top, width: waterWidth, height });
    const gapTop = jetty.top - 18;
    const gapBottom = jetty.top + jetty.height + 18;
    const rail = deckLeft - 6;
    const spans = Math.max(1, Math.round((height - 60) / 170));
    const posts = Array.from({ length: spans + 1 }, (_, index) => top + 30 + (height - 60) * index / spans)
      .filter(y => y < gapTop - 40 || y > gapBottom + 40);
    posts.push(gapTop, gapBottom);
    posts.sort((a, b) => a - b);
    for (let index = 1; index < posts.length; index++) {
      if (posts[index - 1] === gapTop) continue;
      drawRope(graphic, rail, posts[index - 1], rail, posts[index], -12, 0);
    }
    for (const y of posts) drawPost(graphic, rail, y, 13, false);
  }

  /**
   * The jetty out into the pond: planks running out over the water, bridged across to the
   * decking, pilings and a rope rail round the open sides, and a lantern, bait bucket, crate and
   * coil of rope for a bit of life.
   */
  function drawDock(graphic: Record<string, any>, water: NonNullable<typeof pondBounds>): void {
    const { left, top, width, height } = jettyRect(water);
    dockBounds = { left, top, width, height };
    graphic.clear();
    const bridge = 34;
    graphic.roundRect(left + 16, top + 22, width + bridge, height, 10).fill({ color: 0x0b2f38, alpha: .38 });
    graphic.roundRect(left - 8, top - 8, width + bridge + 8, height + 16, 10).fill({ color: 0x3b2413, alpha: 1 });
    drawPlanks(graphic, left, top, width + bridge, height, 'x', 31);
    // Wet, mossy lip on the end facing open water, and the cross beam where it meets the bank.
    graphic.rect(left - 8, top - 4, 6, height + 8).fill({ color: 0x2f5a3a, alpha: .6 });
    graphic.rect(left + width - 6, top - 6, 14, height + 12).fill({ color: 0x5f3a20, alpha: .9 });

    const pilings: [number, number][] = [
      [left - 4, top - 4], [left + width / 2, top - 6], [left + width - 4, top - 6],
      [left - 4, top + height + 4], [left + width / 2, top + height + 6], [left + width - 4, top + height + 6],
    ];
    for (let index = 0; index < 2; index++) {
      drawRope(graphic, ...pilings[index], ...pilings[index + 1], 0, -10);
      drawRope(graphic, ...pilings[index + 3], ...pilings[index + 4], 0, 10);
    }
    for (const [x, y] of pilings) drawPost(graphic, x, y, 16, true);

    // Lantern on a post at the end of the jetty: a warm pool of light, the frame and the glass.
    const lanternX = left - 6;
    const lanternY = top + height / 2;
    graphic.circle(lanternX + 30, lanternY, 90).fill({ color: 0xfbbf24, alpha: .07 });
    graphic.circle(lanternX + 20, lanternY, 48).fill({ color: 0xfde68a, alpha: .1 });
    drawPost(graphic, lanternX, lanternY, 16, true);
    graphic.roundRect(lanternX - 10, lanternY - 12, 20, 24, 4).fill({ color: 0x1f2937, alpha: 1 });
    graphic.roundRect(lanternX - 6, lanternY - 8, 12, 16, 3).fill({ color: 0xfde68a, alpha: 1 });
    graphic.circle(lanternX, lanternY, 3).fill({ color: 0xffffff, alpha: .9 });

    // Bait bucket near the bank end.
    const bucketX = left + width - 46;
    const bucketY = top + 44;
    graphic.circle(bucketX + 5, bucketY + 7, 20).fill({ color: 0x0b1f22, alpha: .3 });
    graphic.circle(bucketX, bucketY, 20).fill({ color: 0x6b7280, alpha: 1 });
    graphic.circle(bucketX, bucketY, 15).fill({ color: 0x3f6f5a, alpha: 1 });
    graphic.circle(bucketX - 4, bucketY - 3, 5).fill({ color: 0x9ca3af, alpha: .5 });
    graphic.circle(bucketX, bucketY, 20).stroke({ color: 0x9ca3af, width: 3, alpha: 1 });
    // A coil of rope opposite it.
    const coilX = left + width - 50;
    const coilY = top + height - 48;
    graphic.circle(coilX + 4, coilY + 6, 24).fill({ color: 0x0b1f22, alpha: .28 });
    for (let ring = 0; ring < 4; ring++) {
      graphic.circle(coilX, coilY, 22 - ring * 5).stroke({ color: ring % 2 ? 0xb9a574 : 0x8c7a4f, width: 5, alpha: 1 });
    }
    // A fish crate along the far side, stencilled with a little fish.
    const crateX = left + width * .42;
    const crateY = top + height - 58;
    graphic.rect(crateX + 5, crateY + 7, 44, 38).fill({ color: 0x0b1f22, alpha: .3 });
    graphic.rect(crateX, crateY, 44, 38).fill({ color: 0xb07a45, alpha: 1 });
    graphic.rect(crateX, crateY, 44, 38).stroke({ color: 0x5f3a20, width: 4, alpha: 1 });
    graphic.moveTo(crateX + 3, crateY + 3).lineTo(crateX + 41, crateY + 35).stroke({ color: 0x5f3a20, width: 3, alpha: .8 });
    graphic.ellipse(crateX + 24, crateY + 26, 8, 4).fill({ color: 0x3b2413, alpha: .55 });
    graphic.poly([crateX + 16, crateY + 26, crateX + 10, crateY + 22, crateX + 10, crateY + 30], true).fill({ color: 0x3b2413, alpha: .55 });
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

  function addRipple(x: number, y: number, size: number, life: number, alpha: number): void {
    ripples.push({ x, y, at: performance.now(), size, life, alpha });
    if (ripples.length > 90) ripples.splice(0, ripples.length - 90);
  }

  /** A pond-fraction point to world coordinates. */
  function pondPoint(x: number, y: number): { x: number; y: number } {
    const { left, top, width, height } = pondBounds!;
    return { x: left + width * x, y: top + height * y };
  }

  /** Screen point to a spot on the water, pushed off the dock so the float never lands on planks. */
  function aimAt(clientX: number, clientY: number): { x: number; y: number } | null {
    if (!pondBounds) return null;
    const world = scene.toWorld(clientX, clientY);
    if (!world) return null;
    let { x } = world;
    const { y } = world;
    if (dockBounds && x > dockBounds.left - 50 && y > dockBounds.top - 30 && y < dockBounds.top + dockBounds.height + 30) x = dockBounds.left - 50;
    const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
    return {
      x: clamp((x - pondBounds.left) / pondBounds.width, .06, .94),
      y: clamp((y - pondBounds.top) / pondBounds.height, .08, .92),
    };
  }

  /** Scales a 0xRRGGBB colour toward black (below 1) or white (above 1). */
  function shade(colour: number, factor: number): number {
    const channel = (shift: number) => {
      const value = colour >> shift & 255;
      return Math.round(factor < 1 ? value * factor : value + (255 - value) * (factor - 1)) & 255;
    };
    return channel(16) << 16 | channel(8) << 8 | channel(0);
  }

  /**
   * A top-down fish built along a spine that swims: the head holds steady and a travelling wave
   * grows toward the tail, so the whole body flexes instead of a rigid shape wagging a triangle.
   * `swim` is the wave's phase, `thrash` scales how hard it flexes, and `spots` paints koi patches.
   */
  function drawFish(graphic: Record<string, any>, x: number, y: number, size: number, colour: number, direction: number, swim: number, alpha = .88, thrash = 1, spots = false): void {
    const segments = 8;
    const length = size * 1.9;
    const amplitude = size * .17 * thrash;
    const spine = Array.from({ length: segments + 1 }, (_, index) => {
      const t = index / segments;
      return { x: x + direction * (size * .95 - t * length), y: y + Math.sin(swim - t * 2.4) * amplitude * t * t };
    });
    const normal = (index: number) => {
      const from = spine[Math.max(0, index - 1)];
      const to = spine[Math.min(segments, index + 1)];
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const span = Math.hypot(dx, dy) || 1;
      return { x: -dy / span, y: dx / span };
    };
    // Round at the nose, widest a third of the way back, narrowing into the tail root.
    const halfWidth = (t: number) => size * .44 * Math.sin(Math.PI * (.16 + .74 * t));
    const outline = (offsetX: number, offsetY: number): number[] => {
      const head = spine[0];
      const sides: number[][] = [[], []];
      spine.forEach((point, index) => {
        const n = normal(index);
        const w = halfWidth(index / segments);
        sides[0].push(point.x + n.x * w + offsetX, point.y + n.y * w + offsetY);
        sides[1].unshift(point.x - n.x * w + offsetX, point.y - n.y * w + offsetY);
      });
      return [head.x + direction * size * .14 + offsetX, head.y + offsetY, ...sides[0], ...sides[1]];
    };
    const back = (() => {
      const from = spine[segments - 1];
      const to = spine[segments];
      const span = Math.hypot(to.x - from.x, to.y - from.y) || 1;
      return { x: (to.x - from.x) / span, y: (to.y - from.y) / span };
    })();
    const tailRoot = spine[segments];
    const tailNormal = normal(segments);
    const flick = Math.sin(swim - 2.9) * .18 * thrash;
    const tailPoint = (reach: number, spread: number) => ({
      x: tailRoot.x + back.x * size * reach + tailNormal.x * size * (spread + flick),
      y: tailRoot.y + back.y * size * reach + tailNormal.y * size * (spread + flick),
    });

    // Shadow on the pond bed, offset as if lit from the top left.
    graphic.poly(outline(size * .22, size * .32), true).fill({ color: 0x03161c, alpha: .24 * alpha });

    // Pectoral fins, flapping out of step with each other.
    for (const side of [1, -1]) {
      const root = spine[2];
      const n = normal(2);
      const w = halfWidth(.25) * .8;
      const flap = .28 + Math.sin(swim * 1.3 + (side > 0 ? 0 : Math.PI)) * .1;
      graphic.poly([
        root.x + n.x * w * side, root.y + n.y * w * side,
        root.x + n.x * (w + size * flap) * side + back.x * size * .3, root.y + n.y * (w + size * flap) * side + back.y * size * .3,
        root.x + n.x * w * side + back.x * size * .28, root.y + n.y * w * side + back.y * size * .28,
      ], true).fill({ color: shade(colour, .8), alpha: alpha * .8 });
    }

    const tailTop = tailPoint(.64, .48);
    const tailNotch = tailPoint(.36, 0);
    const tailBottom = tailPoint(.64, -.48);
    graphic.poly([tailRoot.x, tailRoot.y, tailTop.x, tailTop.y, tailNotch.x, tailNotch.y, tailBottom.x, tailBottom.y], true)
      .fill({ color: shade(colour, .88), alpha: alpha * .9 });

    const body = outline(0, 0);
    graphic.poly(body, true).fill({ color: colour, alpha });
    graphic.poly(body, true).stroke({ color: shade(colour, .55), width: Math.max(1.5, size * .05), alpha: alpha * .55 });

    if (spots) {
      for (const [index, side, scale] of [[2, .35, .2], [4, -.3, .24], [6, .2, .14]] as const) {
        const point = spine[index];
        const n = normal(index);
        const w = halfWidth(index / segments);
        graphic.circle(point.x + n.x * w * side, point.y + n.y * w * side, size * scale).fill({ color: 0xfaf7f0, alpha: alpha * .85 });
      }
    }

    // A darker ridge down the back and a soft sheen along one flank.
    graphic.moveTo(spine[1].x, spine[1].y);
    for (let index = 2; index <= segments - 1; index++) graphic.lineTo(spine[index].x, spine[index].y);
    graphic.stroke({ color: shade(colour, .6), width: size * .12, alpha: alpha * .45 });
    const sheen = (index: number) => {
      const n = normal(index);
      const w = halfWidth(index / segments) * .45;
      return { x: spine[index].x - n.x * w, y: spine[index].y - n.y * w };
    };
    const firstSheen = sheen(1);
    graphic.moveTo(firstSheen.x, firstSheen.y);
    for (let index = 2; index <= 5; index++) { const point = sheen(index); graphic.lineTo(point.x, point.y); }
    graphic.stroke({ color: 0xffffff, width: size * .07, alpha: alpha * .22 });

    // Eyes sit either side of the head, as they would from above.
    const eyeNormal = normal(0);
    const eyeBase = { x: spine[0].x - direction * size * .02, y: spine[0].y };
    const eyeOffset = halfWidth(0) * .78;
    for (const side of [1, -1]) {
      const eyeX = eyeBase.x + eyeNormal.x * eyeOffset * side;
      const eyeY = eyeBase.y + eyeNormal.y * eyeOffset * side;
      graphic.circle(eyeX, eyeY, Math.max(2, size * .075)).fill({ color: 0xf8fafc, alpha });
      graphic.circle(eyeX + direction * size * .015, eyeY, Math.max(1.2, size * .045)).fill({ color: 0x0b1220, alpha });
    }
  }

  /** Tint, frost rim and a slow drift of light across the surface. */
  function drawWater(graphic: Record<string, any>, now: number): void {
    const { left, top, width, height } = pondBounds!;
    const current = weather();
    const tint = current ? WEATHER_TINT[current] : undefined;
    if (tint) graphic.roundRect(left, top, width, height, 44).fill(tint);
    if (current === 'Frost') {
      graphic.roundRect(left + 7, top + 7, width - 14, height - 14, 40).stroke({ color: 0xf0f9ff, width: 14, alpha: .38 });
    }
    for (let index = 0; index < 7; index++) {
      const drift = (index * .173 + now / 70000 * (1 + index % 3 * .35)) % 1;
      const x = left + 70 + (width - 140) * drift;
      const y = top + height * (.1 + index * .125);
      const alpha = .05 + .05 * Math.sin(now / 900 + index * 1.7);
      if (alpha > .01) graphic.ellipse(x, y, 46 + index % 3 * 14, 3).fill({ color: 0xffffff, alpha });
    }
  }

  function playerPoint(geometry: WorldGeometry): { x: number; y: number } | null {
    const avatar = scene.avatar();
    if (!avatar?.getGlobalPosition || !geometry.system.worldContainer?.toLocal) return null;
    try {
      const point = geometry.system.worldContainer.toLocal(avatar.getGlobalPosition());
      return { x: point.x, y: point.y };
    } catch { return null; }
  }

  function updateWorldScene(now: number): void {
    if (panel()?.hidden) return;
    const geometry = scene.sync();
    const fishGraphic = scene.layer('fish');
    const surface = scene.layer('surface');
    const rodGraphic = scene.layer('rod');
    const fireGraphic = scene.layer('fire');
    if (fireGraphic) drawFirePits(fireGraphic, now);
    if (!geometry || !pondBounds || !farmBounds || !fishGraphic || !surface || !rodGraphic) return;
    positionPondInput();
    const { left, top, width, height } = pondBounds;
    const player = playerPoint(geometry);
    fishGraphic.clear();
    surface.clear();
    drawWater(fishGraphic, now);

    for (const swimmer of swimmers) {
      const direction = Math.sign(swimmer.speed) || 1;
      const size = swimmer.size * 3.1;
      const routeProgress = Math.max(0, Math.min(1, (swimmer.x + .15) / 1.3));
      const horizontalPadding = Math.min(width * .2, size * 1.35);
      const verticalPadding = Math.min(height * .2, size * .65);
      const sway = Math.sin(now / 1600 + swimmer.phase) * .025;
      const x = left + horizontalPadding + routeProgress * Math.max(0, width - horizontalPadding * 2);
      const y = top + verticalPadding + Math.max(0, Math.min(1, swimmer.y + sway)) * Math.max(0, height - verticalPadding * 2);
      drawFish(fishGraphic, x, y, size, Number.parseInt(swimmer.colour.slice(1), 16), direction, now / 170 + swimmer.phase, .82, 1, swimmer.spots);
    }

    // Where the line ends: the float while waiting, the fish itself once it is on.
    const castElapsed = Math.max(0, now - castAt);
    const casting = phase === 'waiting' && castElapsed < CAST_WINDUP + CAST_FLIGHT;
    const float = pondPoint(castDistance, hookDepth);
    let lineEnd = float;
    if (phase === 'reel' && hooked) {
      // Distance follows the bar: the fish starts where the float landed, comes in to the player's
      // feet as the bar fills, and backs off past the float as it drains toward the floor.
      const reach = Math.max(-.4, Math.min(1, (progress - fightStartProgress) / Math.max(.01, 1 - fightStartProgress)));
      const home = player ? { x: player.x, y: player.y - 20 } : float;
      const anchor = { x: home.x + (float.x - home.x) * (1 - reach), y: home.y + (float.y - home.y) * (1 - reach) };
      if (reach < 0) {
        anchor.x = Math.max(left + 40, Math.min(left + width - 40, anchor.x));
        anchor.y = Math.max(top + 40, Math.min(top + height - 40, anchor.y));
      }
      // The track runs across the water, narrowing as the fish comes in so it does not swing wide at your feet.
      const fishX = anchor.x + (fishAt - .5) * Math.min(260, width * .28) * (1 - Math.max(0, reach) * .6);
      const fishY = anchor.y + Math.sin(now / 260) * 6;
      const tier = RARITY_ORDER.indexOf(hooked.rarity);
      const share = (hookedWeight - hooked.min) / Math.max(.01, hooked.max - hooked.min);
      const size = 30 + tier * 4 + share * 12;
      const direction = fishVelocity >= 0 ? 1 : -1;
      drawFish(fishGraphic, fishX, fishY, size, Number.parseInt(RARITIES[hooked.rarity].colour.slice(1), 16), direction, now / (fishInside ? 85 : 42), .78, fishInside ? 1.3 : 2.2);
      lineEnd = { x: fishX + direction * size * .9, y: fishY };
      hookedPos = { x: (fishX - left) / width, y: (fishY - top) / height };
      if (now - lastThrashAt > (fishInside ? 480 : 170)) {
        lastThrashAt = now;
        addRipple(hookedPos.x + (Math.random() - .5) * .03, hookedPos.y + (Math.random() - .5) * .04, fishInside ? 34 : 52, 650, fishInside ? .35 : .6);
      }
    } else if (phase === 'waiting' || phase === 'bite') {
      hookedPos = { x: castDistance, y: hookDepth };
    }

    for (const ripple of ripples) {
      const age = (now - ripple.at) / ripple.life;
      if (age < 0 || age >= 1) continue;
      const point = pondPoint(ripple.x, ripple.y);
      const radius = ripple.size * (.25 + age);
      surface.ellipse(point.x, point.y, radius, radius * .72).stroke({ color: 0xe0f2fe, width: 2.5, alpha: ripple.alpha * (1 - age) });
    }
    ripples = ripples.filter(ripple => now - ripple.at < ripple.life);

    if ((phase === 'waiting' && !casting) || phase === 'bite') {
      const bob = Math.sin(now / 420) * 2.5;
      const nibble = Math.max(0, 1 - (now - nibbleAt) / 300);
      if (phase === 'bite') {
        // Pulled under: only a dark smudge and a pulsing gold ring show where it went.
        surface.circle(float.x, float.y + 4, 9).fill({ color: 0x7f1d1d, alpha: .45 });
        surface.circle(float.x, float.y, 28 + Math.sin(now / 90) * 7).stroke({ color: 0xfbbf24, width: 5, alpha: .75 });
      } else {
        const y = float.y + bob + nibble * 6;
        const scale = 1 - nibble * .3;
        surface.ellipse(float.x, float.y + 8, 13, 5).fill({ color: 0x0b2530, alpha: .25 });
        surface.circle(float.x, y, 11 * scale).fill({ color: 0xef4444, alpha: .95 });
        surface.circle(float.x, y - 4 * scale, 7 * scale).fill({ color: 0xf8fafc, alpha: .95 });
        surface.circle(float.x, y - 9 * scale, 2.5 * scale).fill({ color: 0x1f2937, alpha: 1 });
      }
    }

    if (flashAt > -Infinity) {
      const flash = Math.max(0, 1 - (now - flashAt) / 380);
      const flicker = now - flashAt > 90 && now - flashAt < 150 ? .3 : 1;
      if (flash > 0) surface.roundRect(left, top, width, height, 44).fill({ color: 0xf8fafc, alpha: .32 * flash * flicker });
    }

    rodGraphic.clear();
    if (!player) return;
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
    // Between casts the line is wound in: the float hangs a short way below the rod tip, swaying.
    const reeledIn = phase === 'idle' || phase === 'result';
    let lineEndX = reeledIn ? rodTipX + Math.sin(now / 650) * 4 : lineEnd.x;
    let lineEndY = reeledIn ? rodTipY + 42 : lineEnd.y;
    if (casting && castElapsed < CAST_WINDUP) {
      lineEndX = rodTipX;
      lineEndY = rodTipY;
    } else if (casting) {
      const progress = Math.max(0, Math.min(1, (castElapsed - CAST_WINDUP) / CAST_FLIGHT));
      lineEndX = rodTipX + (lineEnd.x - rodTipX) * progress;
      lineEndY = rodTipY + (lineEnd.y - rodTipY) * progress - Math.sin(Math.PI * progress) * 70;
      surface.circle(lineEndX, lineEndY, 10).fill({ color: 0xf8fafc, alpha: .92 });
    }
    // The rod bows toward the fish under load: harder while reeling, a flick on the strike.
    const tension = phase === 'reel' ? (holding ? 1 : .55) : phase === 'bite' ? .45 : 0;
    const towardX = lineEndX - rodTipX;
    const towardY = lineEndY - rodTipY;
    const reach = Math.hypot(towardX, towardY) || 1;
    const jitter = phase === 'reel' ? Math.sin(now / 38) * 2.2 * tension : 0;
    const bentX = rodTipX + towardX / reach * 30 * tension + jitter;
    const bentY = rodTipY + towardY / reach * 30 * tension + 10 * tension;
    const controlX = (rodBaseX + rodTipX) / 2;
    const controlY = (rodBaseY + rodTipY) / 2;
    rodGraphic.moveTo(rodBaseX, rodBaseY).quadraticCurveTo(controlX, controlY, bentX, bentY).stroke({ color: 0x70411f, width: 9, alpha: 1 });
    rodGraphic.moveTo(rodBaseX, rodBaseY).quadraticCurveTo(controlX, controlY - 2, bentX, bentY - 1).stroke({ color: 0xc08346, width: 2.5, alpha: .55 });
    const slack = phase === 'waiting' && !casting ? 26 : 0;
    rodGraphic.moveTo(bentX, bentY)
      .quadraticCurveTo((bentX + lineEndX) / 2, (bentY + lineEndY) / 2 + slack, lineEndX, lineEndY)
      .stroke({ color: 0xe2e8f0, width: phase === 'reel' ? 2.5 : 2, alpha: .85 });
    if (reeledIn) {
      rodGraphic.circle(lineEndX, lineEndY + 7, 7).fill({ color: 0xef4444, alpha: 1 });
      rodGraphic.circle(lineEndX, lineEndY + 3, 4.5).fill({ color: 0xf8fafc, alpha: 1 });
      rodGraphic.circle(lineEndX, lineEndY, 1.8).fill({ color: 0x1f2937, alpha: 1 });
    }
    rodGraphic.circle(rodBaseX, rodBaseY, 7).fill({ color: 0xd6a15b, alpha: 1 });
    rodGraphic.circle(rodBaseX + 10, rodBaseY - 8, 5).stroke({ color: 0x3f2a18, width: 2, alpha: .9 });

    // A landed fish arcs out of the water and over to the player.
    if (leap) {
      const age = (now - leap.at) / 650;
      if (age >= 1) leap = null;
      else {
        const from = pondPoint(leap.x, leap.y);
        const x = from.x + (player.x - from.x) * age;
        const y = from.y + (player.y - 60 - from.y) * age - Math.sin(Math.PI * age) * 110;
        const direction = player.x >= from.x ? 1 : -1;
        drawFish(rodGraphic, x, y, leap.size * (1 + age * .2), leap.colour, direction, now / 40, .95, 2);
      }
    }
  }

  function updateHud(): void {
    const host = panel();
    if (!host || host.hidden || view !== 'game') return;
    if (renderedWeather !== weather() && phase !== 'reel' && phase !== 'bite') { renderChrome(); return; }
    const status = host.querySelector<HTMLElement>('[data-fishing-status]');
    const meter = host.querySelector<HTMLElement>('.gf-meter');
    const track = host.querySelector<HTMLElement>('.gf-track');
    const progressNode = host.querySelector<HTMLElement>('.gf-meter-progress i');
    const zoneNode = host.querySelector<HTMLElement>('.gf-track-zone');
    const fishNode = host.querySelector<HTMLElement>('.gf-track-fish');
    const live = phase === 'reel';
    const colour = hooked ? RARITIES[hooked.rarity].colour : '#34d399';
    if (status) { status.textContent = message; status.style.color = resultColour; }
    if (meter) meter.dataset.live = String(live);
    if (track) track.dataset.slip = String(live && !fishInside);
    if (progressNode) {
      const shown = Math.max(0, Math.min(1, progress));
      progressNode.style.height = `${shown * 100}%`;
      progressNode.style.background = live && progress < .12 ? '#f87171' : colour;
    }
    if (zoneNode) {
      zoneNode.style.top = `${Math.max(0, zoneAt - zoneHeight / 2) * 100}%`;
      zoneNode.style.height = `${zoneHeight * 100}%`;
      zoneNode.dataset.inside = String(live && fishInside);
      zoneNode.hidden = !live;
    }
    if (fishNode) {
      fishNode.style.top = `${fishAt * 100}%`;
      fishNode.style.color = colour;
      fishNode.style.background = colour;
      fishNode.hidden = !live;
    }
  }

  // Idle scenery: a few fish drifting through the water so the pond is never still.
  interface Swimmer { x: number; y: number; speed: number; size: number; colour: string; phase: number; spots: boolean }
  const SWIMMER_COLOURS = ['#4b7f96', '#3f6f86', '#5b8f7a', '#6b7f9c', '#7a8fa0'];
  /** About one fish in four is a koi, which reads as a garden pond rather than a river. */
  const KOI_COLOURS = ['#e0763a', '#d9d2c3', '#c2410c'];
  const swimmers: Swimmer[] = Array.from({ length: 9 }, () => spawnSwimmer(Math.random()));

  function spawnSwimmer(x = Math.random() < .5 ? -.1 : 1.1): Swimmer {
    const rightward = x < .5;
    const koi = Math.random() < .25;
    return {
      x,
      y: .12 + Math.random() * .78,
      speed: (rightward ? 1 : -1) * (.035 + Math.random() * .075),
      size: 6 + Math.random() * 10,
      ...(koi
        ? { colour: KOI_COLOURS[Math.floor(Math.random() * KOI_COLOURS.length)], spots: true }
        : { colour: SWIMMER_COLOURS[Math.floor(Math.random() * SWIMMER_COLOURS.length)], spots: false }),
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

  /** Casts to the clicked spot on the pond, or somewhere mid-water when cast from the button. */
  function cast(aim?: { x: number; y: number } | null): void {
    if (phase !== 'idle' && phase !== 'result') return;
    record.casts++;
    save();
    hooked = null;
    testing = false;
    holding = false;
    lastCatch = null;
    progress = 0;
    leap = null;
    castDistance = aim?.x ?? .28 + Math.random() * .5;
    hookDepth = aim?.y ?? .16 + Math.random() * .38;
    castAt = performance.now();
    // The bite can never land before the float does, whatever the wait rolls.
    const landAt = castAt + CAST_WINDUP + CAST_FLIGHT;
    const wait = (1200 + Math.random() * 3600) * (activeBait()?.wait ?? 1);
    waitUntil = landAt + wait;
    landedSplash = false;
    nibbleAt = -Infinity;
    nibbles = Array.from({ length: Math.floor(Math.random() * 4) }, () => landAt + 500 + Math.random() * Math.max(0, wait - 900))
      .filter(at => at < waitUntil - 350)
      .sort((a, b) => a - b);
    setPhase('waiting', 'Line is out. Nibbles are fakes - wait for it to go under.');
    playCast();
    resumeLoop();
  }

  /** Puts a fish on the hook and resets the fight, shared by a real bite and a bench fight. */
  function armFish(fish: FishDef, now: number): void {
    hooked = fish;
    hookedWeight = fish.min + Math.random() * (fish.max - fish.min);
    fight = createFight(fish, { zone: equipmentTotal('zone'), fill: equipmentFill(), drain: equipmentDrain(), start: equipmentTotal('start') });
    syncFight();
    lastCatch = null;
    fightEndedAt = 0;
  }

  /** Copies the fight's state into what the scene and meter draw from. */
  function syncFight(): void {
    if (!fight) return;
    fishAt = fight.fishAt;
    fishVelocity = fight.fishVelocity;
    zoneAt = fight.zoneAt;
    zoneHeight = fight.zoneHeight;
    progress = fight.progress;
    fightStartProgress = fight.startProgress;
    fishInside = fight.inside;
    fightSlipped = fight.slipped;
  }

  function beginBite(now: number): void {
    const bait = activeBait();
    armFish(pickFish(weather(), bait), now);
    if (bait) {
      record.baits[bait.id]--;
      if (record.baits[bait.id] <= 0) { delete record.baits[bait.id]; record.bait = ''; }
      save();
    }
    testing = false;
    biteAt = now;
    lastBiteRingAt = 0;
    addRipple(castDistance, hookDepth, 90, 900, .8);
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
    setPhase('reel', `Test fight: ${fish.name}`);
    startLoop();
  }

  function beginReel(now: number): void {
    reelStartedAt = now;
    // The click that set the hook is already a press, so it counts as the first pull.
    holding = true;
    setPhase('reel', 'Hold to lift the zone, release to let it sink.');
  }

  /** Runs live during a fight and freezes once one ends, so the badge and the result agree. */
  function fightLength(): string {
    return `${(((fightEndedAt || performance.now()) - reelStartedAt) / 1000).toFixed(1)}s`;
  }

  function land(): void {
    if (!hooked) return;
    fightEndedAt = performance.now();
    const existing = record.fish[hooked.id];
    const perfect = !fightSlipped;
    const trophy = isTrophy(hooked, hookedWeight);
    const sizeRecord = Boolean(existing) && hookedWeight > (existing?.best ?? 0);
    const base = catchRewards(hooked, hookedWeight);
    const bonus = (perfect ? PERFECT_BONUS : 1) * (trophy ? TROPHY_BONUS : 1);
    const reward = testing ? { coins: 0, xp: 0 } : { coins: Math.round(base.coins * bonus), xp: Math.round(base.xp * bonus) };
    const droppedItem = testing ? undefined : itemDrop(hooked);
    if (!testing) {
      record.fish[hooked.id] = {
        count: (existing?.count ?? 0) + 1,
        best: Math.max(existing?.best ?? 0, hookedWeight),
        first: existing?.first ?? Date.now(),
      };
      record.caught++;
      if (perfect) record.perfects++;
      record.coins += reward.coins;
      record.xp += reward.xp;
      if (droppedItem) record.equipment[droppedItem.id] = 1;
      save();
    }
    const rule = RARITIES[hooked.rarity];
    lastCatch = { fish: hooked, weight: hookedWeight, fresh: !testing && !existing, ...reward, item: droppedItem, perfect, trophy, sizeRecord };
    const tier = RARITY_ORDER.indexOf(hooked.rarity);
    const share = (hookedWeight - hooked.min) / Math.max(.01, hooked.max - hooked.min);
    leap = { at: fightEndedAt, x: hookedPos.x, y: hookedPos.y, colour: Number.parseInt(rule.colour.slice(1), 16), size: 30 + tier * 4 + share * 12 };
    addRipple(hookedPos.x, hookedPos.y, 110, 1000, .85);
    addRipple(hookedPos.x, hookedPos.y, 60, 700, .6);
    playCatch(tier);
    const detail = testing
      ? `Test fight won in ${fightLength()} - not recorded`
      : `${hooked.name} landed in ${fightLength()}`;
    setPhase('result', detail, rule.colour);
  }

  function lose(text: string): void {
    fightEndedAt = performance.now();
    if (phase === 'bite' || phase === 'reel') {
      addRipple(hookedPos.x, hookedPos.y, 120, 1100, .8);
      addRipple(hookedPos.x + .02, hookedPos.y - .02, 50, 600, .6);
    }
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

  function press(aim?: { x: number; y: number } | null): void {
    const now = performance.now();
    if (phase === 'result' && now < resultLockUntil) return;
    if (phase === 'idle' || phase === 'result') return cast(aim);
    if (phase === 'waiting') return lose(now - nibbleAt < 400 ? 'Struck at a nibble. It spooked.' : 'Reeled in too early. Nothing there.');
    if (phase === 'bite') return beginReel(now);
    if (phase === 'reel') holding = true;
  }

  function release(): void { holding = false; }

  function shiftActiveTimers(duration: number): void {
    if (phase === 'waiting') {
      waitUntil += duration;
      castAt += duration;
      nibbleAt += duration;
      nibbles = nibbles.map(at => at + duration);
    } else if (phase === 'bite') biteAt += duration;
    else if (phase === 'reel') {
      reelStartedAt += duration;
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
    if (phase === 'waiting') {
      if (!landedSplash && now >= castAt + CAST_WINDUP + CAST_FLIGHT) {
        landedSplash = true;
        addRipple(castDistance, hookDepth, 70, 900, .7);
        addRipple(castDistance, hookDepth, 36, 600, .5);
      }
      while (nibbles.length && now >= nibbles[0]) {
        nibbles.shift();
        nibbleAt = now;
        addRipple(castDistance, hookDepth, 30, 550, .45);
        playNibble();
      }
      if (now >= waitUntil) beginBite(now);
    } else if (phase === 'bite') {
      if (now - lastBiteRingAt > 220) { lastBiteRingAt = now; addRipple(castDistance, hookDepth, 56, 700, .6); }
      if (now - biteAt > BITE_WINDOW + equipmentTotal('bite')) lose('The bite went slack. It let go.');
    } else if (phase === 'reel' && hooked && fight) {
      const result = fight.step(delta, holding);
      syncFight();
      if (holding) playReelClick(fishInside);
      // Landing or losing only ends the cast, never the loop: the frame below must always be
      // queued, or the panel stops animating and no later cast can ever start.
      if (result === 'landed') land();
      else if (result === 'escaped') lose('It threw the hook and was gone.');
      else if (result === 'timeout') lose('The line gave out. It kept the hook.');
    }
    for (const swimmer of swimmers) {
      swimmer.x += swimmer.speed * delta;
      if (swimmer.x < -.15 || swimmer.x > 1.15) Object.assign(swimmer, spawnSwimmer());
    }
    const current = weather();
    const rain = current ? RAIN_RATE[current] ?? 0 : 0;
    if (rain && Math.random() < rain * delta) addRipple(.05 + Math.random() * .9, .06 + Math.random() * .88, 14 + Math.random() * 10, 700, .4);
    if (current === 'Thunderstorm' && now >= nextFlashAt) {
      if (nextFlashAt) flashAt = now;
      nextFlashAt = now + 6000 + Math.random() * 10000;
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
        const detail = entry ? [gate, FIGHT_STYLES[fish.style].label, fish.note].filter(Boolean).join(' · ') : gate || 'Not caught yet';
        const trophy = entry && isTrophy(fish, entry.best) ? '<span title="Trophy-sized catch">&#127942;</span> ' : '';
        return `<div class="gf-row" data-found="${Boolean(entry)}"><i style="background:${RARITIES[rarity].colour};color:${RARITIES[rarity].colour}"></i><span><b>${escapeHtml(fish.name)}</b><small>${escapeHtml(detail)}</small></span><em>${entry ? `${trophy}${entry.count}x &middot; ${escapeHtml(formatWeight(entry.best))}` : '&mdash;'}</em></div>`;
      }).join('');
      const tierFound = FISH.filter(fish => fish.rarity === rarity && record.fish[fish.id]).length;
      const tierTotal = FISH.filter(fish => fish.rarity === rarity).length;
      return `<div class="gf-tier" style="color:${RARITIES[rarity].colour}"><span>${RARITIES[rarity].label}</span><span>${tierFound}/${tierTotal}</span></div>${rows}`;
    }).join('');
    return `<div class="gf-body"><p class="gf-note">Fish with a weather listed bite in that weather and no other. Caught fish are recorded in this browser only - nothing here touches your garden.</p><div class="gf-totals"><div><small>Caught</small><b>${record.caught.toLocaleString(NUMBER_LOCALE)}</b></div><div><small>Species</small><b>${found}/${FISH.length}</b></div><div><small>Casts</small><b>${record.casts.toLocaleString(NUMBER_LOCALE)}</b></div><div><small>Perfect</small><b>${record.perfects.toLocaleString(NUMBER_LOCALE)}</b></div></div><p class="gf-note">A perfect catch never lets the fish leave the zone and pays ${PERFECT_BONUS}x. A trophy sits in the top ${Math.round((1 - TROPHY_SHARE) * 100)}% of its species' weight and pays ${TROPHY_BONUS}x.</p>${sections}<div class="gf-reset"><button data-reset>Reset record</button></div></div>`;
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
        return `<div class="gf-gear" data-active="${equipped}" data-locked="${!owned && !item.price}"><span class="gf-gear-icon">${SLOT_ICONS[slot]}</span><span class="gf-gear-text"><b>${escapeHtml(item.name)}</b><small>${escapeHtml(acquisition)}</small></span>${action}</div>`;
      }).join('');
      return `<div class="gf-tier"><span>${slotNames[slot]}</span><span>${record.equipped[slot] ? escapeHtml(EQUIPMENT_BY_ID.get(record.equipped[slot])?.name ?? '') : 'Empty'}</span></div><div class="gf-gear-grid">${rows}</div>`;
    }).join('');
    const baitRows = BAITS.map(bait => {
      const held = record.baits[bait.id] ?? 0;
      const using = record.bait === bait.id && held > 0;
      const use = held ? `<button data-use-bait="${bait.id}" data-active="${using}">${using ? 'On hook' : 'Use'}</button>` : '';
      const buy = `<button data-buy-bait="${bait.id}" ${record.coins < bait.price ? 'disabled' : ''}>${BAIT_PACK} for ${bait.price.toLocaleString(NUMBER_LOCALE)}</button>`;
      const flavour = using ? `<p class="gf-flavour">${escapeHtml(bait.flavour)}</p>` : '';
      return `<div class="gf-gear" data-active="${using}"><span class="gf-gear-icon">${bait.icon}</span><span class="gf-gear-text"><b>${escapeHtml(bait.name)}${held ? ` &times;${held}` : ''}</b><small>${escapeHtml(bait.detail)}</small></span>${use}${buy}${flavour}</div>`;
    }).join('');
    const baitSection = `<div class="gf-tier"><span>Bait</span><span>${escapeHtml(activeBait()?.name ?? 'Bare hook')}</span></div><p class="gf-note">One piece is used each time a fish bites. Reeling in early keeps it.</p><div class="gf-gear-grid">${baitRows}</div>`;
    return `<div class="gf-body"><div class="gf-totals"><div><small>Level</small><b>${level.level}</b></div><div><small>XP</small><b>${record.xp.toLocaleString(NUMBER_LOCALE)}</b></div><div><small>Coins</small><b>${record.coins.toLocaleString(NUMBER_LOCALE)}</b></div></div><div class="gf-progress-line"><i style="width:${level.current / level.needed * 100}%"></i></div><p class="gf-note" style="margin-top:8px">${level.current.toLocaleString(NUMBER_LOCALE)} / ${level.needed.toLocaleString(NUMBER_LOCALE)} XP to the next level. Each level adds 0.5% catch progress, up to 12%. Fishing coins, XP and equipment belong only to this minigame.</p>${baitSection}${sections}</div>`;
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
        `<button class="gf-bench-fish" data-fight="${escapeHtml(fish.id)}">${escapeHtml(fish.name)}<small>${escapeHtml([fish.weather ? weatherLabel(fish.weather) : '', FIGHT_STYLES[fish.style].label].filter(Boolean).join(' · '))}</small></button>`).join('');
      return `<div class="gf-tier" style="color:${rule.colour}"><span>${rule.label}</span><span>hold ${breakEven}% to break even</span></div><div class="gf-bench-stats"><span>Zone <b>${Math.round(rule.zone * 100)}%</b></span><span>Fish <b>${fishTravelSpeed(rule.speed).toFixed(2)}/s</b></span><span>Lift <b>${((ZONE_LIFT - ZONE_GRAVITY) / ZONE_DRAG * zoneAgility(rule.speed)).toFixed(2)}/s</b></span><span>Drop <b>${(ZONE_GRAVITY / ZONE_DRAG * zoneAgility(rule.speed)).toFixed(2)}/s</b></span><span>Fill <b>${fill.toFixed(3)}/s</b></span><span>Drain <b>${drain.toFixed(3)}/s</b></span><span>Flawless <b>${perfect}s</b></span></div><div class="gf-bench-grid">${buttons}</div>`;
    }).join('');
    return `<div class="gf-body"><p class="gf-note">Pick any fish to fight it straight away, skipping the cast and its weather. Bench fights are never added to your record. Pace ${FIGHT_PACE}, start ${START_PROGRESS}, floor ${LOSE_FLOOR}, limit ${REEL_LIMIT / 1000}s.</p>${tiers}<div class="gf-reset"><button data-view="game">Back to the pond</button></div></div>`;
  }

  /** Weather-only fish that can bite right now. Uncaught ones stay a mystery until landed. */
  function bitingHtml(): string {
    const current = weather();
    const special = FISH.filter(fish => fish.weather && fish.weather === current);
    const body = special.length
      ? special.map(fish => `<span style="color:${RARITIES[fish.rarity].colour}" title="${RARITIES[fish.rarity].label}">${record.fish[fish.id] ? escapeHtml(fish.name) : '???'}</span>`).join('')
      : '<p>Only the regulars. Weather brings rarer fish.</p>';
    return `<div><div class="gf-label"><span>Biting now</span><span>${weatherIcon(current)} ${escapeHtml(weatherLabel(current))}</span></div><div class="gf-biting">${body}</div></div>`;
  }

  function phaseLabel(): string {
    if (phase === 'waiting') return 'Line out';
    if (phase === 'bite') return 'Bite!';
    if (phase === 'reel') return testing ? 'Test fight' : 'Reeling';
    if (phase === 'result') return lastCatch ? 'Landed' : 'Missed';
    return 'Ready';
  }

  /** Both the world pond and the action button use the same press and release controls. */
  function gameHtml(): string {
    const catchCard = phase === 'result' && lastCatch ? (() => {
      const rule = RARITIES[lastCatch.fish.rarity];
      const rewards = testing ? `<span>Bench catch</span>` : `<span>+${lastCatch.coins} coins</span><span>+${lastCatch.xp} XP</span>`;
      const item = lastCatch.item ? `<small class="gf-catch-item">Equipment found: ${escapeHtml(lastCatch.item.name)}</small>` : '';
      const tags = [
        lastCatch.perfect ? `Perfect ${PERFECT_BONUS}x` : '',
        lastCatch.trophy ? `Trophy ${TROPHY_BONUS}x` : '',
        lastCatch.sizeRecord && !testing ? 'Size record' : '',
      ].filter(Boolean).map(tag => `<span>${tag}</span>`).join('');
      const share = (lastCatch.weight - lastCatch.fish.min) / Math.max(.01, lastCatch.fish.max - lastCatch.fish.min);
      return `<div class="gf-catch" style="--catch-colour:${rule.colour}">${lastCatch.fresh ? '<span class="gf-catch-new">NEW</span>' : ''}<div class="gf-catch-fish">${fishSvg(rule.colour, share)}</div><div><p>${rule.label} &middot; ${FIGHT_STYLES[lastCatch.fish.style].label}</p><h3>${escapeHtml(lastCatch.fish.name)}</h3><small>${escapeHtml(formatWeight(lastCatch.weight))} &middot; landed in ${escapeHtml(fightLength())}</small><div class="gf-catch-rewards">${rewards}</div>${tags ? `<div class="gf-catch-tags">${tags}</div>` : ''}${item}</div></div>`;
    })() : '';
    const bait = activeBait();
    const baitCard = bait
      ? `<div class="gf-bait-head"><span class="gf-bait-icon">${bait.icon}</span><div class="gf-bait-text"><b>${escapeHtml(bait.name)} &times;${record.baits[bait.id]}</b><small>${escapeHtml(bait.detail)}</small></div><button data-bait-cycle title="Switch bait">Switch</button></div><p class="gf-flavour">${escapeHtml(bait.flavour)}</p>`
      : `<div class="gf-bait-head"><span class="gf-bait-icon">&#129693;</span><div class="gf-bait-text"><b>Bare hook</b><small>${BAITS.some(item => record.baits[item.id] > 0) ? 'Switch to put some bait on.' : 'Buy bait from the Tackle tab.'}</small></div><button data-bait-cycle title="Switch bait">Switch</button></div>`;
    const button = phase === 'reel' ? 'Hold to reel' : phase === 'bite' ? 'Set the hook!' : phase === 'waiting' ? 'Reel in' : 'Cast line';
    return `<div class="gf-game">${catchCard}<div class="gf-stage"><div class="gf-stage-main"><div class="gf-status" data-phase="${phase}"><span class="gf-phase">${phaseLabel()}</span><b data-fishing-status style="color:${resultColour}">${escapeHtml(message)}</b></div><button class="gf-action" data-reel data-phase="${phase}">${button}</button>${bitingHtml()}<div><div class="gf-label"><span>Bait</span></div><div class="gf-bait">${baitCard}</div></div></div><div class="gf-meter" data-live="false"><div class="gf-meter-bars"><div class="gf-track"><i class="gf-track-zone"></i><i class="gf-track-fish"></i></div><div class="gf-meter-progress"><i></i></div></div><small>Catch</small></div></div></div><div class="gf-foot"><span>Click the pond to cast there</span><span><kbd>Space</kbd> works too</span></div>`;
  }

  function renderChrome(): void {
    const host = panel();
    if (!host || host.hidden) return;
    const card = host.querySelector<HTMLElement>('.gf-card');
    if (!card) return;
    const quiet = fishingMuted();
    const body = view === 'collection' ? collectionHtml() : view === 'equipment' ? equipmentHtml() : view === 'bench' ? benchHtml() : gameHtml();
    card.dataset.view = view;
    renderedWeather = weather();
    const pondInput = host.querySelector<HTMLElement>('.gf-pond-input');
    if (pondInput && view !== 'game') pondInput.hidden = true;
    const level = fishingLevel(record.xp);
    const tabs = ([['game', 'Pond'], ['equipment', 'Tackle'], ['collection', 'Journal']] as const)
      .map(([id, label]) => `<button data-view="${id}" data-active="${view === id}">${label}</button>`).join('');
    card.innerHTML = `<header><div class="gf-title"><span class="gf-logo">&#127907;</span><div><h2>Fishing</h2><div class="gf-level"><span>Lv ${level.level}</span><i><b style="width:${level.current / level.needed * 100}%"></b></i></div></div></div><div class="gf-head-actions"><span class="gf-coins" title="Fishing coins"><i></i>${record.coins.toLocaleString(NUMBER_LOCALE)}</span><button class="gf-icon" data-mute title="${quiet ? 'Sound off' : 'Sound on'}">${quiet ? '&#128263;' : '&#128266;'}</button><button class="gf-icon" data-close aria-label="Close">&#10005;</button></div></header><nav class="gf-tabs">${tabs}</nav>${body}`;
    card.querySelector<HTMLButtonElement>('[data-close]')!.onclick = close;
    card.querySelector<HTMLButtonElement>('[data-mute]')!.onclick = () => {
      setFishingMuted(!quiet);
      if (quiet) primeFishingAudio();
      renderChrome();
    };
    card.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(button => button.onclick = () => {
      view = button.dataset.view as typeof view;
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
    card.querySelectorAll<HTMLButtonElement>('[data-buy-bait]').forEach(button => button.onclick = () => {
      const bait = BAIT_BY_ID.get(button.dataset.buyBait!);
      if (!bait || record.coins < bait.price) return;
      record.coins -= bait.price;
      record.baits[bait.id] = (record.baits[bait.id] ?? 0) + BAIT_PACK;
      if (!activeBait()) record.bait = bait.id;
      save();
      renderChrome();
    });
    card.querySelectorAll<HTMLButtonElement>('[data-use-bait]').forEach(button => button.onclick = () => {
      const id = button.dataset.useBait!;
      if (!record.baits[id]) return;
      record.bait = record.bait === id ? '' : id;
      save();
      renderChrome();
    });
    card.querySelector<HTMLButtonElement>('[data-bait-cycle]')?.addEventListener('click', () => {
      const options = ['', ...BAITS.filter(bait => record.baits[bait.id] > 0).map(bait => bait.id)];
      record.bait = options[(options.indexOf(activeBait() ? record.bait : '') + 1) % options.length];
      save();
      renderChrome();
    });
    card.querySelector<HTMLButtonElement>('[data-reset]')?.addEventListener('click', () => {
      if (!confirm('Clear your fishing record? Every catch is forgotten.')) return;
      record = { ...EMPTY_RECORD, fish: {}, equipment: { ...EMPTY_RECORD.equipment }, equipped: { ...EMPTY_RECORD.equipped }, baits: {} };
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
    // Only one minigame holds the farm at a time.
    if (page.__gardenCompanionGardenDefenceOpen?.()) page.__gardenCompanionToggleGardenDefence?.();
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
      press(aimAt(event.clientX, event.clientY));
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
    // Space mirrors the mouse while the pond is up. Captured on the window and stopped there, so
    // the game and the companion's own space bindings never see it.
    const ownsSpace = (event: KeyboardEvent) => event.code === 'Space' && panel()?.hidden === false && view === 'game'
      && !isTyping() && !event.ctrlKey && !event.altKey && !event.metaKey;
    window.addEventListener('keydown', event => {
      if (!ownsSpace(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) press();
    }, true);
    window.addEventListener('keyup', event => {
      // Releasing always lets go, even after a tab switch mid-fight, or the reel stays held down.
      if (event.code === 'Space') release();
      if (!ownsSpace(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
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
