/**
 * The transparent overlay you drag a rectangle on (DESIGN.md §12.1).
 *
 * > A transparent, always-on-top, click-through-until-armed overlay handles
 * > region selection.
 *
 * One window per display, because a single window spanning the virtual screen
 * cannot be transparent-and-clickable on every platform and gets the DPI wrong
 * the moment two monitors differ. N windows also make the coordinate story
 * simple: each one covers exactly one display, so a drag inside it is already in
 * that display's space, and `region.ts` does one conversion.
 *
 * ## The page is injected, not loaded
 *
 * `executeJavaScript` resolves with the value of the promise the script returns,
 * so the whole interaction — markup, styling, listeners, and the answer — is one
 * expression the main process awaits. The alternative was a preload script and
 * an IPC channel for a window that lives for three seconds, or a build entry for
 * a second HTML page that then has to be found again after packaging. Neither
 * buys anything a `Promise` does not.
 *
 * ## Click-through until it is on screen
 *
 * The overlay is created ignoring mouse events and stops when it is actually
 * shown. This is not ceremony: the click that opened the picker is still in
 * flight when the window is constructed, and an armed overlay would read that
 * mouse-up as the end of a zero-pixel drag. `MIN_SELECTION_PX` catches that too,
 * but as an error message rather than as nothing happening — and nothing
 * happening is the right response to a click that was never meant for you.
 *
 * ## Nothing here is exercised by a test
 *
 * It needs a compositor, and the CI for this project does not have one. The
 * parts that can go wrong silently — the coordinate arithmetic — are in
 * `region.ts` and are tested there. What is left is window construction and
 * listener wiring, which fails loudly the first time anybody uses it.
 */

import { BrowserWindow, screen } from 'electron';
import {
  firstAnswer,
  resolveSelection,
  type DisplayInfo,
  type ResolvedRegion,
  type Selection,
} from './region.js';

/**
 * The overlay, as one expression.
 *
 * Returns the drag in this window's own CSS pixels, or `null` for Escape and
 * right-click. Both are cancels: Escape is the keyboard one and right-click is
 * what a hand reaches for when a selection has gone wrong, and treating the
 * second as a selection would capture whatever the user was trying to escape.
 */
const OVERLAY = (displayId: number): string => `
new Promise((resolve) => {
  const d = document;
  d.body.style.cssText =
    'margin:0;height:100vh;cursor:crosshair;background:rgba(0,0,0,0.28);' +
    'user-select:none;overflow:hidden';

  const box = d.createElement('div');
  box.style.cssText =
    'position:fixed;border:1px solid #7aa2f7;background:rgba(122,162,247,0.18);' +
    'display:none;pointer-events:none';
  d.body.appendChild(box);

  const hint = d.createElement('div');
  hint.textContent = 'Drag to choose a region  ·  Esc to cancel';
  hint.style.cssText =
    'position:fixed;top:16px;left:50%;transform:translateX(-50%);color:#e6e6ef;' +
    'font:12px system-ui,sans-serif;background:rgba(0,0,0,0.6);padding:6px 12px;' +
    'border-radius:4px;pointer-events:none';
  d.body.appendChild(hint);

  let start = null;
  const done = (value) => { d.body.style.display = 'none'; resolve(value); };

  d.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return done(null);
    start = { x: e.clientX, y: e.clientY };
    hint.style.display = 'none';
    box.style.display = 'block';
  });

  d.addEventListener('mousemove', (e) => {
    if (start === null) return;
    box.style.left = Math.min(start.x, e.clientX) + 'px';
    box.style.top = Math.min(start.y, e.clientY) + 'px';
    box.style.width = Math.abs(e.clientX - start.x) + 'px';
    box.style.height = Math.abs(e.clientY - start.y) + 'px';
  });

  d.addEventListener('mouseup', (e) => {
    if (start === null) return;
    done({
      displayId: ${displayId},
      x: start.x, y: start.y,
      w: e.clientX - start.x, h: e.clientY - start.y,
    });
  });

  d.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(null); });
  window.focus();
});
`;

function toInfo(display: Electron.Display): DisplayInfo {
  return { id: display.id, bounds: display.bounds, scaleFactor: display.scaleFactor };
}

/**
 * Show the overlay and wait for a rectangle.
 *
 * `null` when the user cancelled, which is an ordinary outcome and not an
 * error — opening the overlay and changing your mind is a thing people do, and
 * a thrown exception there would surface as a red banner for a decision.
 */
export async function selectRegion(): Promise<ResolvedRegion | null> {
  const displays = screen.getAllDisplays();
  const windows: BrowserWindow[] = [];

  try {
    const races = displays.map(async (display) => {
      const win = new BrowserWindow({
        ...display.bounds,
        transparent: true,
        frame: false,
        // `alwaysOnTop` alone is not enough on macOS, where a fullscreen app
        // lives on its own Space — `screen-saver` is the level that floats above
        // one, and a region selector that cannot cover what you are looking at
        // is a region selector for the wrong screen.
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        movable: false,
        hasShadow: false,
        enableLargerThanScreen: true,
        show: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true },
      });
      windows.push(win);
      win.setAlwaysOnTop(true, 'screen-saver');
      // Click-through until it is actually on screen, so the mouse-up that
      // opened the picker cannot land here as a zero-pixel drag.
      win.setIgnoreMouseEvents(true);

      await win.loadURL('about:blank');
      win.show();
      win.setIgnoreMouseEvents(false);
      win.focus();

      const selection = (await win.webContents.executeJavaScript(
        OVERLAY(display.id),
        // `userGesture`: some platforms gate focus changes on one, and the
        // overlay asks for focus so Escape reaches it.
        true,
      )) as Selection | null;
      return selection;
    });

    const selection = await firstAnswer(races);
    if (selection === null) return null;

    return resolveSelection(displays.map(toInfo), selection);
  } finally {
    // Whatever happened, including a throw from the arithmetic. An overlay left
    // behind is a transparent always-on-top window covering the user's screen,
    // which is the worst failure mode this file has.
    for (const win of windows) if (!win.isDestroyed()) win.destroy();
  }
}
