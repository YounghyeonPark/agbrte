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
 * **There is deliberately no "add a server to this session" control**, and that
 * is a report of what the owner supports rather than a gap in this file:
 * `SessionManager` attaches servers in `createSession` and has no command to
 * attach one later, so a button here would either lie or need the whole
 * lifecycle (a live connection appearing mid-turn, a tool list changing under a
 * model that has already been told what it has) designed first. Wanting one is
 * obvious; inventing half of it in a renderer is how the app and the log start
 * disagreeing about what a session could reach.
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
}

/**
 * The fields, folded away until wanted.
 *
 * `<details>` closed, like `Group`: most sessions attach no servers, and a
 * five-field block above the Create button would make the common case pay for
 * the rare one. The summary counts what is there so a filled-in form is not
 * hidden by its own fold.
 */
export function McpServerFields({ drafts, onChange }: McpServerFieldsProps): JSX.Element {
  const update = (index: number, next: McpDraft): void =>
    onChange(drafts.map((d, i) => (i === index ? next : d)));

  return (
    <details className="border-line rounded-[2px] border px-2 py-1" data-testid="mcp-fields">
      <summary className={`${LABEL} text-muted cursor-pointer`}>
        tools from an MCP server{drafts.length > 0 ? ` — ${drafts.length}` : ''}
      </summary>

      <div className="grid gap-2 pt-2">
        {/*
          Said before anything is typed, because it is the reason the fields are
          here and not in a settings page — and because it sets the expectation
          that this choice belongs to this session and no other.
        */}
        <p className="text-muted text-[11px] leading-relaxed">
          A server is started on this host when the session is created, and its tools arrive as{' '}
          <code>mcp__name__tool</code> — gated per call like any other. It belongs to this session
          only: nothing here carries over to the next one.
        </p>

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
