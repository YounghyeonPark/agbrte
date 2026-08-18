/**
 * Fixing the machine, from the screen that noticed it was broken (DESIGN.md
 * §6.4, §3.8, §6.5, §13).
 *
 * ## The screen this replaces
 *
 * A freshly attached ssh host gave `Add an agent` three sentences and no verbs:
 * *Claude Code … not detected on this host (ENOENT)*, *Gemini CLI … not detected
 * (ENOENT)*, *0 found. local: fetch failed*, and one runtime — the harness —
 * that cannot run without a model. Every sentence was accurate. Together they
 * described a dead end, and the app had the reach to fix all three and used it
 * only to report them. **A diagnosis with no remedy beside it is a worse screen
 * than a diagnosis with one, even when the diagnosis is perfect.**
 *
 * ## Open when there is nothing to choose, closed otherwise
 *
 * The panel is not a wizard and is not a step. Somebody whose machine already
 * has Claude Code should see a picker, not a setup form — so it is a disclosure,
 * and the *only* thing that opens it by itself is the state above: no installed
 * CLI and no model. That is the same rule the attach panel follows for its
 * search — the situation triggers it, not a click — and it fails the same way if
 * it is wrong: one extra closed row.
 *
 * ## Three routes, and why they look unequal
 *
 * They are unequal. Installing a CLI ends with something a person must still do
 * themselves — `claude` needs an interactive sign-in on that machine, and this
 * app's terminal pane is local-only — so it reports a follow-up sentence rather
 * than a tick. Installing Ollama ends with a working endpoint and then hands
 * over to the model browser that already exists. Adding an API endpoint is the
 * only one that both finishes the job and puts a credential on somebody else's
 * machine, which is stated at the moment of typing it rather than afterwards.
 *
 * ## The key
 *
 * The field is `type="password"`, is never put in component state that anything
 * else reads, is cleared the moment the call resolves, and is the one value in
 * this file that is not echoed anywhere. What comes back names the file it
 * landed in and whether a credential is attached — never the credential. §13
 * keeps credentials host-side; this is the app *handing one over* and then not
 * having it.
 */

import { useEffect, useState, type JSX } from 'react';
import type { HostInfo, SetupOutcomeDto, SetupPlanDto } from '../shared/ipc/contract.js';
import { opensOnItsOwn, setupSummary } from './setupRoutes.js';

const LABEL = 'text-[10px] uppercase tracking-wider';

export interface SetUpMachineProps {
  /** How to name the machine in a sentence: an ssh alias, or "this machine". */
  where: string;
  /** Runtimes this host looked for and did not find (§3.12). */
  notes: HostInfo['runtimeNotes'];
  /** Endpoints it can reach. Empty is the case the model browser got wrong. */
  endpoints: HostInfo['endpoints'];
  /** Whether anything on this host can run a model right now. */
  anyModels: boolean;
  /** Whether an installed CLI is already offered here. */
  anyCli: boolean;
  setUp: (plan: SetupPlanDto) => Promise<SetupOutcomeDto>;
  /** Steps as they happen, for this host. Returns its unsubscribe. */
  subscribeProgress: (cb: (step: string) => void) => () => void;
}

type Route = 'cli' | 'ollama' | 'endpoint';

export function SetUpMachine({
  where,
  notes,
  endpoints,
  anyModels,
  anyCli,
  setUp,
  subscribeProgress,
}: SetUpMachineProps): JSX.Element {
  const stuck = opensOnItsOwn(anyCli, anyModels);
  const [open, setOpen] = useState(stuck);
  const [route, setRoute] = useState<Route | null>(null);
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<string[]>([]);
  const [outcome, setOutcome] = useState<SetupOutcomeDto | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  // Endpoint form. Kept here rather than in a child so switching routes and
  // back does not silently keep a half-typed key alive in an unmounted tree.
  const [provider, setProvider] = useState('openai');
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1');
  const [endpointId, setEndpointId] = useState('openai');
  const [apiKey, setApiKey] = useState('');

  /*
   * Subscribed only while something is running.
   *
   * A push that nobody is looking at is a push that accumulates in a list a
   * closed panel will show stale on its next open — and this one arrives for
   * *every* host, so an unfiltered listener in a two-host app shows one
   * machine's steps under the other's name.
   */
  useEffect(() => {
    if (!busy) return;
    return subscribeProgress((step) => setSteps((was) => [...was, step]));
  }, [busy, subscribeProgress]);

  const run = async (plan: SetupPlanDto): Promise<void> => {
    setBusy(true);
    setSteps([]);
    setOutcome(null);
    setFailure(null);
    try {
      const result = await setUp(plan);
      setOutcome(result);
      // Cleared on success only. A key that was rejected — a typo, a wrong URL —
      // must survive so the fix is an edit rather than a retype from a password
      // manager.
      if (plan.kind === 'endpoint') setApiKey('');
    } catch (err) {
      // Verbatim. These sentences come from `curl`, `npm`, `tar` or the host's
      // own validator, about a machine the reader cannot see, and every attempt
      // to paraphrase one has made it less useful.
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-line grid gap-2 rounded-[2px] border p-3" data-testid="setup-machine">
      <div className="flex items-baseline justify-between gap-2">
        <span className={`${LABEL} text-muted`}>Set up {where}</span>
        <button
          type="button"
          className="btn-quiet shrink-0 text-[11px]"
          data-testid="setup-toggle"
          onClick={() => setOpen((was) => !was)}
        >
          {open ? 'Hide' : 'Show'}
        </button>
      </div>

      {/*
        The diagnosis, in one line, above the remedies.

        Deliberately the *same* facts `runtime-notes` and the model note carry —
        this does not detect anything of its own. Two answers to "what is missing
        here" would be two things to keep in step, and the picker's notes are the
        host's own words.
      */}
      <p className="text-muted m-0 text-[11px]" data-testid="setup-summary">
        {setupSummary(where, anyCli, anyModels)}
      </p>

      {open && (
        <div className="grid gap-2">
          <div className="flex flex-wrap gap-1">
            {(
              [
                ['cli', 'Install an agent CLI'],
                ['ollama', 'Install Ollama'],
                ['endpoint', 'Add an API endpoint'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`btn-quiet text-[11px] ${route === id ? 'text-accent' : ''}`}
                data-testid={`setup-route-${id}`}
                aria-pressed={route === id}
                disabled={busy}
                onClick={() => setRoute(route === id ? null : id)}
              >
                {label}
              </button>
            ))}
          </div>

          {route === 'cli' && (
            <div className="grid gap-1" data-testid="setup-cli">
              {/*
                Named honestly before the click, not after it.

                An install that ends in "now go and sign in over ssh" is a fine
                outcome and a terrible surprise. Saying it up front is what makes
                the button worth pressing: somebody who cannot open a terminal on
                that machine now knows to choose a different route instead of
                spending four minutes finding out.
              */}
              <p className="text-muted m-0 text-[11px]">
                Installs into <code>~/.agbrte/npm</code> on {where} with its own npm prefix —
                nothing system-wide, no sudo. Signing in is still yours to do afterwards, in an
                ssh session there.
              </p>
              {notes.length > 0 && (
                <ul className="text-muted m-0 grid gap-0.5 pl-4 text-[11px]">
                  {notes.map((n) => (
                    <li key={n.id}>{n.label} is not there now</li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap gap-1">
                <button
                  type="button"
                  className="btn-quiet text-accent text-[11px]"
                  data-testid="setup-install-claude"
                  disabled={busy}
                  onClick={() => void run({ kind: 'cli', cli: 'claude-code' })}
                >
                  Install Claude Code
                </button>
                <button
                  type="button"
                  className="btn-quiet text-accent text-[11px]"
                  data-testid="setup-install-gemini"
                  disabled={busy}
                  onClick={() => void run({ kind: 'cli', cli: 'gemini-cli' })}
                >
                  Install Gemini CLI
                </button>
              </div>
            </div>
          )}

          {route === 'ollama' && (
            <div className="grid gap-1" data-testid="setup-ollama">
              <p className="text-muted m-0 text-[11px]">
                Downloads Ollama into <code>~/.agbrte/ollama</code> on {where}, checks it against
                the checksum the release publishes, and starts it listening on{' '}
                <code>127.0.0.1:11434</code> — loopback only, so nobody else on that machine can
                reach it. About a gigabyte. Then pick a model from Browse models below.
              </p>
              <button
                type="button"
                className="btn-quiet text-accent justify-self-start text-[11px]"
                data-testid="setup-install-ollama"
                disabled={busy}
                onClick={() => void run({ kind: 'ollama' })}
              >
                Install and start Ollama
              </button>
            </div>
          )}

          {route === 'endpoint' && (
            <div className="grid gap-1" data-testid="setup-endpoint">
              {/*
                §6.5's table, at the moment of the decision.

                This is the *remote-resident credential* row: highest exposure,
                and the only arrangement in which a detached run keeps going with
                this app closed. Both halves are said here because they are one
                trade and reading only one of them leads to the wrong choice.
              */}
              <p className="text-muted m-0 text-[11px]">
                The key is sent to the host over this session's own channel — a unix socket for a
                local host, an ssh tunnel for a remote one — and written to{' '}
                <code>~/.agbrte/endpoints.json</code> there, mode 0600. It is not kept on this
                computer. That is what lets a run continue while this app is closed, and it means
                anyone who can read your home directory on {where} can use it.
              </p>
              <label className="text-muted grid gap-1 text-xs">
                Name
                <input
                  className="field"
                  data-testid="setup-endpoint-id"
                  value={endpointId}
                  onChange={(e) => setEndpointId(e.target.value)}
                  placeholder="openai"
                />
              </label>
              <label className="text-muted grid gap-1 text-xs">
                Provider
                <input
                  className="field"
                  data-testid="setup-endpoint-provider"
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                  placeholder="openai"
                />
              </label>
              <label className="text-muted grid gap-1 text-xs">
                Base URL
                <input
                  className="field"
                  data-testid="setup-endpoint-url"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
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
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="leave empty for a server that needs none"
                />
              </label>
              <button
                type="button"
                className="btn-quiet text-accent justify-self-start text-[11px]"
                data-testid="setup-add-endpoint"
                disabled={busy || endpointId.trim() === '' || baseUrl.trim() === ''}
                onClick={() =>
                  void run({
                    kind: 'endpoint',
                    endpoint: {
                      id: endpointId.trim(),
                      provider: provider.trim(),
                      baseUrl: baseUrl.trim(),
                      // Omitted rather than sent empty, so "no credential" is a
                      // shape the host can see rather than a string it has to
                      // interpret.
                      ...(apiKey === '' ? {} : { apiKey }),
                    },
                  })
                }
              >
                Add endpoint
              </button>
            </div>
          )}

          {steps.length > 0 && (
            /*
              Every step, kept.

              A single replaced line loses the one thing worth having when an
              install fails four minutes in: which step it got to. The host's own
              words, in order, is also what makes "the download worked and the
              unpack did not" legible without reading a log on another machine.
            */
            <ol className="text-muted m-0 grid gap-0.5 pl-4 text-[11px]" data-testid="setup-steps">
              {steps.map((step, i) => (
                <li key={`${i}-${step}`}>{step}</li>
              ))}
            </ol>
          )}

          {busy && (
            <p className="text-accent m-0 text-[11px]" data-testid="setup-busy">
              Working on {where}… this can take several minutes and survives closing this panel.
            </p>
          )}

          {failure !== null && (
            <p className="text-state-fail m-0 text-[11px]" data-testid="setup-failure">
              {failure}
            </p>
          )}

          {outcome !== null && (
            <div className="grid gap-1" data-testid="setup-outcome">
              <p
                className={outcome.redetected ? 'text-muted m-0 text-[11px]' : 'text-state-paused m-0 text-[11px]'}
                data-testid="setup-outcome-summary"
              >
                {/*
                  Which half worked, always. "Installed, and the host has not
                  noticed" is the state that actually happens — a host mid-turn
                  is entitled to refuse a restart — and reporting it as either
                  success or failure would be a false sentence about somebody's
                  machine.
                */}
                {outcome.detail ?? outcome.summary}
              </p>
              {outcome.followUp !== undefined && (
                <p className="text-state-paused m-0 text-[11px]" data-testid="setup-followup">
                  {outcome.followUp}
                </p>
              )}
            </div>
          )}

          {endpoints.length === 0 && (
            <p className="text-muted m-0 text-[11px]" data-testid="setup-no-endpoint">
              This host has no model endpoint at all, so there is nothing for a model to be
              installed into yet.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
