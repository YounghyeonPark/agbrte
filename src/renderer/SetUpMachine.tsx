/**
 * The two pieces of "set up this machine" that survived being absorbed into the
 * picker (DESIGN.md §6.4, §3.7, §3.8, §6.5, §13).
 *
 * ## Why there is no panel here any more
 *
 * A freshly attached ssh host gave `Add an agent` three sentences and no verbs —
 * *Claude Code … not detected (ENOENT)*, *Gemini CLI … not detected*, *0 found*
 * — and the app had the reach to fix all three and used it only to report them.
 * The remedy that answered it was a panel of routes, which was then cut to one
 * obvious action, which was then re-ranked to put models first. Every version
 * was an improvement and every version had the same flaw: **it was a second
 * place to answer the question the picker underneath it was already asking.**
 *
 * The screen had three controls that all answered *what should run this
 * session* — the set-up routes, the "what will run" dropdown, and a catalogue
 * with its own Install buttons — and choosing between them required knowing
 * which of our mechanisms applied to you. So the routes became entries in the
 * one list (`setupRoutes.ts`, `buildEntries`), and the panel stopped existing.
 *
 * What could not become a list entry is what is left here:
 *
 * - **`SetUpEndpoint`** — four fields and a credential, because a key cannot be
 *   guessed from a menu selection. Selecting *Use a model API…* reveals it.
 * - **`SetupProgress`** — the host's own words while something is being
 *   installed, its failures verbatim, and the follow-up an install ends with.
 *
 * ## The key
 *
 * Unchanged, and the reason this file is worth its own module. The field is
 * `type="password"`, is never echoed, and the value lives in exactly one place
 * in the renderer: the picker's state, cleared the moment the call resolves.
 * What comes back names the file it landed in and whether a credential is
 * attached — never the credential. §13 keeps credentials host-side; this is the
 * app *handing one over* and then not having it.
 *
 * ## What is refused, and by whom
 *
 * No entry is hidden for being impossible. A read-only browser client, a
 * transport that cannot hold a process open past the connection, and a client
 * built without a provisioner are each refused in main (`fleet.setUpHost`),
 * which is the only side that knows — §7 puts enforcement there precisely
 * because a client cannot police itself, and §6.2 says a transport's
 * capabilities are asked rather than assumed, so the renderer deliberately does
 * not keep a second copy of them to grey rows out with. The refusal arrives as a
 * sentence naming the reason and the way round it, and `SetupProgress` prints it
 * verbatim under the control that was pressed.
 */

import type { JSX } from 'react';
import { useState } from 'react';
import type {
  EndpointChainDto,
  ReadinessDto,
  SetupOutcomeDto,
} from '../shared/ipc/contract.js';

/** The endpoint form's four values, held by whoever renders it. */
export interface EndpointDraft {
  id: string;
  provider: string;
  baseUrl: string;
  /** Never read back for display, never logged, cleared on success. */
  apiKey: string;
  /**
   * Which adapter speaks to it — `openai-compatible` or `anthropic`.
   *
   * On the draft because the endpoints file grew the field and this form was the
   * only way of writing an endpoint that could not set it, so anything added
   * through the app was `openai-compatible` whatever it actually was.
   */
  api: string;
}

/**
 * What the form opens on, and it is a local server rather than a hosted API.
 *
 * It used to be `openai` / `https://api.openai.com/v1`, which made the whole
 * panel read as "paste a cloud key" — and the row that leads here still says
 * "a key kept on that machine". But the keyless case is not an exception here:
 * a vLLM or an NVIDIA NIM on the GPU box next to the agent is exactly what §3.8
 * calls `target-local`, the arrangement with *nothing to hold* and the lowest
 * exposure in §6.5's table. Opening on the highest-exposure row and leaving the
 * lowest to be discovered is the wrong way round.
 *
 * The port is vLLM's and NIM's default. Ollama has its own entry elsewhere and
 * is already the implicit fallback when no file exists, so it is not what a
 * person comes to this form to add.
 */
export const EMPTY_ENDPOINT: EndpointDraft = {
  id: 'gpubox',
  provider: 'local',
  baseUrl: 'http://127.0.0.1:8000/v1',
  apiKey: '',
  api: 'openai-compatible',
};

/**
 * Where a key is typed, and where the trade it makes is stated.
 *
 * Controlled rather than self-owning, so the one button on the screen can submit
 * it: the alternative was a second submit inside the form, which is the shape
 * this whole redesign exists to remove. The value lives one level up and nowhere
 * else.
 */
export function SetUpEndpoint({
  where,
  value,
  onChange,
}: {
  where: string;
  value: EndpointDraft;
  onChange: (next: EndpointDraft) => void;
}): JSX.Element {
  const set = (patch: Partial<EndpointDraft>): void => onChange({ ...value, ...patch });

  return (
    <div className="grid gap-1" data-testid="setup-endpoint">
      {/*
        §6.5's table, in one line — but only the row this endpoint is actually on.

        It used to say the credential sentence unconditionally, which is the
        *remote-resident credential* row: highest exposure, and the only
        arrangement in which a detached run keeps going with this app closed.
        Both halves of that trade have to be read together or the choice goes
        wrong, so the sentence is right — for an endpoint with a key.

        For one without, it was describing a key that does not exist. A vLLM or
        an NIM on the agent's own box is §6.5's `target-local` row: *nothing to
        hold*, lowest exposure, and a detached run keeps going because there was
        never a tunnel. Telling somebody adding one that "anyone who can read
        your home directory can use it" is a warning about a file that will not
        contain anything worth reading.
      */}
      <p className="text-muted m-0 text-[11px]">
        {value.apiKey === '' ? (
          <>
            A server on {where} with no key to hold — a vLLM, an NVIDIA NIM, anything speaking the
            OpenAI shape. Nothing is stored, and a run keeps going with this app closed because
            there is no tunnel to lose.
          </>
        ) : (
          <>
            The key is written to <code>~/.agbrte/endpoints.json</code> on {where} and not kept here
            — which is what lets a run continue with this app closed, and means anyone who can read
            your home directory there can use it.
          </>
        )}
      </p>
      <label className="text-muted grid gap-1 text-xs">
        Name
        <input
          className="field"
          data-testid="setup-endpoint-id"
          value={value.id}
          onChange={(e) => set({ id: e.target.value })}
          placeholder="openai"
        />
      </label>
      <label className="text-muted grid gap-1 text-xs">
        Provider
        <input
          className="field"
          data-testid="setup-endpoint-provider"
          value={value.provider}
          onChange={(e) => set({ provider: e.target.value })}
          placeholder="openai"
        />
      </label>
      {/*
        Which wire it speaks, which is not the same question as who receives it.

        `Provider` above is §13's disclosure — free text, shown wherever a turn's
        destination is displayed, and `"NVIDIA (on-prem)"` is a good value for
        it. This one must match an adapter id exactly or nothing routes, which is
        why the two are not one field: a config where the routing looks like a
        label is one somebody fills in with a label.

        A `select` rather than a text input, because unlike every other field
        here the set is closed and known — an unknown value is refused by the
        host, and offering a box to type a refusal into is offering a mistake.
      */}
      <label className="text-muted grid gap-1 text-xs">
        API
        <select
          className="field"
          data-testid="setup-endpoint-api"
          value={value.api}
          onChange={(e) => set({ api: e.target.value })}
        >
          <option value="openai-compatible">OpenAI-compatible — vLLM, NIM, Ollama, LM Studio</option>
          <option value="anthropic">Anthropic</option>
        </select>
      </label>
      <label className="text-muted grid gap-1 text-xs">
        Base URL
        <input
          className="field"
          data-testid="setup-endpoint-url"
          value={value.baseUrl}
          onChange={(e) => set({ baseUrl: e.target.value })}
          placeholder="http://127.0.0.1:8000/v1"
        />
      </label>
      <label className="text-muted grid gap-1 text-xs">
        API key
        <input
          className="field"
          type="password"
          autoComplete="off"
          spellCheck={false}
          data-testid="setup-endpoint-key"
          value={value.apiKey}
          onChange={(e) => set({ apiKey: e.target.value })}
          placeholder="leave empty for a server that needs none"
        />
      </label>
    </div>
  );
}

/**
 * What is happening on that machine, in its own words.
 *
 * Rendered under the one button, for every kind of work it does: installing a
 * model server, pulling a model, installing a CLI, writing an endpoint. One
 * place, because from here they are the same event — *the app is doing
 * something to a machine you cannot see* — and four differently-shaped progress
 * areas were four things to keep in step.
 */
export function SetupProgress({
  where,
  busy,
  steps,
  failure,
  outcome,
}: {
  where: string;
  busy: boolean;
  steps: string[];
  failure: string | null;
  outcome: SetupOutcomeDto | null;
}): JSX.Element | null {
  if (!busy && steps.length === 0 && failure === null && outcome === null) return null;

  return (
    <div className="grid gap-1">
      {steps.length > 0 && (
        /*
          Every step, kept.

          A single replaced line loses the one thing worth having when an install
          fails four minutes in: which step it got to. The host's own words, in
          order, are also what make "the download worked and the unpack did not"
          legible without reading a log on another machine — and they are where
          the mechanism belongs, because while it is happening it explains
          something.
        */
        <ol className="text-muted m-0 grid gap-0.5 pl-4 text-[11px]" data-testid="setup-steps">
          {steps.map((step, i) => (
            <li key={`${i}-${step}`}>{step}</li>
          ))}
        </ol>
      )}

      {busy && (
        <p className="text-accent m-0 text-[11px]" data-testid="setup-busy">
          Working on {where}… this can take several minutes and survives closing this window.
        </p>
      )}

      {failure !== null && (
        /*
          Verbatim. These sentences come from `curl`, `npm`, `tar`, `ollama` or
          the host's own validator, about a machine the reader cannot see, and
          every attempt to paraphrase one has made it less useful. The refusals
          arrive here too, each already carrying its own way round.
        */
        <p className="text-state-fail m-0 text-[11px]" data-testid="setup-failure">
          {failure}
        </p>
      )}

      {outcome !== null && (
        <div className="grid gap-1" data-testid="setup-outcome">
          <p
            className={
              outcome.redetected ? 'text-muted m-0 text-[11px]' : 'text-state-paused m-0 text-[11px]'
            }
            data-testid="setup-outcome-summary"
          >
            {/*
              Which half worked, always. "Installed, and the host has not
              noticed" is the state that actually happens — a host mid-turn is
              entitled to refuse a restart — and reporting it as either success
              or failure would be a false sentence about somebody's machine.
            */}
            {outcome.detail ?? outcome.summary}
          </p>
          {outcome.followUp !== undefined && (
            /*
              The half this app cannot do.

              For a CLI it is a sign-in that needs a browser and a terminal on
              that machine, and the agent seated a moment later cannot run
              without it — so it is also raised as a notice that survives landing
              in the chat (App.tsx, `say`). Printed here as well, because the
              person who is still looking at this pane should not have to go
              looking for it.
            */
            <p className="text-state-paused m-0 text-[11px]" data-testid="setup-followup">
              {outcome.followUp}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * What this machine still needs before vLLM or NIM could serve on it.
 *
 * ## Why a list of commands, and not a button
 *
 * Every other route on this screen ends in the app doing the work. This one
 * ends in a person doing it, and the reason is written into the steps
 * themselves: vLLM has no native Windows build and its own docs name WSL2,
 * which wants administrator rights and a restart; NIM's images are behind an
 * NGC account whose key `docker login nvcr.io` authenticates with. An app that
 * reboots somebody's machine or that could conjure an NVIDIA account is not the
 * remedy. Knowing *which* of those is in the way is.
 *
 * So the honest thing is a diagnosis, and the value in it is the ordering: a
 * missing GPU makes every later step pointless and is said alone, and the NGC
 * key is named even on a machine that already has Docker and the toolkit, so
 * somebody who cannot get one finds out here rather than after two installs.
 *
 * `why` is rendered only where it exists, and it exists only on the steps the
 * app is *choosing* not to automate. "Why isn't this a button" is the question a
 * list of manual commands provokes, and leaving it unanswered reads as the
 * feature being unfinished rather than as a decision.
 */
export function ServerReadiness({
  server,
  where,
  busy,
  answer,
}: {
  server: 'vllm' | 'nim';
  where: string;
  busy: boolean;
  answer: ReadinessDto | null;
}): JSX.Element | null {
  if (!busy && answer === null) return null;
  const name = server === 'vllm' ? 'vLLM' : 'NIM';

  if (busy) {
    return (
      <p className="text-accent m-0 text-[11px]" data-testid="readiness-busy">
        Looking at {where} — GPU, WSL, Docker, and whether anything is serving already…
      </p>
    );
  }
  if (answer === null) return null;

  return (
    <div className="grid gap-1" data-testid="readiness">
      <p
        className={
          answer.ready ? 'text-accent m-0 text-[11px]' : 'text-state-paused m-0 text-[11px]'
        }
        data-testid="readiness-summary"
      >
        {name} on {where}: {answer.summary}
      </p>

      {answer.steps.length > 0 && (
        /*
          Numbered, unlike the progress list above it, and the difference is who
          acts. That one is a log of what already happened, where an order is
          implied by the sequence. This one is instructions somebody carries to
          another window and comes back from — "I did two, what was three" is a
          question it should be able to answer.
        */
        <ol className="text-muted m-0 list-decimal pl-4 text-[11px]" data-testid="readiness-steps">
          {answer.steps.map((step, i) => (
            /*
              The grid is on the inner element, not on the `li`, and that is not
              cosmetic bookkeeping: `display: grid` on a list item drops its
              marker, and so does making the `ol` itself a grid — a browser
              generates no `::marker` for a grid item. Both were tried, and both
              produced a numbered list with no numbers on it.
            */
            <li key={`${i}-${step.what}`} className="mb-1.5 last:mb-0">
              <div className="grid gap-0.5">
                <span>{step.what}</span>
                {step.command !== undefined && (
                  /*
                    Selectable, and wrapping. These are meant to be copied into a
                    terminal on another machine, and a command truncated at the
                    pane's edge is one somebody retypes by eye — which is how a
                    `--password-stdin` turns into a key in a shell history.
                  */
                  <code className="control-note break-all select-text">{step.command}</code>
                )}
                {step.why !== undefined && <span className="opacity-70">{step.why}</span>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/**
 * The order this machine tries its endpoints in, and a way to change it (§3.9).
 *
 * ## Why this is a screen at all
 *
 * The order has routed turns for a while: `nextAfter` answers it,
 * `askWithFailover` walks it, and a move writes `model.endpoint_switched` into
 * the transcript with the reason it moved. What no client could do was *see* it,
 * let alone set it — `endpoints.add` was the only endpoint write on the wire, so
 * the order every turn on a machine follows could be changed in exactly one way:
 * by opening `endpoints.json` on that machine. For the remote GPU box the
 * feature exists for, that is an ssh session and hand-edited JSON.
 *
 * The invisible half was the worse one. §13 requires that where source code goes
 * be legible before it is sent, and a fallback is a *second* recipient chosen in
 * advance: somebody whose turns had moved to a hosted API could read the reason
 * in the transcript and could not read the configuration that put it there.
 *
 * ## Up and down, not drag and drop
 *
 * Two buttons per row, which is the whole interaction. Dragging is nicer with a
 * mouse and unusable with a keyboard, poor on a phone — where §7 says this app
 * has to work — and it is a lot of code for a list that is realistically three
 * items long. Reordering is also the kind of thing people do once.
 *
 * ## Nothing is written until it is asked for
 *
 * The order is local until *Save* — so a two-step rearrangement is not two
 * writes, two host restarts and two windows during which a turn would have gone
 * somewhere half-chosen. It also makes cancelling free: leave the panel.
 */
export function EndpointOrder({
  endpoints,
  chain,
  where,
  busy,
  outcome,
  onSave,
}: {
  endpoints: Array<{ id: string; label: string; provider: string }>;
  /** What the host says is in force. Empty when it has no order to report. */
  chain: string[];
  where: string;
  busy: boolean;
  outcome: EndpointChainDto | null;
  onSave: (order: string[]) => void;
}): JSX.Element | null {
  /*
   * The host's order first, then anything it does not mention.
   *
   * An endpoint absent from the chain is not an error and is common: adding one
   * does not put it in the order, so a machine can have four endpoints and an
   * order over two of them. Leaving those rows out would make them look deleted;
   * showing them at the end, after the ordered ones, is what they are — reachable
   * by name, never reached by a fallback.
   */
  const initial = [
    ...chain.filter((id) => endpoints.some((e) => e.id === id)),
    ...endpoints.filter((e) => !chain.includes(e.id)).map((e) => e.id),
  ];
  const [order, setOrder] = useState<string[] | null>(null);
  const current = order ?? initial;

  // Nothing to order. Said by rendering nothing rather than by a panel
  // explaining that a list of one has no order.
  if (endpoints.length < 2) return null;

  const move = (from: number, to: number): void => {
    if (to < 0 || to >= current.length) return;
    const next = [...current];
    const [taken] = next.splice(from, 1);
    if (taken !== undefined) next.splice(to, 0, taken);
    setOrder(next);
  };

  const changed = order !== null && order.join(' ') !== initial.join(' ');
  const labelOf = (id: string): { label: string; provider: string } => {
    const found = endpoints.find((e) => e.id === id);
    return { label: found?.label ?? id, provider: found?.provider ?? '' };
  };

  return (
    <details className="border-line rounded-surface border" data-testid="endpoint-order">
      <summary className="text-muted cursor-pointer px-2 py-1.5 text-[11px]">
        {chain.length === 0
          ? 'Fallback order — not set'
          : `Fallback order — ${labelOf(current[0] ?? '').label} first`}
      </summary>

      <div className="grid gap-1.5 px-2 pt-1 pb-2">
        <p className="text-muted m-0 text-[11px]">
          A turn refused, rate-limited or sent to an unreachable server moves down this list and
          carries on. A missing credential and a malformed request stay put.
        </p>

        <ol className="m-0 grid list-decimal gap-1 pl-4" data-testid="endpoint-order-list">
          {current.map((id, i) => {
            const { label, provider } = labelOf(id);
            return (
              <li key={id} className="min-w-0">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 grow truncate text-xs" data-testid="endpoint-order-row">
                    {label}
                    {/* §13's disclosure, on the row that decides where a turn
                        goes second. A fallback is a recipient chosen in advance,
                        and choosing one without seeing the provider is the quiet
                        change this rule exists to stop. */}
                    <span className="text-muted"> · {provider}</span>
                  </span>
                  <button
                    className="btn-quiet"
                    aria-label={`move ${label} up`}
                    data-testid={`endpoint-up-${id}`}
                    disabled={busy || i === 0}
                    onClick={() => move(i, i - 1)}
                  >
                    Up
                  </button>
                  <button
                    className="btn-quiet"
                    aria-label={`move ${label} down`}
                    data-testid={`endpoint-down-${id}`}
                    disabled={busy || i === current.length - 1}
                    onClick={() => move(i, i + 1)}
                  >
                    Down
                  </button>
                </div>
              </li>
            );
          })}
        </ol>

        <div className="flex items-center gap-2">
          <button
            className="btn text-accent"
            data-testid="endpoint-order-save"
            disabled={busy || !changed}
            onClick={() => onSave(current)}
          >
            {busy ? 'Saving…' : 'Save order'}
          </button>
          {changed && !busy && (
            <button className="btn-quiet" onClick={() => setOrder(null)}>
              Cancel
            </button>
          )}
        </div>

        {outcome !== null && (
          <p
            className={
              outcome.inForce ? 'text-muted m-0 text-[11px]' : 'text-state-paused m-0 text-[11px]'
            }
            data-testid="endpoint-order-outcome"
          >
            {outcome.inForce
              ? `Saved to ${outcome.path} on ${where}, and the host restarted onto it.`
              : /* The half that happened, named as the half it is. The remedy is
                   a restart rather than another write, and saying "failed" would
                   send somebody to write the same order again. */
                outcome.detail}
          </p>
        )}
      </div>
    </details>
  );
}
