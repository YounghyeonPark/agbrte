/**
 * Driving a session from a terminal.
 *
 * The window's job, minus the window: pick or create a session, add an agent,
 * send turns, watch the transcript arrive, answer permission prompts. All of it
 * over one `HostConnection`, so what happens here is indistinguishable — to the
 * host, to the log, to anyone attached from elsewhere — from the same thing done
 * in the app.
 *
 * ## Leaving is not stopping
 *
 * Ctrl-D detaches and the run continues, because that is the property the whole
 * three-process design exists to provide, and a terminal client that killed a
 * session on exit would quietly take it away. Ctrl-C interrupts the *turn* and
 * keeps the session — the one thing people expect Ctrl-C to do at a prompt is
 * stop what is running now, not throw away the work.
 *
 * ## Printing while typing
 *
 * Events arrive whenever the agent produces them, including mid-keystroke.
 * Writing straight to stdout would land inside the line being typed and leave a
 * corrupted prompt behind, so every write goes through a helper that clears the
 * line, prints, and restores what readline had. This is the one piece of cursor
 * handling here, and it is the minimum that a streaming transcript plus an input
 * line requires.
 */

import { createInterface, type Interface } from 'node:readline';
import type { HostConnection } from '@main/host/hostConnection.js';
import type { AgentId, AgbrteEvent, PermissionRequest, Session, SessionId } from '@shared/types/index.js';
import { detectGraphics, inlineImage } from './graphics.js';
import { c, preview } from './format.js';

export interface AttachOptions {
  path: string;
  /** Answer every permission request with allow. For unattended runs only. */
  autoApprove: boolean;
}

export async function attach(connection: HostConnection, opts: AttachOptions): Promise<number> {
  const identity = await connection.ready;
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '› ' });

  /**
   * Print without eating the half-typed line underneath.
   *
   * Only redraws the prompt once the input loop owns the bottom line. Before
   * that — while `chooseSession` and `ensureAgent` are asking their own
   * questions — restoring the main prompt paints `› ` over the question being
   * asked, so every setup line arrived with a stray prompt in front of it. This
   * is visible only on a real PTY, which is why a piped test passed and an ssh
   * one did not.
   */
  let driving = false;
  const say = (text: string): void => {
    if (process.stdout.isTTY === true && driving) {
      rl.pause();
      process.stdout.write(`\x1b[2K\r${text}\n`);
      rl.resume();
      rl.prompt(true);
    } else {
      process.stdout.write(`${text}\n`);
    }
  };

  say(c.dim(`${opts.path}  ·  host pid ${identity.pid}  ·  ${connection.role}`));
  if (identity.unavailableReason !== undefined) {
    // Readable but not runnable. Saying so up front beats discovering it when a
    // turn fails for reasons that look like the model's fault.
    say(c.warn(`agent host unavailable — ${identity.unavailableReason}`));
    say(c.dim('transcripts are readable; nothing can run'));
  }

  const session = await chooseSession(connection, rl, say);
  if (session === null) {
    rl.close();
    return 0;
  }

  const agentId = await ensureAgent(connection, session, identity.runtimes, rl, say);
  if (agentId === null) {
    rl.close();
    return 1;
  }

  // From here the session is live: everything the host pushes for it is printed,
  // and everything typed is a turn.
  let lastSeq = -1;
  const onEvent = (id: unknown, event: unknown): void => {
    if (id !== session.sessionId) return;
    const e = event as AgbrteEvent;
    // Guarded because the catch-up read below and the live push can overlap;
    // without it, attaching mid-turn prints the tail of the transcript twice.
    if (e.seq <= lastSeq) return;
    lastSeq = e.seq;
    const line = render(e);
    if (line !== null) say(line);
    // Fetched rather than rendered from the event, because the event carries a
    // hash and the bytes live on whichever machine owns the session.
    void showPicture(connection, session.sessionId, e, say);
  };
  const onPermission = (request: unknown): void => {
    void answer(connection, request as PermissionRequest, rl, say, opts.autoApprove);
  };
  connection.on('event', onEvent);
  connection.on('permission', onPermission);

  // Anything already in flight before we attached — a turn started from the app,
  // or from another machine. Without this, attaching mid-run shows nothing until
  // the next event and looks like a hang.
  for (const event of await connection.events(session.sessionId)) {
    lastSeq = Math.max(lastSeq, event.seq);
  }
  for (const request of await connection.pendingPermissions()) {
    void answer(connection, request, rl, say, opts.autoApprove);
  }

  say(c.dim('type to send · Ctrl-C interrupts the turn · Ctrl-D leaves the session running'));
  driving = true;
  rl.prompt();

  let sending = false;
  rl.on('line', (input) => {
    const text = input.trim();
    if (text === '') {
      rl.prompt();
      return;
    }
    if (sending) {
      // Queued by the host in arrival order either way; saying so is better than
      // silence, since the prompt returning looks like nothing happened.
      say(c.dim('queued behind the running turn'));
    }
    sending = true;
    void connection
      .send(session.sessionId, agentId, text)
      .catch((err: unknown) => say(c.fail(err instanceof Error ? err.message : String(err))))
      .finally(() => {
        sending = false;
        rl.prompt();
      });
  });

  rl.on('SIGINT', () => {
    // Interrupt the turn, keep the session. Exiting here would make Ctrl-C the
    // thing that loses work, which is the opposite of what it is for.
    void connection.interrupt(session.sessionId).then(
      () => say(c.dim('interrupted')),
      (err: unknown) => say(c.fail(String(err))),
    );
  });

  await new Promise<void>((done) => rl.on('close', done));
  connection.off('event', onEvent);
  connection.off('permission', onPermission);
  say(c.dim('detached — the session keeps running'));
  return 0;
}

/**
 * Draw an image the session just produced, where the terminal can take one.
 *
 * The blob store has held these since captures existed and nothing could ask for
 * them back, so a screenshot was visible to the model and to nobody else. This
 * asks, and asking is why it is `void`-ed rather than awaited: a picture is
 * decoration on a transcript that must keep scrolling, and a slow or missing
 * blob is not a reason to stall the line after it.
 *
 * On a terminal without graphics it says where the file is instead. That is the
 * §3.3 shape — refuse by name — and it is also the more useful answer for
 * anything that is not an image, since a path can be opened and a caption
 * cannot.
 */
async function showPicture(
  connection: HostConnection,
  sessionId: SessionId,
  event: AgbrteEvent,
  say: (line: string) => void,
): Promise<void> {
  const found =
    event.type === 'capture.attached'
      ? { sha256: event.sha256, mime: event.mime }
      : event.type === 'agent.tool_result' && (event.resultBlobs?.length ?? 0) > 0
        ? { sha256: event.resultBlobs![0]!, mime: undefined }
        : null;
  if (found === null) return;

  // Asked before fetching: on a terminal that cannot draw, the bytes would be
  // downloaded across an ssh link to be thrown away.
  if (detectGraphics() === 'none') {
    const where = event.type === 'capture.attached' ? `image ${found.sha256.slice(0, 12)}` : null;
    if (where !== null) say(c.dim(`  ${where} — this terminal shows no inline images`));
    return;
  }

  try {
    const bytes = await connection.getBlob(sessionId, found.sha256, found.mime);
    if (bytes === null) return;
    const drawn = inlineImage(bytes, { name: found.sha256.slice(0, 12) });
    if (drawn !== null) process.stdout.write(drawn);
  } catch {
    // A picture that will not load is not worth an error line in a transcript
    // somebody is reading for the work.
  }
}

/** One line of transcript, or null for events a person reading along does not need. */
function render(event: AgbrteEvent): string | null {
  switch (event.type) {
    case 'agent.text':
      return event.text;
    case 'user.turn':
      // Echoed only when it came from elsewhere; our own is already on screen.
      return event.actor === undefined ? null : c.dim(`‹ ${previewTurn(event)}`);
    case 'agent.tool_use':
      return `${c.accent('⚒')} ${event.tool} ${c.dim(preview(event.args))}`;
    case 'agent.tool_result':
      return `${event.ok ? c.ok('✓') : c.fail('✗')} ${c.dim(preview(event.summary))}`;
    case 'permission.decided':
      return event.via === 'policy'
        ? null // Silent by design: policy settling a call is not news.
        : c.dim(`  ${event.decision.result} ${event.tool}${actorSuffix(event)}`);
    case 'agent.stopped':
      return c.dim(`— ${event.stop.kind}`);
    case 'session.state':
      return c.dim(`  ${event.from} → ${event.to}`);
    default:
      return null;
  }
}

function previewTurn(event: Extract<AgbrteEvent, { type: 'user.turn' }>): string {
  const text = event.content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join(' ');
  return `${preview(text, 80)}${actorSuffix(event)}`;
}

/** Who did it, when that is someone other than the only person here. */
function actorSuffix(event: AgbrteEvent): string {
  return event.actor?.label === undefined ? '' : c.dim(` · ${event.actor.label}`);
}

async function answer(
  connection: HostConnection,
  request: PermissionRequest,
  rl: Interface,
  say: (t: string) => void,
  autoApprove: boolean,
): Promise<void> {
  if (autoApprove) {
    await connection.respondPermission(request.requestId, { result: 'allow', scope: 'once' });
    say(c.dim(`auto-allowed ${request.tool}`));
    return;
  }

  say(`${c.warn('◆ permission')} ${c.bold(request.tool)} ${c.dim(preview(request.args))}`);
  const reply = await ask(rl, `  allow? [y/N/a=session] `);
  const decision =
    reply === 'y'
      ? ({ result: 'allow', scope: 'once' } as const)
      : reply === 'a'
        ? ({ result: 'allow', scope: 'session' } as const)
        : ({ result: 'deny', reason: 'denied at the terminal' } as const);

  const outcome = await connection.respondPermission(request.requestId, decision);
  if (outcome === 'already-answered') {
    // Several clients can see one prompt; a race is ordinary, not an error.
    say(c.dim('  answered elsewhere first'));
  }
}

/**
 * A one-off question, without disturbing the main prompt.
 *
 * Resolves empty at EOF rather than rejecting. `agbrte < answers.txt` and a
 * closed pipe both end the stream mid-question, and readline's own error for
 * that is "readline was closed" — a sentence about our internals presented as
 * the user's problem. Empty means "took the default", which is what pressing
 * Enter does anyway.
 */
function ask(rl: Interface, query: string): Promise<string> {
  return new Promise((done) => {
    let settled = false;
    const finish = (value: string): void => {
      if (settled) return;
      settled = true;
      rl.off('close', atEof);
      done(value);
    };
    const atEof = (): void => finish('');
    rl.on('close', atEof);
    rl.question(query, (answerText) => finish(answerText.trim().toLowerCase()));
  });
}

async function chooseSession(
  connection: HostConnection,
  rl: Interface,
  say: (t: string) => void,
): Promise<Session | null> {
  const live = await connection.list();
  const onDisk = (await connection.listOnDisk()).filter(
    (d) => !live.some((s) => s.sessionId === d.sessionId),
  );

  if (live.length === 0 && onDisk.length === 0) return create(connection, rl, say);

  say(c.bold('sessions'));
  const options = [...live.map((s) => ({ id: s.sessionId, label: s.title, state: s.state })),
    ...onDisk.map((d) => ({ id: d.sessionId as SessionId, label: d.title, state: 'on disk' }))];
  options.forEach((o, i) => say(`  ${String(i + 1).padStart(2)}  ${o.state.padEnd(20)} ${o.label}`));

  const reply = await ask(rl, `  number, or Enter for a new session: `);
  if (reply === '') return create(connection, rl, say);

  const chosen = options[Number(reply) - 1];
  if (chosen === undefined) {
    say(c.fail('no such session'));
    return null;
  }
  // `resume` for one that was only on disk; a live one comes back as-is.
  return connection.resumeSession(chosen.id);
}

async function create(
  connection: HostConnection,
  rl: Interface,
  say: (t: string) => void,
): Promise<Session | null> {
  const title = await ask(rl, '  title: ');
  if (title === '') {
    say(c.dim('nothing to do'));
    return null;
  }
  const goal = (await ask(rl, '  goal (Enter to reuse the title): ')) || title;
  return connection.createSession({ title, goal });
}

async function ensureAgent(
  connection: HostConnection,
  session: Session,
  runtimes: string[],
  rl: Interface,
  say: (t: string) => void,
): Promise<AgentId | null> {
  const existing = session.agents[0];
  if (existing !== undefined) return existing.agentId;

  if (runtimes.length === 0) {
    say(c.fail('this host reported no runtimes — nothing can run here'));
    return null;
  }

  say(c.bold('runtimes'));
  runtimes.forEach((id, i) => say(`  ${String(i + 1).padStart(2)}  ${id}`));
  const reply = await ask(rl, `  number [1]: `);
  const runtimeId = runtimes[reply === '' ? 0 : Number(reply) - 1];
  if (runtimeId === undefined) {
    say(c.fail('no such runtime'));
    return null;
  }

  // Asked only when the runtime needs one. A wrapped harness brings its own
  // model, and a field it ignores invites a silent no-op.
  const model =
    runtimeId === 'agbrte-harness' ? await ask(rl, '  model [qwen2.5:7b]: ') || 'qwen2.5:7b' : null;

  const agent = await connection.addAgent(session.sessionId, {
    role: 'worker',
    runtimeId,
    ...(model !== null ? { model: { providerId: 'openai-compatible', modelId: model } } : {}),
  });
  return agent.agentId;
}
