/**
 * Settings (DESIGN.md §7, §14).
 *
 * There was no such pane, and the things that belong in one were scattered or
 * absent. `About` was a top-level button because the menu bar used to be the one
 * place an About lived; and two preferences this client keeps had **no control
 * at all**. (A theme picker lived here too, for as long as there was more than
 * one theme.)
 *
 * ## What is here because it was missing, not because it was moved
 *
 * - **What each host seats by default.** One successful add teaches it, and from
 *   then on every zero-agent session on that host is seated before the picker
 *   can be shown. That is the right behaviour — the first run teaches the form,
 *   every later run skips it — and it was unreachable: nothing said it was
 *   happening and nothing offered to stop it. A person who tried Claude once was
 *   given it forever.
 * - **Which machines this app offers.** `machines.ts` has had a `forgetMachine`
 *   since it was written and nothing ever called it, so the ssh aliases offered
 *   by the attach panel and the new-session form only ever grew.
 *
 * ## And what is deliberately *not* here
 *
 * The keys the machine holds (§13) stay in the creation form, where somebody is
 * already being asked for one. That placement is a decision with a test on it:
 * they are legible and removable "where somebody is already being asked for keys
 * — rather than in a settings page they would have to know exists". A settings
 * pane existing does not make that argument any less true, and mirroring them
 * here would put a credential list one click from the front door for the
 * convenience of a case that already works.
 */

import { useState, type JSX } from 'react';
import { About } from './About.js';
import { forgetAgentDefault, listAgentDefaults } from './agentDefaults.js';
import { forgetMachine, loadMachines, type Machine } from './machines.js';
import type { HostInfo, UpdateState } from '@shared/ipc/contract.js';
import { LABEL } from './App.js';

export function Settings({
  hosts,
  update,
}: {
  hosts: HostInfo[];
  update: UpdateState;
}): JSX.Element {
  return (
    <div className="m-auto grid w-full max-w-xl gap-6 p-6" data-testid="settings">
      <div className="grid gap-2">
        <h2 className="text-xl">Settings</h2>
        <p className="text-muted text-sm leading-relaxed">
          Kept by this client, on this device. A host owns the log, the queue and the
          permission gate; none of what is below travels to one.
        </p>
      </div>

      <Remembered hosts={hosts} />
      <Updates update={update} />

      {/* The About pane, unchanged, as a section rather than a destination. It
          was a top-level button only because the menu bar used to be the one
          place an About lived, and a version number is not a place to go. */}
      <div className="grid gap-2">
        <span className={`${LABEL} text-muted`}>About</span>
        <About inset />
      </div>
    </div>
  );
}

/**
 * Where this application's own update stands (`main/update.ts`).
 *
 * The window used to show exactly one of the updater's seven states: the banner
 * that appears once a download is ready. Checking, downloading, failing and
 * "this build cannot update itself" were all invisible, so a laptop that had
 * been offline at launch simply stayed on the old version with nothing anywhere
 * saying it had tried — found the ordinary way, by somebody asking why a release
 * published an hour earlier had not arrived.
 *
 * Every state is a sentence here, and a failure is red rather than muted (§4.1):
 * it is the one that needs somebody, if only to know that the version on their
 * screen is not the newest one. "Not checked yet" is kept apart from "up to
 * date", because before the first check returns nobody knows, and saying "up to
 * date" then would be an unknown rendered as a no (§3.3).
 *
 * And it can be asked. The only other ways to make the app look were to wait up
 * to six hours or to quit and relaunch it — and quitting is also how a
 * downloaded update installs, which makes "relaunch to find out" a strange
 * instruction to give anybody.
 */
function Updates({ update }: { update: UpdateState }): JSX.Element {
  const [asking, setAsking] = useState(false);

  const line = ((): string => {
    switch (update.phase) {
      case 'idle':
        return 'Not checked yet. The app looks when it starts, and every six hours after.';
      case 'checking':
        return 'Checking for a new version…';
      case 'current':
        return `Up to date. Last checked at ${new Date(update.checkedAt).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        })}.`;
      case 'downloading':
        return (
          `Downloading ${update.version ?? 'a new version'} — ${update.percent}%. ` +
          'It installs when you close the app.'
        );
      case 'ready':
        return `${update.version} is downloaded. It installs when you close the app, or now:`;
      case 'failed':
        return `Could not check for a new version: ${update.reason}`;
      case 'unsupported':
        return `This copy does not update itself: ${update.reason}.`;
    }
  })();

  const tone =
    update.phase === 'failed'
      ? 'text-state-fail'
      : update.phase === 'ready'
        ? 'text-accent'
        : 'text-muted';
  // Nothing to look for when the build cannot update, and nothing to gain once a
  // version is waiting — the next step then is the restart, not another check.
  const canCheck = update.phase !== 'unsupported' && update.phase !== 'ready';
  const checking = asking || update.phase === 'checking';
  // Held while a download runs too, but not *labelled* as checking: it is not,
  // and the line above already says what is happening.
  const busy = checking || update.phase === 'downloading';

  return (
    <div className="grid gap-2" data-testid="updates">
      <span className={`${LABEL} text-muted`}>Updates</span>
      <p
        className={`${tone} text-xs leading-relaxed`}
        data-testid="update-status"
        data-phase={update.phase}
      >
        {line}
      </p>
      {(canCheck || update.phase === 'ready') && (
        <div className="flex gap-2">
          {update.phase === 'ready' && (
            <button
              className="btn text-accent px-3 py-1 text-xs"
              data-testid="update-restart"
              onClick={() => void window.agbrte.update.installNow()}
            >
              Restart to update
            </button>
          )}
          {canCheck && (
            <button
              className="btn px-3 py-1 text-xs"
              data-testid="update-check"
              disabled={busy}
              onClick={() => {
                setAsking(true);
                void window.agbrte.update
                  .check()
                  .catch(() => undefined)
                  .finally(() => setAsking(false));
              }}
            >
              {checking ? 'Checking…' : update.phase === 'failed' ? 'Check again' : 'Check for updates'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The two things this client remembers and could not be told to forget.
 *
 * Both are shown with what they will *do* rather than with their stored shape: a
 * default is named by the agent it will seat, and a machine by the alias it will
 * offer. A list of instance ids would be a settings page nobody can act on.
 */
function Remembered({ hosts }: { hosts: HostInfo[] }): JSX.Element {
  const [defaults, setDefaults] = useState(() => listAgentDefaults());
  const [machines, setMachines] = useState<Machine[]>(() => loadMachines());

  /*
   * Named by the host where one is attached, and by the id where one is not.
   *
   * A default outlives the host it was learned on — the entry is keyed by
   * `instanceId` and a host that is not running right now still has one. Hiding
   * those would make the list disagree with what actually happens the next time
   * that machine is attached.
   */
  const nameOf = (instanceId: string): string =>
    hosts.find((h) => h.instanceId === instanceId)?.label ?? instanceId;

  // `local` is not forgettable: it is where the app is running, and offering to
  // remove it would be a control that puts the list in a state it cannot mean.
  // Filtered on `kind` rather than on the id, so a machine that happens to be
  // reached at an address spelled `local` is still an ssh host.
  const forgettable = machines.filter((m) => m.kind === 'ssh');

  return (
    <div className="grid gap-4" data-testid="remembered">
      <div className="grid gap-2">
        <span className={`${LABEL} text-muted`}>What each host seats by default</span>
        {defaults.length === 0 ? (
          <p className="text-muted text-xs leading-relaxed" data-testid="no-defaults">
            Nothing yet. The first agent you add on a host is remembered, and later
            sessions there start with it instead of asking.
          </p>
        ) : (
          <div className="grid gap-1.5">
            {defaults.map(({ instanceId, choice }) => (
              <div
                key={instanceId}
                data-testid="remembered-default"
                data-instance={instanceId}
                className="border-line flex items-center gap-3 rounded-control border px-3 py-2"
              >
                <span className="grid min-w-0 gap-0.5">
                  <span className="truncate-line text-[13px]">{nameOf(instanceId)}</span>
                  <span className="text-muted truncate-line text-xs">
                    {choice.runtimeId}
                    {choice.model !== null ? ` · ${choice.model.modelId}` : ''}
                  </span>
                </span>
                <button
                  type="button"
                  className="btn-quiet ml-auto shrink-0 text-[11px]"
                  data-testid="forget-default"
                  title="Ask again on the next session here"
                  onClick={() => {
                    forgetAgentDefault(instanceId);
                    setDefaults(listAgentDefaults());
                  }}
                >
                  Ask again
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="grid gap-2">
        <span className={`${LABEL} text-muted`}>Machines this app offers</span>
        {forgettable.length === 0 ? (
          <p className="text-muted text-xs leading-relaxed" data-testid="no-machines">
            Only this one. An ssh host is remembered here once you attach it, so the
            next attach offers it by name.
          </p>
        ) : (
          <div className="grid gap-1.5">
            {forgettable.map((machine) => (
              <div
                key={machine.id}
                data-testid="remembered-machine"
                data-alias={machine.id}
                className="border-line flex items-center gap-3 rounded-control border px-3 py-2"
              >
                <span className="truncate-line min-w-0 text-[13px]">{machine.label}</span>
                <button
                  type="button"
                  className="btn-quiet ml-auto shrink-0 text-[11px]"
                  data-testid="forget-machine"
                  /* Stops offering it; does not detach anything. A host that is
                     attached right now stays attached, which is why the label is
                     about the list rather than about the machine. */
                  title="Stop offering this alias. Anything attached stays attached."
                  onClick={() => setMachines(forgetMachine(machine.id))}
                >
                  Forget
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
