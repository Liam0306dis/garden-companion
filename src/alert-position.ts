import { loadLocal, saveLocal } from './utils.js';

const POSITION_KEY = 'gc-alarm-position';
/** How close to the middle a drag has to come before it snaps there. */
const SNAP_PX = 14;

/**
 * Where the alarm banner sits, as fractions of the window: x is the banner's centre, y its top
 * edge. Fractions so a spot chosen in one window size means the same spot in another, and a
 * centre because the banner is drawn centred on its left edge (translateX(-50%)).
 */
interface AlertPosition { x: number; y: number }

let editing: { finish: () => void } | null = null;

function savedPosition(): AlertPosition | null {
  const saved = loadLocal<AlertPosition | null>(POSITION_KEY, null);
  return saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) ? saved : null;
}

/** Keeps the whole banner on screen; with nothing saved it falls back to the stylesheet's top centre. */
function applyPosition(element: HTMLElement, position: AlertPosition | null): void {
  if (!position) {
    element.style.left = element.style.top = '';
    return;
  }
  const rect = element.getBoundingClientRect();
  const half = rect.width / 2;
  const centre = Math.min(Math.max(half + 4, position.x * window.innerWidth), window.innerWidth - half - 4);
  const top = Math.min(Math.max(4, position.y * window.innerHeight), window.innerHeight - rect.height - 4);
  element.style.left = `${Math.round(centre)}px`;
  element.style.top = `${Math.round(top)}px`;
}

/** Puts an alarm banner where the player chose to keep it clear of the game's own popups. */
export function placeAlarmBanner(element: HTMLElement): void {
  applyPosition(element, savedPosition());
}

function placeCurrentBanner(): void {
  const banner = document.getElementById('gc-alarm');
  if (banner) placeAlarmBanner(banner);
}

window.addEventListener('resize', placeCurrentBanner);

export function isEditingAlarmPosition(): boolean {
  return editing !== null;
}

/**
 * Lets the alarm banner be dragged until Done (or Enter/Escape). A real alarm on screen is moved
 * directly; otherwise a sample banner stands in for one. It snaps to the horizontal middle, with a
 * guide line, since that is where most people want it back.
 */
export function editAlarmPosition(onFinish?: () => void): void {
  if (editing) return;
  let banner = document.getElementById('gc-alarm');
  const sample = !banner;
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'gc-alarm';
    banner.dataset.sample = 'true';
    banner.innerHTML = '<i class="gc-alarm-icon">!</i><div><small>Sample alert</small><strong>Drag me</strong><span>Alarm banners will show here</span></div>';
    document.body.appendChild(banner);
  }
  const element = banner;
  element.dataset.editing = 'true';
  const done = document.createElement('button');
  done.type = 'button';
  done.textContent = 'Done';
  done.dataset.positionDone = 'true';
  element.appendChild(done);
  placeAlarmBanner(element);

  const guide = document.createElement('div');
  guide.id = 'gc-alarm-guide';
  document.documentElement.appendChild(guide);

  let drag: { offsetX: number; offsetY: number; pointerId: number } | null = null;

  const onDown = (event: PointerEvent) => {
    // The banner's own buttons keep working while it is being placed.
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
    const rect = element.getBoundingClientRect();
    drag = { offsetX: event.clientX - (rect.left + rect.width / 2), offsetY: event.clientY - rect.top, pointerId: event.pointerId };
    element.dataset.dragging = 'true';
    try { element.setPointerCapture(event.pointerId); } catch {}
    event.preventDefault();
  };
  const onMove = (event: PointerEvent) => {
    if (!drag) return;
    let centre = event.clientX - drag.offsetX;
    const snapped = Math.abs(centre - window.innerWidth / 2) <= SNAP_PX;
    if (snapped) centre = window.innerWidth / 2;
    guide.classList.toggle('is-visible', snapped);
    applyPosition(element, { x: centre / window.innerWidth, y: (event.clientY - drag.offsetY) / window.innerHeight });
  };
  const onUp = () => {
    if (!drag) return;
    try { element.releasePointerCapture(drag.pointerId); } catch {}
    drag = null;
    delete element.dataset.dragging;
    guide.classList.remove('is-visible');
    const rect = element.getBoundingClientRect();
    saveLocal(POSITION_KEY, { x: (rect.left + rect.width / 2) / window.innerWidth, y: rect.top / window.innerHeight });
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' && event.key !== 'Enter') return;
    event.preventDefault();
    event.stopPropagation();
    finish();
  };

  function finish(): void {
    if (!editing) return;
    editing = null;
    element.removeEventListener('pointerdown', onDown);
    element.removeEventListener('pointermove', onMove);
    element.removeEventListener('pointerup', onUp);
    element.removeEventListener('pointercancel', onUp);
    window.removeEventListener('keydown', onKey, true);
    delete element.dataset.editing;
    delete element.dataset.dragging;
    done.remove();
    guide.remove();
    if (sample) element.remove();
    onFinish?.();
  }

  element.addEventListener('pointerdown', onDown);
  element.addEventListener('pointermove', onMove);
  element.addEventListener('pointerup', onUp);
  element.addEventListener('pointercancel', onUp);
  window.addEventListener('keydown', onKey, true);
  done.onclick = finish;
  editing = { finish };
}

export function finishEditingAlarmPosition(): void {
  editing?.finish();
}

/** Puts alarm banners back at the top centre. */
export function resetAlarmPosition(): void {
  saveLocal(POSITION_KEY, null);
  placeCurrentBanner();
}
