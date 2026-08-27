/**
 * Fetching the recording, and saying out loud that it is one (§7).
 *
 * The half of the demo that needs a document. `replay.ts` holds the other half —
 * the fold from a recorded log to the object the app talks to — and the split is
 * not tidiness: this file cannot be unit tested without a DOM, and that one is
 * where all the decisions worth pinning down live. `hostAddress.ts` and
 * `askForHost.ts` are divided along the same line for the same reason.
 */

import { replay, type Link, type Recording } from './replay.js';

/** Where the site keeps it. Same origin, so `connect-src 'self'` permits it. */
const RECORDING_URL = './recording.json';

/**
 * A standing reminder that none of this is live.
 *
 * The demo is convincing on purpose, which is exactly what makes an unmarked one
 * dishonest — somebody who believes they are looking at their own machine is
 * being misled by the thing that was supposed to introduce them to it. It is a
 * corner pill rather than a bar across the top because the app owns its layout
 * and a demo has no business reflowing it; and it is dismissible because a
 * person who has understood the point should not have to keep reading it.
 */
function banner(): void {
  const pill = document.createElement('div');
  pill.id = 'agbrte-demo-pill';
  Object.assign(pill.style, {
    position: 'fixed',
    left: '0.75rem',
    bottom: '0.75rem',
    zIndex: '2147483646',
    display: 'flex',
    alignItems: 'center',
    gap: '0.6rem',
    padding: '0.45rem 0.7rem',
    borderRadius: '999px',
    border: '1px solid #3a3a3a',
    background: 'rgba(20,20,20,0.92)',
    color: '#d8d8d8',
    font: '13px/1.3 system-ui, -apple-system, Segoe UI, sans-serif',
    boxShadow: '0 4px 16px rgba(0,0,0,0.45)',
    maxWidth: 'calc(100vw - 1.5rem)',
  } satisfies Partial<CSSStyleDeclaration>);

  const text = document.createElement('span');
  text.textContent = 'A recording — nothing is running';

  const get = document.createElement('a');
  get.href = 'https://github.com/YounghyeonPark/agbrte/releases/latest';
  get.textContent = 'Get it';
  get.rel = 'noreferrer';
  Object.assign(get.style, { color: '#8ab4ff', whiteSpace: 'nowrap' });

  const close = document.createElement('button');
  close.textContent = '×';
  close.setAttribute('aria-label', 'dismiss');
  Object.assign(close.style, {
    border: 'none',
    background: 'transparent',
    color: '#8a8a8a',
    font: 'inherit',
    fontSize: '15px',
    cursor: 'pointer',
    padding: '0',
    lineHeight: '1',
  } satisfies Partial<CSSStyleDeclaration>);
  close.addEventListener('click', () => pill.remove());

  pill.append(text, get, close);
  const mount = (): void => void document.body.append(pill);
  if (document.body !== null) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
}

/**
 * Fetch the recording and hand back a link that replays it.
 *
 * Throws when there is no recording to fetch — a published copy always has one
 * beside it, but a page served by `agbrte web` does not, and neither does a
 * developer's `dist/renderer` opened from disk. The caller shows the reason on
 * the screen it is already standing on rather than replacing it with a blank.
 */
export async function startDemo(): Promise<Link> {
  const response = await fetch(RECORDING_URL);
  if (!response.ok) throw new Error(`no recording here (${response.status})`);
  const recording = (await response.json()) as Recording;
  banner();
  return replay(recording);
}

export type { Link } from './replay.js';
