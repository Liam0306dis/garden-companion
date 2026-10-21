/**
 * For code that runs inside the game's own calls - a getter on its frame context, a wrapper around
 * one of its methods. A throw there lands in the game's render loop, and a build that changes shape
 * would keep throwing every frame. Each guarded piece of work is named; it hands back the fallback
 * (normally the game's own value) whenever it throws, and after a few throws it stops being run at
 * all, with one warning in the console, so a future game update turns the feature off rather than
 * breaking the page.
 */

import { noteIssue, setCheck, warn } from './diagnostics.js';

const MAX_FAILURES = 3;
const failures = new Map<string, number>();

export function hookDisabled(name: string): boolean {
  return (failures.get(name) ?? 0) >= MAX_FAILURES;
}

export function guarded<T>(name: string, work: () => T, fallback: T): T {
  if (hookDisabled(name)) return fallback;
  try {
    return work();
  } catch (error) {
    const count = (failures.get(name) ?? 0) + 1;
    failures.set(name, count);
    if (count >= MAX_FAILURES) {
      warn(`${name} kept failing and has been switched off until the page is reloaded.`, error);
      setCheck(name, 'failed', 'kept failing, switched off until the page is reloaded');
    } else noteIssue('warn', `${name} failed`, error);
    return fallback;
  }
}

/** Test hook: forget past failures. */
export function resetHookFailures(): void {
  failures.clear();
}
