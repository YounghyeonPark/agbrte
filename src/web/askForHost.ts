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

function field(label: string, placeholder: string, mode: string): HTMLInputElement {
  const input = document.createElement('input');
  input.placeholder = placeholder;
  input.setAttribute('aria-label', label);
  input.spellcheck = false;
  /*
   * The keyboard corrections a phone applies by default, all turned off.
   *
   * This screen exists mostly *for* a phone — it is the device that has no
   * terminal to read the link from — and a phone keyboard capitalises the first
   * letter, so the address arrives as `Http://…` and the host is never reached.
   * Autocorrect is worse on the token: sixty-four hex characters are exactly the
   * shape a spellchecker feels entitled to improve, and the failure is a refused
   * handshake with nothing on screen to explain it.
   *
   * `inputmode` is the other half — `url` puts `/` and `:` on the first layer of
   * an on-screen keyboard, which is the difference between typing an address and
   * hunting for it.
   */
  input.setAttribute('autocapitalize', 'none');
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('inputmode', mode);
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

  /*
   * Two audiences, and the stranger goes first — with one line to run.
   *
   * This screen is the landing page of a published copy, so most people reading
   * it have never heard of Agbrte and none of them has a host: somebody who does
   * was handed a link, and a returning visitor has an address stored and never
   * sees this at all. A page that opens with "paste your token" is a login form
   * for a product nobody has been introduced to.
   *
   * Two earlier versions of this screen got the *order* right and the offer
   * wrong. The first explained itself and then presented two fields the majority
   * could not fill — a locked door with directions to the locksmith written on
   * it. The second put a recorded session behind a button, which did give them
   * something to look at, and looking at it was the problem: it was the real app
   * driving a file, nothing was running, and it read as staged. A demo that has
   * to be labelled "nothing here is live" is a demo arguing against itself.
   *
   * So what is first now is a command, and what it does is start the actual
   * program on the reader's own machine. It is shorter than the download it sits
   * above, it needs no account and no key, and the host it starts is the same
   * one the desktop app talks to — one per machine — so a folder open in both
   * shows one session list. Nothing here is a stand-in for the product.
   *
   * Then the download, and the fields last, for the minority who came here
   * already holding a link.
   */
  const title = document.createElement('h1');
  title.textContent = 'Agbrte';
  style(title, { font: '600 1.6rem/1.2 inherit', margin: '0 0 0.4rem' });

  const lede = document.createElement('p');
  lede.textContent =
    'Coding agents that keep working after you close the laptop. A session runs on a host — ' +
    'your machine, or a server over ssh — and this page is a window onto one, not the thing ' +
    'itself. Which is why it needs to be told where yours is.';
  style(lede, { margin: '0 0 1.25rem', color: '#a8a8a8' });

  /*
   * The command, and a button that puts it on the clipboard.
   *
   * A command somebody has to retype by hand from a phone screen onto a laptop
   * is a command most people abandon, and this one is being read on the device
   * that is *least* able to run it — that is the whole shape of the problem this
   * screen has. Copying is the affordance that survives the device change.
   *
   * `navigator.clipboard` is guarded rather than assumed: it is absent on
   * insecure origins and can be refused outright, and the fallback is the text
   * itself, which is selectable and was always the real answer.
   */
  const run = document.createElement('div');
  style(run, { margin: '0 0 1.75rem' });

  const runHead = document.createElement('h2');
  runHead.textContent = 'No host yet? One line.';
  style(runHead, { font: '600 1rem/1.3 inherit', margin: '0 0 0.5rem' });

  const COMMAND = 'npx agbrte web .';
  const row = document.createElement('div');
  style(row, { display: 'flex', gap: '0.5rem', alignItems: 'stretch' });

  const cmd = document.createElement('code');
  cmd.textContent = COMMAND;
  style(cmd, {
    flex: '1',
    background: '#161616',
    border: '1px solid #3a3a3a',
    borderRadius: '6px',
    padding: '0.6rem 0.7rem',
    font: '0.95rem/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    color: '#e8e8e8',
    overflowX: 'auto',
    whiteSpace: 'nowrap',
  } satisfies Partial<CSSStyleDeclaration>);

  const copy = document.createElement('button');
  copy.textContent = 'Copy';
  style(copy, {
    padding: '0.6rem 0.9rem',
    borderRadius: '6px',
    border: '1px solid #4a4a4a',
    background: '#222',
    color: '#e8e8e8',
    font: 'inherit',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  } satisfies Partial<CSSStyleDeclaration>);
  copy.addEventListener('click', () => {
    void navigator.clipboard
      ?.writeText(COMMAND)
      .then(() => {
        copy.textContent = 'Copied';
        setTimeout(() => (copy.textContent = 'Copy'), 1500);
      })
      .catch(() => {
        // Refused, or no clipboard on this origin. The command is right there.
        copy.textContent = 'Select it';
        setTimeout(() => (copy.textContent = 'Copy'), 1500);
      });
  });
  row.append(cmd, copy);

  /*
   * "In a project folder", said here rather than left to be discovered.
   *
   * The earlier wording was "in whatever folder you are in", which is true and
   * was the trap: a terminal opens where it opens, and on Windows the elevated
   * PowerShell shortcut opens in `C:\WINDOWS\system32`. Somebody pasted this
   * line there and got an errno. The CLI now refuses that folder by name and
   * says what to do — but a sentence here is what stops them meeting the refusal
   * at all, and the `.` is only obvious to people who already knew.
   */
  const runNote = document.createElement('p');
  runNote.textContent =
    'Run it inside a project folder — the sessions live with the code, so the folder matters. ' +
    'Needs Node 22+, nothing else. It prints a link: open that, or paste it below.';
  style(runNote, { margin: '0.5rem 0 0', color: '#8a8a8a', fontSize: '0.88rem' });

  run.append(runHead, row, runNote);

  const links = document.createElement('p');
  style(links, { margin: '0 0 1.75rem', display: 'flex', gap: '0.9rem', flexWrap: 'wrap' });
  for (const [text, href] of [
    ['Download', 'https://github.com/YounghyeonPark/agbrte/releases/latest'],
    ['The idea', 'https://agbrte.dev/idea/'],
    ['Source', 'https://github.com/YounghyeonPark/agbrte'],
  ]) {
    const a = document.createElement('a');
    a.href = href as string;
    a.textContent = text as string;
    a.rel = 'noreferrer';
    style(a, { color: '#8ab4ff' });
    links.append(a);
  }

  const already = document.createElement('h2');
  already.textContent = 'Already have a host?';
  style(already, { font: '600 1rem/1.3 inherit', margin: '0 0 0.15rem' });

  const paste = document.createElement('p');
  paste.textContent = 'Paste the whole link it printed — the token comes out of it.';
  style(paste, { margin: '0 0 0.75rem', color: '#a8a8a8', fontSize: '0.92rem' });

  const addressInput = field('Host address', 'http://127.0.0.1:7717', 'url');
  const tokenInput = field('Token', 'the value after #t= in the printed link', 'text');

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

  card.append(title, lede, run, links, already, paste, addressInput, tokenInput, problem, button);
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
