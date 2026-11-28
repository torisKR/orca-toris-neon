/**
 * The one panel timer: every TICK_MS while the panel is visible it rewrites elapsed and "n초 전" text,
 * and hands back the pieces whose pose or text crossed a time boundary (15 s start, 180 s quiet, each
 * quiet minute) so only those are re-rendered. No per-frame JS: sprites animate with CSS steps().
 */
import { elapsed } from './teams.mjs';
import { agoText, sinceText } from './pixelview.mjs';

export const TICK_MS = 5000;

export function tickPixels(root, now, refresh) {
  const focused = (element) => globalThis.document?.activeElement?.contains?.(element); // a focused control's text stays stable
  const write = (element, text) => { if (!focused(element) && element.textContent !== text) element.textContent = text; };
  for (const time of root.querySelectorAll('time[data-since]')) write(time, elapsed(time.dataset.since, now));
  for (const time of root.querySelectorAll('time[data-px-since]')) write(time, sinceText(Number(time.dataset.pxSince), now));
  for (const time of root.querySelectorAll('time[data-px-ago]')) write(time, agoText(Number(time.dataset.pxAgo), now));
  const due = [...root.querySelectorAll('[data-px-until]')].filter((element) => Number(element.dataset.pxUntil) <= now);
  if (due.length) refresh(due);
}

/** Runs tick() every TICK_MS only while the document is visible; returns a stop function. */
export function startTicker(tick, { document = globalThis.document, timers = globalThis } = {}) {
  if (typeof timers.setInterval !== 'function') return () => {};
  let timer = null;
  const sync = () => {
    const visible = document?.visibilityState !== 'hidden';
    if (visible && timer === null) { tick(); timer = timers.setInterval(tick, TICK_MS); }
    else if (!visible && timer !== null) { timers.clearInterval(timer); timer = null; }
  };
  document?.addEventListener?.('visibilitychange', sync);
  sync();
  return () => { document?.removeEventListener?.('visibilitychange', sync); if (timer !== null) timers.clearInterval(timer); timer = null; };
}
