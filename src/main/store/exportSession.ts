/**
 * A session, as a document somebody can read (DESIGN.md §15 Phase 8).
 *
 * The log is already JSONL — crash-safe, replayable, greppable — and that is the
 * right shape for a machine. What nobody can do today is *read* a session
 * outside the app, or attach one to a bug report, or keep one after deleting the
 * workspace it lived in. That is what this is for, and it is why the output is
 * Markdown rather than a JSON bundle: a bundle would be the log again, renamed.
 *
 * ## An export is the moment a transcript leaves
 *
 * §13 puts `.agbrte/` at `0700` and says a workspace "sitting on a shared
 * server must not be a credential leak". Everything protecting a transcript so
 * far has been about a directory. An export is a file the user will attach to an
 * email, and none of that applies to it.
 *
 * So the document **says what it contains, at the top, every time** — including
 * the parts a reader would not think to look for, like full `bash` arguments and
 * the paths an agent touched. This is disclosure rather than redaction: silently
 * stripping things would make the export a misleading record of what happened,
 * which is worse for the two jobs it exists to do. `toolArgs: 'summary'` is
 * offered for when the point is the shape of a run rather than its specifics.
 *
 * ## What it does not contain, and says so
 *
 * Attachments are referenced by hash, never embedded. A screenshot base64'd into
 * Markdown makes a 40 KB transcript into a 4 MB one, and the images are already
 * content-addressed in a directory beside the log. The header names the count
 * and the directory, so a reader knows the export is not the whole story rather
 * than assuming nothing was captured.
 */

import type { AgbrteEvent, Session } from '@shared/types/index.js';
import { formatCost, type Cost } from '@shared/cost.js';

export interface ExportOptions {
  /**
   * `full` reproduces what the gate saw, which is what makes the export usable
   * as evidence (§13 logs every decision with its arguments). `summary`
   * truncates them for sharing the shape of a run rather than its specifics.
   */
  toolArgs?: 'full' | 'summary';
  /** Overridable so a test is not at the mercy of a clock. */
  now?: () => Date;
}

const MAX_SUMMARY = 120;

export function exportSessionMarkdown(
  session: Session,
  events: readonly AgbrteEvent[],
  opts: ExportOptions = {},
): string {
  const full = (opts.toolArgs ?? 'full') === 'full';
  const now = opts.now ?? ((): Date => new Date());

  const captures = events.filter((e) => e.type === 'capture.attached').length;
  const out: string[] = [];

  // ------------------------------------------------------------------- header
  out.push(`# ${session.title}`, '');
  out.push(`> ${session.goal}`, '');
  out.push('| | |', '|---|---|');
  out.push(`| Session | \`${session.sessionId}\` |`);
  out.push(`| Started | ${session.createdAt} |`);
  out.push(`| State at export | ${session.state} |`);
  out.push(`| Target | ${session.target.kind} |`);
  for (const agent of session.agents) {
    const model = agent.spec.model ? ` · ${agent.spec.model.modelId}` : '';
    // A replaced seat is listed and said to be replaced. Dropping it would
    // leave the rows it wrote attributed to a name the header never mentions;
    // listing it silently would claim the session runs two models (§4.2).
    const retired = agent.status === 'retired' ? ' — retired' : '';
    out.push(`| Agent \`${agent.role}\` | ${agent.spec.runtimeId}${model}${retired} |`);
  }
  out.push(`| Exported | ${now().toISOString()} |`, '');

  /**
   * The disclosure, and it is not boilerplate.
   *
   * A reader of an exported transcript cannot tell what was left out, and the
   * person doing the exporting is about to attach it to something. Saying it
   * here costs four lines and is the only place it can be said.
   */
  out.push('**What this file contains.** Every turn, every tool call, and every');
  out.push(
    full
      ? 'permission decision — with **full tool arguments**, which include the commands run and the paths touched.'
      : 'permission decision, with tool arguments **truncated**.',
  );
  out.push(
    captures > 0
      ? // Named relative to the workspace's own Agbrte directory rather than
        // spelling it: that directory is `.agbrte/` on a workspace made today
        // and `.devagents/` on one made before the rename (§5.1), and this
        // function has no workspace root to ask. A path that is right for one
        // reader and wrong for the other is worse than one that says where to
        // start looking.
        `${captures} attachment(s) are referenced by hash and **not included**; the images are in the workspace's Agbrte directory, under \`sessions/${session.sessionId}/attachments/\`.`
      : 'No attachments were captured in this session.',
  );
  out.push('', '---', '');

  // -------------------------------------------------------------------- body
  let usage = { input: 0, output: 0 };
  let cost: Cost = 0;

  /**
   * Agent ids are UUIDs, and a transcript headed `### 🤖 019fe9dc-a82f-…` is not
   * a document anybody reads. Found by generating one and looking at it, which
   * no assertion here would have caught.
   */
  const roleOf = new Map(session.agents.map((a) => [a.agentId, a.role]));

  for (const event of events) {
    const line = render(event, full, roleOf);
    if (line !== null) out.push(line, '');

    if (event.type === 'usage') {
      usage = {
        input: usage.input + event.inputTokens,
        output: usage.output + event.outputTokens,
      };
      if (event.cost !== undefined) {
        cost = cost === 'unknown' || event.cost === 'unknown' ? 'unknown' : cost + event.cost;
      }
    }
  }

  // ------------------------------------------------------------------- totals
  out.push('---', '');
  out.push(
    `**${usage.input.toLocaleString()} in / ${usage.output.toLocaleString()} out tokens · ${formatCost(cost)}**`,
  );
  out.push('', `${events.length} events. Exported from Agbrte.`);

  return out.join('\n');
}

/** `null` for events that are bookkeeping rather than transcript. */
function render(
  event: AgbrteEvent,
  full: boolean,
  roleOf: ReadonlyMap<string, string>,
): string | null {
  const who = event.actor ? ` *(${event.actor.id})*` : '';

  switch (event.type) {
    case 'user.turn': {
      const text = event.content
        .map((b) =>
          b.type === 'text'
            ? b.text
            : b.type === 'image'
              ? `*[image ${b.width}×${b.height}, \`${b.sha256.slice(0, 12)}\`]*`
              : `*[${b.type}]*`,
        )
        .join('\n\n');
      return `### 🧑 You${who}\n\n${text}`;
    }

    case 'agent.text':
      return `### 🤖 ${agentName(event.agentId, roleOf)}\n\n${event.text}`;

    case 'agent.tool_use':
      return `> **${event.tool}** — ${args(event.args, full)}`;

    case 'agent.tool_result':
      // The outcome, because a transcript of calls with no results reads as an
      // agent talking to itself.
      return `> ${event.ok ? '✓' : '✗'} ${truncate(event.summary, 300)}`;

    case 'permission.requested':
      return `> ⚖️ asked to run **${event.tool}** — ${args(event.args, full)}`;

    case 'permission.decided':
      /**
       * Included even when policy settled it without a prompt.
       *
       * §13: without the settled ones "a transcript can show hundreds of tool
       * calls and no evidence the gate was ever consulted". An export that
       * dropped them would be exactly that transcript.
       */
      return `> ⚖️ **${event.decision.result}** via ${event.via}${
        event.decision.result === 'deny' && event.decision.reason
          ? ` — ${event.decision.reason}`
          : ''
      }${who}`;

    case 'permission.standing_grant':
      // The line every later `via standing-grant` refers back to (§17 Q19). An
      // export that dropped it would show the questions stopping for no stated
      // reason, attributed to nobody.
      return `> ⚖️ **standing grant** — every ask from here on is allowed without a prompt${who}`;

    case 'agent.stopped':
      return `> ■ stopped: \`${event.stop.kind}\`${'limit' in event.stop ? ` (${String(event.stop.limit)})` : ''}`;

    case 'agent.interrupted':
      return `> ✋ interrupted${event.delivered ? '' : ' — the runtime could not honour it'}${who}`;

    case 'content.downgraded':
      // Kept, because "this model keeps ignoring my screenshots" is exactly the
      // question an exported transcript gets read to answer (§3.5).
      return `> ⚠️ ${event.note.detail}`;

    case 'agent.message':
      return `> ✉️ ${event.message.from} → ${event.message.to}: ${truncate(
        event.message.content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join(' '),
        200,
      )}`;

    /*
     * Kept, and refusals with them (§17 Q22).
     *
     * An export is where a transcript leaves the `0700` directory §13 protects
     * it in, and the question it gets read to answer is "why did this session do
     * that" — for which "another session asked it to" is the whole answer. A
     * dropped line here would leave a turn nobody sent.
     */
    case 'session.peer_message_sent':
      return `> ✉️ → session \`${event.message.toSessionId}\` (${event.message.kind}): ${truncate(
        event.message.text,
        200,
      )}${event.delivered ? '' : ` — **not delivered**: ${event.refusedBecause ?? 'refused'}`}`;

    case 'session.peer_message_received':
      return `> ✉️ ← session \`${event.message.fromSessionId}\` (${event.message.kind}): ${truncate(
        event.message.text,
        200,
      )}`;

    case 'session.joined_group':
      return `> 👥 joined the group **${event.name}**${who}`;

    case 'session.left_group':
      return `> 👥 left its group${who}`;

    case 'session.state':
      return `> — ${event.from} → ${event.to}${event.reason ? ` (${event.reason})` : ''}`;

    case 'capture.attached':
      return `> 📎 attachment \`${event.sha256.slice(0, 12)}\` (${event.mime})`;

    case 'agent.created':
      return `> ＋ agent \`${event.role}\` on ${event.runtimeId}${event.model ? ` · ${event.model.modelId}` : ''}`;

    /*
     * The model changed here, and an exported transcript has to say so.
     *
     * Without this line the file reads as one agent whose answers change
     * character halfway down for no stated reason — the exact confusion §4.2
     * writes the event to prevent, and an export is where a reader has least
     * context to recover it from.
     */
    case 'agent.retired':
      return `> — retired ${event.was ?? 'this session’s agent'}${
        event.replacedBy !== undefined ? ', replaced by the agent below' : ''
      }${who}`;

    default:
      // Bookkeeping — usage, checklist churn, brief plumbing. Rendering every
      // one of these would bury the conversation the export exists to show.
      return null;
  }
}

/**
 * A name for an agent that a person can read.
 *
 * The role, plus a short id when a session has more than one agent in it — two
 * `worker`s are two agents and a transcript that calls them both `worker` is
 * worse than one that shows UUIDs.
 */
function agentName(agentId: string | undefined, roleOf: ReadonlyMap<string, string>): string {
  if (agentId === undefined) return 'agent';
  const role = roleOf.get(agentId);
  if (role === undefined) return agentId.slice(0, 8);
  const sameRole = [...roleOf.values()].filter((r) => r === role).length;
  return sameRole > 1 ? `${role} ${agentId.slice(0, 8)}` : role;
}

function args(value: unknown, full: boolean): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return full ? `\`${text}\`` : `\`${truncate(text, MAX_SUMMARY)}\``;
}

function truncate(text: string, at: number): string {
  return text.length > at ? `${text.slice(0, at)}…` : text;
}
