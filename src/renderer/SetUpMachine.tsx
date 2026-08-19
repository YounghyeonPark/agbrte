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
import type { SetupOutcomeDto } from '../shared/ipc/contract.js';

/** The endpoint form's four values, held by whoever renders it. */
export interface EndpointDraft {
  id: string;
  provider: string;
  baseUrl: string;
  /** Never read back for display, never logged, cleared on success. */
  apiKey: string;
}

export const EMPTY_ENDPOINT: EndpointDraft = {
  id: 'openai',
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
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
        §6.5's table, in one line, at the moment of the decision.

        This is the *remote-resident credential* row: highest exposure, and the
        only arrangement in which a detached run keeps going with this app
        closed. Both halves of that trade are in the sentence, because reading
        only one of them leads to the wrong choice.
      */}
      <p className="text-muted m-0 text-[11px]">
        The key is written to <code>~/.agbrte/endpoints.json</code> on {where} and not kept here —
        which is what lets a run continue with this app closed, and means anyone who can read your
        home directory there can use it.
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
      <label className="text-muted grid gap-1 text-xs">
        Base URL
        <input
          className="field"
          data-testid="setup-endpoint-url"
          value={value.baseUrl}
          onChange={(e) => set({ baseUrl: e.target.value })}
          placeholder="https://api.example.com/v1"
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
