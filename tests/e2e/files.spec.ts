/**
 * The workspace file browser, driven through the real app (DESIGN.md §6.6, §7).
 *
 * End-to-end rather than a unit test, because the claims span every process and
 * are false if any one of them is wrong: a click goes renderer → preload → main
 * → the detached host → `readdir` on that machine, and the answer comes back
 * over a channel that touches neither the event log nor `ipc/eventBridge.ts`. A
 * fake anywhere in that chain would prove nothing about the part that was hard.
 *
 * Five properties, and the last three are the ones that would rot quietly:
 *
 *  - Expanding a directory is **incremental**: the root listing does not contain
 *    what is inside `src`, and clicking `src` fetches it.
 *  - Opening a file shows its contents, in a rail of its own.
 *  - **Three columns, in this order**: transcript, tree, file. Asserted on
 *    painted x-coordinates rather than on class names, because the arrangement
 *    *is* the feature — a file you cannot read beside the transcript that named
 *    it is the pane mode this replaced.
 *  - **Nothing reaches `events.jsonl`.** Byte-for-byte, before and after — a
 *    view that quietly appended would put a person's browsing in the durable
 *    record of what an agent did, and there would be nothing on screen to show
 *    it happened.
 *  - **Neither rail takes height from the transcript.** Measured rather than
 *    asserted by inspection, because the failure is visual and gradual: fixed
 *    rows in the session column must hold their height (see `SessionHeader`),
 *    and the transcript is the only child allowed to give any up. Now measured
 *    with *both* rails open, which is the arrangement that could go wrong.
 *
 * The workspace here is local, so the *remote* path — the case that motivated
 * the feature — is exercised in shape only: the same two commands, the same
 * `HostConnection`, and a host that answers about its own disk. An ssh host is
 * not reachable from this environment and is not covered here.
 */

import { expect, test, type Page } from '@playwright/test';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launch, makeRepo } from './harness.js';
import { addAgent, createSession } from './actions.js';

const MARKER = 'the-file-browser-can-see-this';

/** A repo with something worth looking at in it, including two caps to bite. */
async function repoWithFiles(): Promise<string> {
  const repo = await makeRepo();
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, 'src', 'hello.ts'), `export const greeting = '${MARKER}';\n`);
  await writeFile(join(repo, 'README.md'), '# a repo\n');

  // Over the host's 256 KiB preview cap, so the refusal is exercised against a
  // real file rather than a mocked size.
  await writeFile(join(repo, 'huge.txt'), 'x'.repeat(300 * 1024));

  // Over the host's 500-entry cap by 20, so the rail has an exact number to
  // report and the test can assert the number rather than the presence of a
  // vague "and more" row.
  await mkdir(join(repo, 'many'), { recursive: true });
  await Promise.all(
    Array.from({ length: 520 }, (_, i) =>
      writeFile(join(repo, 'many', `f${String(i).padStart(4, '0')}.txt`), 'x'),
    ),
  );
  return repo;
}

/** `events.jsonl` for the one session in this workspace, byte for byte. */
async function log(repo: string): Promise<string> {
  const sessionsDir = join(repo, '.devagents', 'sessions');
  const ids = await readdir(sessionsDir);
  return readFile(join(sessionsDir, ids[0]!, 'events.jsonl'), 'utf8');
}

/** The transcript's painted box, whose height no rail may change. */
async function transcriptBox(page: Page): Promise<{ x: number; width: number; height: number }> {
  const box = await page.locator('[data-testid=transcript]').boundingBox();
  return { x: box?.x ?? 0, width: box?.width ?? 0, height: box?.height ?? 0 };
}

/** The painted width of a rail, or 0 if it is not on screen. */
async function railBox(page: Page, testid: string): Promise<{ x: number; width: number }> {
  const box = await page.locator(`[data-testid=${testid}]`).boundingBox();
  return { x: box?.x ?? 0, width: box?.width ?? 0 };
}

/**
 * Remove the workspace, allowing for the detached host still holding it.
 *
 * The host lingers `AGBRTE_HOST_LINGER_MS` (3 s in this suite) past `app.close()`
 * before releasing its handles under `.devagents`, and Windows will not remove a
 * directory anybody has open. Same reasoning — and the same generous window — as
 * `shell.spec.ts`.
 */
async function removeRepo(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 100, retryDelay: 100 });
}

test.describe('the workspace file browser', () => {
  test('opens two rails beside the transcript, and writes nothing to the log', async () => {
    const repo = await repoWithFiles();
    const agbrte = await launch(repo);

    try {
      await createSession(agbrte.window, 'Browsing');
      await addAgent(agbrte.window, 'echo');

      const before = await log(repo);
      const closed = await transcriptBox(agbrte.window);

      await agbrte.window.click('[data-testid=toggle-files]');
      const tree = agbrte.window.locator('[data-testid=file-browser]');
      await expect(tree).toBeVisible();

      /*
       * The root listing, and what it deliberately does not contain.
       *
       * `src` is a row; `hello.ts` is not, because the host answered about one
       * directory. That absence is the incremental design — the thing that
       * makes a `node_modules` tree over ssh a click rather than a hang — and it
       * is the assertion most likely to be broken by a later "helpful" prefetch.
       */
      await expect(tree.locator('[data-testid=file-tree-dir][data-path="src"]')).toBeVisible();
      await expect(
        tree.locator('[data-testid=file-tree-file][data-path="README.md"]'),
      ).toBeVisible();
      await expect(
        tree.locator('[data-testid=file-tree-file][data-path="src/hello.ts"]'),
      ).toHaveCount(0);

      // Expanding is a second request to the host, and the child appears.
      await tree.locator('[data-testid=file-tree-dir][data-path="src"]').click();
      const file = tree.locator('[data-testid=file-tree-file][data-path="src/hello.ts"]');
      await expect(file).toBeVisible();

      // The contents, read on the machine that owns the workspace and shown in
      // the second rail.
      await file.click();
      const viewer = agbrte.window.locator('[data-testid=file-viewer]');
      await expect(viewer).toBeVisible();
      await expect(viewer.locator('[data-testid=file-viewer-path]')).toHaveText('src/hello.ts');
      await expect(viewer.locator('[data-testid=file-viewer-text]')).toContainText(MARKER);

      /*
       * The point of the whole arrangement: the transcript is **still there**.
       *
       * As a pane mode this file replaced the transcript, so reading the file
       * and reading the line that named it were alternatives. Asserted on
       * painted geometry — transcript, then tree, then file, left to right —
       * because "visible" alone would also pass for three boxes stacked on top
       * of one another.
       */
      await expect(agbrte.window.locator('[data-testid=transcript]')).toBeVisible();
      const withBoth = await transcriptBox(agbrte.window);
      const treeBox = await railBox(agbrte.window, 'file-browser');
      const viewerBox = await railBox(agbrte.window, 'file-viewer');
      expect(withBoth.x).toBeLessThan(treeBox.x);
      expect(treeBox.x).toBeLessThan(viewerBox.x);

      /*
       * And the viewer is wide enough to be worth having.
       *
       * 320px is roughly 47 monospace columns; the tree's 224 is not a width you
       * can read code at, which is the reason the file did not simply reuse the
       * tree's rail. A regression that let this collapse toward the tree width
       * would leave every assertion above passing.
       */
      expect(viewerBox.width).toBeGreaterThanOrEqual(320);
      expect(treeBox.width).toBeGreaterThan(0);

      /*
       * The mode toggle now names only what is in the main pane.
       *
       * `File` used to be a fourth entry there, reachable only after a click in
       * the tree. It is gone rather than dead, and this is the assertion that
       * notices if somebody puts it back.
       */
      await expect(agbrte.window.locator('[data-testid=show-file]')).toHaveCount(0);
      await expect(agbrte.window.locator('[data-testid=show-chat]')).toBeVisible();

      /*
       * The strongest half of this test.
       *
       * Browsing is a view. If the log gained a byte, a person reading a file
       * would be in the durable record of what an agent did — indistinguishable
       * from a tool call in an export, and impossible to explain afterwards.
       * Byte-for-byte rather than "does not contain hello.ts", because the
       * failure this guards against is any write at all.
       */
      expect(await log(repo)).toBe(before);

      /*
       * And they took no height from the transcript.
       *
       * The rails are columns *beside* the pane, so with both open the
       * transcript is narrower and exactly as tall. Measured because the
       * alternative — a fixed row added to the session's vertical stack — fails
       * silently and gradually: the roster compresses, and the first transcript
       * line paints over it.
       */
      expect(Math.abs(withBoth.height - closed.height)).toBeLessThanOrEqual(1);
      expect(withBoth.width).toBeLessThan(closed.width);

      /*
       * Each rail collapses on its own, and the width goes back to the
       * transcript rather than to the other rail.
       *
       * Closing the file first: the tree is still open afterwards, which is the
       * property two pieces of state exist for — closing what you were reading
       * must not also close what you were browsing.
       */
      await viewer.locator('[data-testid=file-viewer-close]').click();
      await expect(viewer).toHaveCount(0);
      await expect(tree).toBeVisible();
      const treeOnly = await transcriptBox(agbrte.window);
      expect(treeOnly.width).toBeGreaterThan(withBoth.width);
      expect(Math.abs(treeOnly.height - closed.height)).toBeLessThanOrEqual(1);

      // Hiding the tree gives the last of the width back, still at the same
      // height, and the transcript is exactly the box it started as.
      await tree.locator('[data-testid=file-browser-close]').click();
      await expect(tree).toHaveCount(0);
      const back = await transcriptBox(agbrte.window);
      expect(Math.abs(back.width - closed.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.height - closed.height)).toBeLessThanOrEqual(1);
    } finally {
      await agbrte.close();
      await removeRepo(repo);
    }
  });

  /**
   * The viewer rail is draggable, and it has a floor.
   *
   * Driven from the keyboard rather than with a mouse drag: the handle is the
   * same control either way, arrow keys are exact where a synthetic drag is
   * approximate, and a resizer that only answers to a pointer is one some people
   * cannot use at all — so the accessible path is the one worth pinning.
   */
  test('resizes the viewer, and refuses to go below a readable width', async () => {
    const repo = await repoWithFiles();
    const agbrte = await launch(repo);

    try {
      await createSession(agbrte.window, 'Resizing');
      await addAgent(agbrte.window, 'echo');
      await agbrte.window.click('[data-testid=toggle-files]');

      const tree = agbrte.window.locator('[data-testid=file-browser]');
      await tree.locator('[data-testid=file-tree-file][data-path="README.md"]').click();
      await expect(agbrte.window.locator('[data-testid=file-viewer-text]')).toBeVisible();

      const opened = (await railBox(agbrte.window, 'file-viewer')).width;
      const handle = agbrte.window.locator('[data-testid=file-viewer-resize]');
      await handle.focus();

      // Right narrows, 16px a press. Twelve presses ask for 192px less than the
      // 448 it opens at, which is below the floor — so the floor is what
      // answers, and the transcript gets the difference.
      for (let i = 0; i < 12; i++) await handle.press('ArrowRight');
      const narrow = await railBox(agbrte.window, 'file-viewer');
      expect(narrow.width).toBeLessThan(opened);
      expect(Math.abs(narrow.width - 320)).toBeLessThanOrEqual(1);

      // And back out again, four presses' worth, which is inside the range.
      for (let i = 0; i < 4; i++) await handle.press('ArrowLeft');
      const wider = await railBox(agbrte.window, 'file-viewer');
      expect(Math.abs(wider.width - 384)).toBeLessThanOrEqual(1);

      /*
       * The width outlives the file, which is why it is `App`'s state and not
       * the viewer's. A rail that snapped back to its default every time
       * somebody closed a file would be a control that forgets what it was told.
       */
      await agbrte.window.click('[data-testid=file-viewer-close]');
      await tree.locator('[data-testid=file-tree-file][data-path="README.md"]').click();
      await expect(agbrte.window.locator('[data-testid=file-viewer-text]')).toBeVisible();
      expect(Math.abs((await railBox(agbrte.window, 'file-viewer')).width - 384)).toBeLessThanOrEqual(
        1,
      );
    } finally {
      await agbrte.close();
      await removeRepo(repo);
    }
  });

  test('says when a cap bites, rather than truncating quietly', async () => {
    const repo = await repoWithFiles();
    const agbrte = await launch(repo);

    try {
      await createSession(agbrte.window, 'Caps');
      await addAgent(agbrte.window, 'echo');
      await agbrte.window.click('[data-testid=toggle-files]');

      const rail = agbrte.window.locator('[data-testid=file-browser]');
      const tree = rail.locator('[data-testid=file-tree]');
      await rail.locator('[data-testid=file-tree-dir][data-path="many"]').click();

      /*
       * 520 files, 500 listed, and the row says twenty.
       *
       * The number rather than "and more": a directory that stopped at 500 and
       * did not say so looks like a directory holding exactly 500 things, and
       * somebody hunting a missing file has no way to learn it was the browser
       * and not the repo.
       *
       * Reached by scrolling, because the tree is windowed — the notice sits at
       * the end of 500 rows and is not in the DOM until it is nearly on screen.
       * That is the same scroll a person makes to see the end of the folder, and
       * asserting it *after* scrolling is what proves the row survives
       * virtualization rather than being a special case rendered outside it.
       */
      // The listing has to have landed before the scroll, or the scroll is
      // against a two-row list and lands nowhere — a `toBeVisible` retry would
      // then poll forever against a viewport nobody moved again.
      await expect(
        rail.locator('[data-testid=file-tree-file][data-path="many/f0000.txt"]'),
      ).toBeVisible();
      await tree.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      const capped = rail.locator('[data-testid=file-tree-truncated]');
      await expect(capped).toBeVisible();
      await expect(capped).toContainText('20 more');
      await expect(capped).toContainText('500 per folder');

      // And the 500 rows it stands at the end of are not all in the DOM: the
      // renderer holds a window over them, which is §7's rule applied to a list
      // rather than to a log. Re-measured in the right-hand rail at 6,028 rows of
      // state / 135 elements for a fully expanded tree, against 24,097 with the
      // window taken out; the assertion here only has to catch its removal.
      const rendered = await rail.locator('[data-testid=file-tree-file]').count();
      expect(rendered).toBeLessThan(120);

      // Back to the top, so the click below lands on a row that is on screen —
      // `huge.txt` sorts after `many/`, and 500 rows now sit between them.
      await tree.evaluate((el) => {
        el.scrollTop = 0;
      });
      await rail.locator('[data-testid=file-tree-dir][data-path="many"]').click();

      /*
       * An oversized file is refused, and the host's own sentence is what is
       * shown — with the size and the cap in it. Not an empty rail, and not the
       * first 256 KB with no marker.
       */
      await rail.locator('[data-testid=file-tree-file][data-path="huge.txt"]').click();
      const failed = agbrte.window.locator('[data-testid=file-viewer-error]');
      await expect(failed).toBeVisible();
      await expect(failed).toContainText('300 KB');
      await expect(failed).toContainText('256 KB');
      // Nothing of the file leaked into the rail alongside the refusal.
      await expect(agbrte.window.locator('[data-testid=file-viewer-text]')).toHaveCount(0);
      // And a refusal is still a rail you can close, back to the transcript.
      await agbrte.window.click('[data-testid=file-viewer-close]');
      await expect(agbrte.window.locator('[data-testid=file-viewer]')).toHaveCount(0);
    } finally {
      await agbrte.close();
      await removeRepo(repo);
    }
  });

  /**
   * A path that escapes the workspace is refused *by the host*, with the app's
   * own preload as the only route in.
   *
   * Driven through `window.agbrte.files` rather than the tree, because the tree
   * cannot produce such a path — which is the point. The check that matters is
   * the one on the far side of the boundary, so this asks the way a compromised
   * renderer would and asserts it is told no.
   */
  test('refuses a path that escapes the workspace, whatever the client asks', async () => {
    const repo = await repoWithFiles();
    const agbrte = await launch(repo);

    try {
      await createSession(agbrte.window, 'Escapes');
      await addAgent(agbrte.window, 'echo');

      const refusals = await agbrte.window.evaluate(async () => {
        const api = (
          globalThis as unknown as {
            agbrte: {
              hosts: { list(): Promise<Array<{ instanceId: string }>> };
              files: {
                list(r: { instanceId: string; path: string }): Promise<unknown>;
                read(r: { instanceId: string; path: string }): Promise<unknown>;
              };
            };
          }
        ).agbrte;
        const instanceId = (await api.hosts.list())[0]!.instanceId;

        const attempt = async (fn: () => Promise<unknown>): Promise<string> => {
          try {
            await fn();
            return 'ALLOWED';
          } catch (err) {
            return err instanceof Error ? err.message : String(err);
          }
        };

        return {
          up: await attempt(() => api.files.list({ instanceId, path: '../..' })),
          absolute: await attempt(() => api.files.read({ instanceId, path: '/etc/passwd' })),
          nested: await attempt(() => api.files.list({ instanceId, path: 'src/../../..' })),
          inside: await attempt(() => api.files.list({ instanceId, path: 'src' })),
        };
      });

      expect(refusals.up).toContain('outside this workspace');
      expect(refusals.absolute).toContain('outside this workspace');
      expect(refusals.nested).toContain('outside this workspace');
      // And the ordinary case still works, so the refusals above are a boundary
      // rather than the feature being broken.
      expect(refusals.inside).toBe('ALLOWED');
    } finally {
      await agbrte.close();
      await removeRepo(repo);
    }
  });
});
