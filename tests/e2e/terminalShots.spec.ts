/**
 * Screenshots of the app as it opens now — a terminal with the agent in it
 * (DESIGN.md §17 Q24) — for the landing page and the README.
 *
 * `shots.spec.ts` photographs the web client's dashboard and session view,
 * which was the first screen until 0.0.47 and is now what a phone and a browser
 * get. The desktop app opens on a terminal, so a landing page that led with the
 * dashboard was describing a program nobody downloads any more. These are taken
 * from the real Electron window, with a real model, doing the thing the tab is
 * for: a command fails, and the agent is asked about it in the same terminal.
 *
 * Tagged `@shots` and kept out of the default run for the reason that file
 * gives; written to `.shots/` and copied into `docs/shots/` by hand.
 *
 *   AGBRTE_WRITE_FIXTURES=1 npx playwright test terminalShots --grep @shots
 *
 * Skipped without `qwen2.5:7b`: an `echo:` reply is a fixture, not a picture
 * of the product, and these are only taken to be published.
 */

import { expect, test, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tempFixture } from './fixtureDirs.js';
import { launchWith, makeRepo, modelAvailable, warmModel } from './harness.js';

const OUT = resolve('.shots');
const MODEL = 'qwen2.5:7b';
const ACTIVE = '[data-testid=terminal-tab-pane][data-active=true] [data-testid=pty-screen]';

async function screen(page: Page): Promise<string> {
  return (await page.locator(ACTIVE).innerText()).replace(/\s+/g, ' ');
}

/**
 * Wait for the agent to finish, answering its permission questions with `y`.
 *
 * Finished is "the screen stopped changing", because nothing on a terminal says
 * a turn is over except the prompt coming back, and the prompt is the shell's
 * and differs per shell.
 */
async function settle(page: Page): Promise<void> {
  let last = '';
  let stillFor = 0;
  let answered = 0;
  for (let waited = 0; waited < 240_000; waited += 1000) {
    const now = await screen(page);
    const asks = now.split('allow? [y/N/a=session]').length - 1;
    if (asks > answered) {
      answered = asks;
      await page.keyboard.type('y');
      stillFor = 0;
    } else if (now === last) {
      stillFor += 1000;
      if (stillFor >= 6000) return;
    } else stillFor = 0;
    last = now;
    await page.waitForTimeout(1000);
  }
}

/** A small repository with one bug, and a test that finds it. */
async function probeRepo(): Promise<string> {
  const repo = await makeRepo(join(await tempFixture('agbrte-tshots-'), 'probe'));
  await mkdir(join(repo, 'src'), { recursive: true });
  await mkdir(join(repo, 'docs'), { recursive: true });
  await writeFile(
    join(repo, 'src', 'probe.js'),
    [
      '// Parse `key=value` lines from a probe into a Map.',
      'export function parseProbe(text) {',
      '  const out = new Map();',
      "  for (const line of text.split('\\n')) {",
      "    const [key, value] = line.split('=');",
      '    if (value !== undefined) out.set(key.trim(), value.trim());',
      '  }',
      '  return out;',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    join(repo, 'test.js'),
    [
      "import assert from 'node:assert/strict';",
      "import { parseProbe } from './src/probe.js';",
      '',
      "const probe = parseProbe('gpu=on\\nfans=2\\n');",
      // The failure in two lines rather than Node's twenty: a screenshot has
      // room for the command, the question and the answer, and not for a stack.
      'try {',
      "  assert.equal(probe.get('fans'), 2);",
      "  console.log('ok');",
      '} catch (err) {',
      "  console.error('FAIL ' + err.message.replace(/\\n+/g, ' '));",
      '  process.exitCode = 1;',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(join(repo, 'package.json'), '{ "type": "module" }\n', 'utf8');
  return repo;
}

test.describe('@shots', () => {
  test('captures the terminal the app opens on', async () => {
    test.setTimeout(900_000);
    test.skip(!(await modelAvailable(MODEL)), `needs ${MODEL} through Ollama`);
    await mkdir(OUT, { recursive: true });
    await warmModel(MODEL);

    const repo = await probeRepo();
    const agbrte = await launchWith(
      {
        ui: 'terminal',
        endpoints: {
          endpoints: [{ id: 'local', baseUrl: 'http://127.0.0.1:11434/v1' }],
          default: 'local',
        },
      },
      repo,
    );
    const w = agbrte.window;
    const cls = process.platform === 'win32' ? 'cls' : 'clear';
    const clear = async (): Promise<void> => {
      await w.locator(ACTIVE).click();
      await w.keyboard.type(cls);
      await w.keyboard.press('Enter');
      await w.waitForTimeout(800);
    };

    try {
      await agbrte.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.setSize(1200, 600),
      );
      await expect.poll(async () => await screen(w), { timeout: 60_000 }).toContain('? asks the agent once');

      // The model, from the palette's list of what this host serves.
      await w.keyboard.press('Control+Shift+P');
      await w.click('[data-testid=palette-item][data-command="agent"]');
      await w.click(`[data-testid=palette-item][data-command="seat:agbrte-harness:local:${MODEL}"]`);
      await expect(w.locator('[data-testid=palette]')).toHaveCount(0);
      // Seated before the first question: the add is a round trip to the host,
      // and a question typed during it is answered "no agent yet".
      await expect
        .poll(
          async () =>
            await w.evaluate(
              `window.agbrte.sessions.list().then((l) => l.some((s) => s.agents.some((a) => a.status !== 'retired')))`,
            ),
          { timeout: 60_000 },
        )
        .toBe(true);
      await clear();

      // A command fails, and the agent is asked about it on the next line.
      await w.locator(ACTIVE).click();
      await w.keyboard.type('node test.js');
      await w.keyboard.press('Enter');
      await expect.poll(async () => await screen(w), { timeout: 30_000 }).toContain('FAIL');
      await w.keyboard.type('?');
      await w.keyboard.type('why did that fail? open src/probe.js and point at the line');
      await w.keyboard.press('Enter');
      await settle(w);
      /*
       * Scrolled back to the command. On Windows the routing scrolls what was on
       * the screen into the history when the agent takes it (`resync`,
       * mux/session.ts), so the failure is one wheel-turn up rather than on
       * screen, and a picture of an answer without its question says nothing.
       * Typing the next command brings the view back down.
       */
      const box = await w.locator(ACTIVE).boundingBox();
      if (box !== null) await w.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let i = 0; i < 30 && !(await screen(w)).includes('node test.js'); i += 1) {
        await w.mouse.wheel(0, -40);
        await w.waitForTimeout(100);
      }
      await w.mouse.wheel(0, -40);
      await w.waitForTimeout(300);
      await w.screenshot({ path: `${OUT}/10-terminal.png` });

      // The palette: everything that is not a program.
      await w.keyboard.press('Control+Shift+P');
      await expect(w.locator('[data-testid=palette]')).toBeVisible();
      await w.waitForTimeout(400);
      await w.screenshot({ path: `${OUT}/11-palette.png` });
      await w.keyboard.press('Escape');

      // A picture in the terminal, from `agbrte show`. Drawn by a hidden window
      // of the app itself, so the chart is in the app's palette and no image
      // library is needed to make one.
      const png = await agbrte.app.evaluate(async ({ BrowserWindow }) => {
        const bars = [38, 64, 51, 88, 72, 95, 60];
        const cols = bars
          .map(
            (h, i) =>
              `<div style="display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:6px">` +
              `<div style="width:44px;height:${h * 2}px;background:${i === 5 ? '#ffff55' : '#ffffff'}"></div>` +
              `<span>n${i + 1}</span></div>`,
          )
          .join('');
        const html =
          `<body style="margin:0;overflow:hidden;background:#000a30;color:#fff;font:15px Consolas,monospace;padding:20px">` +
          `<div style="margin-bottom:14px">GPU utilisation by node, last hour (%)</div>` +
          `<div style="display:flex;gap:22px;height:220px;align-items:flex-end">${cols}</div></body>`;
        const win = new BrowserWindow({ show: false, width: 560, height: 340 });
        await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
        const image = await win.webContents.capturePage();
        win.destroy();
        return image.toPNG().toString('base64');
      });
      await writeFile(join(repo, 'gpu.png'), Buffer.from(png, 'base64'));
      await clear();
      await w.keyboard.type('agbrte show gpu.png');
      await w.keyboard.press('Enter');
      await w.waitForTimeout(4000);
      await w.screenshot({ path: `${OUT}/12-picture.png` });

      // The window asking before the agent may reach another folder.
      await clear();
      await w.keyboard.type('agbrte grant docs');
      await w.keyboard.press('Enter');
      await expect(w.locator('[data-testid=grant-dialog]')).toBeVisible({ timeout: 30_000 });
      await w.waitForTimeout(900);
      await w.screenshot({ path: `${OUT}/13-grant.png` });
      await w.click('[data-testid=grant-deny]');
    } finally {
      await agbrte.close();
    }
  });
});
