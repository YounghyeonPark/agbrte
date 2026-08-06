/**
 * One turn, no prompt, an exit code (DESIGN.md §6.4).
 *
 * `loom attach` needs a person at a terminal. This is the other half of "works
 * without a GUI": cron, CI, a git hook, a shell script — places with no TTY and
 * nobody to answer a question. The difference is not cosmetic. An interactive
 * client that merely *tolerates* a pipe still stops at the first permission
 * prompt and waits for an answer that is never coming, which in a scheduled job
 * is a hang rather than a failure.
 *
 * So the rules here are the opposite of interactive ones:
 *
 *  - **A permission request with no `--yes` is a denial, not a wait.** Denying
 *    feeds a reason back to the agent, which can adapt; waiting produces a job
 *    that never ends and a queue that never drains.
 *  - **The exit code is the result.** 0 completed, 1 failed, 2 stopped for a
 *    reason a rerun will not fix — a hit limit, an exhausted quota.
 *  - **Nothing is asked for.** A missing runtime or model is an error naming
 *    what to pass, not a prompt.
 *
 * The session is still owned by the host and still logged, so a scripted run is
 * inspectable afterwards with `loom ls` and readable in the app.
 */

import type { HostConnection } from '@main/host/hostConnection.js';
import type { AgentId, LoomEvent, PermissionRequest, SessionId } from '@shared/types/index.js';
import { c, preview } from './format.js';

export interface OnceOptions {
  prompt: string;
  title?: string | undefined;
  /** Continue an existing session instead of starting one. */
  sessionId?: string | undefined;
  runtimeId?: string | undefined;
  model?: string | undefined;
  /** Allow every permission request. Off by default — see above. */
  autoApprove: boolean;
  /** Print each event as it arrives rather than only the agent's text. */
  verbose: boolean;
}

export async function once(connection: HostConnection, opts: OnceOptions): Promise<number> {
  const identity = await connection.ready;

  if (identity.unavailableReason !== undefined) {
    process.stderr.write(`${c.fail('nothing can run here')}: ${identity.unavailableReason}\n`);
    return 1;
  }

  const runtimeId = opts.runtimeId ?? identity.runtimes[0];
  if (runtimeId === undefined) {
    process.stderr.write(`${c.fail('this host reported no runtimes')}\n`);
    return 1;
  }
  if (!identity.runtimes.includes(runtimeId)) {
    process.stderr.write(
      `${c.fail(`no runtime ${runtimeId} here`)} — available: ${identity.runtimes.join(', ')}\n`,
    );
    return 1;
  }

  const session =
    opts.sessionId !== undefined
      ? await connection.resumeSession(opts.sessionId as SessionId)
      : await connection.createSession({
          title: opts.title ?? preview(opts.prompt, 60),
          goal: opts.title ?? preview(opts.prompt, 60),
        });

  const agentId: AgentId =
    session.agents[0]?.agentId ??
    (
      await connection.addAgent(session.sessionId, {
        role: 'worker',
        runtimeId,
        ...(opts.model !== undefined
          ? { model: { providerId: 'openai-compatible', modelId: opts.model } }
          : {}),
      })
    ).agentId;

  let denied = 0;
  const onPermission = (request: unknown): void => {
    const req = request as PermissionRequest;
    if (opts.autoApprove) {
      void connection.respondPermission(req.requestId, { result: 'allow', scope: 'session' });
      return;
    }
    denied += 1;
    // Reported on stderr so a scripted run's stdout stays the agent's output,
    // while the reason a task came up short is still visible in a job log.
    process.stderr.write(
      `${c.warn('denied')} ${req.tool} ${c.dim(preview(req.args, 80))} ${c.dim('(pass --yes to allow)')}\n`,
    );
    void connection.respondPermission(req.requestId, {
      result: 'deny',
      reason: 'running non-interactively; nobody can approve this',
    });
  };

  let stop: LoomEvent | null = null;
  const onEvent = (id: unknown, event: unknown): void => {
    if (id !== session.sessionId) return;
    const e = event as LoomEvent;
    if (e.type === 'agent.stopped') stop = e;
    if (opts.verbose) {
      process.stderr.write(`${c.dim(e.type)} ${c.dim(preview(bodyOf(e), 100))}\n`);
    }
    if (e.type === 'agent.text') process.stdout.write(`${e.text}\n`);
  };

  connection.on('permission', onPermission);
  connection.on('event', onEvent);

  try {
    await connection.send(session.sessionId, agentId, opts.prompt);
  } catch (err) {
    process.stderr.write(`${c.fail(err instanceof Error ? err.message : String(err))}\n`);
    return 1;
  } finally {
    connection.off('permission', onPermission);
    connection.off('event', onEvent);
  }

  process.stderr.write(c.dim(`session ${session.sessionId}\n`));

  const kind = (stop as LoomEvent | null)?.type === 'agent.stopped' ? stopKind(stop) : 'end_turn';
  if (kind === 'error') return 1;
  // Distinguished from a plain failure because a rerun will not help: the limit
  // or the quota has to change first, and a job that retries on 2 loops.
  if (kind === 'max_turns' || kind === 'max_tokens' || kind === 'quota_exhausted') {
    process.stderr.write(`${c.warn(`stopped: ${kind}`)}\n`);
    return 2;
  }
  return denied > 0 ? 1 : 0;
}

function stopKind(event: LoomEvent | null): string {
  return event !== null && event.type === 'agent.stopped' ? event.stop.kind : 'end_turn';
}

/** The part of an event worth one line of a verbose log. */
function bodyOf(event: LoomEvent): unknown {
  switch (event.type) {
    case 'agent.text':
      return event.text;
    case 'agent.tool_use':
      return `${event.tool} ${preview(event.args, 60)}`;
    case 'agent.tool_result':
      return event.summary;
    case 'permission.decided':
      return `${event.tool} → ${event.decision.result}`;
    default:
      return '';
  }
}
