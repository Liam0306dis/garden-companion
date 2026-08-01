let toastTimer: ReturnType<typeof setTimeout> | undefined;

/** Brief status message in the corner. A new message replaces whatever is showing. */
export function toast(message: string, tone = ''): void {
  let element = document.getElementById('gc-toast');
  if (!element) {
    element = document.createElement('div');
    element.id = 'gc-toast';
    document.documentElement.appendChild(element);
  }
  element.textContent = message;
  element.dataset.tone = tone;
  element.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('is-visible'), 2600);
}
