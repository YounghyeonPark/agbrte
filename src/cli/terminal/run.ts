/**
 * Running `TerminalSession` against a real terminal, a real shell and a host.
 *
 * Everything with a process or a socket in it lives here, so `session.ts` stays
 * the part a test can drive. The shell is the one the app's terminal pane would
 * start — the same resolution (`programs.ts`), the same teaching
 * (`integration.ts`), the same pty module (`shell.ts`) — so a prompt looks the
 * same in either place.
 *
 * Returns `null` when this terminal cannot be used: stdin or stdout is not a
 * terminal, or the pty module is not on this machine. The caller then falls back
 * to the line client, which is how a pipe or a server without the module still
 * gets a working `agbrte attach`.
 */

import type { HostConnection } from '@main/host/hostConnection.js';
import { integrate } from '@main/terminal/integration.js';
import { TerminalPrograms, terminalEnv } from '@main/terminal/programs.js';
import { ptySpawner } from '@main/terminal/shell.js';
import type { AgentId, AgbrteEvent, PermissionRequest, SessionId, Sha256 } from '@shared/types/index.js';
import { detectGraphics, drawBlob, playsMedia } from '@main/terminal/graphics.js';
import { ansiStyle, plainStyle } from '@main/terminal/mux/markdown.js';
import { TerminalSession } from '@main/terminal/mux/session.js';

export interface RunTerminalOptions {
  connection: HostConnection;
  sessionId: SessionId;
  agentId: AgentId;
  /** The folder the shell starts in. */
  cwd: string;
  autoApprove: boolean;
}

export function canRunTerminal(): boolean {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return false;
  if (process.env['AGBRTE_TERMINAL'] === '0') return false;
  try {
    ptySpawner();
    return true;
  } catch {
    return false;
  }
}

export async function runTerminal(o: RunTerminalOptions): Promise<number> {
  const spawner = ptySpawner();
  const env = terminalEnv(process.env);
  const chosen = new TerminalPrograms({ env }).resolve({ kind: 'shell' }, { workspaceRoot: o.cwd });
  const taught = integrate(chosen, { env });
  const columns = (): number => process.stdout.columns ?? 80;
  const rows = (): number => process.stdout.rows ?? 24;
  const pty = spawner(taught.file, taught.args, {
    cwd: o.cwd,
    cols: columns(),
    rows: rows(),
    env: { ...env, ...(chosen.env ?? {}), ...taught.env },
  });

  const colour = process.env['NO_COLOR'] === undefined && process.env['TERM'] !== 'dumb';
  // Read before `terminalEnv` replaced `TERM` for the shell: this is about the
  // terminal this client is running in, not the one it gives the shell.
  const graphics = detectGraphics(process.env);
  let finish: (code: number) => void = () => undefined;
  const finished = new Promise<number>((done) => {
    finish = done;
  });

  const session = new TerminalSession({
    out: (bytes) => process.stdout.write(bytes),
    columns,
    rows,
    resync: process.platform === 'win32',
    shell: pty,
    integration: taught.level,
    agent: {
      send: (text) => o.connection.send(o.sessionId, o.agentId, text),
      interrupt: () => o.connection.interrupt(o.sessionId),
      respond: (requestId, decision) => o.connection.respondPermission(requestId, decision),
      // Pictures where the terminal this runs in says it draws them; elsewhere
      // none are fetched, and an image is the tool line that produced it.
      ...(graphics !== 'none'
        ? {
            picture: async ({ sha256, mime }: { sha256: string; mime?: string }) => {
              const bytes = await o.connection.getBlob(o.sessionId, sha256 as Sha256, mime);
              return bytes === null
                ? null
                : drawBlob(bytes, graphics, { name: sha256.slice(0, 12), media: playsMedia() });
            },
          }
        : {}),
    },
    style: colour ? ansiStyle : plainStyle,
    exit: (code) => finish(code),
  });

  // Events: only this session's, each once. The catch-up read sets where the
  // live push takes over, so attaching mid-turn does not replay the transcript.
  let lastSeq = -1;
  for (const e of await o.connection.events(o.sessionId)) lastSeq = Math.max(lastSeq, e.seq);
  const onEvent = (id: unknown, event: unknown): void => {
    if (id !== o.sessionId) return;
    const e = event as AgbrteEvent;
    if (e.seq <= lastSeq) return;
    lastSeq = e.seq;
    session.event(e);
  };
  const onPermission = (request: unknown): void => {
    const r = request as PermissionRequest;
    if (o.autoApprove) {
      void o.connection.respondPermission(r.requestId, { result: 'allow', scope: 'once' }).catch(() => undefined);
      return;
    }
    session.permission(r);
  };
  o.connection.on('event', onEvent);
  o.connection.on('permission', onPermission);

  pty.onData((data) => session.shellOutput(data));
  pty.onExit(({ exitCode }) => session.shellExited(exitCode));

  const onKeys = (chunk: Buffer | string): void => session.input(chunk.toString());
  const onResize = (): void => session.resize(columns(), rows());
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', onKeys);
  process.stdin.resume();
  process.stdout.on('resize', onResize);

  for (const request of await o.connection.pendingPermissions()) onPermission(request);

  const code = await finished;
  process.stdout.off('resize', onResize);
  process.stdin.off('data', onKeys);
  process.stdin.setRawMode(false);
  process.stdin.pause();
  o.connection.off('event', onEvent);
  o.connection.off('permission', onPermission);
  return code;
}
