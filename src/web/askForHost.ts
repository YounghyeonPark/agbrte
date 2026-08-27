/**
 * The screen a published copy of the app shows before it knows a host (§7).
 *
 * ## Why this asks instead of looking
 *
 * The obvious design is to probe: try `127.0.0.1:7717`, and if nothing answers,
 * say "install Agbrte". Measured against a real browser, that fails four ways
 * and each one is a wrong sentence shown to a real person.
 *
 *  - **A browser will not let a published page look quietly.** Reaching a
 *    private address needs the Local Network Access permission, so probing shows
 *    *"this site wants to access devices on your local network"* to somebody who
 *    may have nothing installed — a frightening question asked before there is
 *    any reason for it.
 *  - **The failures are indistinguishable from script.** Not installed, permission
 *    declined, bound to another port, and served over https all arrive as one
 *    opaque error. Four states, one message, three of them wrong.
 *  - **The desktop app opens no port at all.** It speaks Electron IPC, so a probe
 *    tells somebody who has Agbrte installed and running that they do not.
 *  - **A hit would not help.** The socket admits nobody without the token the
 *    host printed, and a person holding that link can open it directly — so
 *    detection cannot shorten the path it was meant to shorten.
 *
 * So the empty state is a *question*, and "you do not have a host yet" is what
 * the screen says by default rather than something it infers. Nothing can be
 * wrong about it, no permission is asked until somebody presses Connect, and the
 * failure text names all the reasons at once because the client genuinely cannot
 * tell them apart.
 *
 * ## Built with the DOM rather than with the app
 *
 * This runs *before* the renderer boots and must work when the renderer cannot —
 * it is the screen for "there is nothing to render from". Styles are set through
 * the CSSOM, which the page's `style-src` permits and which needs no stylesheet
 * of its own.
 */

import { describeAddressProblem } from './hostAddress.js';

const ROOT_ID = 'agbrte-connect';

/** Where the address is written, read back by `readAddress` on the next attempt. */
const ADDRESS_KEY = 'agbrte:host';

const style = (el: HTMLElement, css: Partial<CSSStyleDeclaration>): void => {
  Object.assign(el.style, css);
};

function field(label: string, placeholder: string): HTMLInputElement {
  const input = document.createElement('input');
  input.placeholder = placeholder;
  input.setAttribute('aria-label', label);
  input.spellcheck = false;
  style(input, {
    width: '100%',
    padding: '0.6rem 0.7rem',
    marginTop: '0.35rem',
    borderRadius: '6px',
    border: '1px solid #3a3a3a',
    background: '#161616',
    color: '#e8e8e8',
    font: 'inherit',
    boxSizing: 'border-box',
  });
  return input;
}

/**
 * Show the screen, and call `retry` once an address has been written.
 *
 * Idempotent: the reconnect loop calls this every time it finds no host, and a
 * second call must not stack a second copy on the first.
 */
export function askForHost(retry: () => void): void {
  if (document.getElementById(ROOT_ID) !== null) return;

  const root = document.createElement('div');
  root.id = ROOT_ID;
  style(root, {
    position: 'fixed',
    inset: '0',
    zIndex: '2147483647',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#0d0d0d',
    color: '#e8e8e8',
    font: '15px/1.5 system-ui, -apple-system, Segoe UI, sans-serif',
    padding: '1.5rem',
  });

  const card = document.createElement('div');
  style(card, { width: '100%', maxWidth: '30rem' });

  const title = document.createElement('h1');
  title.textContent = 'Point this at your host';
  style(title, { font: '600 1.3rem/1.3 inherit', margin: '0 0 0.5rem' });

  const lede = document.createElement('p');
  lede.textContent =
    'A session runs on a host — this machine, or a server over ssh. This page is only the ' +
    'window onto one. Paste the link it printed.';
  style(lede, { margin: '0 0 1.25rem', color: '#a8a8a8' });

  const addressInput = field('Host address', 'http://127.0.0.1:7717');
  const tokenInput = field('Token', 'the value after #t= in the printed link');

  const problem = document.createElement('p');
  style(problem, { margin: '0.75rem 0 0', color: '#ff8f6b', minHeight: '1.5em' });
  problem.setAttribute('role', 'status');

  const button = document.createElement('button');
  button.textContent = 'Connect';
  style(button, {
    marginTop: '0.9rem',
    padding: '0.6rem 1.1rem',
    borderRadius: '6px',
    border: '1px solid #4a4a4a',
    background: '#222',
    color: '#e8e8e8',
    font: 'inherit',
    cursor: 'pointer',
  });

  /**
   * A whole printed link pasted into the address field fills both.
   *
   * That link is one string, and asking somebody to split it by hand is asking
   * them to handle a credential with scissors. Pasting the whole thing is what
   * people will do, so it is what works.
   */
  const splitPastedLink = (): void => {
    const raw = addressInput.value.trim();
    const hash = raw.indexOf('#');
    if (hash < 0) return;
    const token = /[#&]t=([^&]+)/.exec(raw.slice(hash))?.[1];
    if (token !== undefined) tokenInput.value = decodeURIComponent(token);
    try {
      addressInput.value = new URL(raw.slice(0, hash)).origin;
    } catch {
      addressInput.value = raw.slice(0, hash);
    }
  };
  addressInput.addEventListener('change', splitPastedLink);
  addressInput.addEventListener('paste', () => setTimeout(splitPastedLink, 0));

  const submit = (): void => {
    splitPastedLink();
    const origin = addressInput.value.trim();
    const token = tokenInput.value.trim();
    const said = describeAddressProblem(origin, token);
    if (said !== null) {
      problem.textContent = said;
      return;
    }
    try {
      localStorage.setItem(ADDRESS_KEY, JSON.stringify({ origin, token }));
    } catch {
      problem.textContent =
        'this browser will not let the page remember anything, so the link is needed every time';
    }
    problem.textContent = 'connecting…';
    retry();
  };

  button.addEventListener('click', submit);
  for (const input of [addressInput, tokenInput]) {
    input.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') submit();
    });
  }

  const nothing = document.createElement('p');
  style(nothing, { margin: '1.75rem 0 0', color: '#a8a8a8', fontSize: '0.92rem' });
  nothing.append('No host yet? Run ');
  const code = document.createElement('code');
  code.textContent = 'agbrte web .';
  style(code, { background: '#1c1c1c', padding: '0.1rem 0.35rem', borderRadius: '4px' });
  nothing.append(code, ' where your work is — it prints the link this wants. ');
  const link = document.createElement('a');
  link.href = 'https://github.com/YounghyeonPark/agbrte#get-it';
  link.textContent = 'Install it';
  link.rel = 'noreferrer';
  style(link, { color: '#8ab4ff' });
  nothing.append(link, '.');

  card.append(title, lede, addressInput, tokenInput, problem, button, nothing);
  root.append(card);

  /*
   * There may be no `<body>` yet, and that is not an edge case.
   *
   * The shim is injected into `<head>` on purpose — the app reads
   * `window.agbrte` while it boots, and a script loaded after would be too late
   * — so this code runs before the document has a body to append to. The served
   * path never noticed, because it finds an address and never touches the DOM.
   * The published path is the first caller that does, and it would have thrown
   * on `document.body.append` of null.
   */
  const mount = (): void => {
    document.body.append(root);
    addressInput.focus();
  };
  if (document.body !== null) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
}

/**
 * Take the screen down once a socket is actually admitted.
 *
 * Not when one *opens*: a host answers, and then refuses the token. Removing it
 * at `open` would flash the app for the moment before the close, and leave the
 * person looking at an empty dashboard with no way back to the field they need
 * to correct.
 */
export function dismissAsk(): void {
  document.getElementById(ROOT_ID)?.remove();
}

/** Report a failed attempt on the screen, when it is up. */
export function reportAskFailure(): void {
  const problem = document.querySelector(`#${ROOT_ID} [role="status"]`);
  if (problem === null) return;
  /*
   * Every reason at once, because the client cannot tell them apart.
   *
   * A browser reports "not running", "permission declined", "wrong port" and
   * "wrong token" as one opaque event. Picking one to display would be right a
   * quarter of the time and would send somebody looking in the wrong place the
   * rest.
   */
  problem.textContent =
    'could not connect. The host may not be running, the address or token may be wrong, ' +
    'or the browser may have blocked a local address — check the prompt it showed.';
}
