/**
 * Plays Garden Defence headlessly with bots of different skill and reports how often each wins.
 * The target is a game a sensible player usually beats and a careless one usually does not:
 *
 *   npx tsx scripts/garden-defence-balance.ts [runs]
 *
 * The bots see only what a player sees - the board, the sun, the packets - and act on a reaction
 * delay, picking up only some of the sun, so they are a stand-in for a person rather than an
 * optimiser.
 */
import { createBoard, PLANT_BY_ID, TOTAL_WAVES, type PlantDef, type Sun } from '../src/features/garden-defence-rules.js';

interface Skill {
  name: string;
  /** Seconds between decisions. */
  reaction: number;
  /** Chance of picking up any one sun token, and how long it sits first. */
  pickup: number;
  pickupDelay: number;
  sunflowersPerLane: number;
  /** Shooters the bot wants in every lane by these waves. */
  shooterPlan: [wave: number, perLane: number][];
  /** Which extras it knows to use. */
  walls: boolean;
  bombs: boolean;
  mines: boolean;
  pines: boolean;
  /** Buys the better shooters, rather than only the cheapest. */
  upgrades: boolean;
}

const SKILLS: Skill[] = [
  {
    name: 'good', reaction: .8, pickup: .92, pickupDelay: 1.2, sunflowersPerLane: 2,
    shooterPlan: [[1, 1], [8, 2], [14, 3], [18, 4]], walls: true, bombs: true, mines: true, pines: true, upgrades: true,
  },
  {
    name: 'casual', reaction: 1.6, pickup: .75, pickupDelay: 2.5, sunflowersPerLane: 1.4,
    shooterPlan: [[1, 1], [10, 2], [16, 3]], walls: true, bombs: false, mines: false, pines: false, upgrades: true,
  },
  {
    name: 'careless', reaction: 2.5, pickup: .55, pickupDelay: 4, sunflowersPerLane: 1,
    shooterPlan: [[3, 1], [12, 2]], walls: false, bombs: false, mines: false, pines: false, upgrades: false,
  },
];

/** Seeded so a change to the rules can be measured against the same games. */
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function dps(def: PlantDef): number {
  if (def.kind !== 'shooter') return 0;
  return (def.damage ?? 0) / (def.interval ?? 1) * (def.spread ? 1 : 1) * (1 + (def.splash ?? 0) * .6) * (1 + ((def.pierce ?? 1) - 1) * .3);
}

function play(skill: Skill, seed: number): { won: boolean; wave: number } {
  const random = mulberry32(seed);
  const botRandom = mulberry32(seed ^ 0x9e3779b9);
  const board = createBoard({ lanes: 5, columns: 9, random });
  const seen = new WeakMap<Sun, { at: number; take: boolean }>();
  let nextDecision = 0;
  let opened = false;
  const dt = 1 / 30;

  const count = (lane: number, kind?: string, id?: string) => board.plants.filter(plant => plant.lane === lane
    && (!kind || plant.def.kind === kind) && (!id || plant.def.id === id)).length;
  const laneDps = (lane: number) => board.plants.reduce((sum, plant) => {
    if (plant.def.kind !== 'shooter') return sum;
    if (plant.lane === lane || (plant.def.spread && Math.abs(plant.lane - lane) === 1)) return sum + dps(plant.def);
    return sum;
  }, 0);
  const pressure = (lane: number) => board.pests.filter(pest => pest.lane === lane)
    .reduce((sum, pest) => sum + (pest.hp + pest.shell) * (1 + (board.columns - pest.x) / board.columns), 0);
  const tryPlant = (id: string, lane: number, fromColumn: number, toColumn = board.columns - 1): boolean => {
    for (let column = fromColumn; column <= toColumn; column++) {
      const result = board.place(id, lane, column);
      if (typeof result !== 'string') return true;
      if (result.includes('sun') || result.includes('recharging')) return false;
    }
    return false;
  };
  const ready = (id: string) => board.seedCharge(PLANT_BY_ID.get(id)!) === 0;
  const afford = (id: string, spare = 0) => board.sun >= PLANT_BY_ID.get(id)!.cost + spare;

  function decide(): void {
    const lanes = [...Array(board.lanes).keys()];
    // OPENER=1: before anything else, a sunflower on the back tile of every lane.
    if (process.env.OPENER === '1' && !opened) {
      const missing = lanes.filter(lane => !board.plantAt(lane, 0));
      if (!missing.length) opened = true;
      else {
        if (ready('Sunflower') && afford('Sunflower')) board.place('Sunflower', missing[0], 0);
        return;
      }
    }
    // Emergencies first: a pest about to break through gets whatever can stop it.
    for (const lane of lanes) {
      const front = board.pests.filter(pest => pest.lane === lane).sort((a, b) => a.x - b.x)[0];
      if (!front || front.x > 3) continue;
      if (skill.bombs && pressure(lane) > 1000 && ready('Habanero') && afford('Habanero') && tryPlant('Habanero', lane, 2)) return;
      if (skill.walls && ready('Pumpkin') && afford('Pumpkin') && count(lane, 'wall') === 0
        && tryPlant('Pumpkin', lane, Math.max(0, Math.floor(front.x) - 1), Math.max(0, Math.floor(front.x) - 1))) return;
    }
    const danger = (lane: number) => board.pests.some(pest => pest.lane === lane && pest.x < 4.5) && pressure(lane) > laneDps(lane) * 10;
    // A lane with a pest in it and nothing to shoot back comes before anything else.
    // Only once it is close enough to matter: a pest at the far edge is most of a minute away.
    const exposed = lanes.filter(lane => board.pests.some(pest => pest.lane === lane && pest.x < 6.5) && laneDps(lane) === 0)
      .sort((a, b) => Math.min(...board.pests.filter(pest => pest.lane === a).map(pest => pest.x)) - Math.min(...board.pests.filter(pest => pest.lane === b).map(pest => pest.x)));
    // The PvZ opener: a cheap mine in front of a lone early pest buys the time to build sunflowers.
    if (skill.mines) {
      for (const lane of lanes) {
        const front = board.pests.filter(pest => pest.lane === lane).sort((a, b) => a.x - b.x)[0];
        if (!front || laneDps(lane) > 0 || count(lane, 'mine') > 0) continue;
        const column = Math.min(7, Math.floor(front.x - front.def.speed * 16));
        if (column >= 2 && ready('Mushroom') && afford('Mushroom') && tryPlant('Mushroom', lane, column, column)) return;
      }
    }
    if (exposed.length) {
      if (ready('Saffron') && afford('Saffron') && tryPlant('Saffron', exposed[0], 2, 6)) return;
      // Nothing else is bought while a lane is open: the sun is saved for its shooter.
      if (board.sun < 100) return;
    }
    // Sunflowers, but never so far ahead of the shooters that a lane is left bare for long.
    const wantedSun = Math.round(skill.sunflowersPerLane * board.lanes);
    const sunflowers = board.plants.filter(plant => plant.def.kind === 'producer').length;
    const shootersTotal = board.plants.filter(plant => plant.def.kind === 'shooter').length;
    if (sunflowers < wantedSun && sunflowers <= shootersTotal * 2 + 3 && ready('Sunflower') && afford('Sunflower') && !lanes.some(danger)) {
      const lane = [...lanes].sort((a, b) => count(a, 'producer') - count(b, 'producer'))[0];
      if (tryPlant('Sunflower', lane, 0, 1)) return;
    }
    // Shooters: the lane most out-gunned first, then any lane short of its planned share.
    const planned = skill.shooterPlan.filter(([wave]) => board.wave + 1 >= wave).pop()?.[1] ?? 0;
    const order = [...lanes].sort((a, b) => (pressure(b) / (laneDps(b) + 5)) - (pressure(a) / (laneDps(a) + 5)));
    for (const lane of order) {
      const shooters = count(lane, 'shooter') + board.plants.filter(plant => plant.def.spread && Math.abs(plant.lane - lane) === 1).length;
      if (shooters >= planned && !danger(lane)) continue;
      const choices = !skill.upgrades ? ['Saffron']
        : board.wave >= 12 ? ['Grape', 'Starweaver', 'Cactus', 'Saffron']
        : board.wave >= 6 ? ['Starweaver', 'Cactus', 'Saffron'] : ['Saffron'];
      for (const id of choices) {
        if (id === 'Grape' && (lane === 0 || lane === board.lanes - 1)) continue;
        // Better shooters are worth a short wait for the sun, unless the lane is already in trouble.
        if (id !== 'Saffron' && !afford(id) && !danger(lane) && board.sun >= 100 && skill.upgrades) break;
        if (ready(id) && afford(id) && tryPlant(id, lane, 2, 6)) return;
      }
    }
    // Extras once the basics are in.
    if (skill.pines && board.wave >= 10) {
      const lane = lanes.find(candidate => count(candidate, 'aura') === 0 && count(candidate, 'shooter') >= 2);
      if (lane !== undefined && ready('Gentian') && afford('Gentian', 100) && tryPlant('Gentian', lane, 1, 6)) return;
    }
    if (skill.walls && board.wave >= 6) {
      const lane = lanes.find(candidate => count(candidate, 'wall') === 0 && count(candidate, 'shooter') >= 1);
      if (lane !== undefined && ready('Pumpkin') && afford('Pumpkin', 100) && tryPlant('Pumpkin', lane, 7, 8)) return;
    }
    if (skill.mines && board.wave >= 4) {
      const lane = lanes.sort((a, b) => pressure(b) - pressure(a))[0];
      if (pressure(lane) > 0 && ready('Mushroom') && afford('Mushroom', 50)) tryPlant('Mushroom', lane, 6, 8);
    }
  }

  let lastWave = 0;
  while (!board.over && !board.won && board.time < 60 * 30) {
    board.step(dt);
    if (process.env.TRACE && board.wave !== lastWave) {
      lastWave = board.wave;
      const kinds = board.plants.reduce((map, plant) => (map[plant.def.id] = (map[plant.def.id] ?? 0) + 1, map), {} as Record<string, number>);
      console.log(`  t=${board.time.toFixed(0)} wave ${board.wave} sun ${board.sun} pests ${board.pests.length} plants ${JSON.stringify(kinds)}`);
    }
    for (const token of [...board.suns]) {
      if (token.y < token.targetY) continue;
      let plan = seen.get(token);
      if (!plan) { plan = { at: board.time + skill.pickupDelay * (.5 + botRandom()), take: botRandom() < skill.pickup }; seen.set(token, plan); }
      if (plan.take && board.time >= plan.at) board.collect(token.x, token.y, .01);
    }
    if (board.time >= nextDecision) {
      nextDecision = board.time + skill.reaction;
      decide();
    }
  }
  if (process.env.TRACE) {
    const breach = board.pests.filter(pest => pest.x <= 0).map(pest => `${pest.def.id}@lane${pest.lane}`);
    console.log(`  end: ${board.won ? 'won' : 'lost'} wave ${board.wave} breach ${breach.join(',')} cans ${board.cans.map(can => can.state[0]).join('')}`);
  }
  return { won: board.won, wave: board.wave };
}

const runs = Number(process.argv[2]) || 200;
for (const skill of SKILLS) {
  let wins = 0;
  const reached = new Array(TOTAL_WAVES + 1).fill(0);
  for (let seed = 1; seed <= runs; seed++) {
    const result = play(skill, seed * 7919);
    if (result.won) wins++;
    reached[result.wave]++;
  }
  const lost = reached.map((count, wave) => count ? `w${wave}:${count}` : '').filter(Boolean).join(' ');
  console.log(`${skill.name.padEnd(9)} wins ${(wins / runs * 100).toFixed(0).padStart(3)}%   waves reached ${lost}`);
}
