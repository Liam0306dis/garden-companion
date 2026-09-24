/**
 * Keeps trying something the game has not set up yet until it succeeds.
 *
 * Every hook into the game waits for a global or an atom that only exists once the game has
 * booted, and boot can take minutes: a sign-in screen, a slow Discord activity, a tab left in the
 * background. A fixed number of attempts gave up on exactly those players and left the panel with
 * no data and nothing in the console to say why, so this never stops - it only slows down, polling
 * quickly while the page is starting and settling to an occasional check after that.
 */
const FAST_INTERVAL_MS = 500;
const SLOW_INTERVAL_MS = 5_000;
const FAST_PHASE_MS = 120_000;

export function retryUntil(attempt: () => boolean, label: string): void {
  const started = Date.now();
  let warned = false;
  const run = () => {
    let done = false;
    try { done = attempt(); }
    catch (error) { console.warn(`[Garden Companion] ${label} failed while hooking into the game.`, error); }
    if (done) return;
    const waited = Date.now() - started;
    if (waited >= FAST_PHASE_MS && !warned) {
      warned = true;
      console.info(`[Garden Companion] Still waiting for the game before ${label} can start; checking every few seconds.`);
    }
    setTimeout(run, waited < FAST_PHASE_MS ? FAST_INTERVAL_MS : SLOW_INTERVAL_MS);
  };
  run();
}
