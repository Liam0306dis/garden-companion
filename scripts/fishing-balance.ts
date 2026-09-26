/**
 * Plays fishing fights headlessly with bots of different skill and reports the catch rate and fight
 * length for every tier, bare-handed and with the best gear:
 *
 *   npx tsx scripts/fishing-balance.ts [fights per style]
 *
 * A bot sees the fish late (reaction time) and imprecisely (noise), and can only change its mind so
 * often (tapping rate), which is what separates a novice from an expert on a real mouse.
 */
import {
  catchRewards, createFight, EQUIPMENT, FISH, fishingLevel, NO_GEAR, pickFish, RARITY_ORDER, type FishDef, type FightStyle, type Gear, type Rarity,
} from '../src/features/fishing-rules.js';

interface Skill {
  name: string;
  /** Seconds between seeing the fish and acting on it. */
  latency: number;
  /** Error in judging where the fish is, as a share of the track. */
  noise: number;
  /** Seconds between decisions: how fast the player can tap. */
  decide: number;
  /** Seconds of the fish's motion the player allows for. */
  lead: number;
  /** How hard the player chases the fish: desired zone speed per unit of distance. */
  gain: number;
}

const SKILLS: Skill[] = [
  { name: 'expert', latency: .15, noise: .015, decide: .05, lead: .15, gain: 6 },
  { name: 'average', latency: .22, noise: .03, decide: .08, lead: .08, gain: 5 },
  { name: 'novice', latency: .3, noise: .05, decide: .12, lead: 0, gain: 4 },
];

/** The Moon Rod, Mirror Silk Line and Prismatic Lure at level 25: the most help a player can have. */
const BEST_GEAR: Gear = { zone: .04, fill: 1.16 * 1.12 * 1.12, drain: .78, start: 0 };

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function gaussian(random: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
}

function play(fish: FishDef, gear: Gear, skill: Skill, seed: number): { landed: boolean; seconds: number; perfect: boolean } {
  const fightRandom = mulberry32(seed);
  const eye = mulberry32(seed ^ 0x51ed27);
  const fight = createFight(fish, gear, fightRandom);
  const dt = 1 / 60;
  const history: number[] = [];
  const delay = Math.round(skill.latency / dt);
  let holding = false;
  let nextDecision = 0;
  let time = 0;
  for (;;) {
    history.push(fight.fishAt);
    if (time >= nextDecision) {
      nextDecision = time + skill.decide;
      const seen = history[Math.max(0, history.length - 1 - delay)];
      const before = history[Math.max(0, history.length - 1 - delay - 6)];
      const velocity = (seen - before) / (6 * dt);
      const guess = seen + velocity * (skill.lead + skill.latency * .5) + gaussian(eye) * skill.noise;
      // Hold when the zone is not already heading toward the fish fast enough.
      const wanted = (guess - fight.zoneAt) * skill.gain;
      holding = fight.zoneVelocity > wanted;
    }
    const result = fight.step(dt, holding);
    time += dt;
    if (result) return { landed: result === 'landed', seconds: time, perfect: !fight.slipped };
  }
}

const perStyle = Number(process.argv[2]) || 150;
const styles: FightStyle[] = ['steady', 'darter', 'sinker', 'glider', 'leaper'];
for (const [label, gear] of [['bare', NO_GEAR], ['best gear', BEST_GEAR]] as const) {
  console.log(`\n== ${label}`);
  console.log(`${'tier'.padEnd(10)}${SKILLS.map(skill => skill.name.padStart(18)).join('')}`);
  for (const rarity of RARITY_ORDER) {
    const cells = SKILLS.map(skill => {
      let landed = 0;
      let seconds = 0;
      let fights = 0;
      for (const style of styles) {
        const fish = FISH.find(candidate => candidate.rarity === rarity && candidate.style === style)
          ?? { ...FISH.find(candidate => candidate.rarity === rarity)!, style };
        for (let seed = 1; seed <= perStyle; seed++) {
          const result = play(fish, gear, skill, seed * 2654435761 + styles.indexOf(style));
          fights++;
          if (result.landed) { landed++; seconds += result.seconds; }
        }
      }
      return `${(landed / fights * 100).toFixed(0).padStart(4)}% ${(seconds / Math.max(1, landed)).toFixed(1).padStart(5)}s`;
    });
    console.log(`${rarity.padEnd(10)}${cells.map(cell => cell.padStart(18)).join('')}`);
  }
}

/**
 * A two-hour session in clear weather with no bait: the bot buys each rod as soon as it can and
 * equips any line or tackle a fish drops, so this shows how quickly the gear ladder is climbed.
 */
function session(skill: Skill, seed: number, minutes: number) {
  const random = mulberry32(seed);
  let time = 0;
  let coins = 0;
  let xp = 0;
  const owned = new Set(['reedRod']);
  const bought: Record<string, number> = {};
  const caught: Partial<Record<Rarity, number>> = {};
  let casts = 0;
  const equippedIn = (slot: string) => EQUIPMENT.filter(item => item.slot === slot && owned.has(item.id)).pop();
  while (time < minutes * 60) {
    const rod = equippedIn('rod');
    const line = equippedIn('line');
    const tackle = equippedIn('tackle');
    const level = fishingLevel(xp).level;
    const items = [rod, line, tackle].filter(Boolean) as typeof EQUIPMENT;
    const gear: Gear = {
      zone: items.reduce((sum, item) => sum + (item.zone ?? 0), 0),
      fill: items.reduce((product, item) => product * (item.fill ?? 1), 1 + Math.min(.12, (level - 1) * .005)),
      drain: items.reduce((product, item) => product * (item.drain ?? 1), 1),
      start: items.reduce((sum, item) => sum + (item.start ?? 0), 0),
    };
    // Cast, wait for the bite, strike - plus a second or two of a person looking at the result and clicking again.
    time += .36 + 1.2 + random() * 3.6 + .5 + 1 + random() * 1.5;
    const fish = pickFish(null, undefined, random);
    const result = play(fish, gear, skill, Math.floor(random() * 2 ** 31));
    time += result.seconds + 1.9;
    casts++;
    if (!result.landed) continue;
    caught[fish.rarity] = (caught[fish.rarity] ?? 0) + 1;
    const weight = fish.min + random() * (fish.max - fish.min);
    const reward = catchRewards(fish, weight);
    const bonus = result.perfect ? 1.5 : 1;
    coins += Math.round(reward.coins * bonus);
    xp += Math.round(reward.xp * bonus);
    const drop = EQUIPMENT.find(item => item.foundFrom === fish.id && !owned.has(item.id));
    if (drop && random() < (drop.dropChance ?? 0)) { owned.add(drop.id); bought[drop.id] = time; }
    for (const item of EQUIPMENT) {
      if (item.price && !owned.has(item.id) && coins >= item.price) { coins -= item.price; owned.add(item.id); bought[item.id] = time; }
    }
  }
  return { bought, caught, casts, level: fishingLevel(xp).level, coins };
}

console.log('\n== two-hour sessions (median of 21)');
for (const skill of SKILLS) {
  const runs = Array.from({ length: 21 }, (_, index) => session(skill, index * 104729 + 7, 120));
  const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const minute = (id: string) => {
    const times = runs.map(run => run.bought[id] ?? Infinity);
    const value = median(times);
    return Number.isFinite(value) ? `${(value / 60).toFixed(0)}m` : 'never';
  };
  const perHour = (rarity: Rarity) => (median(runs.map(run => run.caught[rarity] ?? 0)) / 2).toFixed(1);
  console.log(`${skill.name.padEnd(8)} oak ${minute('oakRod')}  silver ${minute('silverRod')}  moon ${minute('moonRod')}  | level ${median(runs.map(run => run.level))}  casts/h ${median(runs.map(run => run.casts)) / 2}  | per hour: ${RARITY_ORDER.map(rarity => `${rarity.slice(0, 3)} ${perHour(rarity)}`).join(' ')}`);
}
