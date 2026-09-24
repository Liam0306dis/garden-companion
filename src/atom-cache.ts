import type { JotaiAtom } from './types.js';
import { page } from './page.js';

/**
 * The game's registry of jotai atoms. It is a plain Map on some builds and an object holding one
 * under `cache` on others; null until the game has created it.
 */
export function atomMap(): Map<unknown, JotaiAtom> | null {
  const cache = page.jotaiAtomCache;
  if (cache instanceof Map) return cache;
  return cache?.cache ?? null;
}

/**
 * Atoms are found by debugLabel, which the game sets to a bare name. A plain endsWith would let one
 * label swallow another - lastCurrencyTransactionAtom ends with actionAtom - and which of the two
 * won would come down to Map order, so a match is either exact or a whole path segment.
 */
export function labelMatches(label: string, match: string): boolean {
  return label === match || label.endsWith(`/${match}`);
}

/** The first atom whose debugLabel matches any of `labels`, or null. */
export function findAtom(labels: string | readonly string[]): JotaiAtom | null {
  const map = atomMap();
  if (!map || typeof map.values !== 'function') return null;
  const wanted = typeof labels === 'string' ? [labels] : labels;
  for (const atom of map.values()) {
    const label = String(atom?.debugLabel ?? '');
    if (wanted.some(match => labelMatches(label, match))) return atom;
  }
  return null;
}
