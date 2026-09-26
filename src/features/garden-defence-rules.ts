/**
 * The rules of Garden Defence with nothing drawn: every tower, pest, wave and timer, stepped by
 * hand. The panel draws a board and feeds it clicks; the balance script plays whole runs against
 * it with a bot to check the game can be won without being easy. Positions are in board units -
 * columns from the lawn's left edge and lanes from the top - so neither side needs the other's
 * idea of pixels.
 *
 * The numbers follow Plants vs. Zombies (from the PvZ wiki) wherever there is one to follow: the sun
 * economy, a basic shooter's damage and rate, plant and pest toughness, pest speed, wave points and
 * the rule that a wave cut down quickly brings the next one early.
 */

export const TOTAL_WAVES = 20;
/** Every tenth wave is a huge wave, with a warning first, as in PvZ's flag waves. */
export const HUGE_EVERY = 10;
/** More than PvZ's 50: every lane and every plant is open from the first second here, with no easy early levels to build up in. */
export const STARTING_SUN = 200;
export const SUN_VALUE = 25;
/** Seconds a landed sun token waits to be picked up. */
export const SUN_LIFETIME = 12;
/** PvZ drops sky sun about every ten seconds in daylight. */
const SKY_SUN_INTERVAL = 10;
const FIRST_WAVE_DELAY = 45;
/** A wave that is not dealt with arrives on this timer, somewhere in the range. */
const WAVE_INTERVAL_MIN = 25;
const WAVE_INTERVAL_MAX = 30;
/**
 * PvZ brings the next wave early once enough of the current one is dealt with: between half and
 * two thirds of its health, two seconds later, and never sooner than six seconds apart.
 */
const EARLY_SHARE_MIN = .5;
const EARLY_SHARE_MAX = .65;
const EARLY_DELAY = 2;
const MIN_WAVE_GAP = 6;
/** The breather before a huge wave, so its warning means something. */
const HUGE_WAVE_BREAK = 8;
/**
 * Endless escalates past the tenth-wave points ramp: pests get tougher every wave, the gap between
 * waves shrinks down to half, and Storm Wolves lead every flag wave, one more every twenty waves.
 */
const ENDLESS_TOUGHNESS_PER_WAVE = .05;
const ENDLESS_GAP_SHRINK_PER_WAVE = .02;
const ENDLESS_GAP_FLOOR = .5;
/** Watering cans cross the lane this many columns a second. */
const CAN_SPEED = 5;

export type PlantKind = 'producer' | 'shooter' | 'wall' | 'mine' | 'bomb' | 'aura';

export interface PlantDef {
  /** A game plant id, whose own art is used for the tower. */
  id: string;
  name: string;
  kind: PlantKind;
  cost: number;
  hp: number;
  /** Seconds before the packet can be planted again. */
  recharge: number;
  /** Seconds of recharge the packet starts a run with. */
  startCharge?: number;
  detail: string;
  /** Seconds between shots or sun. */
  interval?: number;
  /** Seconds before a producer's first sun. */
  firstSun?: number;
  damage?: number;
  /** Columns travelled per second. */
  shotSpeed?: number;
  /** Speed multiplier on a hit pest, for slowDuration seconds. */
  slow?: number;
  slowDuration?: number;
  /** Pests one shot passes through. */
  pierce?: number;
  /** Splash radius in columns. */
  splash?: number;
  /** Fires into the lanes either side as well. */
  spread?: boolean;
  sun?: number;
  /** Damage per second back into whatever is eating it. */
  thorns?: number;
  /** A mine's time to arm, or a bomb's fuse, in seconds. */
  arm?: number;
  /** A mine's or bomb's blast damage. */
  blast?: number;
  /**
   * An aura plant chills its whole lane: pests on the lawn there move and bite at this share of
   * their pace, and lose frostbite health a second. Two in one lane do not stack.
   */
  auraSlow?: number;
  frostbite?: number;
}

/** Recharge bands from PvZ: fast, slow and very slow packets. */
const FAST = 7.5;
const SLOW = 30;
const VERY_SLOW = 50;

/** In price order, which is also the order of the seed tray and its number keys. */
export const PLANTS: PlantDef[] = [
  { id: 'Mushroom', name: 'Puffball', kind: 'mine', cost: 25, hp: 300, recharge: SLOW, startCharge: 20, arm: 15, blast: 1800, detail: 'One use. Arms after 15s, then bursts under the first pest to step on it and is gone.' },
  { id: 'Sunflower', name: 'Sunflower', kind: 'producer', cost: 50, hp: 300, recharge: FAST, interval: 24, firstSun: 7, sun: SUN_VALUE, detail: 'Makes 25 sun every 24s.' },
  { id: 'Pumpkin', name: 'Pumpkin', kind: 'wall', cost: 50, hp: 4000, recharge: SLOW, startCharge: 20, detail: 'Soaks a great deal of chewing. Does not attack.' },
  { id: 'Saffron', name: 'Saffron', kind: 'shooter', cost: 100, hp: 300, recharge: FAST, interval: 1.425, damage: 20, shotSpeed: 5.5, detail: 'Fires a thread down its lane.' },
  { id: 'Habanero', name: 'Habanero', kind: 'bomb', cost: 125, hp: 300, recharge: VERY_SLOW, startCharge: 35, arm: 1, blast: 1800, detail: 'One use. Bursts a moment after planting, scorching every pest in its lane, and is gone.' },
  { id: 'Cactus', name: 'Cactus', kind: 'shooter', cost: 150, hp: 300, recharge: FAST, interval: 1.425, damage: 20, shotSpeed: 6.5, pierce: 3, thorns: 25, detail: 'Spines pass through three pests. Hurts anything that bites it.' },
  { id: 'Gentian', name: 'Frost Gentian', kind: 'aura', cost: 150, hp: 600, recharge: SLOW, auraSlow: .75, frostbite: 5, detail: 'Chills its whole lane: every pest in it moves and bites a quarter slower and takes a little frostbite.' },
  { id: 'Starweaver', name: 'Starweaver', kind: 'shooter', cost: 175, hp: 300, recharge: FAST, interval: 1.425, damage: 20, shotSpeed: 5.5, slow: .5, slowDuration: 10, detail: 'Snares what it hits to half speed for 10s.' },
  { id: 'Milkcap', name: 'Milkcap', kind: 'shooter', cost: 300, hp: 300, recharge: FAST, interval: 2.9, damage: 80, shotSpeed: 3.4, splash: 1.2, detail: 'Lobs a heavy cap that bursts on impact, hurting everything close by.' },
  { id: 'Grape', name: 'Grape', kind: 'shooter', cost: 325, hp: 300, recharge: FAST, interval: 1.425, damage: 20, shotSpeed: 5.5, spread: true, detail: 'Fires down its own lane and both lanes beside it.' },
];
export const PLANT_BY_ID = new Map(PLANTS.map(plant => [plant.id, plant]));

export interface PestDef {
  id: string;
  name: string;
  /** The game pet whose art the pest wears. */
  species: string;
  /** Multiply colour for the sprite; unset draws the pet as it is. */
  tint?: number;
  /** Cycles the tint through the hue wheel. */
  rainbow?: boolean;
  hp: number;
  /** Columns crossed per second. */
  speed: number;
  /** Damage per second to whatever it is eating. */
  bite: number;
  /** Drawn size as a share of a cell. */
  size: number;
  /** Relative spawn weight; zero keeps it out of the random draw. */
  weight: number;
  /** Wave points it costs, as in PvZ, where a basic zombie is 1. */
  points: number;
  /** First wave it can turn up in. */
  from: number;
  detail: string;
  /** Extra health that soaks damage first; losing it speeds the pest up by shellBreakSpeed. */
  shell?: number;
  shellBreakSpeed?: number;
  /** Jumps clean over the first plant it meets, then walks on at this share of its speed. */
  hops?: boolean;
  hopSpeed?: number;
  /** Turns up this many at a time, strung out down one lane. */
  swarm?: number;
  /** Bursts into these pests when it dies. */
  splitInto?: { id: string; count: number };
  /** Every so often, stuns the plants just ahead of it in its lane. */
  stun?: { every: number; reach: number; duration: number };
}

/**
 * Each pest stands in for a PvZ zombie: the worm is the basic zombie, the snail a conehead, the
 * turtle a buckethead, the bunny a pole vaulter, and the Storm Wolf a gargantuar. A PvZ tile is
 * five seconds of walking for a basic zombie, and a bite is 100 damage a second.
 */
export const PESTS: PestDef[] = [
  { id: 'worm', name: 'Worm', species: 'Worm', tint: 0xf0a8a0, hp: 200, speed: .2, bite: 100, size: .34, weight: 4000, points: 1, from: 1, detail: 'Plods up the lane and chews whatever is in the way.' },
  { id: 'snail', name: 'Snail', species: 'Snail', hp: 200, shell: 370, speed: .2, bite: 100, size: .38, weight: 4000, points: 2, from: 4, detail: 'Its shell soaks the first hits.' },
  { id: 'bee', name: 'Bee', species: 'Bee', hp: 70, speed: .4, bite: 60, size: .3, weight: 2000, points: 2, from: 6, swarm: 3, detail: 'Fast and fragile, and always comes in threes.' },
  { id: 'bunny', name: 'Bunny', species: 'Bunny', hp: 340, speed: .4, bite: 100, size: .38, weight: 2000, points: 2, from: 8, hops: true, hopSpeed: .5, detail: 'Races in, hops clean over the first plant it reaches, then slows down.' },
  { id: 'bloat', name: 'Bloat Worm', species: 'Worm', rainbow: true, hp: 500, speed: .15, bite: 100, size: .5, weight: 1500, points: 3, from: 10, splitInto: { id: 'worm', count: 2 }, detail: 'Bursts into two worms when it pops.' },
  { id: 'turtle', name: 'Turtle', species: 'Turtle', hp: 200, shell: 1100, speed: .2, bite: 100, size: .5, weight: 3000, points: 4, from: 12, detail: 'Its shell takes a long time to crack.' },
  { id: 'goat', name: 'Goat', species: 'Goat', hp: 900, speed: .3, bite: 300, size: .5, weight: 1000, points: 6, from: 15, detail: 'Charges in and eats plants three times faster than anything else.' },
];
/** Leads the final wave. Never drawn at random. */
export const BOSS: PestDef = {
  id: 'stormwolf', name: 'Storm Wolf', species: 'ThunderWolf', hp: 3000, speed: .18, bite: 600, size: .78, weight: 0, points: 10, from: Infinity,
  stun: { every: 7, reach: 2.5, duration: 3 }, detail: 'Howls every few seconds, stunning the plants just ahead of it, and flattens whatever it reaches.',
};
export const ALL_PESTS = [...PESTS, BOSS];
const PEST_BY_ID = new Map(ALL_PESTS.map(pest => [pest.id, pest]));

export interface Plant {
  def: PlantDef; lane: number; column: number; hp: number; timer: number;
  /** When a mine arms or a bomb goes off, in board time. */
  armAt: number;
  stunUntil: number;
  /** 1 the moment it acts, decaying back to rest; the panel turns it into a recoil. */
  kick: number;
}
export interface Pest {
  def: PestDef; lane: number; x: number; hp: number; maxHp: number; shell: number;
  slowUntil: number; eating: Plant | null; hopped: boolean; flash: number; stunTimer: number;
  /** The wave it came with, for the early-next-wave rule. */
  wave: number;
  /** Inside a frost aura this step, so the panel can show it. */
  chilled: boolean;
}
export interface Shot {
  /** The tower that fired it, so the panel can draw each one's own projectile. */
  source: string;
  /** Where it left the tower, for drawing a lobbed shot's arc. */
  from: number;
  /** The lane of the tower that fired it: a spread shot curves out of it into its own lane. */
  fromLane: number;
  lane: number; x: number; speed: number; damage: number; slow?: number; slowDuration?: number; pierce: number; splash: number; hit: Set<Pest> }
export interface Sun { x: number; y: number; targetY: number; value: number; age: number }
export interface Can { state: 'ready' | 'running' | 'used'; x: number }

export interface BoardEvents {
  /** A burst to draw, in board units. */
  poof?(x: number, lane: number, colour: number, size: number): void;
  /** A line for the status bar. */
  say?(text: string): void;
  /** `wolves` is how many Storm Wolves lead it: one on the final wave, more on endless flag waves. */
  wave?(wave: number, huge: boolean, final: boolean, wolves: number): void;
  end?(won: boolean): void;
}

export interface BoardOptions {
  lanes: number;
  columns: number;
  /** Free towers with no recharge, for tuning. */
  dev?: boolean;
  random?: () => number;
  events?: BoardEvents;
  /** Where each lane's watering can waits, in columns (negative is into the house). */
  canHome?: number;
}

export type Board = ReturnType<typeof createBoard>;

export function createBoard(options: BoardOptions) {
  const random = options.random ?? Math.random;
  const events = options.events ?? {};
  const { lanes, columns } = options;
  const board = {
    lanes,
    columns,
    dev: Boolean(options.dev),
    time: 0,
    sun: STARTING_SUN,
    wave: 0,
    waveTimer: FIRST_WAVE_DELAY,
    /** Seconds since the current wave began, and the health it started with. */
    waveAge: 0,
    waveHealth: 0,
    /** Share of the wave's health that has to go before the next wave is brought forward. */
    earlyShare: 0,
    skyTimer: SKY_SUN_INTERVAL * .6,
    queued: [] as { def: PestDef; lane?: number }[],
    spawnTimer: 0,
    waveSize: 0,
    over: false,
    won: false,
    endless: false,
    wavesHeld: false,
    plants: [] as Plant[],
    pests: [] as Pest[],
    shots: [] as Shot[],
    suns: [] as Sun[],
    cans: Array.from({ length: lanes }, (): Can => ({ state: 'ready', x: options.canHome ?? -.5 })),
    cooldowns: new Map<string, number>(PLANTS.filter(plant => plant.startCharge).map(plant => [plant.id, plant.startCharge!])),
    step,
    place,
    dig,
    collect,
    plantAt,
    canPlant,
    seedCharge,
    spawn,
    startWave,
    keepGoing,
    isFinalWave,
  };
  if (board.dev) board.cooldowns.clear();

  function isFinalWave(wave: number): boolean {
    return !board.endless && wave === TOTAL_WAVES;
  }

  function plantAt(lane: number, column: number): Plant | undefined {
    return board.plants.find(plant => plant.lane === lane && plant.column === column);
  }

  /** Share of the packet's recharge still to go, 0 when ready. */
  function seedCharge(def: PlantDef): number {
    if (board.dev) return 0;
    return Math.max(0, board.cooldowns.get(def.id) ?? 0) / Math.max(def.recharge, def.startCharge ?? 0, 1);
  }

  function canPlant(def: PlantDef, lane: number, column: number): string | null {
    if (board.over || board.won) return 'The run is over.';
    if (lane < 0 || lane >= lanes || column < 0 || column >= columns) return 'That is off the lawn.';
    if (plantAt(lane, column)) return 'That tile is already planted.';
    if (!board.dev && board.sun < def.cost) return `Not enough sun for a ${def.name}.`;
    if (!board.dev && (board.cooldowns.get(def.id) ?? 0) > 0) return `The ${def.name} packet is still recharging.`;
    return null;
  }

  function place(id: string, lane: number, column: number): Plant | string {
    const def = PLANT_BY_ID.get(id);
    if (!def) return 'Unknown seed.';
    const problem = canPlant(def, lane, column);
    if (problem) return problem;
    if (!board.dev) {
      board.sun -= def.cost;
      board.cooldowns.set(def.id, def.recharge);
    }
    const plant: Plant = {
      def, lane, column, hp: def.hp,
      timer: def.kind === 'producer' ? def.firstSun ?? def.interval ?? 1 : def.interval ?? 0,
      armAt: board.time + (def.arm ?? 0), stunUntil: 0, kick: 0,
    };
    board.plants.push(plant);
    return plant;
  }

  function dig(lane: number, column: number): Plant | null {
    const plant = plantAt(lane, column);
    if (plant) removePlant(plant);
    return plant ?? null;
  }

  function removePlant(plant: Plant): void {
    const index = board.plants.indexOf(plant);
    if (index >= 0) board.plants.splice(index, 1);
    for (const pest of board.pests) if (pest.eating === plant) pest.eating = null;
  }

  /** Picks up the sun token nearest the point, if one is within reach. */
  function collect(x: number, y: number, reach = .45): Sun | null {
    let best: Sun | null = null;
    let bestDistance = reach;
    for (const token of board.suns) {
      const distance = Math.hypot(token.x - x, token.y - y);
      if (distance <= bestDistance) { best = token; bestDistance = distance; }
    }
    if (!best) return null;
    board.sun += best.value;
    board.suns.splice(board.suns.indexOf(best), 1);
    return best;
  }

  /** A random pest this wave can have, costing no more than the points left. */
  function weightedPest(points: number): PestDef {
    const pool = PESTS.filter(pest => board.wave >= pest.from && pest.weight > 0 && pest.points <= points);
    const total = pool.reduce((sum, pest) => sum + pest.weight, 0);
    let roll = random() * total;
    for (const pest of pool) {
      roll -= pest.weight;
      if (roll <= 0) return pest;
    }
    return pool[0] ?? PESTS[0];
  }

  /** PvZ's wave points: one more every two and a half waves, and a flag wave gets two and a half times as many. */
  function wavePoints(wave: number): number {
    const points = Math.floor(wave * .8 / 2) + 1;
    return wave % HUGE_EVERY === 0 ? Math.round(points * 2.5) : points;
  }

  /** Waves past the end of a normal run, which is what endless escalates on. */
  function overtime(wave = board.wave): number {
    return Math.max(0, wave - TOTAL_WAVES);
  }

  /** How much tougher pests are than their listed health, from nothing in a normal run upward in endless. */
  function toughness(wave = board.wave): number {
    return 1 + overtime(wave) * ENDLESS_TOUGHNESS_PER_WAVE;
  }

  function nextWaveTimer(): number {
    const pace = Math.max(ENDLESS_GAP_FLOOR, 1 - overtime() * ENDLESS_GAP_SHRINK_PER_WAVE);
    const base = (WAVE_INTERVAL_MIN + random() * (WAVE_INTERVAL_MAX - WAVE_INTERVAL_MIN)) * pace;
    return (board.wave + 1) % HUGE_EVERY === 0 ? base + HUGE_WAVE_BREAK : base;
  }

  function startWave(): void {
    board.wave++;
    const huge = board.wave % HUGE_EVERY === 0;
    const final = isFinalWave(board.wave);
    let points = wavePoints(board.wave);
    const queue: { def: PestDef; lane?: number }[] = [];
    // The final wave has one Storm Wolf in the middle lane; endless flag waves bring one more every twenty waves.
    const wolves = final ? 1 : board.endless && huge ? 1 + Math.floor(overtime() / 20) : 0;
    for (let wolf = 0; wolf < wolves; wolf++) {
      queue.push({ def: BOSS, lane: wolves === 1 ? Math.floor(lanes / 2) : Math.floor(random() * lanes) });
      points = Math.max(1, points - BOSS.points);
    }
    while (points > 0 && queue.length < 60) {
      const def = weightedPest(points);
      points -= def.points;
      const lane = Math.floor(random() * lanes);
      for (let index = 0; index < (def.swarm ?? 1); index++) queue.push({ def, lane });
    }
    // Shuffled so a wave mixes its pests; the wolves stay at the front and lead it in.
    const leaders = queue.slice(0, wolves);
    const rest = queue.slice(wolves).sort(() => random() - .5);
    queue.splice(0, queue.length, ...leaders, ...rest);
    board.queued = queue;
    board.waveSize = queue.length;
    board.waveHealth = queue.reduce((sum, entry) => sum + (entry.def.hp + (entry.def.shell ?? 0)) * toughness(), 0);
    board.waveAge = 0;
    board.earlyShare = EARLY_SHARE_MIN + random() * (EARLY_SHARE_MAX - EARLY_SHARE_MIN);
    board.spawnTimer = 0;
    board.waveTimer = nextWaveTimer();
    events.wave?.(board.wave, huge, final, wolves);
  }

  /** How much of the current wave's health is still out there, arrived or not. */
  function waveHealthLeft(): number {
    const alive = board.pests.filter(pest => pest.wave === board.wave).reduce((sum, pest) => sum + Math.max(0, pest.hp) + pest.shell, 0);
    const waiting = board.queued.reduce((sum, entry) => sum + (entry.def.hp + (entry.def.shell ?? 0)) * toughness(), 0);
    return alive + waiting;
  }

  function makePest(def: PestDef, lane: number, x: number, wave = board.wave): Pest {
    return {
      def, lane, x, hp: Math.round(def.hp * toughness(wave)), maxHp: Math.round(def.hp * toughness(wave)), shell: Math.round((def.shell ?? 0) * toughness(wave)),
      slowUntil: 0, eating: null, hopped: false, flash: 0, stunTimer: def.stun?.every ?? 0, wave, chilled: false,
    };
  }

  /** Pests walk in from a tile off the lawn, as PvZ zombies do from off-screen. */
  function spawn(def: PestDef, lane = Math.floor(random() * lanes), x = columns + 1): Pest {
    const pest = makePest(def, lane, x);
    board.pests.push(pest);
    return pest;
  }

  function keepGoing(): void {
    board.won = false;
    board.endless = true;
    board.waveTimer = nextWaveTimer();
  }

  /** `quiet` damage, like frostbite, wears a pest down without the white flash of a hit. */
  function damage(pest: Pest, amount: number, slow?: number, slowDuration?: number, quiet = false): void {
    if (pest.hp <= 0) return;
    if (!quiet) pest.flash = .1;
    if (pest.shell > 0) {
      const soaked = Math.min(pest.shell, amount);
      pest.shell -= soaked;
      amount -= soaked;
      if (pest.shell <= 0) events.poof?.(pest.x, pest.lane, 0xd6c7a1, .5);
    }
    pest.hp -= amount;
    if (slow && slowDuration) pest.slowUntil = Math.max(pest.slowUntil, board.time + slowDuration);
  }

  /** The frost plant chilling this pest's lane, once the pest is on the lawn. */
  function chillOf(pest: Pest): PlantDef | undefined {
    if (pest.x > columns) return undefined;
    return board.plants.find(plant => plant.def.kind === 'aura' && plant.lane === pest.lane)?.def;
  }

  function blast(lane: number, from: number, to: number, amount: number): void {
    for (const pest of board.pests) if (pest.lane === lane && pest.x >= from && pest.x <= to) damage(pest, amount);
  }

  function step(delta: number): void {
    if (board.over || board.won) return;
    board.time += delta;
    for (const [id, left] of board.cooldowns) board.cooldowns.set(id, Math.max(0, left - delta));

    board.skyTimer -= delta;
    if (board.skyTimer <= 0) {
      board.skyTimer = SKY_SUN_INTERVAL;
      board.suns.push({ x: .4 + random() * (columns - .8), y: -.5, targetY: .3 + random() * (lanes - .6), value: SUN_VALUE, age: 0 });
    }

    const finished = !board.endless && board.wave >= TOTAL_WAVES;
    if (!board.wavesHeld && !finished) {
      board.waveAge += delta;
      board.waveTimer -= delta;
      // Cut a wave down fast and the next one comes early - PvZ's way of keeping a strong garden busy.
      // A huge wave is never brought forward: its break is part of the warning.
      const hugeNext = (board.wave + 1) % HUGE_EVERY === 0;
      if (board.wave > 0 && !hugeNext && board.waveTimer > EARLY_DELAY && board.waveAge >= MIN_WAVE_GAP - EARLY_DELAY
        && waveHealthLeft() <= board.waveHealth * (1 - board.earlyShare)) {
        board.waveTimer = EARLY_DELAY;
      }
      if (board.waveTimer <= 0) startWave();
    }

    if (board.queued.length) {
      board.spawnTimer -= delta;
      if (board.spawnTimer <= 0) {
        const next = board.queued.shift()!;
        spawn(next.def, next.lane);
        // A wave comes in as a group, a pace or so apart, as PvZ sends its zombies.
        const swarmNext = board.queued[0]?.def === next.def && next.def.swarm;
        board.spawnTimer = swarmNext ? .6 : .8 + random() * 1.2;
      }
    }

    for (const token of board.suns) {
      if (token.y < token.targetY) token.y = Math.min(token.targetY, token.y + 1.2 * delta);
      else token.age += delta;
    }
    board.suns = board.suns.filter(token => token.age < SUN_LIFETIME);

    for (const plant of [...board.plants]) {
      plant.kick = Math.max(0, plant.kick - delta * 6);
      const def = plant.def;
      if (def.kind === 'bomb') {
        if (board.time >= plant.armAt) {
          blast(plant.lane, -1, columns + 1, def.blast ?? 0);
          events.poof?.(plant.column + .5, plant.lane, 0xf97316, columns * .5);
          removePlant(plant);
        }
        continue;
      }
      if (def.kind === 'mine') {
        if (board.time < plant.armAt) continue;
        const trigger = board.pests.find(pest => pest.lane === plant.lane && Math.abs(pest.x - (plant.column + .5)) < .5);
        if (trigger) {
          blast(plant.lane, plant.column - .3, plant.column + 1.3, def.blast ?? 0);
          events.poof?.(plant.column + .5, plant.lane, 0xc4b5fd, 1.2);
          removePlant(plant);
        }
        continue;
      }
      if (def.kind === 'wall' || def.kind === 'aura' || board.time < plant.stunUntil) continue;
      plant.timer -= delta;
      if (plant.timer > 0) continue;
      plant.timer = def.interval ?? 1;
      if (def.kind === 'producer') {
        plant.kick = 1;
        board.suns.push({ x: plant.column + .5 + (random() - .5) * .3, y: plant.lane + .1, targetY: plant.lane + .55, value: def.sun ?? SUN_VALUE, age: 0 });
        continue;
      }
      const targetLanes = def.spread ? [plant.lane - 1, plant.lane, plant.lane + 1].filter(lane => lane >= 0 && lane < lanes) : [plant.lane];
      const live = targetLanes.filter(lane => board.pests.some(pest => pest.lane === lane && pest.x > plant.column && pest.x < columns + .2));
      if (!live.length) { plant.timer = .2; continue; }
      plant.kick = 1;
      for (const lane of def.spread ? targetLanes : live) {
        board.shots.push({
          source: def.id, from: plant.column + .45, fromLane: plant.lane, lane, x: plant.column + .45, speed: def.shotSpeed ?? 5, damage: def.damage ?? 10,
          slow: def.slow, slowDuration: def.slowDuration, pierce: def.pierce ?? 1, splash: def.splash ?? 0, hit: new Set(),
        });
      }
    }

    for (const shot of board.shots) {
      shot.x += shot.speed * delta;
      for (const pest of board.pests) {
        if (pest.lane !== shot.lane || shot.hit.has(pest) || pest.hp <= 0 || Math.abs(pest.x - shot.x) > .34) continue;
        shot.hit.add(pest);
        damage(pest, shot.damage, shot.slow, shot.slowDuration);
        if (shot.splash > 0) {
          events.poof?.(pest.x, pest.lane, 0xfda4af, shot.splash * .6);
          for (const other of board.pests) {
            if (other === pest || other.lane !== shot.lane || Math.abs(other.x - pest.x) > shot.splash) continue;
            damage(other, shot.damage * .5, shot.slow, shot.slowDuration);
          }
        }
        if (shot.hit.size >= shot.pierce) break;
      }
    }
    board.shots = board.shots.filter(shot => shot.x <= columns + .6 && shot.hit.size < shot.pierce);

    for (const pest of board.pests) {
      pest.flash = Math.max(0, pest.flash - delta);
      const frost = chillOf(pest);
      pest.chilled = Boolean(frost);
      const cold = frost?.auraSlow ?? 1;
      if (frost?.frostbite) damage(pest, frost.frostbite * delta, undefined, undefined, true);
      if (pest.def.stun) {
        pest.stunTimer -= delta;
        if (pest.stunTimer <= 0) {
          pest.stunTimer = pest.def.stun.every;
          for (const plant of board.plants) {
            if (plant.lane === pest.lane && plant.column + .5 <= pest.x && plant.column + .5 >= pest.x - pest.def.stun.reach) {
              plant.stunUntil = board.time + pest.def.stun.duration;
            }
          }
          events.poof?.(pest.x, pest.lane, 0xfde047, pest.def.stun.reach);
        }
      }
      const blocker = board.plants.find(plant => plant.lane === pest.lane && plant.def.kind !== 'bomb'
        && !(plant.def.kind === 'mine' && board.time >= plant.armAt)
        && Math.abs(plant.column + .5 - pest.x) < .45);
      if (blocker && pest.def.hops && !pest.hopped) {
        pest.hopped = true;
        pest.x = blocker.column - .05;
        events.poof?.(blocker.column + .5, pest.lane, 0xffffff, .5);
        pest.eating = null;
        continue;
      }
      pest.eating = blocker ?? null;
      if (blocker) {
        blocker.hp -= pest.def.bite * delta * cold;
        if (blocker.def.thorns) damage(pest, blocker.def.thorns * delta);
        continue;
      }
      const cracked = pest.def.shell && pest.shell <= 0 ? pest.def.shellBreakSpeed ?? 1 : 1;
      const landed = pest.def.hops && pest.hopped ? pest.def.hopSpeed ?? 1 : 1;
      const speed = pest.def.speed * cracked * landed * (board.time < pest.slowUntil ? .5 : 1) * cold;
      pest.x -= speed * delta;
    }

    for (const [lane, can] of board.cans.entries()) {
      if (can.state === 'ready' && board.pests.some(pest => pest.lane === lane && pest.x <= 0)) {
        can.state = 'running';
        events.say?.('A watering can washed a lane clear!');
      }
      if (can.state !== 'running') continue;
      can.x += CAN_SPEED * delta;
      for (const pest of board.pests) {
        if (pest.lane !== lane || pest.hp <= 0 || pest.x > can.x + .5) continue;
        pest.hp = 0;
        pest.def = pest.def.splitInto ? { ...pest.def, splitInto: undefined } : pest.def;
        events.poof?.(pest.x, lane, 0x7dd3fc, .45);
      }
      if (can.x > columns + 1) can.state = 'used';
    }

    for (const plant of [...board.plants]) {
      if (plant.hp > 0) continue;
      events.poof?.(plant.column + .5, plant.lane, 0x86efac, .4);
      removePlant(plant);
    }
    const survivors: Pest[] = [];
    for (const pest of board.pests) {
      if (pest.hp > 0) { survivors.push(pest); continue; }
      events.poof?.(pest.x, pest.lane, pest.def.tint ?? 0xe5e7eb, pest.def.size * 1.2);
      const split = pest.def.splitInto;
      const child = split && PEST_BY_ID.get(split.id);
      if (child) {
        for (let index = 0; index < split.count; index++) survivors.push(makePest(child, pest.lane, pest.x + (index - (split.count - 1) / 2) * .35, pest.wave));
      }
    }
    board.pests = survivors;

    if (board.pests.some(pest => pest.x <= -.6 && board.cans[pest.lane]?.state !== 'running')) {
      board.over = true;
      events.end?.(false);
      return;
    }
    if (!board.endless && board.wave >= TOTAL_WAVES && !board.queued.length && !board.pests.length) {
      board.won = true;
      events.end?.(true);
    }
  }

  return board;
}
