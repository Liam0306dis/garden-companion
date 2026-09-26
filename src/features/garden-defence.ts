import { page } from '../page.js';
import { makeDraggable } from '../draggable.js';
import { isTyping } from '../keybinds.js';
import { createWorldScene, readyImage, type WorldBounds, type WorldGeometry } from '../world-scene.js';
import { PLANT_CATALOG } from '../constants.js';
import { escapeHtml, loadLocal, NUMBER_LOCALE, saveLocal } from '../utils.js';
import {
  ALL_PESTS, BOSS, createBoard, HUGE_EVERY, PLANT_BY_ID, PLANTS, SUN_LIFETIME, TOTAL_WAVES,
  type Board, type Pest, type PestDef, type Plant, type PlantDef,
} from './garden-defence-rules.js';

/**
 * A lane defence minigame played on the player's own farm tiles. Like fishing it never talks to the
 * game: no plant is placed, nothing is spent, and the only state that survives a reload is a local
 * record. The garden is hidden and redrawn as a lawn by the shared world scene, so closing the
 * panel always puts the real garden back exactly as it was.
 *
 * The rules live in garden-defence-rules.ts, where the balance script can play them headlessly;
 * this file draws the board, feeds it clicks and keeps the score.
 */

const PANEL_ID = 'gc-garden-defence';
const RECORD_KEY = 'gardenDefence.record';
const POSITION_KEY = 'gardenDefence.position';

/** Classic five lanes and nine columns, trimmed to whatever the farm can actually fit. */
const MAX_LANES = 5;
const MAX_COLUMNS = 9;
const SEED_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
/** How long a new pest's introduction stays up, and a huge wave's warning. */
const INFO_BANNER_SECONDS = 14;
const WARN_BANNER_SECONDS = 8;
/** A garden spade: T-grip, shaft and a pointed blade. */
const SHOVEL_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15.5 3.5l5 5"/><path d="M18 6l-7.5 7.5"/><path d="M10.5 13.5l-2.3-2.3-4.4 4.4c-1.2 1.2-1.3 3.3-.1 4.6 1.3 1.2 3.4 1.1 4.6-.1l4.4-4.4z" fill="currentColor" fill-opacity=".35"/></svg>';

interface Record_ { best: number; runs: number; sun: number; wins: number }
/** A burst of bits where something died or went off, in world coordinates. */
interface Poof { x: number; y: number; at: number; colour: number; size: number }
interface PlantArt { sprite: Record<string, any> | null; fruits: Record<string, any>[] | null; baseScale: { x: number; y: number } | null }

function loadRecord(): Record_ {
  const stored = loadLocal<Partial<Record_>>(RECORD_KEY, {});
  const positive = (value: unknown) => {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
  };
  return { best: positive(stored.best), runs: positive(stored.runs), sun: positive(stored.sun), wins: positive(stored.wins) };
}

/** The harvested crop: what a seed packet shows, and what hangs on a regrowing plant. */
function cropSpriteSource(def: PlantDef): string {
  return page.__gardenCompanionProduceSprites?.[def.id] || page.__gardenCompanionShopSprites?.[def.id] || '';
}

/** The grown plant as it stands in a garden, or its crop where the game has no separate plant art. */
function plantSpriteSource(def: PlantDef): string {
  return page.__gardenCompanionPlantSprites?.[def.id] || cropSpriteSource(def);
}

/**
 * Where a regrowing plant carries its crop, as fractions of a tile from the tile's centre - the
 * game's own slot offset. A plant that is harvested whole is drawn as its plant art alone. The
 * Habanero bush holds several peppers, so it gets a few spread across it.
 */
function fruitOffsets(def: PlantDef): { x: number; y: number }[] {
  const entry = PLANT_CATALOG[def.id];
  if (!entry?.regrows || !entry.slotOffset || !page.__gardenCompanionPlantSprites?.[def.id]) return [];
  const { x, y } = entry.slotOffset;
  return (entry.slots ?? 1) > 1 ? [{ x, y }, { x: -x, y: y + .06 }, { x: x * .1, y: y - .14 }] : [{ x, y }];
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

function injectStyles(): void {
  if (document.getElementById(`${PANEL_ID}-styles`)) return;
  const style = document.createElement('style');
  style.id = `${PANEL_ID}-styles`;
  style.textContent = `
    #${PANEL_ID}{position:fixed;inset:0;z-index:999993;pointer-events:none;color:var(--gd-text);font:12px/1.45 system-ui,sans-serif;
      --gd-bg:#0d1a10;--gd-bg-2:#15291a;--gd-panel:rgba(255,255,255,.035);--gd-line:rgba(134,239,172,.11);--gd-line-2:rgba(134,239,172,.22);
      --gd-text:#e5f2e7;--gd-strong:#f8fafc;--gd-muted:#90b096;--gd-accent-rgb:74,222,128;--gd-sun:#fbbf24}
    #${PANEL_ID}[hidden]{display:none}
    #${PANEL_ID} .gd-card{position:fixed;right:14px;bottom:56px;width:min(480px,calc(100vw - 24px));display:flex;flex-direction:column;overflow:hidden;pointer-events:auto;user-select:none;touch-action:none;border:1px solid var(--gd-line-2);border-radius:16px;background:linear-gradient(180deg,var(--gd-bg-2),var(--gd-bg) 150px);box-shadow:0 22px 60px rgba(0,0,0,.65),inset 0 1px rgba(255,255,255,.05)}
    #${PANEL_ID} button{padding:5px 10px;border:1px solid var(--gd-line-2);border-radius:8px;background:var(--gd-panel);color:var(--gd-text);font:700 10px system-ui,sans-serif;cursor:pointer;transition:background .12s,border-color .12s,color .12s,transform .08s}
    #${PANEL_ID} button:hover:not(:disabled){border-color:rgba(var(--gd-accent-rgb),.45);background:rgba(var(--gd-accent-rgb),.1);color:#dcfce7}
    #${PANEL_ID} button:active:not(:disabled){transform:translateY(1px)}
    #${PANEL_ID} button:disabled{opacity:.45;cursor:default}
    #${PANEL_ID} button[data-active=true]{border-color:rgba(var(--gd-accent-rgb),.55);background:rgba(var(--gd-accent-rgb),.16);color:#dcfce7}
    #${PANEL_ID} header{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 12px 10px 14px;cursor:move}
    #${PANEL_ID} .gd-title{display:flex;align-items:center;gap:10px;min-width:0}
    #${PANEL_ID} .gd-logo{display:grid;place-items:center;flex:0 0 auto;width:34px;height:34px;border-radius:11px;background:linear-gradient(145deg,#2f6b35,#173d1d);box-shadow:inset 0 1px rgba(255,255,255,.14),0 4px 12px rgba(0,0,0,.35);font-size:18px}
    #${PANEL_ID} h2{margin:0;color:var(--gd-strong);font:800 14px/1.1 system-ui,sans-serif;letter-spacing:.01em}
    #${PANEL_ID} .gd-sub{margin-top:3px;color:var(--gd-muted);font-size:9px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}
    #${PANEL_ID} .gd-head-actions{display:flex;align-items:center;gap:4px}
    #${PANEL_ID} .gd-sun{display:flex;align-items:center;gap:6px;height:28px;margin-right:2px;padding:0 11px 0 5px;border:1px solid rgba(251,191,36,.35);border-radius:14px;background:rgba(251,191,36,.1);color:#fde68a;font:800 13px system-ui,sans-serif;font-variant-numeric:tabular-nums}
    #${PANEL_ID} .gd-sun i{width:18px;height:18px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#fffbeb,#fbbf24 50%,#d97706);box-shadow:0 0 8px rgba(251,191,36,.6)}
    #${PANEL_ID} button.gd-icon{width:26px;height:26px;padding:0;border-color:transparent;border-radius:8px;background:transparent;color:var(--gd-muted);font-size:12px}
    #${PANEL_ID} .gd-lawn-input{position:fixed;pointer-events:auto;touch-action:none;cursor:crosshair}
    #${PANEL_ID} .gd-body{padding:4px 12px 12px}
    #${PANEL_ID} .gd-waves{margin-bottom:10px}
    #${PANEL_ID} .gd-waves-label{display:flex;justify-content:space-between;margin-bottom:5px;color:var(--gd-muted);font-size:10px;font-weight:700}
    #${PANEL_ID} .gd-waves-label b{color:var(--gd-strong)}
    #${PANEL_ID} .gd-track{position:relative;height:8px;border-radius:4px;background:rgba(0,0,0,.3);box-shadow:inset 0 0 0 1px rgba(255,255,255,.06)}
    #${PANEL_ID} .gd-track i{position:absolute;inset:0 auto 0 0;width:0;border-radius:4px;background:linear-gradient(90deg,#4ade80,#a3e635);transition:width .3s}
    #${PANEL_ID} .gd-track span{position:absolute;top:50%;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;background:#1a2e1d;box-shadow:inset 0 0 0 2px #f87171;font-size:8px;line-height:14px;text-align:center}
    #${PANEL_ID} .gd-track span[data-done=true]{background:#f87171}
    #${PANEL_ID} .gd-banner{margin-bottom:10px;padding:8px 10px;border:1px solid rgba(248,113,113,.45);border-radius:10px;background:rgba(248,113,113,.12);color:#fecaca;font-size:11px;font-weight:800;text-align:center;letter-spacing:.04em;animation:gd-throb .6s ease-in-out infinite alternate}
    #${PANEL_ID} .gd-banner[data-kind=info]{border-color:rgba(125,211,252,.45);background:rgba(125,211,252,.1);color:#e0f2fe;animation:none}
    @keyframes gd-throb{to{background:rgba(248,113,113,.2)}}
    #${PANEL_ID} .gd-seeds{display:grid;grid-template-columns:repeat(5,1fr);gap:5px}
    #${PANEL_ID} .gd-seed{position:relative;display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 3px 5px;overflow:hidden;border:1px solid var(--gd-line);border-radius:10px;background:linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,.02))}
    #${PANEL_ID} .gd-seed[data-selected=true]{border-color:rgba(var(--gd-accent-rgb),.7);background:rgba(var(--gd-accent-rgb),.16);box-shadow:0 0 0 2px rgba(var(--gd-accent-rgb),.2)}
    #${PANEL_ID} .gd-seed::after{content:"";position:absolute;inset:0 0 auto 0;height:calc(var(--cd,0) * 100%);background:rgba(0,0,0,.55);pointer-events:none}
    #${PANEL_ID} .gd-seed img{width:28px;height:28px;object-fit:contain}
    #${PANEL_ID} .gd-seed em{display:grid;place-items:center;width:28px;height:28px;color:var(--gd-muted);font-style:normal;font-size:14px}
    #${PANEL_ID} .gd-seed b{color:var(--gd-strong);font:700 9px system-ui,sans-serif;text-align:center;line-height:1.15}
    #${PANEL_ID} .gd-seed small{color:#fde68a;font:800 9px system-ui,sans-serif}
    #${PANEL_ID} .gd-seed .gd-once{position:absolute;top:3px;right:4px;color:#fca5a5;font:800 8px system-ui,sans-serif;font-style:normal}
    #${PANEL_ID} .gd-seed kbd{position:absolute;top:3px;left:4px;color:var(--gd-muted);font:700 8px system-ui,sans-serif}
    #${PANEL_ID} .gd-tools{display:flex;gap:5px;margin-top:8px}
    #${PANEL_ID} .gd-tools button{display:inline-flex;align-items:center;justify-content:center;gap:5px;flex:1;padding:7px 8px;font-size:11px}
    #${PANEL_ID} .gd-dev{margin-top:9px;padding:8px 9px;border:1px dashed rgba(167,139,250,.5);border-radius:9px;background:rgba(167,139,250,.08)}
    #${PANEL_ID} .gd-dev > b{display:block;margin-bottom:6px;color:#ddd6fe;font:800 10px system-ui,sans-serif;text-transform:uppercase;letter-spacing:.08em}
    #${PANEL_ID} .gd-dev-row{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:4px}
    #${PANEL_ID} .gd-dev-row button{font-size:10px;padding:4px 7px}
    #${PANEL_ID} .gd-dev > small{display:block;margin-top:5px;color:var(--gd-muted);font-size:9px}
    #${PANEL_ID} .gd-status{margin-top:9px;color:var(--gd-text);font-size:11px;min-height:15px}
    #${PANEL_ID} .gd-foot{display:flex;justify-content:space-between;gap:8px;padding:9px 14px;border-top:1px solid var(--gd-line);color:var(--gd-muted);font-size:10px}
    #${PANEL_ID} .gd-end{margin-bottom:10px;padding:11px 12px;border-radius:12px;animation:gd-rise .35s ease-out}
    @keyframes gd-rise{from{opacity:0;transform:translateY(6px)}}
    #${PANEL_ID} .gd-end[data-kind=lost]{border:1px solid rgba(248,113,113,.4);background:rgba(248,113,113,.1)}
    #${PANEL_ID} .gd-end[data-kind=won]{border:1px solid rgba(251,191,36,.5);background:radial-gradient(circle at 0 0,rgba(251,191,36,.22),transparent 70%),rgba(255,255,255,.03)}
    #${PANEL_ID} .gd-end b{display:block;color:var(--gd-strong);font:800 15px system-ui,sans-serif}
    #${PANEL_ID} .gd-end small{display:block;margin-top:3px;color:var(--gd-text);font-size:11px}
    #${PANEL_ID} .gd-end div{display:flex;gap:6px;margin-top:9px}
    #${PANEL_ID} .gd-end div button{flex:1;padding:7px}
  `;
  document.head.appendChild(style);
}

export function initGardenDefence(): void {
  let record = loadRecord();
  let board: Board | null = null;
  /** Set by a restart before the lawn has been measured; the board is built once it has. */
  let pendingRun = true;
  let paused = false;
  let selected: string | null = null;
  let shovel = false;
  /** Shown above the seed tray: a huge wave's warning, or what a new pest does. */
  let banner = '';
  let bannerKind: 'warn' | 'info' = 'warn';
  let bannerUntil = 0;
  let bannerQueue: string[] = [];
  /** Pest kinds already introduced this run, so each gets its one-line explanation once. */
  let introduced = new Set<string>();
  /**
   * Tuning mode: towers are free and the waves can be held off, so a single plant can be watched
   * against a single pest. A dev run is never written to the record, the same way a bench fight in
   * fishing is never added to the catch log.
   */
  let dev = false;
  let status = 'Pick a seed, then click a tile to plant it.';
  let lanes = MAX_LANES;
  let columns = MAX_COLUMNS;
  let lawn: WorldBounds | null = null;
  let houseStrip = 0;
  let cellWidth = 0;
  let cellHeight = 0;
  let hovered: { lane: number; column: number } | null = null;
  let draggableReady = false;
  let frame: number | null = null;
  let lastTime = 0;
  let chromeAt = 0;
  /** Real seconds, for animation that should keep going while the board is paused. */
  let wallClock = 0;

  let poofs: Poof[] = [];
  const plantArt = new Map<Plant, PlantArt>();
  const pestSprites = new Map<Pest, Record<string, any>>();
  let canSprites: (Record<string, any> | null)[] = [];

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
      forgetSprites();
    },
    // Pets wait on the porch, not up on the roof.
    petArea: geometry => ({
      left: geometry.left + houseWidth(geometry) * .58,
      top: geometry.top + 20,
      width: Math.max(0, houseWidth(geometry) * .4 - 20),
      height: Math.max(0, geometry.height - 40),
    }),
  });

  /** Drops our handles on sprites the scene has already destroyed, so fresh ones are made. */
  function forgetSprites(): void {
    plantArt.clear();
    pestSprites.clear();
    canSprites = [];
  }

  /** The cottage and porch take a tenth of the farm, so they stay in proportion with the tiles. */
  function houseWidth(geometry: WorldGeometry): number {
    return Math.max(90, geometry.width * .1);
  }

  function layOutLawn(geometry: WorldGeometry): void {
    const nextLanes = Math.max(3, Math.min(MAX_LANES, geometry.rows));
    const nextColumns = Math.max(5, Math.min(MAX_COLUMNS, geometry.cols));
    houseStrip = houseWidth(geometry);
    lawn = {
      left: geometry.left + houseStrip,
      top: geometry.top,
      width: Math.max(1, geometry.width - houseStrip),
      height: geometry.height,
    };
    cellWidth = lawn.width / nextColumns;
    cellHeight = lawn.height / nextLanes;
    // A farm reshaped mid-run cannot keep its board, so it starts over on the new one.
    if (pendingRun || !board || nextLanes !== lanes || nextColumns !== columns) {
      lanes = nextLanes;
      columns = nextColumns;
      newBoard();
    }
  }

  /** Cans stand in the house strip, measured in columns like everything else on the board. */
  function canHome(): number {
    // In the middle of the porch, which is the lawn-side part of the house strip.
    return -Math.min(houseStrip * .22, cellWidth * .5) / Math.max(1, cellWidth);
  }

  function newBoard(): void {
    scene.clearSprites();
    forgetSprites();
    poofs = [];
    introduced = new Set();
    bannerQueue = [];
    pendingRun = false;
    board = createBoard({
      lanes,
      columns,
      dev,
      canHome: canHome(),
      events: {
        poof: (x, lane, colour, size) => poofs.push({ x: boardX(x), y: laneCentreY(lane), at: wallClock, colour, size: size * cellWidth }),
        say: text => { status = text; },
        wave: (wave, huge, final, wolves) => {
          if (huge) {
            showBanner(final ? 'The final wave - and the Storm Wolf leads it!'
              : wolves > 1 ? `A huge wave, led by ${wolves} Storm Wolves!`
              : wolves ? 'A huge wave, led by a Storm Wolf!'
              : 'A huge wave of pests is approaching!', 'warn');
          }
          status = huge ? banner : `Wave ${wave} incoming.`;
          renderChrome();
        },
        end: won => finishRun(won),
      },
    });
    if (!dev) {
      record.runs++;
      save();
    }
  }

  /**
   * A warning takes over at once. A new pest's introduction is there to be read, so it stays up
   * long enough to, and one that arrives while another is showing waits its turn.
   */
  function showBanner(text: string, kind: 'warn' | 'info'): void {
    if (kind === 'info' && banner && wallClock < bannerUntil) { bannerQueue.push(text); return; }
    banner = text;
    bannerKind = kind;
    bannerUntil = wallClock + (kind === 'info' ? INFO_BANNER_SECONDS : WARN_BANNER_SECONDS);
  }

  /** Brings up the next waiting introduction once the one before it has had its time. */
  function advanceBanner(): void {
    if (wallClock < bannerUntil || !bannerQueue.length) return;
    banner = bannerQueue.shift()!;
    bannerKind = 'info';
    bannerUntil = wallClock + INFO_BANNER_SECONDS;
  }

  function cellCentreX(column: number): number {
    return (lawn?.left ?? 0) + (column + .5) * cellWidth;
  }

  function laneCentreY(lane: number): number {
    return (lawn?.top ?? 0) + (lane + .5) * cellHeight;
  }

  /** Board x is measured in columns from the left edge of the lawn, so it survives a farm resize. */
  function boardX(columnsIn: number): number {
    return (lawn?.left ?? 0) + columnsIn * cellWidth;
  }

  /**
   * The field, drawn in the game's own flat, bright style and sized off the tile so it reads the
   * same however big the farm is: a lawn of rounded dirt plots, one per tile, like the game's own
   * garden; the gardener's cottage and porch on the left, where the watering cans wait; flower
   * borders top and bottom; and the wild meadow on the right, behind a fence the pests have broken.
   */
  function drawLawn(graphic: Record<string, any>, geometry: WorldGeometry, area: WorldBounds): void {
    graphic.clear();
    const u = Math.min(cellWidth, cellHeight);
    const house = houseWidth(geometry);
    const right = area.left + area.width;
    const wild = cellWidth * .7;
    const border = u * .34;
    const hash = (value: number) => {
      const sine = Math.sin(value * 127.1 + 311.7) * 43758.5453;
      return sine - Math.floor(sine);
    };
    const outerLeft = geometry.left - u * .08;
    const outerRight = right + wild;
    graphic.roundRect(outerLeft, area.top - border, outerRight - outerLeft, area.height + border * 2, u * .12)
      .fill({ color: 0x7cc043, alpha: 1 });

    // One dirt plot per tile: a darker rim, warm soil, a lit top edge, a couple of soft furrows and a few stones.
    const inset = u * .05;
    for (let lane = 0; lane < lanes; lane++) {
      for (let column = 0; column < columns; column++) {
        const x = area.left + column * cellWidth + inset;
        const y = area.top + lane * cellHeight + inset;
        const w = cellWidth - inset * 2;
        const h = cellHeight - inset * 2;
        const seed = lane * 31 + column * 17;
        graphic.roundRect(x, y + u * .025, w, h, u * .14).fill({ color: 0x4e8a2c, alpha: .6 });
        graphic.roundRect(x, y, w, h, u * .14).fill({ color: 0x7a4a26, alpha: 1 });
        graphic.roundRect(x + u * .03, y + u * .03, w - u * .06, h - u * .07, u * .11).fill({ color: (lane + column) % 2 ? 0x9a6236 : 0xa56a3b, alpha: 1 });
        graphic.roundRect(x + u * .06, y + u * .045, w - u * .12, u * .035, u * .02).fill({ color: 0xc08a55, alpha: .55 });
        for (let furrow = 1; furrow <= 3; furrow++) {
          const fy = y + h * furrow / 4;
          graphic.roundRect(x + u * .1, fy, w - u * .2, u * .022, u * .011).fill({ color: 0x7a4a26, alpha: .35 });
        }
        for (let stone = 0; stone < 4; stone++) {
          const sx = x + u * .1 + hash(seed + stone) * (w - u * .2);
          const sy = y + u * .1 + hash(seed + stone + .5) * (h - u * .2);
          graphic.ellipse(sx, sy, u * .018, u * .013).fill({ color: hash(seed + stone + .7) > .5 ? 0xc9a27a : 0x6b3f1f, alpha: .9 });
        }
      }
    }
    // Tufts in the grass between the plots.
    for (let tuft = 0; tuft < columns * lanes * 2; tuft++) {
      const tx = area.left + hash(tuft + 900) * area.width;
      const lane = Math.floor(hash(tuft + 950) * (lanes + 1));
      const ty = area.top + lane * cellHeight + (hash(tuft + 990) - .5) * inset;
      const s = u * .04;
      graphic.moveTo(tx - s, ty + s * .4).lineTo(tx - s * 1.4, ty - s).stroke({ color: 0x5ea83a, width: u * .012, alpha: 1 });
      graphic.moveTo(tx, ty + s * .4).lineTo(tx, ty - s * 1.3).stroke({ color: 0x5ea83a, width: u * .012, alpha: 1 });
      graphic.moveTo(tx + s, ty + s * .4).lineTo(tx + s * 1.4, ty - s).stroke({ color: 0x5ea83a, width: u * .012, alpha: 1 });
    }

    // Flower borders: a round hedge with blooms in front of it, top and bottom.
    const blooms = [0xf87171, 0xfbbf24, 0xf9a8d4, 0xc084fc, 0xffffff, 0xfb923c];
    for (const [edge, facing] of [[area.top, -1], [area.top + area.height, 1]] as const) {
      const hedgeY = edge + facing * border * .62;
      for (let x = outerLeft + u * .1; x < outerRight; x += u * .16) {
        graphic.circle(x, hedgeY, u * .1 + hash(x) * u * .02).fill({ color: hash(x + 1) > .5 ? 0x3f8f3a : 0x378233, alpha: 1 });
        graphic.circle(x - u * .03, hedgeY - u * .03, u * .035).fill({ color: 0x5fb04c, alpha: .8 });
      }
      for (let x = area.left + u * .08; x < right - u * .04; x += u * .17) {
        const by = edge + facing * border * .2;
        const colour = blooms[Math.floor(hash(x + 7) * blooms.length)];
        const petal = u * .026;
        for (let leaf = 0; leaf < 5; leaf++) {
          const angle = leaf * Math.PI * 2 / 5 + hash(x) * 3;
          graphic.circle(x + Math.cos(angle) * petal, by + Math.sin(angle) * petal, petal * .8).fill({ color: colour, alpha: 1 });
        }
        graphic.circle(x, by, petal * .55).fill({ color: 0xfacc15, alpha: 1 });
      }
    }

    // The cottage: a red tiled roof seen from above, with a ridge and chimney.
    const roofLeft = outerLeft;
    const roofRight = geometry.left + house * .56;
    const roofTop = area.top - border * .3;
    const roofBottom = area.top + area.height + border * .3;
    graphic.roundRect(roofLeft + u * .03, roofTop + u * .04, roofRight - roofLeft, roofBottom - roofTop, u * .06).fill({ color: 0x14351a, alpha: .3 });
    graphic.roundRect(roofLeft, roofTop, roofRight - roofLeft, roofBottom - roofTop, u * .06).fill({ color: 0xb4432f, alpha: 1 });
    const row = u * .13;
    for (let y = roofTop + row, index = 0; y < roofBottom - row * .3; y += row, index++) {
      graphic.rect(roofLeft + u * .02, y - u * .03, roofRight - roofLeft - u * .04, u * .03).fill({ color: 0x8a2f20, alpha: .9 });
      for (let x = roofLeft + u * .07 + (index % 2) * u * .075; x < roofRight - u * .04; x += u * .15) {
        graphic.rect(x, y - row + u * .01, u * .014, row - u * .04).fill({ color: 0x8a2f20, alpha: .6 });
      }
    }
    const ridge = (roofLeft + roofRight) / 2;
    graphic.rect(ridge - u * .03, roofTop, u * .06, roofBottom - roofTop).fill({ color: 0xd4553b, alpha: 1 });
    const chimneyY = area.top + cellHeight * .35;
    graphic.roundRect(ridge + u * .06, chimneyY, u * .2, u * .2, u * .02).fill({ color: 0x8b8378, alpha: 1 });
    graphic.roundRect(ridge + u * .09, chimneyY + u * .03, u * .14, u * .08, u * .02).fill({ color: 0x3f3a36, alpha: 1 });

    // The porch facing the beds, one step per lane where that lane's watering can waits.
    const porchLeft = roofRight;
    const porchRight = area.left;
    graphic.rect(porchLeft, roofTop + u * .04, porchRight - porchLeft, roofBottom - roofTop - u * .08).fill({ color: 0xc58a4e, alpha: 1 });
    for (let x = porchLeft + u * .08; x < porchRight - u * .02; x += u * .08) {
      graphic.rect(x, roofTop + u * .04, u * .012, roofBottom - roofTop - u * .08).fill({ color: 0x9a6236, alpha: .8 });
    }
    for (let lane = 0; lane < lanes; lane++) {
      const y = laneCentreY(lane);
      graphic.ellipse((porchLeft + porchRight) / 2, y + u * .1, (porchRight - porchLeft) * .38, u * .1).fill({ color: 0x9a6236, alpha: .45 });
    }
    graphic.rect(porchRight - u * .03, roofTop + u * .04, u * .03, roofBottom - roofTop - u * .08).fill({ color: 0x7a4a26, alpha: 1 });

    // The wild meadow on the right: long grass, toadstools, stones and daisies.
    graphic.rect(right, area.top - border * .2, wild, area.height + border * .4).fill({ color: 0x5d9a37, alpha: 1 });
    for (let blade = 0; blade < lanes * 22; blade++) {
      const bx = right + u * .05 + hash(blade + 200) * (wild - u * .1);
      const by = area.top + hash(blade + 300) * area.height;
      const lean = (hash(blade + 400) - .5) * u * .08;
      graphic.moveTo(bx, by).lineTo(bx + lean, by - u * .12).stroke({ color: hash(blade) > .5 ? 0x4a8a2c : 0x6fae42, width: u * .016, alpha: 1 });
    }
    for (let item = 0; item < lanes * 2; item++) {
      const ix = right + u * .12 + hash(item + 500) * (wild - u * .24);
      const iy = area.top + hash(item + 600) * area.height;
      if (item % 3 === 0) {
        graphic.rect(ix - u * .012, iy, u * .024, u * .05).fill({ color: 0xf5f5f4, alpha: 1 });
        graphic.ellipse(ix, iy, u * .05, u * .032).fill({ color: 0xdc2626, alpha: 1 });
        graphic.circle(ix - u * .016, iy - u * .01, u * .01).fill({ color: 0xffffff, alpha: 1 });
        graphic.circle(ix + u * .02, iy - u * .004, u * .008).fill({ color: 0xffffff, alpha: 1 });
      } else if (item % 3 === 1) {
        graphic.ellipse(ix, iy, u * .06, u * .04).fill({ color: 0x9ca3af, alpha: 1 });
        graphic.ellipse(ix - u * .015, iy - u * .015, u * .03, u * .015).fill({ color: 0xd1d5db, alpha: .9 });
      } else {
        for (let petal = 0; petal < 5; petal++) {
          const angle = petal * Math.PI * 2 / 5;
          graphic.circle(ix + Math.cos(angle) * u * .02, iy + Math.sin(angle) * u * .02, u * .017).fill({ color: 0xffffff, alpha: 1 });
        }
        graphic.circle(ix, iy, u * .012).fill({ color: 0xfacc15, alpha: 1 });
      }
    }
    // The fence it was meant to stay behind: posts at every lane edge, rails snapped where the lanes run through.
    const fence = right + u * .03;
    for (let edge = 0; edge <= lanes; edge++) {
      const y = area.top + edge * cellHeight;
      graphic.roundRect(fence - u * .035, y - u * .06, u * .07, u * .12, u * .015).fill({ color: 0x7a4a26, alpha: 1 });
      graphic.roundRect(fence - u * .025, y - u * .05, u * .05, u * .04, u * .01).fill({ color: 0xb07a45, alpha: 1 });
      if (edge === lanes) continue;
      const next = y + cellHeight;
      graphic.rect(fence - u * .015, y + u * .06, u * .03, cellHeight * .2).fill({ color: 0xa06b3a, alpha: 1 });
      graphic.rect(fence - u * .015, next - u * .06 - cellHeight * .22, u * .03, cellHeight * .22).fill({ color: 0xa06b3a, alpha: 1 });
      graphic.moveTo(fence + u * .1, y + cellHeight * .42).lineTo(fence + u * .24, y + cellHeight * .55).stroke({ color: 0x8b5a2b, width: u * .03, alpha: 1 });
    }
  }

  function panel(): HTMLElement | null { return document.getElementById(PANEL_ID); }

  function save(): void { saveLocal(RECORD_KEY, record); }

  function restart(): void {
    paused = false;
    selected = null;
    shovel = false;
    banner = '';
    status = dev ? 'Tuning mode: towers are free.' : 'Pick a seed, then click a tile to plant it.';
    // Build now if the lawn is known, otherwise as soon as it is measured.
    if (lawn) newBoard();
    else pendingRun = true;
    renderChrome();
  }

  function finishRun(won: boolean): void {
    selected = null;
    shovel = false;
    if (!dev && board) {
      record.best = Math.max(record.best, board.wave);
      if (won) record.wins++;
      save();
    }
    renderChrome();
  }

  function keepGoing(): void {
    board?.keepGoing();
    status = 'Endless: the waves keep coming until the garden falls.';
    renderChrome();
  }

  function playing(): boolean {
    return Boolean(board && !board.over && !board.won);
  }

  function place(lane: number, column: number): void {
    if (!board || !playing() || paused) return;
    if (shovel) {
      const dug = board.dig(lane, column);
      if (!dug) return;
      status = `Dug up the ${dug.def.name}.`;
      shovel = false;
      renderChrome();
      return;
    }
    if (!selected) { status = 'Pick a seed first.'; renderChrome(); return; }
    const result = board.place(selected, lane, column);
    if (typeof result === 'string') { status = result; renderChrome(); return; }
    poofs.push({ x: cellCentreX(column), y: laneCentreY(lane) + cellHeight * .3, at: wallClock, colour: 0x8b5a2b, size: cellWidth * .35 });
    status = `Planted a ${result.def.name}.`;
    // Keeping the seed selected in dev mode makes filling a lane with one tower a single click each.
    if (!dev) selected = null;
    renderChrome();
  }

  function cellAt(clientX: number, clientY: number): { lane: number; column: number; x: number; y: number } | null {
    const point = scene.toWorld(clientX, clientY);
    if (!point || !lawn) return null;
    const column = Math.floor((point.x - lawn.left) / cellWidth);
    const lane = Math.floor((point.y - lawn.top) / cellHeight);
    return { lane, column, x: point.x, y: point.y };
  }

  function handleLawnClick(clientX: number, clientY: number): void {
    const cell = cellAt(clientX, clientY);
    if (!cell || !board || !lawn) return;
    // Sun first: a token sitting on a tile is picked up rather than planted through.
    const token = board.collect((cell.x - lawn.left) / cellWidth, (cell.y - lawn.top) / cellHeight, Math.max(.35, 30 / cellWidth));
    if (token) {
      if (!dev) { record.sun += token.value; save(); }
      poofs.push({ x: boardX(token.x), y: lawn.top + token.y * cellHeight, at: wallClock, colour: 0xfde68a, size: cellWidth * .3 });
      renderStatus();
      return;
    }
    if (cell.column < 0 || cell.column >= columns || cell.lane < 0 || cell.lane >= lanes) return;
    place(cell.lane, cell.column);
  }

  function pestSize(pest: Pest): number {
    return Math.min(cellWidth, cellHeight) * pest.def.size * 2.1;
  }

  /** A cell's worth of world units: what the game's tile-relative offsets and sizes are measured against. */
  function tileUnit(): number {
    return Math.min(cellWidth, cellHeight) * .9;
  }

  /** Where a plant stands: the middle of its cell, feet a little below centre. */
  function plantFoot(plant: Plant): { x: number; y: number } {
    return { x: cellCentreX(plant.column), y: laneCentreY(plant.lane) + cellHeight * .32 };
  }

  /** Plants that were eaten, dug up or went off lose their sprites; the rest are drawn as grown plants. */
  function updatePlantSprites(): void {
    if (!board) return;
    const alive = new Set(board.plants);
    for (const [plant, art] of plantArt) {
      if (alive.has(plant)) continue;
      scene.removeSprite(art.sprite);
      for (const fruit of art.fruits ?? []) scene.removeSprite(fruit);
      plantArt.delete(plant);
    }
    const unit = tileUnit();
    for (const plant of board.plants) {
      let art = plantArt.get(plant);
      if (!art) { art = { sprite: null, fruits: null, baseScale: null }; plantArt.set(plant, art); }
      const width = unit * (plant.def.kind === 'mine' ? .55 : .86);
      const foot = plantFoot(plant);
      // Four z slots per lane leaves room for fruit above its own plant without reaching the next.
      const zIndex = -998_950 + plant.lane * 4;
      if (!art.sprite) {
        const image = readyImage(plantSpriteSource(plant.def));
        if (image) art.sprite = scene.addSprite(image, { x: foot.x, y: foot.y, width, zIndex });
        if (art.sprite?.scale) art.baseScale = { x: Number(art.sprite.scale.x) || 1, y: Number(art.sprite.scale.y) || 1 };
      }
      // Fruit is hung where the game hangs it: offsets from the tile's centre, sized as the game sizes the crop.
      if (art.sprite && !art.fruits) {
        const offsets = fruitOffsets(plant.def);
        const fruit = offsets.length ? readyImage(cropSpriteSource(plant.def)) : null;
        if (!offsets.length) art.fruits = [];
        else if (fruit) {
          const centreY = foot.y - unit / 2;
          const size = unit * (PLANT_CATALOG[plant.def.id]?.crop.baseTileScale ?? .5) * .9;
          art.fruits = offsets.map(offset => scene.addSprite(fruit, {
            x: foot.x + offset.x * unit,
            y: centreY + offset.y * unit,
            width: size,
            anchorY: .5,
            zIndex: zIndex + 1,
          })).filter((sprite): sprite is Record<string, any> => Boolean(sprite));
        }
      }
      const sprite = art.sprite;
      if (!sprite || sprite.destroyed || !art.baseScale) continue;
      // Recoil on each shot; a bomb swells as its fuse burns; a stunned plant goes grey.
      const fuse = plant.def.arm ?? 1;
      const swell = plant.def.kind === 'bomb' ? 1 + Math.min(1, Math.max(0, 1 - (plant.armAt - board.time) / fuse)) * .35 : 1;
      sprite.scale.x = art.baseScale.x * (1 + plant.kick * .08) * swell;
      sprite.scale.y = art.baseScale.y * (1 - plant.kick * .12) * swell;
      sprite.alpha = plant.def.kind === 'mine' && board.time < plant.armAt ? .55 : 1;
      sprite.tint = board.time < plant.stunUntil ? 0x9ca3af : plant.def.kind === 'bomb' && Math.sin(wallClock * 30) > 0 ? 0xff9a9a : 0xffffff;
    }
  }

  /**
   * Pests wear the game's own pet art, so each one owns a sprite that has to be created late (the
   * atlas loads well after the first frame) and destroyed the moment it leaves the board.
   */
  function updatePestSprites(): void {
    if (!board) return;
    const alive = new Set(board.pests);
    for (const [pest, sprite] of pestSprites) {
      if (alive.has(pest)) continue;
      scene.removeSprite(sprite);
      pestSprites.delete(pest);
    }
    for (const pest of board.pests) {
      if (!introduced.has(pest.def.id)) {
        introduced.add(pest.def.id);
        if (pest.def.id !== 'worm') {
          showBanner(`New pest: ${pest.def.name} - ${pest.def.detail}`, 'info');
          renderStatus();
        }
      }
      const size = pestSize(pest);
      let sprite = pestSprites.get(pest);
      if (!sprite) {
        const image = readyImage(page.__gardenCompanionPetSprites?.[pest.def.species]);
        const created = image && scene.addSprite(image, { x: boardX(pest.x), y: laneCentreY(pest.lane), width: size, anchorY: .5, zIndex: -998_920 + pest.lane });
        if (!created) continue;
        sprite = created;
        // Pet art already faces the way the pests walk, so the sprite keeps its own orientation.
        if (sprite.scale) sprite.scale.x = Math.abs(Number(sprite.scale.x) || 1);
        pestSprites.set(pest, sprite);
      }
      if (sprite.destroyed) continue;
      // Eating pests rear up; walking pests bob. Both come from the same wobble.
      const wobble = Math.sin(board.time * (pest.eating ? 11 : 6) + pest.lane) * size * (pest.eating ? .07 : .045);
      sprite.position.set(boardX(pest.x), laneCentreY(pest.lane) + wobble);
      // A hit flashes white; a snare shows icy; otherwise the pest's own colouring.
      sprite.tint = pest.flash > 0 ? 0xffffff
        : board.time < pest.slowUntil ? 0x8ec5e8
        : pest.chilled ? 0xc4e8ff
        : pest.def.rainbow ? hueTint((board.time * .34 + pest.lane * .13) % 1)
        : pest.def.tint ?? 0xffffff;
      sprite.alpha = pest.flash > 0 ? .75 : 1;
      sprite.zIndex = -998_920 + pest.lane;
    }
  }

  /** The watering can in each lane, from the game's own tool art, drawn by hand if that has not loaded. */
  function updateCans(graphic: Record<string, any>): void {
    if (!board) return;
    const image = readyImage(page.__gardenCompanionShopSprites?.WateringCan);
    const size = Math.min(cellWidth, cellHeight) * .5;
    for (const [lane, can] of board.cans.entries()) {
      if (can.state === 'used') {
        if (canSprites[lane]) { scene.removeSprite(canSprites[lane]); canSprites[lane] = null; }
        continue;
      }
      const x = boardX(can.x);
      const y = laneCentreY(lane);
      graphic.ellipse(x, y + size * .45, size * .5, size * .14).fill({ color: 0x14351a, alpha: .3 });
      if (can.state === 'running') {
        // A spray fanning out ahead of the can as it goes.
        for (let drop = 0; drop < 7; drop++) {
          const reach = size * (.5 + ((wallClock * 9 + drop * .37) % 1) * .9);
          graphic.circle(x + reach, y + (drop - 3) * size * .12, Math.max(2, size * .06)).fill({ color: 0x7dd3fc, alpha: .8 });
        }
      }
      if (image && !canSprites[lane]) canSprites[lane] = scene.addSprite(image, { x, y, width: size, anchorY: .5, zIndex: -998_921 + lane });
      const sprite = canSprites[lane];
      if (sprite && !sprite.destroyed) sprite.position.set(x, y + (can.state === 'running' ? Math.sin(wallClock * 30) * 3 : 0));
      else {
        graphic.roundRect(x - size * .35, y - size * .3, size * .7, size * .6, 8).fill({ color: 0x60a5fa, alpha: 1 });
        graphic.moveTo(x + size * .3, y - size * .1).lineTo(x + size * .6, y - size * .35).stroke({ color: 0x3b82f6, width: 6, alpha: 1 });
      }
    }
  }

  /**
   * The pest itself is a sprite; only what a sprite cannot show is drawn here: a shadow so it sits
   * on the grass, a crown on the boss, a chewing pulse, and its shell and health bars.
   */
  function drawPestOverlay(graphic: Record<string, any>, pest: Pest): void {
    const x = boardX(pest.x);
    const y = laneCentreY(pest.lane);
    const size = pestSize(pest) * .5;
    graphic.ellipse(x, y + size * .78, size * .8, size * .2).fill({ color: 0x14351a, alpha: .32 });
    if (pest.def === BOSS) {
      const top = y - size * .95;
      graphic.poly([x - size * .35, top, x - size * .35, top - size * .3, x - size * .17, top - size * .12, x, top - size * .36, x + size * .17, top - size * .12, x + size * .35, top - size * .3, x + size * .35, top], true)
        .fill({ color: 0xfbbf24, alpha: 1 });
    }
    if (pest.chilled) {
      for (let flake = 0; flake < 3; flake++) {
        const angle = wallClock * 2 + flake * 2.1;
        graphic.circle(x + Math.cos(angle) * size * .7, y - size * .4 + Math.sin(angle) * size * .25, Math.max(2, size * .07)).fill({ color: 0xffffff, alpha: .9 });
      }
    }
    if (pest.eating) {
      const pulse = .55 + .45 * Math.abs(Math.sin(wallClock * 9 + pest.lane));
      graphic.circle(x - size * .78, y, Math.max(3, size * .17 * pulse)).fill({ color: 0xfca5a5, alpha: .85 });
    }
    const barWidth = size * 1.5;
    const barHeight = Math.max(4, size * .13);
    let top = y - size * (pest.def === BOSS ? 1.45 : 1.05);
    if (pest.shell > 0) {
      const full = (pest.def.shell ?? 0) * (pest.maxHp / Math.max(1, pest.def.hp));
      graphic.rect(x - barWidth / 2, top, barWidth, barHeight).fill({ color: 0x0f172a, alpha: .68 });
      graphic.rect(x - barWidth / 2, top, barWidth * Math.min(1, pest.shell / Math.max(1, full)), barHeight).fill({ color: 0xd6c7a1, alpha: .95 });
      top -= barHeight + 3;
    }
    if (pest.hp < pest.maxHp) {
      graphic.rect(x - barWidth / 2, top, barWidth, barHeight).fill({ color: 0x0f172a, alpha: .68 });
      graphic.rect(x - barWidth / 2, top, barWidth * Math.max(0, pest.hp / pest.maxHp), barHeight).fill({ color: 0xf87171, alpha: .95 });
    }
  }

  /** A ring of straw mulch round every plant, which also sets it off against the dark soil of the bed. */
  function drawMounds(graphic: Record<string, any>): void {
    graphic.clear();
    if (!board) return;
    const unit = tileUnit();
    for (const plant of board.plants) {
      const foot = plantFoot(plant);
      graphic.ellipse(foot.x + 3, foot.y + 3, unit * .38, unit * .13).fill({ color: 0x2b1b0e, alpha: .35 });
      graphic.ellipse(foot.x, foot.y - 2, unit * .36, unit * .13).fill({ color: 0xd9b86a, alpha: 1 });
      graphic.ellipse(foot.x, foot.y - 2, unit * .2, unit * .07).fill({ color: 0x5b3a1e, alpha: 1 });
      for (let strand = 0; strand < 9; strand++) {
        const angle = strand * Math.PI * 2 / 9 + plant.column;
        const inner = { x: foot.x + Math.cos(angle) * unit * .22, y: foot.y - 2 + Math.sin(angle) * unit * .08 };
        const outer = { x: foot.x + Math.cos(angle + .3) * unit * .34, y: foot.y - 2 + Math.sin(angle + .3) * unit * .12 };
        graphic.moveTo(inner.x, inner.y).lineTo(outer.x, outer.y).stroke({ color: 0xa8843c, width: 2, alpha: .8 });
      }
    }
  }

  /** How far a lobbed shot was thrown, measured once when it is first drawn: to the pest it was aimed at. */
  const lobReach = new WeakMap<object, number>();

  /** Each tower throws its own thing: saffron threads, cactus spines, stars, grapes, and lobbed caps. */
  function drawShot(graphic: Record<string, any>, shot: Board['shots'][number]): void {
    const r = Math.max(6, Math.min(cellWidth, cellHeight) * .11);
    const x = boardX(shot.x);
    // A shot fired into a neighbouring lane leaves its tower's lane and curves across within a tile.
    const turn = Math.min(1, Math.max(0, (shot.x - shot.from) / .9));
    const eased = turn * turn * (3 - 2 * turn);
    let y = laneCentreY(shot.fromLane) + (laneCentreY(shot.lane) - laneCentreY(shot.fromLane)) * eased - cellHeight * .12;
    switch (shot.source) {
      case 'Saffron':
        graphic.moveTo(x - r * 2.6, y).lineTo(x + r * .4, y).stroke({ color: 0xf97316, width: r * .55, alpha: .9 });
        graphic.moveTo(x - r * 1.6, y - r * .15).lineTo(x + r * .2, y - r * .15).stroke({ color: 0xfed7aa, width: r * .18, alpha: .9 });
        graphic.circle(x + r * .5, y, r * .45).fill({ color: 0xdc2626, alpha: 1 });
        return;
      case 'Cactus':
        graphic.moveTo(x - r * 2.2, y).lineTo(x + r * 1.1, y).stroke({ color: 0xd9f99d, width: Math.max(2, r * .3), alpha: 1 });
        graphic.poly([x + r * 1.1, y - r * .22, x + r * 1.8, y, x + r * 1.1, y + r * .22], true).fill({ color: 0x3f6212, alpha: 1 });
        return;
      case 'Starweaver': {
        const spin = wallClock * 7 + shot.lane;
        const points: number[] = [];
        for (let index = 0; index < 10; index++) {
          const angle = spin + index * Math.PI / 5;
          const reach = index % 2 ? r * .5 : r * 1.25;
          points.push(x + Math.cos(angle) * reach, y + Math.sin(angle) * reach);
        }
        graphic.circle(x - r * 1.6, y + r * .3, r * .28).fill({ color: 0xe0f2fe, alpha: .6 });
        graphic.circle(x - r * 2.5, y - r * .2, r * .2).fill({ color: 0xe0f2fe, alpha: .35 });
        graphic.poly(points, true).fill({ color: 0xf0f9ff, alpha: 1 });
        graphic.poly(points, true).stroke({ color: 0x7dd3fc, width: 2, alpha: .9 });
        return;
      }
      case 'Grape':
        graphic.circle(x, y, r).fill({ color: 0x6d28d9, alpha: 1 });
        graphic.circle(x - r * .3, y - r * .35, r * .35).fill({ color: 0xc4b5fd, alpha: .85 });
        graphic.moveTo(x + r * .2, y - r).lineTo(x + r * .5, y - r * 1.5).stroke({ color: 0x4d7c0f, width: 2, alpha: 1 });
        return;
      case 'Milkcap': {
        // Lobbed: an arc from the tower to where its target was when it was thrown.
        if (!lobReach.has(shot)) {
          const target = board?.pests.filter(pest => pest.lane === shot.lane && pest.x > shot.from).sort((a, b) => a.x - b.x)[0];
          lobReach.set(shot, Math.max(1, (target?.x ?? shot.from + 3) - shot.from));
        }
        const travel = Math.min(1, (shot.x - shot.from) / lobReach.get(shot)!);
        y -= Math.sin(Math.PI * travel) * cellHeight * .55;
        graphic.ellipse(x, laneCentreY(shot.lane) + cellHeight * .1, r * 1.1 * (.6 + travel * .4), r * .35).fill({ color: 0x14351a, alpha: .25 });
        graphic.ellipse(x, y + r * .35, r * 1.15, r * .4).fill({ color: 0xd6c7a1, alpha: 1 });
        graphic.ellipse(x, y, r * 1.35, r * .85).fill({ color: 0xfef3c7, alpha: 1 });
        graphic.circle(x - r * .5, y - r * .2, r * .2).fill({ color: 0xe7d3a3, alpha: 1 });
        graphic.circle(x + r * .35, y - r * .4, r * .16).fill({ color: 0xe7d3a3, alpha: 1 });
        return;
      }
      default:
        graphic.circle(x, y, r).fill({ color: shot.slow ? 0xbae6fd : 0xbbf7d0, alpha: .95 });
        graphic.circle(x, y, r).stroke({ color: 0x14532d, width: 2, alpha: .5 });
    }
  }

  /**
   * A frost gentian's lane: rimed grass along its whole length, thickest by the flower, flakes
   * drifting across it and a cold pulse off the flower itself, so it is plain which lane is chilled.
   */
  function drawFrost(graphic: Record<string, any>, plant: Plant): void {
    if (!lawn) return;
    const y = laneCentreY(plant.lane);
    const flower = cellCentreX(plant.column);
    const top = y - cellHeight / 2 + 6;
    const height = cellHeight - 12;
    for (let column = 0; column < columns; column++) {
      const distance = Math.abs(column - plant.column);
      graphic.rect(lawn.left + column * cellWidth, top, cellWidth + 1, height).fill({ color: 0xe0f2fe, alpha: .08 + .2 * Math.max(0, 1 - distance / 4) });
    }
    graphic.rect(lawn.left, top, lawn.width, height).stroke({ color: 0xbae6fd, width: 3, alpha: .55 });
    for (let flake = 0; flake < 16; flake++) {
      const drift = (wallClock * .1 + flake * .137) % 1;
      const x = lawn.left + lawn.width * ((flake * .618 + drift * .2) % 1);
      const fy = top + height * ((flake * .37 + drift) % 1);
      const size = 3 + flake % 3;
      graphic.moveTo(x - size, fy).lineTo(x + size, fy).stroke({ color: 0xffffff, width: 1.5, alpha: .85 });
      graphic.moveTo(x, fy - size).lineTo(x, fy + size).stroke({ color: 0xffffff, width: 1.5, alpha: .85 });
    }
    const pulse = (wallClock * .6 + plant.column * .13) % 1;
    graphic.circle(flower, y, cellWidth * (.2 + pulse * .5)).stroke({ color: 0xe0f2fe, width: 3, alpha: .6 * (1 - pulse) });
  }

  /** Frost gentians paint their chill on the lawn; armed puffballs pulse; stunned plants spark. */
  function drawPlantEffects(graphic: Record<string, any>): void {
    if (!board || !lawn) return;
    for (const plant of board.plants) {
      const x = cellCentreX(plant.column);
      const y = laneCentreY(plant.lane);
      if (plant.def.kind === 'aura') drawFrost(graphic, plant);
      if (plant.def.kind === 'mine' && board.time >= plant.armAt) {
        graphic.circle(x, y + cellHeight * .15, cellWidth * (.28 + Math.sin(wallClock * 5) * .04)).stroke({ color: 0xc4b5fd, width: 4, alpha: .7 });
      }
      if (board.time < plant.stunUntil) {
        for (let spark = 0; spark < 3; spark++) {
          const angle = wallClock * 6 + spark * 2.1;
          graphic.circle(x + Math.cos(angle) * cellWidth * .25, y - cellHeight * .3 + Math.sin(angle) * cellHeight * .08, 4).fill({ color: 0xfde047, alpha: .95 });
        }
      }
      // Plants are sprites, but their health has to be legible without one.
      if (plant.hp < plant.def.hp) {
        const width = Math.min(cellWidth, cellHeight) * .62;
        const top = y - cellHeight * .34;
        graphic.rect(x - width / 2, top, width, 6).fill({ color: 0x0f172a, alpha: .6 });
        graphic.rect(x - width / 2, top, width * Math.max(0, plant.hp / plant.def.hp), 6).fill({ color: 0x4ade80, alpha: .95 });
      }
    }
  }

  /** Where a seed would go: the lane glows, and the tile shows green if it can be planted, red if not. */
  function drawHover(graphic: Record<string, any>): void {
    if (!hovered || !lawn || !board || !playing() || paused) return;
    const { lane, column } = hovered;
    if (lane < 0 || lane >= lanes || column < 0 || column >= columns) return;
    const x = lawn.left + column * cellWidth;
    const y = lawn.top + lane * cellHeight;
    if (shovel) {
      if (board.plantAt(lane, column)) graphic.rect(x + 4, y + 4, cellWidth - 8, cellHeight - 8).stroke({ color: 0xf87171, width: 5, alpha: .9 });
      return;
    }
    const def = selected ? PLANT_BY_ID.get(selected) : undefined;
    if (!def) return;
    graphic.rect(lawn.left, y, lawn.width, cellHeight).fill({ color: 0xffffff, alpha: .05 });
    const ok = !board.canPlant(def, lane, column);
    graphic.rect(x + 4, y + 4, cellWidth - 8, cellHeight - 8).fill({ color: ok ? 0x86efac : 0xf87171, alpha: .2 });
    graphic.rect(x + 4, y + 4, cellWidth - 8, cellHeight - 8).stroke({ color: ok ? 0xdcfce7 : 0xfecaca, width: 4, alpha: .85 });
  }

  function drawPoofs(graphic: Record<string, any>): void {
    for (const poof of poofs) {
      const age = (wallClock - poof.at) / .5;
      if (age >= 1) continue;
      graphic.circle(poof.x, poof.y, poof.size * (.3 + age * .7)).stroke({ color: poof.colour, width: 4, alpha: .7 * (1 - age) });
      for (let bit = 0; bit < 6; bit++) {
        const angle = bit * Math.PI / 3 + poof.at;
        const reach = poof.size * (.25 + age * .9);
        graphic.circle(poof.x + Math.cos(angle) * reach, poof.y + Math.sin(angle) * reach * .7, Math.max(2, poof.size * .1 * (1 - age))).fill({ color: poof.colour, alpha: 1 - age });
      }
    }
    poofs = poofs.filter(poof => wallClock - poof.at < .5);
  }

  function render(): void {
    const geometry = scene.sync();
    const entities = scene.layer('entities');
    const mounds = scene.layer('plantShadow');
    if (!geometry || !lawn || !entities || !board) return;
    if (mounds) drawMounds(mounds);
    updatePlantSprites();
    updatePestSprites();
    positionLawnInput();
    entities.clear();
    drawHover(entities);
    drawPlantEffects(entities);
    updateCans(entities);

    for (const shot of board.shots) drawShot(entities, shot);

    for (const pest of board.pests) drawPestOverlay(entities, pest);
    drawPoofs(entities);

    for (const token of board.suns) {
      const fade = token.age > SUN_LIFETIME - 3 ? .35 + .65 * Math.max(0, (SUN_LIFETIME - token.age) / 3) : 1;
      const radius = Math.max(16, cellWidth * .22);
      const x = boardX(token.x);
      const y = lawn.top + token.y * cellHeight;
      const spin = wallClock * 1.2;
      for (let ray = 0; ray < 8; ray++) {
        const angle = spin + ray * Math.PI / 4;
        entities.moveTo(x + Math.cos(angle) * radius * 1.1, y + Math.sin(angle) * radius * 1.1)
          .lineTo(x + Math.cos(angle) * radius * 1.55, y + Math.sin(angle) * radius * 1.55)
          .stroke({ color: 0xfde68a, width: 4, alpha: .8 * fade });
      }
      entities.circle(x, y, radius * 1.25).fill({ color: 0xfde68a, alpha: .22 * fade });
      entities.circle(x, y, radius).fill({ color: 0xfbbf24, alpha: .95 * fade });
      entities.circle(x - radius * .25, y - radius * .3, radius * .3).fill({ color: 0xfffbeb, alpha: .8 * fade });
    }
  }

  function positionLawnInput(): void {
    const input = panel()?.querySelector<HTMLElement>('.gd-lawn-input');
    if (!input) return;
    // The input covers the house strip too, and a little above the lawn where sky sun falls in.
    const area = lawn ? { left: lawn.left - houseStrip, top: lawn.top - 40, width: lawn.width + houseStrip, height: lawn.height + 40 } : null;
    const rect = area ? scene.project(area) : null;
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
    wallClock += delta;
    try {
      if (board && !paused) board.step(delta);
      render();
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

  function seedsHtml(): string {
    return PLANTS.map((plant, index) => {
      const sprite = cropSpriteSource(plant) || plantSpriteSource(plant);
      const icon = sprite ? `<img src="${sprite}" alt="">` : `<em>${escapeHtml(plant.name.slice(0, 1))}</em>`;
      return `<button class="gd-seed" data-seed="${plant.id}" title="${escapeHtml(`${plant.name} (${plant.cost} sun): ${plant.detail} Recharge ${plant.recharge}s.`)}"><kbd>${SEED_KEYS[index] ?? ''}</kbd>${plant.kind === 'mine' || plant.kind === 'bomb' ? '<i class="gd-once" title="One use">1&times;</i>' : ''}${icon}<b>${escapeHtml(plant.name)}</b><small>${dev ? 'free' : plant.cost}</small></button>`;
    }).join('');
  }

  function wavesHtml(): string {
    const wave = board?.wave ?? 0;
    if (board?.endless) return `<div class="gd-waves"><div class="gd-waves-label"><span data-wave></span><b>Endless &middot; wave <span data-wave-number>${wave}</span></b></div></div>`;
    const flags = Array.from({ length: Math.floor(TOTAL_WAVES / HUGE_EVERY) }, (_, index) => {
      const at = (index + 1) * HUGE_EVERY;
      return `<span style="left:${at / TOTAL_WAVES * 100}%" data-flag="${at}" data-done="${wave >= at}">&#9873;</span>`;
    }).join('');
    return `<div class="gd-waves"><div class="gd-waves-label"><span data-wave></span><b>Wave <span data-wave-number>${wave}</span> of ${TOTAL_WAVES}</b></div><div class="gd-track"><i data-wave-fill></i>${flags}</div></div>`;
  }

  function renderStatus(): void {
    const host = panel();
    if (!host || host.hidden) return;
    const wave = board?.wave ?? 0;
    const sunNode = host.querySelector<HTMLElement>('[data-sun]');
    const waveNode = host.querySelector<HTMLElement>('[data-wave]');
    const numberNode = host.querySelector<HTMLElement>('[data-wave-number]');
    const fillNode = host.querySelector<HTMLElement>('[data-wave-fill]');
    const statusNode = host.querySelector<HTMLElement>('[data-status]');
    const bannerNode = host.querySelector<HTMLElement>('[data-banner]');
    if (sunNode) sunNode.textContent = dev ? '∞' : String(board?.sun ?? 0);
    if (numberNode) numberNode.textContent = String(wave);
    if (waveNode && board) {
      waveNode.textContent = paused ? 'Paused'
        : wave === 0 ? `First wave in ${Math.max(0, Math.ceil(board.waveTimer))}s`
        : board.queued.length ? `${board.queued.length} still to arrive`
        : !board.endless && wave >= TOTAL_WAVES ? `${board.pests.length} left to clear`
        : `Next wave in ${Math.max(0, Math.ceil(board.waveTimer))}s`;
    }
    if (fillNode && board) {
      // Progress creeps across each wave's share as its pests arrive, not just when the next begins.
      const partial = wave ? 1 - board.queued.length / Math.max(1, board.waveSize) : 0;
      fillNode.style.width = `${Math.min(1, (Math.max(0, wave - 1) + partial) / TOTAL_WAVES) * 100}%`;
    }
    for (const flag of host.querySelectorAll<HTMLElement>('[data-flag]')) flag.dataset.done = String(wave >= Number(flag.dataset.flag));
    advanceBanner();
    if (bannerNode) {
      const showing = Boolean(banner && wallClock < bannerUntil);
      bannerNode.hidden = !showing;
      if (showing && bannerNode.textContent !== banner) bannerNode.textContent = banner;
      bannerNode.dataset.kind = bannerKind;
    }
    if (statusNode) statusNode.textContent = status;
    for (const button of host.querySelectorAll<HTMLButtonElement>('[data-seed]')) {
      const plant = PLANT_BY_ID.get(button.dataset.seed!);
      if (!plant || !board) continue;
      const charge = board.seedCharge(plant);
      button.dataset.selected = String(selected === plant.id);
      button.disabled = !playing() || paused || charge > 0 || (!dev && board.sun < plant.cost);
      button.style.setProperty('--cd', String(charge));
    }
  }

  function devHtml(): string {
    if (!dev) return '';
    const spawns = ALL_PESTS.map(pest => `<button data-spawn="${pest.id}">${escapeHtml(pest.name)}</button>`).join('');
    return `<div class="gd-dev"><b>Tuning mode</b>` +
      `<div class="gd-dev-row">${spawns}<button data-spawn-lane>Fill a lane</button><button data-clear-pests>Clear pests</button></div>` +
      `<div class="gd-dev-row"><button data-hold data-active="${board?.wavesHeld ?? false}">${board?.wavesHeld ? 'Waves held' : 'Hold waves'}</button><button data-next-wave>Next wave</button><button data-add-sun>+500 sun</button><button data-clear-plants>Clear plants</button></div>` +
      `<small>Towers are free and this run is not recorded. Call __gardenCompanionGardenDefenceDev(false) to leave.</small></div>`;
  }

  function endHtml(): string {
    if (!board) return '';
    if (board.over) {
      return `<div class="gd-end" data-kind="lost"><b>The garden was overrun</b><small>You held ${board.wave} wave${board.wave === 1 ? '' : 's'}.${dev ? ' Tuning runs are not recorded.' : ` Best is ${record.best}.`}</small><div><button data-restart>Try again</button></div></div>`;
    }
    if (board.won) {
      return `<div class="gd-end" data-kind="won"><b>&#127803; The garden is safe!</b><small>All ${TOTAL_WAVES} waves beaten and the Storm Wolf seen off${dev ? '.' : ` - ${record.wins} win${record.wins === 1 ? '' : 's'} so far.`} Keep going for an endless run, or start fresh.</small><div><button data-keep-going>Keep going</button><button data-restart>New run</button></div></div>`;
    }
    return '';
  }

  function renderChrome(): void {
    const host = panel();
    if (!host || host.hidden) return;
    const card = host.querySelector<HTMLElement>('.gd-card');
    if (!card) return;
    card.innerHTML = `<header><div class="gd-title"><span class="gd-logo">&#127803;</span><div><h2>Garden Defence</h2><div class="gd-sub">Best wave ${record.best} &middot; ${record.wins} win${record.wins === 1 ? '' : 's'}</div></div></div>` +
      `<div class="gd-head-actions"><span class="gd-sun" title="Sun"><i></i><span data-sun>${dev ? '&#8734;' : board?.sun ?? 0}</span></span><button class="gd-icon" data-pause title="Pause (P)">${paused ? '&#9654;' : '&#10074;&#10074;'}</button><button class="gd-icon" data-close aria-label="Close">&#10005;</button></div></header>` +
      `<div class="gd-body">${endHtml()}${wavesHtml()}<div class="gd-banner" data-banner hidden></div>` +
      `<div class="gd-seeds">${seedsHtml()}</div>` +
      `<div class="gd-tools"><button data-shovel data-active="${shovel}">${SHOVEL_ICON} ${shovel ? 'Digging' : 'Shovel'}</button><button data-restart-run>Restart</button></div>` +
      devHtml() +
      `<div class="gd-status" data-status></div>` +
      `</div><div class="gd-foot"><span>Click sun to collect it &middot; right-click to put down</span><span>${record.sun.toLocaleString(NUMBER_LOCALE)} sun &middot; ${record.runs} runs</span></div>`;
    bindDevButtons(card);
    card.querySelector<HTMLButtonElement>('[data-close]')!.onclick = close;
    card.querySelector<HTMLButtonElement>('[data-pause]')!.onclick = togglePause;
    for (const button of card.querySelectorAll<HTMLButtonElement>('[data-restart], [data-restart-run]')) button.onclick = restart;
    card.querySelector<HTMLButtonElement>('[data-keep-going]')?.addEventListener('click', keepGoing);
    card.querySelector<HTMLButtonElement>('[data-shovel]')!.onclick = toggleShovel;
    for (const button of card.querySelectorAll<HTMLButtonElement>('[data-seed]')) {
      button.onclick = () => selectSeed(button.dataset.seed!);
    }
    renderStatus();
  }

  function selectSeed(id: string): void {
    const def = PLANT_BY_ID.get(id);
    if (!def || !playing() || paused) return;
    selected = selected === id ? null : id;
    shovel = false;
    status = selected ? `${def.name}: ${def.detail}` : 'Pick a seed, then click a tile to plant it.';
    renderChrome();
  }

  function toggleShovel(): void {
    if (!playing()) return;
    shovel = !shovel;
    if (shovel) selected = null;
    status = shovel ? 'Click a plant to dig it up.' : 'Shovel put away.';
    renderChrome();
  }

  function togglePause(): void {
    if (!playing()) return;
    paused = !paused;
    status = paused ? 'Paused. Press P or the play button to carry on.' : 'Back to it!';
    renderChrome();
  }

  function bindDevButtons(card: HTMLElement): void {
    if (!dev || !board) return;
    const current = board;
    for (const button of card.querySelectorAll<HTMLButtonElement>('[data-spawn]')) {
      button.onclick = () => {
        const def = ALL_PESTS.find(pest => pest.id === button.dataset.spawn) as PestDef | undefined;
        if (!def) return;
        current.spawn(def);
        status = `Spawned a ${def.name}.`;
        renderStatus();
      };
    }
    card.querySelector<HTMLButtonElement>('[data-spawn-lane]')!.onclick = () => {
      for (let lane = 0; lane < lanes; lane++) current.spawn(ALL_PESTS[0], lane);
      status = `Spawned a worm in all ${lanes} lanes.`;
      renderStatus();
    };
    card.querySelector<HTMLButtonElement>('[data-clear-pests]')!.onclick = () => {
      current.pests = [];
      current.queued = [];
      status = 'Cleared every pest.';
      renderStatus();
    };
    card.querySelector<HTMLButtonElement>('[data-clear-plants]')!.onclick = () => {
      for (const plant of [...current.plants]) current.dig(plant.lane, plant.column);
      status = 'Cleared the board.';
      renderStatus();
    };
    card.querySelector<HTMLButtonElement>('[data-hold]')!.onclick = () => {
      current.wavesHeld = !current.wavesHeld;
      status = current.wavesHeld ? 'Waves held. Spawn pests by hand.' : 'Waves running again.';
      renderChrome();
    };
    card.querySelector<HTMLButtonElement>('[data-next-wave]')!.onclick = () => current.startWave();
    card.querySelector<HTMLButtonElement>('[data-add-sun]')!.onclick = () => {
      current.sun += 500;
      renderStatus();
    };
  }

  function open(): void {
    const host = panel();
    if (!host) return;
    // Growing-plant art is decoded on demand, and some towers are drawn as the plant.
    page.__gardenCompanionLoadSpriteGroup?.('deferred');
    // Only one minigame holds the farm at a time.
    if (page.__gardenCompanionFishingOpen?.()) page.__gardenCompanionToggleFishing?.();
    host.hidden = false;
    scene.enter();
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
    // The scene took every sprite with it, so a reopened board draws them fresh.
    forgetSprites();
    hovered = null;
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
    lawnInput.addEventListener('contextmenu', event => event.preventDefault());
    lawnInput.onpointerdown = event => {
      event.preventDefault();
      // Right click puts down whatever is in hand.
      if (event.button === 2) {
        selected = null;
        shovel = false;
        renderChrome();
        return;
      }
      if (event.button !== 0) return;
      handleLawnClick(event.clientX, event.clientY);
    };
    lawnInput.onpointermove = event => {
      const cell = cellAt(event.clientX, event.clientY);
      hovered = cell ? { lane: cell.lane, column: cell.column } : null;
    };
    lawnInput.onpointerleave = () => { hovered = null; };
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
    // Number keys pick seeds, P pauses, Escape puts down what is in hand. Only while
    // the board is up, and stopped there so the game's own bindings do not fire as well.
    window.addEventListener('keydown', event => {
      if (panel()?.hidden !== false || isTyping() || event.ctrlKey || event.altKey || event.metaKey || event.repeat) return;
      const key = event.key.toLowerCase();
      const seedIndex = SEED_KEYS.indexOf(key);
      if (seedIndex >= 0 && PLANTS[seedIndex]) selectSeed(PLANTS[seedIndex].id);
      else if (key === 'p') togglePause();
      else if (key === 'escape') { selected = null; shovel = false; renderChrome(); }
      else return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
    page.__gardenCompanionToggleGardenDefence = () => (panel()?.hidden ? open() : close());
    // Published rather than shown, so tuning controls stay out of a normal player's panel.
    page.__gardenCompanionGardenDefenceDev = (enabled = !dev) => {
      dev = enabled;
      // Switching modes always starts a clean run: a scored run must not gain free towers, and a
      // tuning run must never be scored.
      if (panel()?.hidden !== false) open();
      restart();
      return dev;
    };
  }

  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
}
