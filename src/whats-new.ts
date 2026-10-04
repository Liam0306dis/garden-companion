import { escapeHtml, scriptVersion } from './utils.js';

/**
 * The "What's new" popover behind the version number in the companion's footer. Only the latest few
 * changelog entries are built into the script (see scripts/build.ts); the full history stays in the
 * repository's changelog.txt.
 */

const SEEN_KEY = 'gardenCompanion.whatsNewSeen.v1';

function seenVersion(): string | null {
  try { return localStorage.getItem(SEEN_KEY); } catch { return null; }
}

function markSeen(): void {
  try { localStorage.setItem(SEEN_KEY, scriptVersion()); } catch {}
}

/**
 * Whether this version's notes have yet to be opened. A fresh install has nothing it was updated
 * from, so it starts out seen rather than greeting a new player with a dot about changes they never
 * knew the before of.
 */
export function whatsNewUnseen(): boolean {
  const seen = seenVersion();
  if (seen === null) {
    markSeen();
    return false;
  }
  return seen !== scriptVersion();
}

function close(): void {
  document.getElementById('gc-whats-new')?.remove();
  document.removeEventListener('pointerdown', closeOnOutside, true);
  document.removeEventListener('keydown', closeOnEscape, true);
}

function closeOnOutside(event: PointerEvent): void {
  const target = event.target as HTMLElement | null;
  if (target?.closest('#gc-whats-new, [data-whats-new]')) return;
  close();
}

function closeOnEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  event.stopPropagation();
  close();
}

/** Opens the notes, or closes them when already open, and counts this version as seen. */
export function toggleWhatsNew(): void {
  if (document.getElementById('gc-whats-new')) {
    close();
    return;
  }
  markSeen();
  const entries = __CHANGELOG__.map(entry => `<section><h4>v${escapeHtml(entry.version)}${entry.version === scriptVersion() ? '<span>Current</span>' : ''}</h4><ul>${entry.notes.map(note => `<li>${escapeHtml(note)}</li>`).join('')}</ul></section>`).join('');
  const popover = document.createElement('div');
  popover.id = 'gc-whats-new';
  popover.dataset.gcUi = '';
  popover.innerHTML = `<header><b>What's new</b><button data-whats-new-close aria-label="Close">×</button></header><main>${entries || '<p>No release notes in this build.</p>'}</main>`;
  popover.querySelector<HTMLButtonElement>('[data-whats-new-close]')!.onclick = close;
  document.body.appendChild(popover);
  document.addEventListener('pointerdown', closeOnOutside, true);
  document.addEventListener('keydown', closeOnEscape, true);
}
