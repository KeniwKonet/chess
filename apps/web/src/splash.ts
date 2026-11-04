/**
 * The splash screen in index.html (the logo, fading while the game loads).
 * It stays up at least long enough to be seen, then fades out.
 */
const MIN_MS = 1400;

export function splashStatus(text: string) {
  const el = typeof document !== 'undefined' ? document.querySelector('#splash .splash-status') : null;
  if (el) el.textContent = text;
}

export function hideSplash() {
  const el = typeof document !== 'undefined' ? document.getElementById('splash') : null;
  if (!el || el.classList.contains('done')) return;
  const wait = Math.max(0, MIN_MS - performance.now());
  setTimeout(() => {
    el.classList.add('done');
    el.setAttribute('aria-hidden', 'true');
    setTimeout(() => el.remove(), 900);
  }, wait);
}
