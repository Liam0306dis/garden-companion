import { feature } from '../config.js';
import { page } from '../page.js';
import { state } from '../state.js';
import { pixiSurface, type PixiSurface } from '../pixi.js';
import { loadLocal, saveLocal } from '../utils.js';
import { quinoaEngine } from '../quinoa-engine.js';

/**
 * A ball is thrown at each active pet before a team swap goes through.
 *
 * Purely decoration, and deliberately self-contained so it can be dropped without unpicking
 * anything: everything it needs lives in this file, including its stylesheet. To remove the
 * feature, delete this module, change the one call in applyPetTeam back to the plain send, and drop
 * the petSwapToss entry from the config and the Features tab.
 *
 * The swap itself is never at the mercy of the animation. Anything that goes wrong - no pets found,
 * the scene unreadable, an animation that never settles - falls through to sending immediately.
 *
 * Everything is drawn from the world each frame rather than from screen positions taken once at the
 * start. The camera follows the player, so a throw made while walking would otherwise drift away
 * from the pet it was aimed at over the second it spends in the air.
 */

const STYLE_ID = 'gc-pet-toss-style';
const LAYER_ID = 'gc-pet-toss-layer';
/** How long the whole thing may take before the swap is sent regardless. */
const TOSS_TIMEOUT_MS = 3_000;
/**
 * How long the caught pets stay hidden after the swap is sent, waiting for the server to replace
 * them. Without it they pop back into view for the round trip and the swap looks like it failed.
 */
const SETTLE_MS = 700;
const THROW_MS = 360;
const STAGGER_MS = 110;
const FLASH_MS = 260;
/** A beat between the ball landing and the pet going, so the catch is watchable rather than instant. */
const CATCH_DELAY_MS = 140;
/** The pet shrinking into the ball in a red glow. The swap is sent once every pet is in. */
const ABSORB_MS = 280;
/** Then the ball rocks this many times, each a tilt and a pause, and clicks shut. */
const SHAKES = 3;
const SHAKE_MS = 260;
const CLICK_MS = 300;

/**
 * The four balls, drawn rather than fetched: a top colour and a band is all it takes to tell them
 * apart at this size, and nothing has to load before the first throw. Which one is pure chance.
 */
const BALL_KINDS = ['poke', 'great', 'ultra', 'master'];

function randomBallKind(): string {
  return BALL_KINDS[Math.floor(Math.random() * BALL_KINDS.length)];
}

/**
 * What gets thrown, for comparing the two by eye. Balls are drawn here; eggs are the game's own art
 * and need the sprite loader to have decoded them, so a missing sprite falls back to a ball rather
 * than throwing nothing.
 *
 * Console: __gardenCompanionTossStyle('egg' | 'ball') to set, no argument to read.
 */
const STYLE_KEY = 'gardenCompanion.tossStyle.v1';
const TOSS_EGGS = [
  'CommonEgg', 'UncommonEgg', 'RareEgg', 'LegendaryEgg', 'MythicalEgg',
  'HorseEgg', 'DawnEgg', 'SnowEgg', 'ThunderEgg',
];

let tossStyle: string = loadLocal<string>(STYLE_KEY, 'ball') === 'egg' ? 'egg' : 'ball';

page.__gardenCompanionTossStyle = (style?: string) => {
  if (style === 'egg' || style === 'ball') {
    tossStyle = style;
    saveLocal(STYLE_KEY, style);
    // Egg art is decoded in the deferred sprite stage, so asking for eggs before that has run would
    // silently keep throwing balls. Nudging the loader makes the flag take effect on its own.
    if (style === 'egg' && !randomEggSprite()) page.__gardenCompanionLoadSpriteGroup?.();
  }
  return tossStyle;
};

function randomEggSprite(): string {
  const sprites = page.__gardenCompanionShopSprites ?? {};
  const available = TOSS_EGGS.filter(egg => sprites[egg]);
  return available.length ? sprites[available[Math.floor(Math.random() * available.length)]] : '';
}

/** The element for one throw: an egg sprite when asked for and available, a drawn ball otherwise. */
function createProjectile(): HTMLElement {
  const egg = tossStyle === 'egg' ? randomEggSprite() : '';
  if (egg) {
    const image = document.createElement('img');
    image.className = 'gc-toss-egg';
    image.src = egg;
    return image;
  }
  const ball = document.createElement('i');
  ball.className = 'gc-toss-ball';
  ball.dataset.kind = randomBallKind();
  return ball;
}

interface TossTarget { x: number; y: number }
interface TossPet { id: string; hold: { x: number; y: number } }

/** Screen centre of a display object, or null when it cannot be measured. */
function screenCentre(surface: PixiSurface, display: Record<string, any> | undefined): TossTarget | null {
  if (!display || display.destroyed || typeof display.getBounds !== 'function') return null;
  try {
    const bounds = display.getBounds();
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0) return null;
    return { x: surface.toScreenX(bounds.x + bounds.width / 2), y: surface.toScreenY(bounds.y + bounds.height / 2) };
  } catch { return null; }
}

function petSystem(): Record<string, any> | undefined {
  return page.__gardenCompanionFarmSystems?.petSystem ?? undefined;
}

/** Where a pet is on screen right now. Read every frame, so the camera moving is followed. */
function petScreen(surface: PixiSurface, id: string): TossTarget | null {
  const views = petSystem()?.views as Map<string, Record<string, any>> | undefined;
  return views instanceof Map ? screenCentre(surface, views.get(id)?.displayObject) : null;
}

/**
 * Where our own avatar is standing, so the throw comes from the player rather than off the bottom
 * of the screen. The avatar system keeps a container per player id.
 *
 * Its transform origin is used rather than its bounds: the avatar is drawn through a batch
 * renderer, so the container's bounds describe its children rather than where the player appears,
 * and taking their centre threw the ball in from the edge of the screen.
 */
function throwOrigin(surface: PixiSurface): TossTarget {
  const fallback = { x: window.innerWidth / 2, y: window.innerHeight + 40 };
  const views = (quinoaEngine()?.getSystem?.('avatar') as { views?: Map<string, Record<string, any>> } | undefined)?.views;
  const container = state.playerId && views instanceof Map ? views.get(state.playerId)?.container : undefined;
  if (!container || container.destroyed || typeof container.getGlobalPosition !== 'function') return fallback;
  try {
    const position = container.getGlobalPosition();
    if (!Number.isFinite(position?.x) || !Number.isFinite(position?.y)) return fallback;
    const origin = { x: surface.toScreenX(position.x), y: surface.toScreenY(position.y) };
    // A point off the screen is not the player, whatever it is, and throwing from there looks like
    // a ball sailing in from nowhere. The bottom centre at least reads as a throw.
    const onScreen = origin.x > -40 && origin.x < window.innerWidth + 40 && origin.y > -40 && origin.y < window.innerHeight + 40;
    return onScreen ? origin : fallback;
  } catch { return fallback; }
}

/** The pets to aim at, and where each stood when the throw began. */
function tossTargets(): TossPet[] {
  const surface = pixiSurface();
  const system = petSystem();
  const views = system?.views as Map<string, Record<string, any>> | undefined;
  if (!surface || !(views instanceof Map)) return [];
  const active = new Set((state.slot?.data?.petSlots ?? []).map(pet => pet.id));
  const targets: TossPet[] = [];
  for (const [id, petView] of views) {
    if (!active.has(id) || system?.petInfoById?.get?.(id)?.riddenByPlayerId) continue;
    const display = petView?.displayObject;
    if (!display?.position || !screenCentre(surface, display)) continue;
    targets.push({ id, hold: { x: Number(display.x), y: Number(display.y) } });
  }
  return targets;
}

/**
 * Pets wander, and the throw takes long enough that one can stroll off the tile it was aimed at.
 * They are pinned where they stood for the length of it, inside the pet system's own draw - the
 * same place the world scene holds them - because a position set on our frame is overwritten on
 * theirs. Restoring only replaces our own wrapper, so a later hook is left where it is.
 */
interface PetHold {
  /** Starts a pet shrinking into its ball. It stays hidden once in, until the hold is released. */
  catch: (id: string) => void;
  release: () => void;
}

/**
 * A pet being drawn into its ball. What it looked like is kept from the first frame of the catch,
 * both to shrink from and to put back if the swap is refused and the pet stays out.
 */
interface Absorb {
  at: number;
  scale?: { x: number; y: number };
  alpha?: number;
  tint?: number;
  /** Its own centre in its parent's space, which it is pulled towards: the ball sits there. */
  centre?: { x: number; y: number } | null;
}

const ABSORB_TINT = 0xff5050;

/** The middle of a display object in its parent's space, since its own origin is usually its feet. */
function localCentre(display: Record<string, any>): { x: number; y: number } | null {
  try {
    const bounds = display.getBounds();
    const point = display.parent?.toLocal?.({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
    return Number.isFinite(point?.x) && Number.isFinite(point?.y) ? { x: point.x, y: point.y } : null;
  } catch { return null; }
}

function holdPets(targets: TossPet[]): PetHold {
  const system = petSystem();
  const caught = new Map<string, Absorb>();
  if (!system || typeof system.draw !== 'function') return { catch: () => undefined, release: () => undefined };
  const original = system.draw;
  const held = new Map(targets.map(target => [target.id, target.hold]));
  const wrapper = function(this: Record<string, any>, ...args: any[]) {
    const result = original.apply(this, args);
    for (const [id, position] of held) {
      const display = this.views?.get?.(id)?.displayObject;
      if (!display?.position || display.destroyed) continue;
      display.position.set(position.x, position.y);
      const absorb = caught.get(id);
      if (!absorb) continue;
      if (!absorb.scale) {
        absorb.scale = { x: Number(display.scale?.x ?? 1), y: Number(display.scale?.y ?? 1) };
        absorb.alpha = Number(display.alpha ?? 1);
        if (typeof display.tint === 'number') absorb.tint = display.tint;
        absorb.centre = localCentre(display);
      }
      const progress = Math.min(1, (performance.now() - absorb.at) / ABSORB_MS);
      // Caught pets end hidden rather than moved away: the swap is already on its way, and the new
      // team takes their place. Everything is put back on release in case it never lands.
      if (progress >= 1) { display.visible = false; continue; }
      const eased = progress * progress;
      const shrink = 1 - eased * .9;
      display.scale?.set?.(absorb.scale.x * shrink, absorb.scale.y * shrink);
      display.alpha = (absorb.alpha ?? 1) * (1 - eased * .6);
      if (absorb.tint !== undefined) display.tint = ABSORB_TINT;
      if (absorb.centre) {
        display.position.set(position.x + (absorb.centre.x - position.x) * eased, position.y + (absorb.centre.y - position.y) * eased);
      }
    }
    return result;
  };
  system.draw = wrapper;
  return {
    catch: id => { if (!caught.has(id)) caught.set(id, { at: performance.now() }); },
    release: () => {
      if (system.draw === wrapper) system.draw = original;
      // Only pets the swap left behind are shown again. The settle ends when our own state says the
      // team changed, which can be a frame or two before the pet system tears the old views down -
      // and showing them in that gap is the reappearance this whole sequence exists to avoid.
      const stillOut = new Set((state.slot?.data?.petSlots ?? []).map(pet => pet.id));
      for (const [id, absorb] of caught) {
        if (!stillOut.has(id)) continue;
        const display = (system.views as Map<string, Record<string, any>> | undefined)?.get?.(id)?.displayObject;
        if (!display || display.destroyed) continue;
        display.visible = true;
        if (absorb.scale) display.scale?.set?.(absorb.scale.x, absorb.scale.y);
        if (absorb.alpha !== undefined) display.alpha = absorb.alpha;
        if (absorb.tint !== undefined) display.tint = absorb.tint;
        const position = held.get(id);
        if (position) display.position.set(position.x, position.y);
      }
    },
  };
}

/** The pets out right now, so the settle can end as soon as the server has actually swapped them. */
function activePetIds(): string {
  return (state.slot?.data?.petSlots ?? []).map(pet => pet.id).sort().join(',');
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
#${LAYER_ID} { position:fixed;inset:0;z-index:99994;pointer-events:none; }
#${LAYER_ID} .gc-toss-egg { position:absolute;left:0;top:0;width:38px;height:38px;margin:-19px 0 0 -19px;object-fit:contain;
  image-rendering:auto;filter:drop-shadow(0 3px 5px rgba(0,0,0,.5)); }
#${LAYER_ID} .gc-toss-ball { position:absolute;left:0;top:0;width:38px;height:38px;margin:-19px 0 0 -19px;border-radius:50%;
  --top:#ee3f3f; --band:#111;
  background:linear-gradient(var(--top) 0 47%,var(--band) 47% 57%,#f6f6f6 57% 100%);
  box-shadow:0 3px 8px rgba(0,0,0,.5),inset -4px -5px 9px rgba(0,0,0,.35),inset 4px 4px 7px rgba(255,255,255,.35); }
#${LAYER_ID} .gc-toss-ball[data-kind=great] { --top:#2f6fd0; }
#${LAYER_ID} .gc-toss-ball[data-kind=ultra] { --top:#33302e; --band:#e8c02a; }
#${LAYER_ID} .gc-toss-ball[data-kind=master] { --top:#7b3fb5; }
#${LAYER_ID} .gc-toss-ball::after { content:'';position:absolute;left:50%;top:50%;width:11px;height:11px;margin:-5.5px 0 0 -5.5px;
  border-radius:50%;background:#f6f6f6;border:3px solid #111;box-sizing:border-box; }
#${LAYER_ID} .gc-toss-flash { position:absolute;left:0;top:0;width:70px;height:70px;margin:-35px 0 0 -35px;border-radius:50%;
  background:radial-gradient(circle,rgba(255,255,255,.95),rgba(255,214,102,.5) 45%,transparent 70%); }
#${LAYER_ID} .gc-toss-glow { position:absolute;left:0;top:0;width:96px;height:96px;margin:-48px 0 0 -48px;border-radius:50%;
  background:radial-gradient(circle,rgba(255,235,235,.95),rgba(255,60,60,.6) 35%,rgba(255,30,30,.25) 55%,transparent 72%); }
#${LAYER_ID} .gc-toss-click { position:absolute;left:0;top:0;width:7px;height:7px;margin:-3.5px 0 0 -3.5px;border-radius:50%;
  box-shadow:0 -24px 0 #ffe066,21px -12px 0 #fff3b0,21px 12px 0 #ffe066,0 24px 0 #fff3b0,-21px 12px 0 #ffe066,-21px -12px 0 #fff3b0; }`;
  document.head.appendChild(style);
}

function layer(): HTMLElement {
  ensureStyle();
  let root = document.getElementById(LAYER_ID);
  if (!root) {
    root = document.createElement('div');
    root.id = LAYER_ID;
    document.body.appendChild(root);
  }
  return root;
}

interface Flight {
  ball: HTMLElement;
  flash: HTMLElement | null;
  /** The red glow the pet is drawn into. */
  glow: HTMLElement | null;
  /** The spark when the ball clicks shut. */
  spark: HTMLElement | null;
  petId: string;
  delay: number;
  landedAt: number;
  caught: boolean;
  /** The pet is fully inside, which is what the swap waits for. */
  absorbed: boolean;
  clicked: boolean;
  finished: boolean;
  /** How far this one spins on the way over, and which way. No two throws look quite the same. */
  spin: number;
  /** The tilt it comes to rest at, so a row of balls does not sit perfectly upright in a line. */
  rest: number;
  /** Scale for this one, so they are not all identical. Centred by margin, so it grows both ways. */
  size: number;
  /** The last screen position we could read, so a pet that vanishes mid-flight is still landed on. */
  target: TossTarget;
}

function place(element: HTMLElement, x: number, y: number, extra: string): void {
  element.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) ${extra}`;
}

function removeFlight(flight: Flight): void {
  for (const element of [flight.ball, flight.flash, flight.glow, flight.spark]) element?.remove();
  flight.flash = flight.glow = flight.spark = null;
}

let tossing = false;
/** Whether the running toss has already sent its swap. */
let tossSent = false;
/**
 * The latest swap asked for while a toss was still in the air. It replaces the toss's own when that
 * is sent, so pressing two teams in quick succession ends on the second rather than the first.
 */
let queued: (() => void) | null = null;

export function petSwapTossing(): boolean {
  return tossing;
}

/**
 * Runs the throw, then commits. The commit is guarded so it happens exactly once whatever the
 * animation does, and immediately when the feature is off or there is nothing to throw at.
 */
export function runPetSwapToss(commit: () => void): void {
  if (tossing) {
    // Once the running toss has sent, a newer swap has nothing to wait for and goes straight out.
    if (tossSent) commit();
    else queued = commit;
    return;
  }
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    tossSent = true;
    const latest = queued ?? commit;
    queued = null;
    latest();
  };
  tossSent = false;
  queued = null;
  if (!feature('petSwapToss') || typeof document === 'undefined') { once(); return; }
  let targets: TossPet[] = [];
  try { targets = tossTargets(); } catch { targets = []; }
  if (!targets.length) { once(); return; }

  tossing = true;
  let hold: PetHold = { catch: () => undefined, release: () => undefined };
  let frame = 0;
  const flights: Flight[] = [];
  const finish = () => {
    cancelAnimationFrame(frame);
    for (const flight of flights) removeFlight(flight);
    hold.release();
    tossing = false;
    once();
  };
  const guard = window.setTimeout(finish, TOSS_TIMEOUT_MS);

  try {
    const root = layer();
    const started = performance.now();
    const surface = pixiSurface();
    const fallbackOrigin = { x: window.innerWidth / 2, y: window.innerHeight + 40 };
    for (const [index, target] of targets.entries()) {
      const ball = createProjectile();
      root.appendChild(ball);
      const start = surface ? petScreen(surface, target.id) ?? fallbackOrigin : fallbackOrigin;
      // The spin ends on the resting tilt rather than anywhere, so the ball carries straight into
      // its wobble instead of snapping upright the moment it lands.
      const rest = Math.random() * 40 - 20;
      const turns = 1 + Math.floor(Math.random() * 2);
      const spin = (Math.random() < .5 ? -1 : 1) * turns * 360 + rest;
      const size = .7 + Math.random() * .7;
      flights.push({
        ball, flash: null, glow: null, spark: null, petId: target.id, delay: index * STAGGER_MS, landedAt: 0,
        caught: false, absorbed: false, clicked: false, finished: false, spin, rest, size, target: start,
      });
    }
    hold = holdPets(targets);
    const petsAtStart = activePetIds();
    let committedAt = 0;

    const step = () => {
      const now = performance.now();
      const live = pixiSurface();
      const from = live ? throwOrigin(live) : fallbackOrigin;
      let active = false;
      for (const flight of flights) {
        if (flight.finished) continue;
        // Read the pet again every frame: it is pinned in the world, so this only changes when the
        // camera does, which is exactly the drift we are cancelling out.
        const target = (live && petScreen(live, flight.petId)) || flight.target;
        flight.target = target;
        const elapsed = now - started - flight.delay;
        if (elapsed < 0) { flight.ball.style.opacity = '0'; active = true; continue; }
        flight.ball.style.opacity = '1';
        if (elapsed < THROW_MS) {
          const progress = elapsed / THROW_MS;
          // An arc rather than a straight line, with the lift scaled to the distance so a pet at
          // your feet gets a lob rather than a launch.
          const lift = Math.max(50, Math.min(150, Math.hypot(target.x - from.x, target.y - from.y) * .45));
          const x = from.x + (target.x - from.x) * progress;
          const y = from.y + (target.y - from.y) * progress - Math.sin(progress * Math.PI) * lift;
          place(flight.ball, x, y, `rotate(${Math.round(progress * flight.spin)}deg) scale(${flight.size.toFixed(2)})`);
          active = true;
          continue;
        }
        if (!flight.landedAt) {
          flight.landedAt = now;
          flight.flash = document.createElement('i');
          flight.flash.className = 'gc-toss-flash';
          root.appendChild(flight.flash);
        }
        const settled = now - flight.landedAt;
        // The pet goes a beat after the ball lands rather than the instant it touches, so there is
        // something to watch: ball hits, pet is drawn in, ball rocks three times and clicks.
        if (!flight.caught && settled >= CATCH_DELAY_MS) {
          flight.caught = true;
          hold.catch(flight.petId);
          flight.glow = document.createElement('i');
          flight.glow.className = 'gc-toss-glow';
          root.appendChild(flight.glow);
        }
        const absorbing = settled - CATCH_DELAY_MS;
        if (absorbing >= ABSORB_MS) flight.absorbed = true;
        const shaking = absorbing - ABSORB_MS;
        const clicking = shaking - SHAKES * SHAKE_MS;
        // Each shake is one tilt there and back followed by a still pause, the rhythm of the games.
        let tilt = 0;
        if (shaking >= 0 && clicking < 0) {
          const beat = (shaking % SHAKE_MS) / SHAKE_MS;
          if (beat < .55) tilt = Math.sin(beat / .55 * Math.PI * 2) * -16;
        }
        // The ball swells a touch as the pet goes in.
        const swell = absorbing >= 0 && absorbing < ABSORB_MS ? 1 + Math.sin(absorbing / ABSORB_MS * Math.PI) * .12 : 1;
        flight.ball.style.opacity = clicking > 0 ? String(Math.max(0, 1 - clicking / CLICK_MS)) : '1';
        place(flight.ball, target.x, target.y, `rotate(${(flight.rest + tilt).toFixed(1)}deg) scale(${(flight.size * swell).toFixed(2)})`);
        if (flight.glow) {
          const age = absorbing / ABSORB_MS;
          if (age >= 1) { flight.glow.remove(); flight.glow = null; }
          else {
            // Bright at the start and pulled inwards, so it reads as the pet being drawn into the ball.
            flight.glow.style.opacity = String((.95 * (1 - age * age)).toFixed(2));
            place(flight.glow, target.x, target.y, `scale(${(1.25 - age * .85).toFixed(2)})`);
          }
        }
        if (clicking >= 0 && !flight.clicked) {
          flight.clicked = true;
          flight.spark = document.createElement('i');
          flight.spark.className = 'gc-toss-click';
          root.appendChild(flight.spark);
        }
        if (flight.spark) {
          const age = clicking / CLICK_MS;
          if (age >= 1) { flight.spark.remove(); flight.spark = null; }
          else {
            flight.spark.style.opacity = String((1 - age).toFixed(2));
            place(flight.spark, target.x, target.y - 4, `scale(${(.5 + age * .9).toFixed(2)})`);
          }
        }
        if (flight.flash) {
          const age = settled / FLASH_MS;
          if (age >= 1) { flight.flash.remove(); flight.flash = null; }
          else {
            flight.flash.style.opacity = String(.9 * (1 - age));
            place(flight.flash, target.x, target.y, `scale(${(.4 + age * .9).toFixed(2)})`);
          }
        }
        if (clicking < CLICK_MS) active = true;
        else { flight.finished = true; removeFlight(flight); }
      }
      // The swap goes as soon as every pet is inside rather than after the shakes, so the new team
      // is already on its way before the animation has finished playing out.
      if (!committedAt && flights.every(flight => flight.absorbed)) {
        committedAt = now;
        once();
      }
      // Once sent, the caught pets stay hidden until the server has actually swapped them, or until
      // the settle runs out - whichever comes first, so a refused swap cannot hide them for good.
      if (committedAt && !active) {
        const swapped = activePetIds() !== petsAtStart;
        if (swapped || now - committedAt > SETTLE_MS) { window.clearTimeout(guard); finish(); return; }
        active = true;
      }
      if (!active) { window.clearTimeout(guard); finish(); return; }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  } catch {
    window.clearTimeout(guard);
    finish();
  }
}
