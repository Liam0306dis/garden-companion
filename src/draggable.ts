import { loadLocal, saveLocal } from './utils.js';

interface Point { left: number; top: number }

/**
 * Makes a fixed-position panel draggable and remembers where it was left. Buttons and fields inside
 * it keep working, and the panel is kept on screen so a saved position from a larger window cannot
 * strand it out of view.
 */
export function makeDraggable(element: HTMLElement, storageKey: string): void {
  function place(point: Point): void {
    const rect = element.getBoundingClientRect();
    const left = Math.min(Math.max(0, point.left), Math.max(0, window.innerWidth - rect.width));
    const top = Math.min(Math.max(0, point.top), Math.max(0, window.innerHeight - rect.height));
    element.style.left = `${Math.round(left)}px`;
    element.style.top = `${Math.round(top)}px`;
    element.style.right = 'auto';
    element.style.bottom = 'auto';
  }

  const saved = loadLocal<Point | null>(storageKey, null);
  if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) place(saved);

  let dragging = false;
  let startX = 0, startY = 0, originLeft = 0, originTop = 0;

  element.addEventListener('pointerdown', event => {
    // Anything interactive keeps its own behaviour, so only bare chrome starts a drag.
    if ((event.target as HTMLElement).closest('button, input, select, textarea, a, [data-no-drag]')) return;
    const rect = element.getBoundingClientRect();
    dragging = true;
    startX = event.clientX;
    startY = event.clientY;
    originLeft = rect.left;
    originTop = rect.top;
    element.dataset.dragging = 'true';
    try { element.setPointerCapture(event.pointerId); } catch {}
    event.preventDefault();
  });

  element.addEventListener('pointermove', event => {
    if (!dragging) return;
    place({ left: originLeft + event.clientX - startX, top: originTop + event.clientY - startY });
  });

  function stop(event: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    delete element.dataset.dragging;
    try { element.releasePointerCapture(event.pointerId); } catch {}
    const rect = element.getBoundingClientRect();
    saveLocal(storageKey, { left: rect.left, top: rect.top });
  }

  element.addEventListener('pointerup', stop);
  element.addEventListener('pointercancel', stop);

  window.addEventListener('resize', () => {
    if (!element.style.left) return;
    const rect = element.getBoundingClientRect();
    place({ left: rect.left, top: rect.top });
  });
}
