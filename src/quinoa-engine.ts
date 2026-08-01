type QuinoaEngine = { getSystem?: (name: string) => Record<string, any> | undefined } | null;

let engine: QuinoaEngine = null;
const listeners = new Set<(value: QuinoaEngine) => void>();

/** The game's engine handle, captured from its own atom. Null until the game has started one. */
export function quinoaEngine(): QuinoaEngine {
  return engine;
}

/**
 * Listeners are replayed the current engine on registration, so a feature that starts up after the
 * game handed us one still hooks it rather than waiting for an engine it will never see again.
 */
export function onQuinoaEngine(listener: (value: QuinoaEngine) => void): void {
  listeners.add(listener);
  if (engine) listener(engine);
}

export function setQuinoaEngine(value: unknown): void {
  const candidate = value as QuinoaEngine;
  engine = candidate && typeof candidate.getSystem === 'function' ? candidate : null;
  for (const listener of listeners) listener(engine);
}
