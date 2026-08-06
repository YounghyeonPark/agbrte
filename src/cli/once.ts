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
 *  - **The exit code is the result.** 0 completed, 1 failed in a way a rerun
 *    will not fix, 2 stopped short in a way a later rerun might — see
 *    `exitCodeFor`, which delegates to `stopDisposition` rather than keeping a
 *    second, and inevitably incomplete, list of what counts as failure.
 *  - **Nothing is asked for.** A missing runtime or model is an error naming
 *    what to pass, not a prompt.
 *
 * The session is still owned by the host and still logged, so a scripted run is
 * inspectable afterwards with `loom ls` and readable in the app.
 */

import type { HostConnection } from '@main/host/hostConnection.js';
import { stopDisposition, type AgentId, type LoomEvent, type PermissionRequest, type SessionId, type StopReason } from '@shared/types/index.js';
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

  const ended = stop as LoomEvent | null;
  const reason: StopReason =
    ended !== null && ended.type === 'agent.stopped' ? ended.stop : { kind: 'end_turn' };

  const code = exitCodeFor(reason);
  if (code !== 0) process.stderr.write(`${c.warn(`stopped: ${reason.kind}`)}\n`);
  // A denial is a shortfall even when the agent finished gracefully around it:
  // the task ran without something it asked for, and a script should be able to
  // tell that from a clean run.
  return code !== 0 ? code : denied > 0 ? 1 : 0;
}

/**
 * What a stop means to a script.
 *
 *   0  completed
 *   1  failed, and rerunning as-is will not help
 *   2  stopped short, and rerunning later may succeed
 *
 * Delegates to `stopDisposition` rather than listing kinds here. The first
 * version did list them and defaulted anything unlisted to 0 — so a run against
 * an unreachable model stopped with `unavailable`, matched nothing, and reported
 * success. A cron job would have logged a clean pass while the model was down.
 * An allow-list of failures is the wrong shape: the failure set is open and
 * grows with the protocol, and the success set does not.
 *
 * The one thing `stopDisposition` cannot settle is `pause`, which covers both
 * "quota resets in an hour" and "you set maxTurns too low". Those want opposite
 * things from a retry loop, so they are separated here and nowhere else.
 */
export function exitCodeFor(stop: StopReason): 0 | 1 | 2 {
  switch (stopDisposition(stop)) {
    case 'done':
    // The supervisor would have continued the loop; arriving here means the turn
    // ended anyway, and nothing failed.
    case 'continue':
      return 0;
    case 'retry':
      return 2;
    case 'pause':
      return stop.kind === 'quota_exhausted' ? 2 : 1;
    case 'fail':
      return 1;
  }
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
