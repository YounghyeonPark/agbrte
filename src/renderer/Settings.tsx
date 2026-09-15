/**
 * Settings (DESIGN.md §7, §14).
 *
 * There was no such pane, and the things that belong in one were scattered or
 * absent. `About` was a top-level button because the menu bar used to be the one
 * place an About lived; the theme picker went in beside it for want of anywhere
 * better; and two preferences this client keeps had **no control at all**.
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
import { applyTheme, rememberTheme, storedTheme } from './applyTheme.js';
import { THEMES } from './themes.js';
import { forgetAgentDefault, listAgentDefaults } from './agentDefaults.js';
import { forgetMachine, loadMachines, type Machine } from './machines.js';
import type { HostInfo } from '@shared/ipc/contract.js';
import { LABEL } from './App.js';

export function Settings({ hosts }: { hosts: HostInfo[] }): JSX.Element {
  return (
    <div className="m-auto grid w-full max-w-xl gap-6 p-6" data-testid="settings">
      <div className="grid gap-2">
        <h2 className="text-xl">Settings</h2>
        <p className="text-muted text-sm leading-relaxed">
          Kept by this client, on this device. A host owns the log, the queue and the
          permission gate; none of what is below travels to one.
        </p>
      </div>

      <Appearance />
      <Remembered hosts={hosts} />

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
 * Choosing a palette (§4.1).
 *
 * Applied on press, not on save. There is no state worth confirming: the change
 * is entirely visible, and a palette you cannot see until you press OK is one
 * you have to choose twice.
 *
 * Each row shows the theme rather than describing it — the ground, the text on
 * it, and the accent. Those are the three decisions a palette makes here, and a
 * name like "Slate" says nothing about whether the thing that needs you will
 * stand out on it.
 */
function Appearance(): JSX.Element {
  // Read once. Nothing else in the app changes this, so subscribing would be a
  // listener for an event with exactly one sender sitting next to it.
  const [chosen, setChosen] = useState(() => storedTheme().id);

  return (
    <div className="grid gap-2" data-testid="appearance">
      <span className={`${LABEL} text-muted`}>Appearance</span>
      <div className="grid gap-1.5">
        {THEMES.map((theme) => (
          <button
            key={theme.id}
            type="button"
            data-testid="theme-option"
            data-theme-id={theme.id}
            aria-pressed={chosen === theme.id}
            className={`border-line hover:border-muted flex items-center gap-3 rounded-control border px-3 py-2 text-left ${
              chosen === theme.id ? 'border-accent' : ''
            }`}
            onClick={() => {
              applyTheme(theme);
              rememberTheme(theme.id);
              setChosen(theme.id);
            }}
          >
            {/* Inline styles because these are the *other* theme's values, and
                utilities read the one that is on. Ground, text, accent — not
                ground and panel, which sit one step apart by design and rendered
                every row as one grey block and a dot. */}
            <span className="border-line flex shrink-0 gap-0.5 rounded-mark border p-0.5">
              {[theme.palette.bg, theme.palette.ink, theme.palette.accent].map((colour) => (
                <span
                  key={colour}
                  aria-hidden
                  className="block size-4 rounded-mark"
                  style={{ background: colour }}
                />
              ))}
            </span>
            <span className="grid gap-0.5">
              <span className="text-[13px]">{theme.label}</span>
              <span className="text-muted text-xs">{theme.hint}</span>
            </span>
          </button>
        ))}
      </div>
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
