import { serverNow } from './server-clock.js';

/**
 * The game's day/night cycle. Nothing in room state says which stage it is - the client works it out
 * from the clock (dayNight chunk: `{day:210,sunset:10,midnight:10,sunrise:10}`, phase =
 * (serverTime % cycle) / cycle, starting at sunrise), so this does the same. check-bundle compares
 * DAY_CYCLE and NIGHT_STRENGTH_BONUS against the live bundle.
 */
export type DayStage = 'sunrise' | 'day' | 'sunset' | 'midnight';

const MINUTE_MS = 60_000;
/** Minutes of each stage, in the order the cycle runs from the server epoch. */
const DAY_CYCLE: Array<[DayStage, number]> = [['sunrise', 10], ['day', 210], ['sunset', 10], ['midnight', 10]];
const CYCLE_MS = DAY_CYCLE.reduce((sum, [, minutes]) => sum + minutes, 0) * MINUTE_MS;

/** Strength a nocturnal pet gains in each stage (flora `{day:0,sunset:15,midnight:20,sunrise:10}`). */
export const NIGHT_STRENGTH_BONUS: Record<DayStage, number> = { day: 0, sunset: 15, midnight: 20, sunrise: 10 };

/**
 * Lunar events - Dawn or Amber Moon - come once a cycle and run ten minutes, starting twenty minutes
 * after night does (at sunset), so they fill sunrise exactly. Which one it is falls at random, Amber
 * Moon "twice as rare as" Dawn (the game's own NPC line). The schedule is the server's, so none of
 * this is in the bundle for check-bundle to compare.
 */
export const LUNAR_STAGE: DayStage = 'sunrise';
export const LUNAR_SHARE: Record<string, number> = { Dawn: 2 / 3, AmberMoon: 1 / 3 };

/** Minutes of a stage in the cycle, and of the whole cycle. */
export function stageMinutes(stage: DayStage): number {
  return DAY_CYCLE.find(([name]) => name === stage)?.[1] ?? 0;
}
export const CYCLE_MINUTES = CYCLE_MS / MINUTE_MS;
export const DAY_STAGES: readonly DayStage[] = DAY_CYCLE.map(([stage]) => stage);

/** The stage the client shows at `now` and how long until it ends. */
export function dayStageAt(now = serverNow()): { stage: DayStage; msLeft: number } {
  let into = ((now % CYCLE_MS) + CYCLE_MS) % CYCLE_MS;
  for (const [stage, minutes] of DAY_CYCLE) {
    const length = minutes * MINUTE_MS;
    if (into < length) return { stage, msLeft: length - into };
    into -= length;
  }
  return { stage: 'day', msLeft: 0 };
}
