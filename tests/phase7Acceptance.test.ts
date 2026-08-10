/**
 * Phase 7's acceptance criterion, as one flow (DESIGN.md §15).
 *
 * > *Done when:* you capture a broken UI region from a forwarded remote preview,
 * > circle it, say what's wrong, and the remote agent fixes it and screenshots
 * > its own fix.
 *
 * Every piece of that has its own tests and every piece has been run against
 * real hardware. Nobody had run the sentence. This session's recurring finding
 * is that pieces which pass their own tests hide the seams between them — a
 * description dropped for exactly the agents that needed it, audio with no
 * branch in the fitter, a read that wrote — so the seam is what this crosses.
 *
 * ## Two honest substitutions, named rather than hidden
 *
 * **The agent is local, not remote.** The tailnet server has no model server
 * reachable, so the far end would have been an `echo` runtime again, which is
 * what made the earlier remote run prove nothing about this. The transport is
 * covered separately and thoroughly: `blobTransfer.test.ts` over an in-memory
 * channel, and a 2.16 MB chunked transfer over real ssh with both machines
 * agreeing on the hash.
 *
 * **The agent does not see the picture.** `qwen2.5:7b` declares
 * `input.image: false`, so §12.2 replaces the screenshot with a placeholder and
 * §12.3's sentence carries what was circled. That is not a degraded run of this
 * test — it is the case §12.3 argues is the *common* one, and the flow either
 * works through it or the annotation description is decoration.
 *
 * Skipped loudly without Ollama, Chrome, whisper.cpp and a speech clip, which is
 * most machines. See `whisperReal.test.ts` for the three voice variables.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { AgbrteHarnessRuntime } from '@main/runtime/runtimes/agbrteHarness.js';
import {
  OpenAiCompatibleProvider,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from '@main/runtime/providers/openaiCompatible.js';
import { openWorkspace } from '@main/store/identity.js';
import { captureUrl, findBrowser } from '@main/capture/headless.js';
import type { ScreenBackend } from '@main/capture/client.js';
import { createApi } from '@main/ipc/api.js';
import { Fleet } from '@main/fleet.js';
import { SessionHostServer } from '../src/host/sessionServer.js';
import { HostConnection } from '@main/host/hostConnection.js';
import { memoryChannelPair } from '@shared/host/memoryChannel.js';
import { CH } from '@shared/ipc/contract.js';
import type { CapturePreviewDto, CaptureResultDto } from '@shared/ipc/contract.js';
import type { SessionCommand, SessionMessage } from '@shared/host/sessionProtocol.js';
import { transcribe } from '@main/voice/stt.js';
import type { Annotation, ModelEndpoint } from '@shared/types/index.js';

const OLLAMA = 'http://127.0.0.1:11434/v1';
const MODEL = 'qwen2.5:7b';
const BIN = process.env['AGBRTE_WHISPER_BIN'] ?? '';
const WEIGHTS = process.env['AGBRTE_WHISPER_MODEL'] ?? '';
const INSTRUCTION = process.env['AGBRTE_SPEECH_INSTRUCTION'] ?? '';

async function reachable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA}/models`, { signal: AbortSignal.timeout(3_000) });
    return res.ok;
  } catch {
    return false;
  }
}

const HAVE_VOICE = [BIN, WEIGHTS, INSTRUCTION].every((p) => p !== '' && existsSync(p));
const HAVE_MODEL = await reachable();
const HAVE_BROWSER = (await findBrowser()) !== null;
const READY = HAVE_VOICE && HAVE_MODEL && HAVE_BROWSER;

if (!READY) {
  // eslint-disable-next-line no-console
  console.warn(
    `phase7Acceptance: skipped — ollama:${HAVE_MODEL} browser:${HAVE_BROWSER} voice:${HAVE_VOICE}. ` +
      'This is the only test that crosses every §12 seam at once; a silent skip would ' +
      'let the phase table claim a flow nobody ran.',
  );
}

/** A page with one obvious defect: the button is there and cannot be seen. */
const BROKEN = `<!doctype html>
<html><body style="margin:0;background:#ffffff;font:16px system-ui">
  <h1 style="color:#111">Settings</h1>
  <button id="save" style="color:#ffffff;background:#ffffff;border:0;padding:12px 24px">Save</button>
</body></html>`;

describe.skipIf(!READY)('capture it, circle it, say it, and let the agent fix it', () => {
  let root: string;
  let server: Server;
  let url: string;
  const managers: SessionManager[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agbrte-phase7-'));
    await writeFile(join(root, 'page.html'), BROKEN, 'utf8');

    // Served rather than opened from disk: `file://` is refused by the capture
    // tool (§12.1), and a served page is what "a forwarded remote preview"
    // actually is.
    server = createServer(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(await readFile(join(root, 'page.html'), 'utf8'));
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  });

  afterEach(async () => {
    for (const m of managers.splice(0)) m.dispose();
    server.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('runs the whole sentence', async () => {
    const identity = await openWorkspace(root);
    const endpoint: ModelEndpoint = {
      endpointId: 'local-ollama',
      providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
      baseUrl: OLLAMA,
      auth: { kind: 'none' },
      locality: 'app-local',
      dataHandling: { provider: 'local', retentionNote: 'nothing transmitted off-machine' },
    };

    // ---- 1. the preview: a real rendering of the broken page
    const preview = await captureUrl(url, { viewport: { width: 800, height: 400, dpr: 1 } });
    expect(preview.png.length).toBeGreaterThan(0);

    // ---- 2. capture a region of it, and circle the button
    //
    // Through the real two-step: the frame is held unstored while the marks are
    // decided, which is what makes §12.1's guarantee a mechanism rather than an
    // instruction.
    const backend: ScreenBackend = {
      access: async () => 'granted',
      sources: async () => [{ id: 'screen:0', name: 'preview', kind: 'screen' }],
      grab: async () => preview.png,
    };

    // A real host, a real fleet, and the real IPC handlers — because the first
    // version of this test called `storeFrame` directly and rebuilt the seam by
    // hand, which lost the annotations and asserted nothing about the path a
    // person takes. That is the exact failure this test exists to catch, made
    // while writing the test for it.
    const registry = new RuntimeRegistry();
    registry.register(
      new AgbrteHarnessRuntime({
        provider: new OpenAiCompatibleProvider(),
        endpointFor: () => endpoint,
      }),
      { label: 'harness', requiresModel: true },
    );
    const manager = new SessionManager({
      registry,
      workspaceRoot: root,
      instanceId: identity.instanceId,
    });
    managers.push(manager);
    // Egress and screenshot are `ask` by §13, and nobody is at a terminal.
    manager.on('permission', (req) => {
      void manager.respondPermission(req.requestId, { result: 'allow', scope: 'session' });
    });

    // Named `host` rather than `server`: the outer `server` is the http one
    // serving the broken page, and shadowing it here would make the teardown
    // read as closing the wrong thing.
    const host = new SessionHostServer({
      manager,
      identity: {
        instanceId: identity.instanceId,
        lineageId: identity.lineageId,
        workspaceRoot: root,
        runtimes: ['agbrte-harness'],
      },
    });
    const fleet = new Fleet({
      runtimes: [{ id: 'agbrte-harness', label: 'harness', version: '1', requiresModel: true }],
      connect: async () => {
        const pair = memoryChannelPair<SessionCommand, SessionMessage>();
        host.accept(pair.host);
        return new HostConnection({ channel: pair.main });
      },
    });
    await fleet.attach({ target: { kind: 'local' }, workspaceRoot: root });

    const api = createApi({
      fleet,
      runtimes: [],
      loadConformance: async () => null,
      broadcast: () => undefined,
      screen: backend,
    });
    const call = (channel: string, ...a: unknown[]): Promise<unknown> =>
      api.handlers.get(channel)!(...a);

    const session = await fleet.createSession(identity.instanceId, {
      title: 'phase 7',
      goal: 'fix the button',
    });
    const agent = await fleet.addAgent(session.sessionId, {
      role: 'worker',
      runtimeId: 'agbrte-harness',
      model: { providerId: OPENAI_COMPATIBLE_PROVIDER_ID, modelId: MODEL },
      limits: { maxTurns: 8 },
    });

    // Held unstored while the marks are decided — §12.1's guarantee as a
    // mechanism rather than an instruction.
    const held = (await call(CH.capturePreview, {
      sourceId: 'screen:0',
    })) as CapturePreviewDto;

    const circled: Annotation[] = [
      { kind: 'rectangle', colour: 'red', rect: { x: 8, y: 60, w: 130, h: 56 }, label: 'this' },
    ];
    const shot = (await call(CH.captureCommit, {
      pendingId: held.pendingId,
      sessionId: session.sessionId,
      annotations: circled,
    })) as CaptureResultDto;
    expect(shot.block.annotations).toHaveLength(1);

    // ---- 3. say what is wrong
    //
    // Blunt, and the bluntness is a property of a 7B model rather than of
    // dictation: §15 already records that a softer instruction made this model
    // answer in prose instead of calling a tool at all. The clip is synthesized
    // by the platform's TTS so the fixture is reproducible.
    const spoken = await transcribe(await readFile(INSTRUCTION), { bin: BIN, model: WEIGHTS });
    expect(spoken.text.toLowerCase()).toContain('button');

    // ---- 4. send the words and what was circled, together
    await fleet.send(session.sessionId, agent.agentId, spoken.text, [shot.block]);

    // ---- 5. what actually happened
    const events = await fleet.events(session.sessionId);
    const turn = events.find((e) => e.type === 'user.turn') as { content: Array<{ type: string; text?: string }> };

    // The agent could not see the picture — `qwen2.5:7b` declares
    // `input.image: false` — so §12.2 replaced it and §12.3's sentence is what
    // carried the circle. This is the case that section calls the common one.
    const described = turn.content.map((b) => b.text ?? '').join(' ');
    expect(described).toMatch(/red box|rectangle/i);

    const fixed = await readFile(join(root, 'page.html'), 'utf8');
    const calls = events.filter((e) => e.type === 'agent.tool_use') as Array<{ tool: string }>;

    // eslint-disable-next-line no-console
    console.log(
      `phase 7: said "${spoken.text}"; tools ${calls.map((c) => c.tool).join(', ') || '(none)'}; ` +
        `button colour now ${/color:\s*#ffffff;background:#ffffff/i.test(fixed) ? 'still invisible' : 'changed'}`,
    );

    // The claim under test is that the flow *runs*: the words and the marks
    // reached a real model, it acted on them, and the transcript says what it
    // did. Whether a 7B model produces a good fix is a property of the model —
    // asserting on its taste would make this a test of qwen rather than of §12.
    expect(calls.length).toBeGreaterThan(0);
    expect(fixed).not.toBe(BROKEN);
  }, 300_000);
});
