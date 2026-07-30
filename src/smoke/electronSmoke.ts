/**
 * End-to-end check of the Electron shell (DESIGN.md §7).
 *
 * Runs as a real Electron main process, loads the real renderer bundle, and
 * drives the real preload bridge — then asserts and exits with a status code.
 *
 * ## Why this exists
 *
 * §14 specifies Playwright's `_electron` for this. Until that harness is set up,
 * the alternative was "the process stayed alive for seven seconds", which proves
 * only that `main.ts` did not throw. It cannot tell you that `contextBridge`
 * exposed anything, that a channel is wired, or that a handler's arguments
 * survive serialization — and those are exactly the failures that present as
 * "the app opens and every button does nothing".
 *
 * This is not a substitute for Playwright: no clicking, no rendering
 * assertions, no screenshots. It is the smallest thing that fails loudly when
 * the IPC contract is broken.
 */

import { app, BrowserWindow } from 'electron';
import { mkdtemp, rm } from 'node:fs/promises';
import { writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionManager } from '../main/sessionManager.js';
import { RuntimeRegistry } from '../main/runtime/registry.js';
import { EchoRuntime } from '../main/runtime/runtimes/echo.js';
import { openWorkspace } from '../main/store/identity.js';
import { registerIpc } from '../main/ipc/register.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

const lines: string[] = [];

/**
 * Collect a result line. Flushed to a file, not to a stream.
 *
 * On Windows the `electron` binary is GUI-subsystem: neither fd 1 nor fd 2
 * reaches the parent's pipe, so `console.log`, `process.stderr.write`, and even
 * `writeSync(2, …)` all vanish — while Electron's own native logging appears,
 * which makes the process look like it is talking when its JS is not. Writing
 * where the launcher can read it sidesteps the whole platform question, and
 * `app.exit()` cannot truncate a completed synchronous write.
 */
function report(line: string): void {
  lines.push(line);
}

function flush(): void {
  const out = process.env['LOOM_SMOKE_OUT'];
  const text = `${lines.join('\n')}\n`;
  if (out !== undefined) writeFileSync(out, text, 'utf8');
  writeSync(2, text); // harmless where it works, e.g. a POSIX terminal
}

function record(name: string, ok: boolean, detail: unknown = ''): void {
  checks.push({ name, ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
}

/**
 * Run an expression in the renderer and return its resolved value.
 *
 * `executeJavaScript` rejects with a bare string for a renderer-side throw, so
 * failures are wrapped to keep the originating check identifiable.
 */
async function evaluate<T>(win: BrowserWindow, expression: string): Promise<T> {
  try {
    return (await win.webContents.executeJavaScript(expression, true)) as T;
  } catch (err) {
    throw new Error(`renderer threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(): Promise<number> {
  const root = await mkdtemp(join(tmpdir(), 'loom-smoke-'));

  try {
    const identity = await openWorkspace(root);
    const registry = new RuntimeRegistry();
    registry.register(
      new EchoRuntime({
        script: [
          { kind: 'text', text: 'smoke reply' },
          { kind: 'stop', stop: { kind: 'end_turn' } },
        ],
      }),
      { label: 'Echo', requiresModel: false },
    );

    const manager = new SessionManager({
      registry,
      workspaceRoot: root,
      instanceId: identity.instanceId,
    });

    const workspace = {
      root,
      lineageId: identity.lineageId,
      instanceId: identity.instanceId,
    };

    const ipc = registerIpc({
      manager,
      workspace,
      runtimes: () => [{ id: 'echo', version: '0.0.1', requiresModel: false }],
      onChooseWorkspace: async () => workspace,
    });

    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: join(HERE, '../main/preload.cjs'),
      },
    });

    await win.loadFile(join(HERE, '../renderer/index.html'));

    // 1. The bridge exists at all. If `contextBridge.exposeInMainWorld` did not
    //    run — the classic symptom of a preload built as ESM — this is where it
    //    shows, rather than as a silent no-op in a click handler.
    const surface = await evaluate<string[]>(
      win,
      'Object.keys(window.loom ?? {}).sort()',
    );
    record(
      'preload exposes the api',
      ['ack', 'on', 'permissions', 'runtimes', 'sessions', 'workspace'].every((k) =>
        surface.includes(k),
      ),
      surface,
    );

    // 2. Node is genuinely absent from the renderer, per §7. A regression here is
    //    a security regression, not a cosmetic one.
    const leaked = await evaluate<string[]>(
      win,
      `['require','process','module','global'].filter((k) => k in window)`,
    );
    record('no node globals in the renderer', leaked.length === 0, leaked);

    // 3. An invoke round trip, with a real reply from main.
    const got = await evaluate<{ root: string }>(win, 'window.loom.workspace.current()');
    record('invoke returns main state', got.root === root, got.root);

    // 4. Arguments survive serialization in both directions, and the session
    //    reaches the real SessionManager rather than a stub.
    const created = await evaluate<{ sessionId: string; title: string; state: string }>(
      win,
      `window.loom.sessions.create({ title: 'Smoke', goal: 'prove the wiring' })`,
    );
    record('create passes arguments through', created.title === 'Smoke', created);
    record('new session starts in planning', created.state === 'planning', created.state);

    // 5. A full turn, and the push channel that carries its events. This is the
    //    one that exercises everything at once: handler → manager → runtime →
    //    store → onAppend → EventBridge → push → preload listener.
    const turn = await evaluate<{ types: string[]; batches: number }>(
      win,
      `(async () => {
         const types = [];
         let batches = 0;
         const off = window.loom.on.events((b) => { batches += 1; for (const e of b.events) types.push(e.type); });
         const agent = await window.loom.sessions.addAgent({
           sessionId: ${JSON.stringify(created.sessionId)}, role: 'lead', runtimeId: 'echo',
         });
         await window.loom.sessions.send({
           sessionId: ${JSON.stringify(created.sessionId)}, agentId: agent.agentId, text: 'hello',
         });
         // The bridge batches on a 50ms timer, so allow it to fire.
         await new Promise((r) => setTimeout(r, 400));
         off();
         return { types, batches };
       })()`,
    );
    record('push channel delivered batches', turn.batches > 0, `${turn.batches} batches`);
    record(
      'a full turn reached the renderer',
      ['user.turn', 'agent.text', 'agent.stopped'].every((t) => turn.types.includes(t)),
      turn.types,
    );

    // 6. The snapshot the UI draws from, including a folded projection.
    const snapshot = await evaluate<{ recent: number; state: string; agents: number }>(
      win,
      `(async () => {
         const s = await window.loom.sessions.snapshot(${JSON.stringify(created.sessionId)});
         return { recent: s.recent.length, state: s.projection.state, agents: s.projection.agents.length };
       })()`,
    );
    record('snapshot carries a window of events', snapshot.recent > 0, snapshot.recent);
    record('snapshot folds the projection', snapshot.agents === 1, snapshot);
    record('end_turn leaves awaiting_input', snapshot.state === 'awaiting_input', snapshot.state);

    // 7. An error crosses the boundary with its message intact, rather than as
    //    Electron's opaque "Error invoking remote method".
    const failure = await evaluate<string>(
      win,
      `window.loom.sessions.resume('session_does_not_exist').then(() => 'no error', (e) => e.message)`,
    );
    record('errors keep their message', failure !== 'no error' && failure.length > 0, failure);

    ipc.dispose();
    win.destroy();
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const failed = checks.filter((c) => !c.ok);
  // stderr, not stdout: on Windows, Electron is a GUI-subsystem binary with no
  // console attached to its parent, so `console.log` is discarded and a run
  // reports its exit code with no visible results. stderr does get through.
  for (const check of checks) {
    report(`${check.ok ? 'ok  ' : 'FAIL'}  ${check.name}${check.detail ? `  — ${check.detail}` : ''}`);
  }
  report(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  return failed.length === 0 ? 0 : 1;
}

/**
 * Hold the app open after the window is destroyed.
 *
 * With no listener, Electron's default is to quit once the last window closes.
 * Destroying the window here is followed by an `await` (the workspace cleanup),
 * which yields — so the app quit mid-teardown and the process exited 0 before
 * any result was computed or written. That presented as "exit code 0, no
 * output", i.e. a passing run with nothing to show, which is the worst possible
 * shape for a test to fail in.
 */
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  let code = 1;
  try {
    code = await main();
  } catch (err) {
    report(`smoke threw: ${err instanceof Error ? err.stack : String(err)}`);
  }
  flush();
  app.exit(code);
});
