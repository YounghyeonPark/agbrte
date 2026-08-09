/**
 * Headless browser capture (DESIGN.md §12.1, §15 Phase 7).
 *
 * > The former lets an agent *see its own output* and iterate without you in the
 * > loop.
 *
 * Everything else in §12 gets *your* screen to a model. This is the one that
 * closes a loop with nobody in it, which is why the return path matters as much
 * as the capture: a screenshot tool that could only answer in prose would not
 * let an agent see anything.
 *
 * The capture itself runs a **real browser** where one is installed, because the
 * claim is that a page renders and the bytes come back. A mocked `execFile`
 * would check the flags and assume the picture.
 */

import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { captureUrl, findBrowser, NoBrowser } from '@main/capture/headless.js';
import { decodePng, isPng } from '@main/content/png.js';
import { screenshotTool, type ToolContext } from '@main/tools/index.js';
import { WorkspaceLeases } from '@main/tools/leases.js';
import type { AgentId, ImageBlock } from '@shared/types/index.js';

const browser = await findBrowser();

function toolCtx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceRoot: process.cwd(),
    signal: new AbortController().signal,
    agentId: 'a' as AgentId,
    leases: new WorkspaceLeases(),
    ...over,
  } as ToolContext;
}

describe('finding a browser', () => {
  it('returns null rather than throwing when there is none', async () => {
    // A host without one is an ordinary state of the world — a headless server,
    // a container. Failing to start up over it would be wrong.
    expect(await findBrowser(['definitely-not-a-browser-xyz'])).toBeNull();
  });

  it('refuses the capture, by name, when none was found', async () => {
    await expect(
      captureUrl('http://127.0.0.1:1/', {
        // A candidate list that matches nothing, which is what a host with no
        // browser looks like from here.
        //
        // This used to stub `exec` instead, and stopped meaning anything when
        // the probe changed: an absolute candidate is now checked by existence,
        // because `chrome.exe --version` on Windows prints nothing and never
        // exits — so the real Chrome on this machine was being skipped after a
        // ten-second stall, and a stubbed `exec` could no longer hide it.
        candidates: ['definitely-not-a-browser-xyz'],
        exec: (async () => {
          throw new Error('nope');
        }) as never,
      }),
    ).rejects.toThrow(NoBrowser);
  });

  it('does not run an absolute candidate to find out whether it is there', async () => {
    // The bug this replaced: probing with `--version` cost ten seconds per
    // capture on Windows *and* selected the wrong browser, because the one that
    // hangs is the one you want.
    let ran = 0;
    const exec = (async () => {
      ran += 1;
      throw new Error('should not be reached for a path');
    }) as never;

    await findBrowser(['/no/such/browser', String.raw`C:\no\such\browser.exe`], exec);
    expect(ran).toBe(0);
  });
});

describe('the tool', () => {
  it('says so where the host cannot capture', async () => {
    // Reporting success would tell an agent to look at a picture that does not
    // exist, and it would then reason about what it imagined.
    const result = await screenshotTool.run({ url: 'http://localhost:3000' }, toolCtx());
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/not available/);
  });

  it('refuses a URL that is not http', async () => {
    // `file://` and `data:` would make this a way to read the disk through a
    // screenshot, which is not what it is for.
    const ctx = toolCtx({ capture: async () => ({}) as ImageBlock });
    expect((await screenshotTool.run({ url: 'file:///etc/passwd' }, ctx)).ok).toBe(false);
    expect((await screenshotTool.run({ url: 'data:text/html,<h1>x' }, ctx)).ok).toBe(false);
  });

  it('hands the image back as a block, not as prose about one', async () => {
    /**
     * The return path is the point. §12.1 wants an agent to *see* its own
     * output, and a tool result is text — so an image has to travel some other
     * way or the feature does not exist.
     */
    const image = { type: 'image', sha256: 'a'.repeat(64), width: 800, height: 600 } as ImageBlock;
    const ctx = toolCtx({ capture: async () => image });

    const result = await screenshotTool.run({ url: 'http://localhost:5173' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.blocks).toEqual([image]);
  });

  it('passes a requested viewport through', async () => {
    const seen: unknown[] = [];
    const ctx = toolCtx({
      capture: async (o) => {
        seen.push(o.viewport);
        return { type: 'image', sha256: 'a'.repeat(64), width: 1, height: 1 } as ImageBlock;
      },
    });
    await screenshotTool.run({ url: 'http://x.test', width: 375, height: 812 }, ctx);
    expect(seen[0]).toEqual({ width: 375, height: 812, dpr: 1 });
  });

  it('reports a failed capture instead of throwing at the loop', async () => {
    const ctx = toolCtx({
      capture: async () => {
        throw new Error('the dev server is not up');
      },
    });
    const result = await screenshotTool.run({ url: 'http://localhost:9999' }, ctx);
    // An agent told why can start the server; one handed an exception cannot.
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('the dev server is not up');
  });
});

describe.skipIf(browser === null)('against a real browser', () => {
  it('renders a served page and brings back a PNG', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<body style="margin:0;background:#ff0000"><h1>hello</h1></body>');
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const port = (server.address() as { port: number }).port;

    try {
      const shot = await captureUrl(`http://127.0.0.1:${port}/`, {
        viewport: { width: 400, height: 300, dpr: 1 },
      });

      expect(isPng(shot.png)).toBe(true);
      const image = decodePng(shot.png);
      expect(image.width).toBe(400);

      // The page was actually rendered, not merely fetched: a red background
      // means pixels came from a layout engine.
      const [r, g, b] = [image.rgba[0], image.rgba[1], image.rgba[2]];
      expect(r).toBeGreaterThan(200);
      expect(g).toBeLessThan(80);
      expect(b).toBeLessThan(80);
    } finally {
      server.close();
    }
  }, 60_000);

  it('leaves no screenshot behind in the temp directory', async () => {
    const server = createServer((_req, res) => res.end('<body>ok</body>'));
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const port = (server.address() as { port: number }).port;

    try {
      const { readdir } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const before = (await readdir(tmpdir())).filter((n) => n.startsWith('agbrte-shot-')).length;
      await captureUrl(`http://127.0.0.1:${port}/`);
      const after = (await readdir(tmpdir())).filter((n) => n.startsWith('agbrte-shot-')).length;

      // A screenshot of somebody's admin panel left in /tmp is the same leak
      // §12.1 spends its length preventing, arriving through a cleanup nobody
      // wrote.
      expect(after).toBe(before);
    } finally {
      server.close();
    }
  }, 60_000);
});
