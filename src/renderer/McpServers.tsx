/**
 * Attaching an MCP server to a session, and saying what it gave you (§17 Q20).
 *
 * ## Why this is on the creation form and nowhere else
 *
 * Q20's answer is that an MCP server is *session state* — "named in
 * `CreateSessionInput.mcpServers` when the person is present" — rather than an
 * app preference somebody turned on months ago. The form that makes a session is
 * therefore the only honest place for these fields: it is the moment where what
 * this session may reach is being decided, by the person deciding it, with the
 * decision going straight into that session's log as `mcp.attached`.
 *
 * ## …and now on the session too, because the owner grew the command
 *
 * This used to say there was deliberately no "add a server to this session"
 * control, and that it was a report of what the owner supported rather than a
 * gap here: `SessionManager` attached servers in `createSession` and had no
 * command to attach one later, so a button would either lie or need the
 * lifecycle designed first. That was the right thing to write and the right
 * thing to refuse to fake. The lifecycle is designed now — `session.attachMcp`,
 * v24 — and the two questions it was waiting on have the same answer:
 *
 *   * **a live connection appearing mid-turn** — the spec is built per turn, so
 *     a server attached during one takes effect from the next. Nothing changes
 *     under a running model. `groupPeers` already works exactly this way.
 *   * **the log and the app disagreeing** — they cannot: attaching appends
 *     `mcp.attached` at the moment it happens, so the transcript carries when
 *     the tools arrived rather than implying they were there from the start.
 *
 * What that buys is not convenience. A resumed session comes back with no MCP
 * connections *by design* — the env values were credentials the log does not
 * carry — so before this, a restart cost a session its tools permanently, and
 * the only cure was making a different session. Q20 says a server is named
 * "when the person is present"; a person re-attaching after a restart is that.
 *
 * ## Env values are credentials, and this file treats them as such
 *
 * They are typed into a masked field, they are never read back out of a session
 * for display, they are never put in a `title`, and the drafts holding them are
 * dropped the moment the create is sent. The only place a value goes is the
 * config that crosses `session.create` — §13's rule verbatim, and the same one
 * that makes `mcp.attached` record env *names* only.
 *
 * ## The failure is shown where the tools would have been
 *
 * §3.5: a server that would not start refuses nothing else, so the session runs
 * with what did attach. A person who is not told that reads "the model ignored
 * my tool" as the feature being broken, so `mcp.failed`'s reason takes the exact
 * place in the list its tool names would have occupied.
 */

import type { JSX } from 'react';
import type { McpServerStatus } from '../shared/types/index.js';
import { LABEL } from './App.js';
import { draftProblem, emptyDraft, type McpDraft } from './mcpConfig.js';

export interface McpServerFieldsProps {
  drafts: McpDraft[];
  onChange: (next: McpDraft[]) => void;
  /** Wrap the fields in their own fold. False inside a panel that is one. */
  folded?: boolean;
  /** The sentence above the fields, where the default one would not be true. */
  note?: JSX.Element;
}

/**
 * The fields, folded away until wanted.
 *
 * `<details>` closed, like `Group`: most sessions attach no servers, and a
 * five-field block above the Create button would make the common case pay for
 * the rare one. The summary counts what is there so a filled-in form is not
 * hidden by its own fold.
 */
export function McpServerFields({
  drafts,
  onChange,
  folded = true,
  note,
}: McpServerFieldsProps): JSX.Element {
  const update = (index: number, next: McpDraft): void =>
    onChange(drafts.map((d, i) => (i === index ? next : d)));

  const body = (
      <div className="grid gap-2 pt-2">
        {/*
          Said before anything is typed, because it is the reason the fields are
          here and not in a settings page — and because it sets the expectation
          that this choice belongs to this session and no other.

          Overridable because these fields have two homes now: the form that
          makes a session, where a server starts *when it is created*, and the
          panel on a session that already exists, where it starts at once. Same
          fields, same rules, and a sentence that is true in the place it is
          read.
        */}
        {note ?? (
          <p className="text-muted text-[11px] leading-relaxed">
            A server is started on this host when the session is created, and its tools arrive as{' '}
            <code>mcp__name__tool</code> — gated per call like any other. It belongs to this
            session only: nothing here carries over to the next one.
          </p>
        )}

        {drafts.map((draft, index) => {
          const problem = draftProblem(draft, drafts);
          return (
            <div
              key={index}
              className="border-line grid gap-1 rounded-[2px] border p-2"
              data-testid="mcp-row"
              data-index={index}
            >
              <input
                className="field text-[11px]"
                data-testid="mcp-id"
                placeholder="name — e.g. search"
                value={draft.id}
                onChange={(e) => update(index, { ...draft, id: e.target.value })}
              />
              <input
                className="field text-[11px]"
                data-testid="mcp-command"
                placeholder="command — e.g. node"
                value={draft.command}
                onChange={(e) => update(index, { ...draft, command: e.target.value })}
              />
              <input
                className="field text-[11px]"
                data-testid="mcp-args"
                placeholder={'arguments — quote anything with a space'}
                value={draft.args}
                onChange={(e) => update(index, { ...draft, args: e.target.value })}
              />

              <div className="grid gap-1">
                {draft.env.map((entry, envIndex) => (
                  <div key={envIndex} className="flex gap-1" data-testid="mcp-env-row">
                    <input
                      className="field text-[11px]"
                      data-testid="mcp-env-key"
                      placeholder="VARIABLE"
                      value={entry.key}
                      onChange={(e) =>
                        update(index, {
                          ...draft,
                          env: draft.env.map((x, i) =>
                            i === envIndex ? { ...x, key: e.target.value } : x,
                          ),
                        })
                      }
                    />
                    {/*
                      Masked, and never re-rendered from anywhere but this
                      keystroke. §13 treats it as a credential from the moment
                      it is typed — the log records only the name, and so does
                      every other view in this app.
                    */}
                    <input
                      className="field text-[11px]"
                      data-testid="mcp-env-value"
                      type="password"
                      autoComplete="off"
                      placeholder="value — not recorded"
                      value={entry.value}
                      onChange={(e) =>
                        update(index, {
                          ...draft,
                          env: draft.env.map((x, i) =>
                            i === envIndex ? { ...x, value: e.target.value } : x,
                          ),
                        })
                      }
                    />
                    <button
                      type="button"
                      className="btn shrink-0 px-2 py-1 text-[11px]"
                      data-testid="mcp-env-remove"
                      title="Remove this variable"
                      onClick={() =>
                        update(index, { ...draft, env: draft.env.filter((_, i) => i !== envIndex) })
                      }
                    >
                      ×
                    </button>
                  </div>
                ))}

                <div className="flex gap-1">
                  <button
                    type="button"
                    className="btn text-[11px]"
                    data-testid="mcp-env-add"
                    onClick={() => update(index, { ...draft, env: [...draft.env, { key: '', value: '' }] })}
                  >
                    Add a variable
                  </button>
                  <button
                    type="button"
                    className="btn text-[11px]"
                    data-testid="mcp-remove"
                    onClick={() => onChange(drafts.filter((_, i) => i !== index))}
                  >
                    Remove this server
                  </button>
                </div>
              </div>

              {/* The host refuses these too — this only means the refusal arrives
                  while the field is still in front of the person. */}
              {problem !== null && (
                <p className="text-state-fail text-[11px]" data-testid="mcp-problem">
                  {problem}
                </p>
              )}
            </div>
          );
        })}

        <button
          type="button"
          className="btn text-[11px]"
          data-testid="mcp-add"
          onClick={() => onChange([...drafts, emptyDraft()])}
        >
          Add a server
        </button>
      </div>
  );

  /*
   * One fold, not two.
   *
   * On the creation form these fields are the rare case and fold themselves
   * away. Inside the session panel the panel is already the fold, and a second
   * one meant opening `mcp`, then opening `tools from an MCP server`, then
   * typing — three gestures to reach a field somebody had already asked for.
   */
  if (!folded) return body;

  return (
    <details className="border-line rounded-[2px] border px-2 py-1" data-testid="mcp-fields">
      <summary className={`${LABEL} text-muted cursor-pointer`}>
        tools from an MCP server{drafts.length > 0 ? ` — ${drafts.length}` : ''}
      </summary>
      {body}
    </details>
  );
}

/**
 * What the servers this session was created with actually contributed.
 *
 * Read off `Session.mcp`, which the owning host fills in at creation, so this
 * says what attached rather than what was asked for — the two differ exactly
 * when something went wrong, which is the case worth rendering.
 */
export function McpAttached({ servers }: { servers?: McpServerStatus[] }): JSX.Element | null {
  // Absent means none were ever named. A panel saying "no MCP servers" on every
  // session would teach people to stop reading this row.
  if (servers === undefined || servers.length === 0) return null;

  return (
    <div
      data-testid="mcp-attached"
      className="border-line flex shrink-0 flex-wrap items-start gap-x-4 gap-y-1 border-b px-4 py-2"
    >
      {servers.map((server) => (
        <div key={server.id} className="grid gap-1" data-testid="mcp-server" data-server={server.id}>
          <span className={`${LABEL} text-muted`}>mcp · {server.id}</span>
          {server.error === undefined ? (
            <span className="flex flex-wrap gap-2">
              {server.tools.map((tool) => (
                <span key={tool} className="text-[11px]" data-testid="mcp-tool" data-tool={tool}>
                  {tool}
                </span>
              ))}
              {/* A server that started and offered nothing is not a failure and
                  is also not usable, and the difference from the line below is
                  worth a reader's attention. */}
              {server.tools.length === 0 && (
                <span className="text-muted text-[11px]" data-testid="mcp-no-tools">
                  attached, but offered no tools
                </span>
              )}
            </span>
          ) : (
            /* §3.5, and the whole reason this component exists: the reason takes
               the place the tool names would have had. */
            <span className="text-state-fail text-[11px]" data-testid="mcp-failed">
              did not start — {server.error}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Attaching a server to the session you are looking at (§17 Q20, v24).
 *
 * Folded, and beside the group for the same reason: it is read rarely, changed
 * rarely, and the transcript is the only thing on that column allowed to give up
 * height. The summary counts what is attached so a session with tools says so
 * without being opened.
 *
 * One draft rather than a list. The creation form takes several because a
 * session is being described all at once; here a person has come to add *a*
 * server, and a list would ask them to manage rows before they can press a
 * button. The field clears on success and keeps its contents on failure, which
 * is the only way to fix a typo in a command without retyping a credential.
 *
 * The env values leave through `onAttach` and nowhere else. Nothing in this
 * component reads them back, and `servers` — what the session says it has —
 * carries names and tools, never a value (§13).
 */
export function McpPanel({
  servers,
  draft,
  onDraft,
  onAttach,
  busy,
}: {
  servers?: McpServerStatus[];
  draft: McpDraft;
  onDraft: (next: McpDraft) => void;
  onAttach: () => void;
  busy?: boolean;
}): JSX.Element {
  const attached = servers ?? [];
  // The same rule the host enforces, said while the field is still in front of
  // the person. `[]` because a single draft has no siblings to collide with —
  // the duplicate check that matters here is against what is *attached*, and
  // that one is the host's: it knows what the session actually holds.
  const problem = draftProblem(draft, []);
  const ready = draft.id.trim() !== '' && draft.command.trim() !== '' && problem === null;

  return (
    <details className="border-line rounded-[2px] border px-2 py-1" data-testid="mcp-panel">
      <summary className={`${LABEL} text-muted cursor-pointer`}>
        mcp{attached.length > 0 ? ` — ${attached.length}` : ''}
      </summary>

      <div className="grid gap-2 pt-2">
        {attached.length > 0 && (
          <div className="grid gap-1" data-testid="mcp-panel-attached">
            {attached.map((server) => (
              <div key={server.id} className="flex flex-wrap items-baseline gap-2">
                <span className={`${LABEL} text-muted`}>{server.id}</span>
                {server.error === undefined ? (
                  <span className="text-muted text-[11px]">
                    {server.tools.length === 0
                      ? 'attached, but offered no tools'
                      : `${server.tools.length} tool${server.tools.length === 1 ? '' : 's'}`}
                  </span>
                ) : (
                  /* §3.5 again, in the panel: the reason takes the place the
                     tool count would have had, so a server that never started
                     is not read as one that offered nothing. */
                  <span className="text-state-fail text-[11px]">did not start — {server.error}</span>
                )}
              </div>
            ))}
          </div>
        )}

        <McpServerFields
          drafts={[draft]}
          onChange={(next) => onDraft(next[0] ?? draft)}
          folded={false}
          note={
            <p className="text-muted text-[11px] leading-relaxed">
              The server starts on this session&rsquo;s machine now, and its tools —{' '}
              <code>mcp__name__tool</code>, gated per call — are available from your next turn.
              This session only, and it does not survive a restart: the log records what a server
              was given, never the values, so nothing here can reconnect it for you.
            </p>
          }
        />

        <button
          type="button"
          className="btn text-[11px]"
          data-testid="mcp-attach"
          disabled={busy === true || !ready}
          onClick={onAttach}
        >
          {busy === true ? 'Attaching…' : 'Attach'}
        </button>
      </div>
    </details>
  );
}
