import { page } from './page.js';

/**
 * What the companion knows about its own health, kept where a player can see it and pass it on.
 *
 * Almost everything that goes wrong here goes wrong quietly by design - a hook that cannot find the
 * game waits instead of throwing, a guarded piece of work switches itself off - and the only record
 * used to be a console line nobody reporting a problem knows to look for. Two kinds of record are
 * kept: checks, the current state of each named piece (connected, still waiting, switched off), and
 * issues, the warnings and errors raised along the way, newest last.
 *
 * This file imports nothing but the page, so the lowest-level helpers (retry, safe-hook) can report
 * into it without a cycle. The report that reads it all back is built in diagnostics-report.ts.
 */

export type CheckStatus = 'ok' | 'waiting' | 'failed';

export interface Check { name: string; status: CheckStatus; detail: string | null; at: number }

export interface Issue { at: number; level: 'warn' | 'error'; message: string; detail: string | null; count: number }

/** When the script started, for the report's uptime and each issue's age. */
export const startedAt = Date.now();

const checks = new Map<string, Check>();
const issues: Issue[] = [];
/** Enough to show what led up to a problem; a repeating one is counted on its entry rather than added again. */
const ISSUE_LIMIT = 40;
const listeners = new Set<() => void>();
let notifyQueued = false;
let alertExpiry: ReturnType<typeof setTimeout> | 0 = 0;

/** Listeners hear about a burst of changes once, after it, rather than once per change. */
function notify(): void {
  if (notifyQueued) return;
  notifyQueued = true;
  queueMicrotask(() => {
    notifyQueued = false;
    for (const listener of listeners) {
      try { listener(); } catch { /* a broken listener must not stop the rest */ }
    }
  });
}

export function onDiagnosticsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setCheck(name: string, status: CheckStatus, detail: string | null = null): void {
  const previous = checks.get(name);
  if (previous && previous.status === status && previous.detail === detail) return;
  checks.set(name, { name, status, detail, at: Date.now() });
  notify();
}

/** One line for an error: its name and message, plus the frame it was thrown from when there is one. */
export function describeError(error: unknown): string | null {
  if (error === undefined || error === null) return null;
  if (error instanceof Error || (typeof error === 'object' && 'message' in (error as object))) {
    const { name, message, stack } = error as Error;
    const frame = topFrame(stack);
    return `${name || 'Error'}: ${message}${frame ? ` (${frame})` : ''}`;
  }
  try { return JSON.stringify(error).slice(0, 300); } catch { return String(error).slice(0, 300); }
}

export function noteIssue(level: Issue['level'], message: string, error?: unknown): void {
  const detail = describeError(error);
  const existing = issues.findIndex(issue => issue.message === message && issue.detail === detail);
  if (existing !== -1) {
    const [issue] = issues.splice(existing, 1);
    issue.count += 1;
    issue.at = Date.now();
    issues.push(issue);
  } else {
    issues.push({ at: Date.now(), level, message, detail, count: 1 });
    if (issues.length > ISSUE_LIMIT) issues.shift();
  }
  notify();
  // Told again once the error has aged out of the alert, so the dot comes down on its own. One timer,
  // pushed back by each new error: an error repeating every frame must not queue one per repeat.
  if (level === 'error') {
    if (alertExpiry) clearTimeout(alertExpiry);
    alertExpiry = setTimeout(() => { alertExpiry = 0; notify(); }, ERROR_ALERT_MS + 1000);
  }
}

/** console.warn under the companion's name, also kept for the report. */
export function warn(message: string, error?: unknown): void {
  if (error === undefined) console.warn(`[Garden Companion] ${message}`);
  else console.warn(`[Garden Companion] ${message}`, error);
  noteIssue('warn', message, error);
}

export function diagnosticsChecks(): Check[] {
  return [...checks.values()];
}

export function diagnosticsIssues(): Issue[] {
  return [...issues];
}

/**
 * How long an error keeps the alert up. A piece that has failed stays failed and keeps it up for as
 * long as it is; an error is an event, and a one-off from an hour ago should not leave the dot on
 * for the rest of the session, training everyone to ignore it.
 */
const ERROR_ALERT_MS = 5 * 60_000;

/** Whether anything is worth the player's attention: a piece that failed, or an error raised recently. */
export function diagnosticsAlert(): boolean {
  const recent = Date.now() - ERROR_ALERT_MS;
  return [...checks.values()].some(check => check.status === 'failed') || issues.some(issue => issue.level === 'error' && issue.at > recent);
}

/**
 * Errors thrown out of our own code, wherever they surface. Ours run inside the game's calls too (a
 * wrapped method, an event handler), so they reach the page's error event rather than a catch of
 * ours; and code that runs in the userscript's own sandbox reaches the sandbox's window instead, so
 * both are listened on.
 *
 * They are told apart by where they were thrown - the file, or the top frame of the stack - which
 * the userscript manager names after the script. Only the top frame counts: the game's and other
 * mods' errors pass through our wrappers too (a wrapped draw, the socket send), and their stacks
 * name us further down without the error being ours. Everyone else's errors are left alone.
 */
const OWN_SCRIPT = /garden(?:%20|[\s_-])?companion/i;

/**
 * A stack frame as Chromium ("at fn (url:1:2)") and Firefox ("fn@url:1:2") write them, so the
 * message line Chromium puts first is never mistaken for one, whatever it says.
 */
const FRAME = /^at\s|@.+:\d+:\d+$/;

function topFrame(stack: unknown): string | null {
  if (typeof stack !== 'string') return null;
  return stack.split('\n').map(line => line.trim()).find(line => FRAME.test(line)) ?? null;
}

function thrownByUs(filename: unknown, error: unknown): boolean {
  const frame = topFrame((error as Error | undefined)?.stack);
  return (typeof filename === 'string' && filename !== '' ? OWN_SCRIPT.test(filename) : false) || (frame !== null && OWN_SCRIPT.test(frame));
}

export function installErrorCapture(): void {
  const targets = new Set<EventTarget>([page, window]);
  for (const target of targets) {
    try {
      target.addEventListener('error', event => {
        const { error, filename, message } = event as ErrorEvent;
        if (thrownByUs(filename, error)) noteIssue('error', message || 'An error was thrown', error);
      });
      target.addEventListener('unhandledrejection', event => {
        const reason = (event as PromiseRejectionEvent).reason;
        if (thrownByUs(null, reason)) noteIssue('error', 'A promise was rejected and nothing handled it', reason);
      });
    } catch { /* a window we cannot listen on just reports less */ }
  }
  // The sprite loader runs in the page, as its own bundle, so it reports through the page instead.
  page.__gardenCompanionNoteIssue = (level: Issue['level'], message: string, error?: unknown) => noteIssue(level === 'error' ? 'error' : 'warn', String(message), error);
}
