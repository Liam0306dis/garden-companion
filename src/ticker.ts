/**
 * A repeating job that only runs while something needs it. Features start one when their panel
 * opens or their subject appears and stop it when that goes away, so nothing polls for a panel that
 * is closed or a feature that is switched off.
 */
export interface Ticker {
  /** Starts the job if it is not already running. Runs it once immediately. */
  start(): void;
  stop(): void;
  running(): boolean;
  /** Starts or stops to match `wanted`. */
  sync(wanted: boolean): void;
}

export function createTicker(job: () => void, intervalMs: number): Ticker {
  let timer = 0;
  const run = () => {
    try { job(); } catch (error) { console.warn('[Garden Companion] A repeating job failed.', error); }
  };
  const ticker: Ticker = {
    start() {
      if (timer) return;
      timer = window.setInterval(run, intervalMs);
      run();
    },
    stop() {
      if (!timer) return;
      window.clearInterval(timer);
      timer = 0;
    },
    running: () => timer !== 0,
    sync(wanted) { if (wanted) ticker.start(); else ticker.stop(); },
  };
  return ticker;
}
