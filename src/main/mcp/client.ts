/**
 * A minimal MCP client over stdio (DESIGN.md §17 Q20).
 *
 * Speaks the Model Context Protocol's stdio transport: JSON-RPC 2.0, one
 * message per line, over the pipes of a process this module spawns. Three
 * verbs are all a session needs — `initialize`, `tools/list`, `tools/call` —
 * and nothing else is implemented, deliberately: resources, prompts, sampling
 * and notifications are surface this client does not promise, and an
 * unimplemented verb that exists is worse than one that does not.
 *
 * ## Owned by the session host, never by a runtime
 *
 * The connection's lifetime is the session's: created when the session is,
 * recorded in its log, killed when it ends. §17.1's rule — the harness may
 * decide, and may not own — is why this file lives beside the session manager
 * and hands runtimes closures rather than a client.
 *
 * ## The spawned process is the user's own command
 *
 * Named by the person creating the session, at creation, and recorded in the
 * log — the same "decided while present" shape as the standing grant. What it
 * is *not* is gated per §13: the gate covers what the model asks for, and this
 * process starts before any model has said anything. The trust statement is
 * the config itself.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';

/** Wire-visible client identity, sent in the `initialize` handshake. */
const CLIENT_INFO = { name: 'agbrte', version: '0.0.1' };
/** The protocol revision this client implements. Servers may answer with an older one. */
const PROTOCOL_VERSION = '2025-06-18';

const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 60_000;
/** Enough stderr to explain a crash, not enough to hold a log hostage. */
const STDERR_TAIL = 2_000;

export interface McpTool {
  name: string;
  description: string;
  inputSchema: object;
}

export interface McpCallResult {
  ok: boolean;
  /** Text content, concatenated. Non-text blocks are named rather than dropped silently. */
  text: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class McpConnectError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'McpConnectError';
  }
}

export class McpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = '';
  private stderrTail = '';
  private closed = false;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    readonly tools: McpTool[],
  ) {}

  /**
   * Spawn, handshake, and list tools — or throw with a reason a person can act
   * on. Everything after a successful return is best-effort; everything before
   * it is all-or-nothing, because a half-attached server whose tool list never
   * arrived is not attached in any sense the transcript could record.
   */
  static async connect(config: {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
  }): Promise<McpConnection> {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(config.command, config.args ?? [], {
        // The parent's environment plus the config's: an MCP server is an
        // ordinary program and needs PATH et al.; the config's entries are
        // what carry its own auth, and those never reach the log.
        env: { ...process.env, ...(config.env ?? {}) },
        ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
        stdio: ['pipe', 'pipe', 'pipe'],
        // Never a shell: the command is data from a config, and a shell would
        // make every metacharacter in it an instruction.
        shell: false,
        windowsHide: true,
      });
    } catch (err) {
      throw new McpConnectError(String(err));
    }

    const conn = new McpConnection(child, []);
    conn.wire();

    // A command that does not exist surfaces as `error`/`exit` rather than a
    // throw from spawn(); race the handshake against that so the failure is
    // "spawn ENOENT" and not a fifteen-second timeout with no explanation.
    const died = once(child, 'exit').then(([code]) => {
      throw new McpConnectError(
        `exited with ${String(code)} before the handshake finished${
          conn.stderrTail !== '' ? `: ${conn.stderrTail.trim()}` : ''
        }`,
      );
    });
    const failed = once(child, 'error').then(([err]) => {
      throw new McpConnectError(String(err));
    });

    try {
      await Promise.race([
        (async () => {
          await conn.request(
            'initialize',
            {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: CLIENT_INFO,
            },
            CONNECT_TIMEOUT_MS,
          );
          conn.notify('notifications/initialized');
          const listed = (await conn.request('tools/list', {}, CONNECT_TIMEOUT_MS)) as {
            tools?: Array<{ name?: unknown; description?: unknown; inputSchema?: unknown }>;
          };
          for (const raw of listed.tools ?? []) {
            if (typeof raw.name !== 'string' || raw.name === '') continue;
            conn.tools.push({
              name: raw.name,
              description: typeof raw.description === 'string' ? raw.description : '',
              inputSchema:
                raw.inputSchema !== null && typeof raw.inputSchema === 'object'
                  ? (raw.inputSchema as object)
                  : { type: 'object', properties: {} },
            });
          }
        })(),
        died,
        failed,
      ]);
    } catch (err) {
      conn.dispose();
      throw err instanceof McpConnectError ? err : new McpConnectError(String(err));
    }

    return conn;
  }

  /** Call one tool. An `isError` result is a tool failure, not a protocol one. */
  async call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpCallResult> {
    if (this.closed) return { ok: false, text: 'the MCP server for this tool is no longer running' };

    const request = this.request('tools/call', { name, arguments: args }, CALL_TIMEOUT_MS);
    // An interrupted turn must not leave a call waiting out its full timeout —
    // the model has already been told to stop.
    const aborted = new Promise<never>((_, reject) => {
      const onAbort = (): void => reject(new Error('interrupted'));
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });

    let result: {
      content?: Array<{ type?: unknown; text?: unknown }>;
      isError?: unknown;
    };
    try {
      result = (await Promise.race([request, aborted])) as typeof result;
    } catch (err) {
      return { ok: false, text: String(err instanceof Error ? err.message : err) };
    }

    const text = (result.content ?? [])
      .map((block) =>
        block.type === 'text' && typeof block.text === 'string'
          ? block.text
          : // Named, not dropped: a model told "the tool returned nothing"
            // about an image it cannot see is being lied to (§3.5).
            `[${String(block.type ?? 'unknown')} content omitted]`,
      )
      .join('\n');

    return { ok: result.isError !== true, text };
  }

  /** Kill the process. Idempotent; pending calls reject rather than hang. */
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('the MCP connection was closed'));
    }
    this.pending.clear();
    this.child.kill();
  }

  // -------------------------------------------------------------------- wire

  private wire(): void {
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      // One JSON-RPC message per line is the stdio transport's whole framing.
      for (;;) {
        const newline = this.buffer.indexOf('\n');
        if (newline === -1) break;
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line !== '') this.receive(line);
      }
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL);
    });
    this.child.on('exit', () => {
      // Everything in flight fails with the stderr tail attached, which is
      // usually the only sentence that explains a crash.
      const reason = `the MCP server exited${this.stderrTail !== '' ? `: ${this.stderrTail.trim()}` : ''}`;
      for (const [, waiter] of this.pending) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(reason));
      }
      this.pending.clear();
      this.closed = true;
    });
    // Swallowed here because `connect` races its own listener; after connect,
    // an error surfaces as `exit` and the rejection above.
    this.child.on('error', () => undefined);
  }

  private receive(line: string): void {
    let message: { id?: unknown; result?: unknown; error?: { message?: unknown } };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return; // a server's stray print must not kill the session's tools
    }
    if (typeof message.id !== 'number') return; // notification — none implemented
    const waiter = this.pending.get(message.id);
    if (waiter === undefined) return;
    this.pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error !== undefined) {
      waiter.reject(new Error(String(message.error.message ?? 'MCP server error')));
    } else {
      waiter.resolve(message.result);
    }
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  private notify(method: string): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  }
}
