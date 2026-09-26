/**
 * The rules of a fishing fight with nothing drawn: the tiers, the species, how a hooked fish moves
 * and how the hook zone answers the reel. The panel runs a fight from here and draws it; the
 * balance script runs thousands of them against bots to check each tier is as hard as it should be.
 */

export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary' | 'mythic';

export interface RarityRule {
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

export const RARITIES: Record<Rarity, RarityRule> = {
  common: { label: 'Common', colour: '#94a3b8', weight: 48, zone: .36, speed: .65, fill: .45, drain: .25 },
  uncommon: { label: 'Uncommon', colour: '#34d399', weight: 28, zone: .32, speed: .72, fill: .42, drain: .29 },
  rare: { label: 'Rare', colour: '#38bdf8', weight: 15, zone: .28, speed: .78, fill: .38, drain: .33 },
  epic: { label: 'Epic', colour: '#a78bfa', weight: 6, zone: .24, speed: .86, fill: .34, drain: .38 },
  legendary: { label: 'Legendary', colour: '#fbbf24', weight: 2.5, zone: .21, speed: .95, fill: .3, drain: .43 },
  mythic: { label: 'Mythic', colour: '#f472b6', weight: .5, zone: .18, speed: 1.08, fill: .26, drain: .48 },
};

export const RARITY_ORDER: Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];
export const WEATHER_FISH_WEIGHT = 2;
export const WEATHER_MYTHIC_CHANCE = .015;

/**
 * Fill and drain are both scaled by this, so a fight takes longer without becoming easier or
 * harder: the share of time a tier needs the fish inside the zone is the ratio between the two,
 * which a shared multiplier leaves untouched.
 */
export const FIGHT_PACE = .35;
/** Where the bar starts, how far below empty it may go before the fish wins, and the hard cap. */
export const START_PROGRESS = .2;
export const LOSE_FLOOR = -.15;
export const REEL_LIMIT = 45000;

/**
 * Hook zone control. Friction is what makes this steerable: without it, holding accelerates without
 * bound and the zone can only ever overshoot, so the smaller a zone gets the more it oscillates
 * past the fish. With it, holding settles at a terminal speed and releasing settles at another, so
 * tapping gives every speed in between and the zone can be parked on a fish rather than flung at it.
 */
export const ZONE_LIFT = 11.5;
export const ZONE_GRAVITY = 4.9;
/** Applied per second, expressed at 60fps. About a 0.14s time constant. */
export const ZONE_FRICTION = .89;
/**
 * How hard a fish swims toward the spot it has picked. This is the real difficulty dial: a fish
 * that crosses the track faster than the zone can follow cannot be caught by playing well, only by
 * waiting for it to swim into a zone that happens to be parked.
 */
export const FISH_PULL = 4.5;
/** Rate that friction sheds velocity, used to state the resulting terminal speeds on the bench. */
export const ZONE_DRAG = -Math.log(ZONE_FRICTION) * 60;

/**
 * The fish speed the zone's own numbers were tuned against. Fixed rather than read from a tier, so
 * that retuning a tier's speed cannot quietly slow down every zone in the game.
 */
export const SPEED_BASELINE = .55;

/**
 * How much faster the zone gets on a faster tier. Deliberately softened rather than matched: the
 * control needs to keep pace with the fish, but making it as twitchy as the fish costs more in
 * precision against a small zone than it gains in reach.
 */
export function zoneAgility(speed: number): number {
  return 1 + (speed / SPEED_BASELINE - 1) * .6;
}

/**
 * How fast a tier's fish actually travels, in track fractions per second, once its own drag has
 * balanced the pull. Quoted for a fish half a track from where it is heading. This is the number
 * that has to stay under the zone's lift speed for a tier to be beatable by playing well.
 */
export function fishTravelSpeed(speed: number): number {
  return .5 * FISH_PULL * speed / (-Math.log(.93) * 60) * 1.6;
}

export type FightStyle = 'steady' | 'darter' | 'sinker' | 'glider' | 'leaper';

/**
 * How a species moves on the track, layered over its tier's speed. Pull scales how hard it swims
 * at its chosen spot and pause scales how long it keeps that spot, so a tier's difficulty stays in
 * the same neighbourhood while each fish reads differently.
 */
export const FIGHT_STYLES: Record<FightStyle, { label: string; pull: number; pause: number }> = {
  steady: { label: 'Steady', pull: 1, pause: 1 },
  darter: { label: 'Darter', pull: 1.15, pause: .55 },
  sinker: { label: 'Sinker', pull: .9, pause: 1.15 },
  glider: { label: 'Glider', pull: .72, pause: 1.9 },
  leaper: { label: 'Leaper', pull: 1, pause: 1 },
};

/** Share of a species' weight range at or above which a catch counts as a trophy. */
export const TROPHY_SHARE = .9;
export const PERFECT_BONUS = 1.5;
export const TROPHY_BONUS = 1.25;

export interface FishDef {
  id: string;
  name: string;
  rarity: Rarity;
  style: FightStyle;
  /** Weight range in kilograms. */
  min: number;
  max: number;
  /** The only weather this fish bites in. Unset means it bites in any weather. */
  weather?: string;
  note: string;
}

/** Entirely invented - none of these exist in the game. */
export const FISH: FishDef[] = [
  { id: 'pondMinnow', name: 'Pond Minnow', rarity: 'common', style: 'darter', min: .1, max: .6, note: 'Travels in crowds and panics alone.' },
  { id: 'muddyBream', name: 'Muddy Bream', rarity: 'common', style: 'sinker', min: .4, max: 1.8, note: 'Tastes of the bottom it never leaves.' },
  { id: 'reedPerch', name: 'Reed Perch', rarity: 'common', style: 'darter', min: .3, max: 1.4, note: 'Hides in the shallows, strikes at anything.' },
  { id: 'gardenGuppy', name: 'Garden Guppy', rarity: 'common', style: 'steady', min: .1, max: .4, note: 'Somehow always in the watering can.' },
  { id: 'rainSilverfin', name: 'Rain Silverfin', rarity: 'common', style: 'leaper', min: .2, max: 1.1, weather: 'Rain', note: 'Rises the moment the first drop lands.' },
  { id: 'copperCarp', name: 'Copper Carp', rarity: 'uncommon', style: 'sinker', min: 1.2, max: 4.5, note: 'Old enough to have opinions about lures.' },
  { id: 'speckledTrout', name: 'Speckled Trout', rarity: 'uncommon', style: 'darter', min: .8, max: 3.2, note: 'Fast, fussy, worth the trouble.' },
  { id: 'glassEel', name: 'Glass Eel', rarity: 'uncommon', style: 'darter', min: .5, max: 2.4, note: 'You can read the riverbed through it.' },
  { id: 'mossBass', name: 'Moss Bass', rarity: 'uncommon', style: 'steady', min: 1.5, max: 5, note: 'Wears its pond like a coat.' },
  { id: 'puddlePike', name: 'Puddle Pike', rarity: 'uncommon', style: 'leaper', min: 1.8, max: 6, weather: 'Rain', note: 'Appears in water far too small for it.' },
  { id: 'moonscaleKoi', name: 'Moonscale Koi', rarity: 'rare', style: 'glider', min: 3, max: 9, note: 'Every scale holds a slightly different moon.' },
  { id: 'brambleRay', name: 'Bramble Ray', rarity: 'rare', style: 'glider', min: 4, max: 12, note: 'Glides like a thrown blanket.' },
  { id: 'ironjawCatfish', name: 'Ironjaw Catfish', rarity: 'rare', style: 'sinker', min: 6, max: 16, note: 'Has taken three hooks and kept them.' },
  { id: 'lanternCod', name: 'Lantern Cod', rarity: 'rare', style: 'steady', min: 3.5, max: 11, weather: 'Dawn', note: 'Carries its own small sunrise.' },
  { id: 'chillbackChar', name: 'Chillback Char', rarity: 'rare', style: 'steady', min: 2.5, max: 8, weather: 'Frost', note: 'Warm to the touch, strangely.' },
  { id: 'amberfinTench', name: 'Amberfin Tench', rarity: 'rare', style: 'sinker', min: 3, max: 10, weather: 'AmberMoon', note: 'Slow, heavy, and the colour of old honey.' },
  { id: 'staticShiner', name: 'Static Shiner', rarity: 'rare', style: 'darter', min: 2, max: 7, weather: 'Thunderstorm', note: 'Sets the hairs on your arm up before you see it.' },
  { id: 'mirrorfinArowana', name: 'Mirrorfin Arowana', rarity: 'epic', style: 'glider', min: 9, max: 30, note: 'Turns without disturbing the water around it.' },
  { id: 'cloudburstSalmon', name: 'Cloudburst Salmon', rarity: 'epic', style: 'leaper', min: 10, max: 28, weather: 'Rain', note: 'Swims up the rain itself, given enough of it.' },
  { id: 'stormfinMarlin', name: 'Stormfin Marlin', rarity: 'epic', style: 'leaper', min: 12, max: 34, weather: 'Thunderstorm', note: 'Runs ahead of the weather front.' },
  { id: 'frostbellySturgeon', name: 'Frostbelly Sturgeon', rarity: 'epic', style: 'sinker', min: 15, max: 40, weather: 'Frost', note: 'Older than the pond it swims in.' },
  { id: 'dawnlitAngelfish', name: 'Dawnlit Angelfish', rarity: 'epic', style: 'glider', min: 8, max: 22, weather: 'Dawn', note: 'Only surfaces while the light is thin.' },
  { id: 'amberscaleTuna', name: 'Amberscale Tuna', rarity: 'epic', style: 'leaper', min: 18, max: 46, weather: 'AmberMoon', note: 'Set solid in colour, still very much alive.' },
  { id: 'crownscaleArapaima', name: 'Crownscale Arapaima', rarity: 'legendary', style: 'steady', min: 28, max: 82, note: 'The smaller fish follow it as if it knows the way.' },
  { id: 'thunderjawGar', name: 'Thunderjaw Gar', rarity: 'legendary', style: 'darter', min: 30, max: 75, weather: 'Thunderstorm', note: 'The bite arrives before the fish does.' },
  { id: 'glacierLeviathan', name: 'Glacier Leviathan', rarity: 'legendary', style: 'sinker', min: 40, max: 95, weather: 'Frost', note: 'Mistaken for the far bank more than once.' },
  { id: 'sunspireSerpent', name: 'Sunspire Serpent', rarity: 'legendary', style: 'glider', min: 25, max: 68, weather: 'Dawn', note: 'Coils around the light and holds it there.' },
  { id: 'harvestmoonWels', name: 'Harvestmoon Wels', rarity: 'legendary', style: 'sinker', min: 35, max: 88, weather: 'AmberMoon', note: 'Comes up once the whole pond has turned the same colour as it.' },
  { id: 'firstLightRay', name: 'First Light Ray', rarity: 'mythic', style: 'glider', min: 55, max: 165, weather: 'Dawn', note: 'Seen only in the minute the sky decides on a colour.' },
  { id: 'oldRootmouth', name: 'Old Rootmouth', rarity: 'mythic', style: 'sinker', min: 60, max: 140, weather: 'AmberMoon', note: 'The garden grew around it, not the other way round.' },
  { id: 'rainbowWhiskerfish', name: 'Rainbow Whiskerfish', rarity: 'mythic', style: 'leaper', min: 70, max: 210, note: 'Nobody agrees on what colour it actually is.' },
];

export const FISH_BY_ID = new Map(FISH.map(fish => [fish.id, fish]));

/** What the player's rod, line, tackle and level add to a fight. */
export interface Gear {
  /** Added to the hook zone's height. */
  zone: number;
  /** Multiplies progress gained while the fish is in the zone. */
  fill: number;
  /** Multiplies progress lost while it is out. */
  drain: number;
  /** Added to where the bar starts. */
  start: number;
}
export const NO_GEAR: Gear = { zone: 0, fill: 1, drain: 1, start: 0 };

export type FightResult = 'landed' | 'escaped' | 'timeout';
export type Fight = ReturnType<typeof createFight>;

/**
 * One fight, stepped by hand. Positions are track fractions where 0 is the top; holding lifts the
 * zone and letting go lets it sink. Everything is per second, so the frame rate cannot change how
 * a fight plays.
 */
export function createFight(fish: FishDef, gear: Gear = NO_GEAR, random: () => number = Math.random) {
  const rule = RARITIES[fish.rarity];
  const style = FIGHT_STYLES[fish.style];
  const start = Math.min(.5, START_PROGRESS + gear.start);
  const fight = {
    fish,
    zoneHeight: Math.min(.42, rule.zone + gear.zone),
    fishAt: .5,
    fishVelocity: 0,
    fishTarget: .5,
    /** How hard the fish swims on its current leg. */
    legPull: 1,
    retargetIn: 0,
    zoneAt: .5,
    zoneVelocity: 0,
    progress: start,
    startProgress: start,
    inside: true,
    /** Whether the fish has ever left the zone, which rules out a perfect catch. */
    slipped: false,
    elapsed: 0,
    step,
  };

  /** Picks where the fish heads next, and for how long, according to how its species fights. */
  function retarget(): void {
    let target = .06 + random() * .88;
    let pull = style.pull;
    let pause = (.32 + random() * .78 / rule.speed) * style.pause;
    if (fish.style === 'sinker') target = .06 + Math.sqrt(random()) * .88;
    else if (fish.style === 'glider') target = fight.fishAt < .5 ? .6 + random() * .34 : .06 + random() * .34;
    else if (fish.style === 'leaper' && random() < .22) {
      target = .04 + random() * .1;
      pull *= 1.6;
      pause *= .6;
    } else if (fish.style === 'darter' && random() < .3) fight.fishVelocity += (target - fight.fishAt) * 1.2;
    fight.fishTarget = target;
    fight.legPull = pull;
    fight.retargetIn = pause;
  }

  function step(delta: number, holding: boolean): FightResult | null {
    fight.elapsed += delta;
    fight.retargetIn -= delta;
    if (fight.retargetIn <= 0) retarget();
    fight.fishVelocity += (fight.fishTarget - fight.fishAt) * FISH_PULL * rule.speed * fight.legPull * delta;
    // Damping has to be per second rather than per frame, or the fish behaves differently on a
    // 144Hz screen than on a 60Hz one and no amount of tuning holds.
    fight.fishVelocity *= Math.pow(.93, delta * 60);
    fight.fishAt = Math.max(.03, Math.min(.97, fight.fishAt + fight.fishVelocity * delta * 1.6));

    // Friction caps the zone at a terminal speed instead of a hard clamp, so the control settles
    // where you hold it rather than pinning itself to the limit and overshooting.
    const agility = zoneAgility(rule.speed);
    fight.zoneVelocity += (holding ? -ZONE_LIFT : ZONE_GRAVITY) * agility * delta;
    fight.zoneVelocity *= Math.pow(ZONE_FRICTION, delta * 60);
    fight.zoneAt += fight.zoneVelocity * delta;
    const half = fight.zoneHeight / 2;
    if (fight.zoneAt < half) { fight.zoneAt = half; fight.zoneVelocity = 0; }
    if (fight.zoneAt > 1 - half) { fight.zoneAt = 1 - half; fight.zoneVelocity = 0; }

    fight.inside = Math.abs(fight.fishAt - fight.zoneAt) < half;
    if (!fight.inside) fight.slipped = true;
    fight.progress += (fight.inside ? rule.fill * gear.fill : -rule.drain * gear.drain) * FIGHT_PACE * delta;
    if (fight.progress >= 1) return 'landed';
    if (fight.progress <= LOSE_FLOOR) return 'escaped';
    if (fight.elapsed * 1000 >= REEL_LIMIT) return 'timeout';
    return null;
  }

  return fight;
}

/** What a bait does to the draw. */
export interface BaitEffect {
  rarity?: Partial<Record<Rarity, number>>;
  weatherBoost?: number;
}

function weightedPick<T>(items: T[], weight: (item: T) => number, random: () => number): T {
  const total = items.reduce((sum, item) => sum + weight(item), 0);
  let roll = random() * total;
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
export function pickFish(weather: string | null, bait?: BaitEffect, random: () => number = Math.random): FishDef {
  const eventMythics = FISH.filter(fish => fish.rarity === 'mythic' && fish.weather === weather);
  const mythicChance = WEATHER_MYTHIC_CHANCE * (bait?.weatherBoost ? 2 : 1);
  if (eventMythics.length && random() < mythicChance) {
    return eventMythics[Math.floor(random() * eventMythics.length)];
  }

  const pool = FISH.filter(fish => (!fish.weather || fish.weather === weather) && !eventMythics.includes(fish));
  const rarities = RARITY_ORDER.filter(rarity => pool.some(fish => fish.rarity === rarity));
  const rarity = weightedPick(rarities, value => RARITIES[value].weight * (bait?.rarity?.[value] ?? 1), random);
  const tier = pool.filter(fish => fish.rarity === rarity);
  return weightedPick(tier, fish => fish.weather ? WEATHER_FISH_WEIGHT * (bait?.weatherBoost ?? 1) : 1, random);
}

export const RARITY_REWARDS: Record<Rarity, { coins: number; xp: number }> = {
  common: { coins: 2, xp: 8 }, uncommon: { coins: 5, xp: 14 }, rare: { coins: 11, xp: 26 },
  epic: { coins: 25, xp: 48 }, legendary: { coins: 55, xp: 90 }, mythic: { coins: 120, xp: 165 },
};

/** Coins and XP for a catch, from 0.7x its tier's base for the lightest of its species to 1.5x for the heaviest. */
export function catchRewards(fish: FishDef, weight: number): { coins: number; xp: number } {
  const base = RARITY_REWARDS[fish.rarity];
  const weightFactor = .7 + Math.max(0, Math.min(1, (weight - fish.min) / Math.max(.01, fish.max - fish.min))) * .8;
  return { coins: Math.max(1, Math.round(base.coins * weightFactor)), xp: Math.max(1, Math.round(base.xp * weightFactor)) };
}

export type EquipmentSlot = 'rod' | 'line' | 'tackle';

export interface EquipmentDef {
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
  /** Multiplies progress lost while the fish is outside the zone. */
  drain?: number;
  bite?: number;
}

export const EQUIPMENT: EquipmentDef[] = [
  { id: 'reedRod', name: 'Reed Rod', slot: 'rod', detail: 'A dependable first rod.' },
  { id: 'oakRod', name: 'Oak Rod', slot: 'rod', detail: '+2% catch zone and +5% progress.', price: 300, zone: .02, fill: 1.05 },
  { id: 'silverRod', name: 'Silver Rod', slot: 'rod', detail: '+3% catch zone and +10% progress.', price: 1200, zone: .03, fill: 1.1 },
  { id: 'moonRod', name: 'Moon Rod', slot: 'rod', detail: '+4% catch zone and +16% progress.', price: 4000, zone: .04, fill: 1.16 },
  { id: 'braidedLine', name: 'Braided Line', slot: 'line', detail: 'Progress slips 12% slower while the fish is loose.', foundFrom: 'speckledTrout', dropChance: .1, drain: .88 },
  { id: 'silkLine', name: 'Mirror Silk Line', slot: 'line', detail: 'Progress slips 22% slower while the fish is loose.', foundFrom: 'mirrorfinArowana', dropChance: .08, drain: .78 },
  { id: 'reedFloat', name: 'Reed Float', slot: 'tackle', detail: '+300ms to set the hook.', foundFrom: 'reedPerch', dropChance: .14, bite: 300 },
  { id: 'barbedHook', name: 'Ironjaw Hook', slot: 'tackle', detail: 'Begin each fight with 7% more progress.', foundFrom: 'ironjawCatfish', dropChance: .1, start: .07 },
  { id: 'crownLure', name: 'Crownscale Lure', slot: 'tackle', detail: '+3% catch zone.', foundFrom: 'crownscaleArapaima', dropChance: .08, zone: .03 },
  { id: 'prismLure', name: 'Prismatic Lure', slot: 'tackle', detail: '+12% progress while the fish is controlled.', foundFrom: 'rainbowWhiskerfish', dropChance: .12, fill: 1.12 },
];

export const EQUIPMENT_BY_ID = new Map(EQUIPMENT.map(item => [item.id, item]));

export function fishingLevel(xp: number): { level: number; current: number; needed: number } {
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
