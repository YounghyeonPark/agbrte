/**
 * Watching the screen of the machine a session runs on (DESIGN.md §12.1, §3.3, §3.5).
 *
 * §12.1 named three kinds of capture and shipped two. This is the third — a grab
 * of a real or virtual display — and it exists because a forwarded port (§6.8)
 * reaches a *listener* and a headless browser shot reaches a *URL*, while an agent
 * that opened an installer, a GUI test or the app it just built put something on a
 * desktop that neither of those can see.
 *
 * ## What this checkout can and cannot prove
 *
 * It cannot prove a capture. There is no X server here, no cookie, no GNOME
 * session, and the decoder and the `xwd` driver have their own unit tests against
 * built dumps (`tests/xwd.test.ts`, `tests/display.test.ts`). What only an end to
 * end run can show is that the path exists at all — renderer to preload to IPC to
 * fleet to the session socket to the host — and that the four states a person
 * actually meets render as four different things rather than as one empty box.
 *
 * The first of those needs no doctoring, and it is the most valuable assertion
 * here: **a Windows host genuinely has no X display**, so opening the pane against
 * the real local host runs the whole stack and comes back with the truth. If any
 * layer of the wiring were missing, that test fails.
 *
 * The other three are doctored at the IPC, because what is under test is what the
 * pane does with an answer — and a real display would make this a test of somebody
 * having remembered to log in.
 */

import { expect, test, type Page } from '@playwright/test';
import { launch, makeRepo, type LaunchedApp } from './harness.js';
import { addAgent, createSession, pretendRemote } from './actions.js';

/**
 * A real 4×3 PNG in the interface's accent colour.
 *
 * Real rather than a plausible string: an `<img>` with a broken `src` still
 * renders an element, so a fake would let a test pass on a base64 blob the browser
 * refused to decode. `naturalWidth` below is the browser saying it parsed it.
 */
const FRAME =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAYAAAC09K7GAAAAEklEQVR4nGO42aT9HxkzEBQAAAK4Hj2Gmre3AAAAAElFTkSuQmCC';

const row = (page: Page) => page.locator('[data-testid=screen-row]');
const toggle = (page: Page) => page.locator('[data-testid=toggle-screen]');

/** Answer `display.list` and `display.grab` with whatever the test needs. */
async function doctorDisplays(
  agbrte: LaunchedApp,
  answer: { tool: string | null; displays: Array<Record<string, unknown>>; wayland?: string[] },
  frame?: Record<string, unknown>,
): Promise<void> {
  await agbrte.app.evaluate(
    async ({ ipcMain }, given) => {
      ipcMain.removeHandler('agbrte:display.list');
      ipcMain.handle('agbrte:display.list', async () => given.answer);
      ipcMain.removeHandler('agbrte:display.grab');
      ipcMain.handle('agbrte:display.grab', async () => {
        if (given.frame === undefined) throw new Error('no frame in this test');
        return given.frame;
      });
    },
    { answer, frame },
  );
}

test.describe('the screen of that machine', () => {
  test('a local session is not offered it, since it is already on screen', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      const page = agbrte.window;
      await createSession(page, 'local work');
      await addAgent(page, 'echo');

      /*
       * The rule `Ports` follows, with a sharper version of its own reason: a
       * local session's screen is the screen this window is drawn on. A control
       * offering to fetch it would be a control that does nothing visible, which
       * is how people learn a feature does nothing.
       */
      await expect(toggle(page)).toHaveCount(0);
      await expect(row(page)).toHaveCount(0);
      // The neighbouring controls are untouched.
      await expect(page.locator('[data-testid=toggle-files]')).toBeVisible();
    } finally {
      await agbrte.close();
    }
  });

  test('reaches the host and reports a machine with no X display', async () => {
    /*
     * The one assertion here that goes all the way down, and the reason it can:
     * this machine really has no `/tmp/.X11-unix`. So the answer on screen was
     * computed by the host, over the session socket, through every layer added
     * for this feature — and a missing handler, an unregistered channel or a
     * command the host does not know fails right here.
     *
     * The message is asserted too, not just its absence of a picture. "No
     * display" on its own is a dead end; naming the thing that does work turns it
     * into a next step (§3.3).
     */
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      const page = agbrte.window;
      await pretendRemote(agbrte);
      await createSession(page, 'looking');
      await addAgent(page, 'echo');

      /*
       * Its label is not the composer's, and this is a regression rather than a
       * preference.
       *
       * It shipped as `Screen` for an afternoon, which put it about ten
       * centimetres from `composer-capture` — also `Screen`, and the control that
       * attaches a picture of *your* screen to the message. One word for "send
       * mine" and "watch theirs", on one row. Pressing the wrong one opens a
       * capture picker instead of a remote desktop, so the two are pinned as
       * different words here.
       */
      await expect(toggle(page)).toHaveText('Display');
      const capture = page.locator('[data-testid=composer-capture]');
      if ((await capture.count()) > 0) {
        expect(await capture.innerText()).not.toBe(await toggle(page).innerText());
      }

      // Closed by default, like `Ports`: this one costs a whole frame off a
      // machine several times a second, so it is never open uninvited.
      await expect(row(page)).toHaveCount(0);
      await toggle(page).click();

      await expect(row(page)).toBeVisible();
      const none = page.locator('[data-testid=screen-none]');
      await expect(none).toBeVisible({ timeout: 20_000 });
      await expect(none).toContainText('no X display');
      // The answer that does work on such a machine, named rather than implied.
      await expect(none).toContainText('5900');
      // And nothing pretends to be a picture.
      await expect(page.locator('[data-testid=screen-frame]')).toHaveCount(0);
      /*
       * The assertion that makes the one above mean something.
       *
       * A first version of this pane rendered a *failed* question as "no X
       * display", so this test would have passed on an IPC that threw — which is
       * precisely the wiring it exists to prove. Three states, three renderings:
       * asking, could-not-ask, and a machine that really has none.
       */
      await expect(page.locator('[data-testid=screen-error]')).toHaveCount(0);
      await expect(page.locator('[data-testid=screen-failed]')).toHaveCount(0);
    } finally {
      await agbrte.close();
    }
  });

  test('shows a frame, and says what the far screen really is', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      const page = agbrte.window;
      await pretendRemote(agbrte);
      await doctorDisplays(
        agbrte,
        { tool: '/usr/bin/xwd', displays: [{ display: ':1', width: 2944, height: 1080 }] },
        {
          display: ':1',
          png: FRAME,
          width: 1280,
          height: 470,
          sourceWidth: 2944,
          sourceHeight: 1080,
          tookMs: 310,
        },
      );
      await createSession(page, 'watching');
      await addAgent(page, 'echo');
      await toggle(page).click();

      const frame = page.locator('[data-testid=screen-frame]');
      await expect(frame).toBeVisible({ timeout: 20_000 });
      await expect(frame).toHaveAttribute('data-display', ':1');
      /*
       * The browser decoded it. An `<img>` whose `src` is rubbish is still a
       * visible element, so `toBeVisible` alone would pass on a base64 string the
       * page threw away — this is the picture actually being there.
       */
      await expect
        /*
         * Read off the element by name rather than through a DOM type: this
         * project's node tsconfig has no `dom` lib, which is correct — a spec is
         * compiled here and the callback runs in the page.
         */
        .poll(() => frame.evaluate((el) => (el as unknown as { naturalWidth: number }).naturalWidth))
        .toBe(4);

      /*
       * The honest part, on screen. `xwd` has no damage tracking, so every frame
       * is the whole screen and this runs at a few frames a second — a viewer
       * that said nothing would read as broken, and somebody would go looking for
       * a bug that is a measurement. The source size is here for the same reason:
       * a 1280px frame of a 2944px desktop otherwise looks like a small monitor.
       */
      const rate = page.locator('[data-testid=screen-rate]');
      await expect(rate).toContainText('2944×1080');
      await expect(rate).toContainText('310ms');

      // Pausing stops asking. The frame stays on screen — a blank pane would
      // throw away the thing somebody paused in order to look at.
      await page.locator('[data-testid=screen-live]').click();
      await expect(page.locator('[data-testid=screen-live]')).toHaveText('Watch');
      await expect(frame).toBeVisible();
    } finally {
      await agbrte.close();
    }
  });

  test('warns that a Wayland machine will probably be black, and still offers it', async () => {
    /*
     * The gap this feature shipped with. `xwd` reads an X display, and under a
     * Wayland session that is XWayland — whose root is not the compositor's
     * output, so the grab comes back black while the desktop is plainly there on
     * the monitor. A picture of nothing with nothing explaining it is the worst
     * failure a viewer has.
     *
     * Said before the frame rather than after, and **not** a refusal: some
     * compositors do put something on the XWayland root, the host cannot know
     * which, and hiding the display on a guess would withhold a view that might
     * have worked (§3.3).
     */
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      const page = agbrte.window;
      await pretendRemote(agbrte);
      await doctorDisplays(
        agbrte,
        {
          tool: '/usr/bin/xwd',
          displays: [{ display: ':0', width: 1920, height: 1080 }],
          wayland: ['1000/wayland-0'],
        },
        {
          display: ':0', png: FRAME, width: 1280, height: 720,
          sourceWidth: 1920, sourceHeight: 1080, tookMs: 120,
        },
      );
      await createSession(page, 'wayland box');
      await addAgent(page, 'echo');
      await toggle(page).click();

      const warned = page.locator('[data-testid=screen-wayland]');
      await expect(warned).toBeVisible({ timeout: 20_000 });
      await expect(warned).toContainText('XWayland');

      // Offered anyway: the display is listed and the control works.
      await expect(page.locator('[data-testid=screen-live]')).toBeEnabled();
      await expect(page.locator('[data-testid=screen-frame]')).toBeVisible();
    } finally {
      await agbrte.close();
    }
  });

  test('offers a display it cannot read, and says why, without pretending', async () => {
    /*
     * The two rules that pull in opposite directions, both honoured in one row.
     * A display whose X cookie the host does not hold is a real screen on that
     * machine with a fixable problem: dropping it would answer "there is no
     * screen" (§3.3), and offering it as ready would be a control that fails on
     * press (§3.5). So it is listed, disabled, and the reason is on screen.
     *
     * `tool: null` is here too, and it is the case an empty list would have got
     * most wrong — there *is* a screen over there, and what is missing is one
     * package on the host.
     */
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      const page = agbrte.window;
      await pretendRemote(agbrte);
      await doctorDisplays(agbrte, {
        tool: null,
        displays: [{ display: ':1001', unreachable: ':1001 did not authorise this user' }],
      });
      await createSession(page, 'refused');
      await addAgent(page, 'echo');
      await toggle(page).click();

      const missing = page.locator('[data-testid=screen-no-tool]');
      await expect(missing).toBeVisible({ timeout: 20_000 });
      // The fix, named. Without it somebody goes looking at their X server.
      await expect(missing).toContainText('x11-apps');

      // Listed rather than hidden, and not offered as something that works.
      const option = page.locator('[data-testid=screen-pick] option[value=":1001"]');
      await expect(option).toHaveCount(1);
      await expect(option).toBeDisabled();
      await expect(option).toContainText('cannot be read');

      // And nothing can be pressed to watch a screen nothing can read.
      await expect(page.locator('[data-testid=screen-live]')).toBeDisabled();
      await expect(page.locator('[data-testid=screen-frame]')).toHaveCount(0);
    } finally {
      await agbrte.close();
    }
  });
});
