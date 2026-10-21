import { config, DEFAULTS, ALWAYS_ENABLED } from './config.js';
import { diagnosticsChecks, diagnosticsIssues, startedAt, type Check } from './diagnostics.js';
import { gameConnectionReady, getSequencerDiagnostics } from './game-connection.js';
import { page } from './page.js';
import { scriptVersion } from './utils.js';

/**
 * The diagnostics as one block of plain text a player can paste into a message.
 *
 * Built to be posted in public: no player id, room code, item id or page address goes in. Messages
 * and error details are written by our own code but can quote what they were handed, so ids that
 * slip in are blanked here rather than trusted not to.
 */

/** The game build, from the /version/<n>/ every one of its script and style urls carries. */
export function gameBuild(): string {
  for (const element of Array.from(document.querySelectorAll<HTMLScriptElement | HTMLLinkElement>('script[src], link[href]'))) {
    const match = ('src' in element ? element.src : element.href).match(/\/version\/([^/]+)\//);
    if (match) return match[1];
  }
  return 'unknown';
}

function browserName(): string {
  const agent = navigator.userAgent;
  const named = agent.match(/(Edg|OPR|Firefox|Chrome|Safari)\/(\d+)/);
  const browser = named ? `${({ Edg: 'Edge', OPR: 'Opera' } as Record<string, string>)[named[1]] ?? named[1]} ${named[2]}` : 'unknown browser';
  const system = /Windows/.test(agent) ? 'Windows' : /Android/.test(agent) ? 'Android' : /iPhone|iPad/.test(agent) ? 'iOS' : /Mac OS X/.test(agent) ? 'macOS' : /Linux/.test(agent) ? 'Linux' : 'unknown system';
  return `${browser}, ${system}`;
}

function scriptManager(): string {
  try {
    const info = GM_info as unknown as { scriptHandler?: string; version?: string };
    return [info.scriptHandler ?? 'unknown manager', info.version].filter(Boolean).join(' ');
  } catch { return 'unknown manager'; }
}

/** Other mods that share the page, by the marks each one leaves on it. */
export function otherMods(): string[] {
  const found: string[] = [];
  const marks = page as unknown as Record<string, unknown>;
  const socketSend = (marks.WebSocket as { prototype?: Record<string, unknown> } | undefined)?.prototype;
  if (marks.AriesMod || socketSend?.__qwsSendPatched || marks.__tmMessageHookInstalled) found.push('AriesMod');
  if (marks.__QPM_PIXI_HOOKS_ACTIVE__ || marks.__QPM_HOOKS_INJECTED__ || marks.QPM) found.push('QPM');
  if (marks.starweaver) found.push('Starweaver');
  return found;
}

/** How long ago, in the one format the tab and the report both use. */
export function timeAgo(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
}

function uptime(): string {
  const minutes = Math.round((Date.now() - startedAt) / 60_000);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Ids and addresses blanked out, so a report can be posted where anyone can read it. */
export function scrub(text: string): string {
  return text
    .replace(/\bu_[A-Za-z0-9]{6,}\b/g, 'u_…')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/https?:\/\/[^\s)'"]+/g, url => url.replace(/[?#].*$/, '').replace(/\/r\/[^/\s]+/, '/r/<room>'));
}

/** Features switched on beyond the ones that cannot be turned off, so the report says what was running. */
function enabledFeatures(): string[] {
  const settings = config as unknown as Record<string, unknown>;
  return Object.keys(DEFAULTS).filter(key => typeof (DEFAULTS as unknown as Record<string, unknown>)[key] === 'boolean' && !ALWAYS_ENABLED.has(key) && settings[key] === true);
}

const STATUS_ORDER: Record<Check['status'], number> = { failed: 0, waiting: 1, ok: 2 };

export function sortedChecks(): Check[] {
  return diagnosticsChecks().sort((left, right) => STATUS_ORDER[left.status] - STATUS_ORDER[right.status] || left.name.localeCompare(right.name));
}

export function buildReport(): string {
  const checks = sortedChecks();
  const problems = checks.filter(check => check.status !== 'ok');
  const working = checks.filter(check => check.status === 'ok');
  const sequencer = getSequencerDiagnostics() as Record<string, unknown>;
  const discord = location.hostname.includes('discord');
  const mods = otherMods();
  const lines = [
    'Garden Companion diagnostics',
    `Version ${scriptVersion()} | game build ${gameBuild()} | ${browserName()} | ${scriptManager()} | ${discord ? 'Discord' : 'web'} | running ${uptime()}`,
    `Other mods: ${mods.length ? mods.join(', ') : 'none detected'}`,
    // The counter is -1 until a Welcome (or the first command) seeds it, which is "not started", not a number.
    `Connection: ${gameConnectionReady() ? 'ready' : 'not ready'} | commands: ${Number(sequencer.sequence) < 0 ? 'numbering not started yet' : `next ${sequencer.sequence}, server at ${sequencer.frontier}`}, resyncs ${sequencer.heals}, catch-ups ${sequencer.forwardJumps}`,
    '',
    problems.length ? `Problems (${problems.length}):` : 'Problems: none',
    ...problems.map(check => `  ${check.status.toUpperCase().padEnd(7)} ${check.name}${check.detail ? ` - ${check.detail}` : ''} (${timeAgo(check.at)})`),
    `Working (${working.length}): ${working.map(check => check.name).join(', ') || 'nothing yet'}`,
    '',
    `Features on: ${enabledFeatures().join(', ') || 'only the built-in ones'}`,
    '',
  ];
  const issues = diagnosticsIssues().reverse();
  lines.push(issues.length ? `Recent warnings and errors (${issues.length}, newest first):` : 'Recent warnings and errors: none');
  for (const issue of issues) {
    lines.push(`  ${timeAgo(issue.at).padEnd(8)} ${issue.level.padEnd(5)} ${issue.message}${issue.count > 1 ? ` (x${issue.count})` : ''}`);
    if (issue.detail) lines.push(`           ${issue.detail}`);
  }
  return scrub(lines.join('\n'));
}
