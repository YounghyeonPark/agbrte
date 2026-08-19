/**
 * The workspaces a machine offered, as one control (DESIGN.md §6.2, §14).
 *
 * Discovery answers with everything it found, and on a working machine that is
 * a lot: eight directories that have held sessions, a dozen repositories, and
 * whatever else is one level below a root. As a list of rows that filled the
 * sidebar and pushed the two things a person actually needs next — the path
 * field and **Attach** — below the fold. The results are the *input* to the
 * decision; the decision is a path and a button, and those must be on screen.
 *
 * So the list collapses into a dropdown. Bounding the rows with a scrollbox was
 * the other option and it is the wrong shape: scrolling to reach the primary
 * action of a panel is a workaround for a panel that is too tall.
 *
 * **Radix, not a native `<select>`** — §14 chose it for exactly this: a native
 * popup on Windows is drawn by the OS, ignores the palette entirely, and cannot
 * carry a group label that looks like the rest of the app. `RuntimeSelect.tsx`
 * is the working example this follows, including the part that matters for
 * tests: items render into a **portal** outside this component's DOM, so each
 * one carries its own `data-testid` rather than being reachable by descending
 * from the trigger.
 *
 * **The groups survive the collapse.** A directory holding `.devagents/` is a
 * different claim from a git repository, which is a different claim from a
 * folder that merely exists — that is the whole reason discovery ranks them, and
 * flattening them into one alphabetical list here would throw the ranking away
 * at the last step. `Select.Group` and `Select.Label` keep it, which a native
 * `<optgroup>` would have done too and everything else about it would not.
 */

import * as Select from '@radix-ui/react-select';
import type { JSX } from 'react';
import type { WorkspaceCandidateDto } from '../shared/ipc/contract.js';

/** How each kind is introduced, in the order they are worth looking at. */
export const GROUPS: Array<{ kind: WorkspaceCandidateDto['kind']; title: string }> = [
  { kind: 'devagents', title: 'Used by Agbrte before' },
  { kind: 'git', title: 'Git repositories' },
  { kind: 'folder', title: 'Other folders' },
];

export function WorkspaceSelect({
  candidates,
  value,
  onChange,
}: {
  candidates: WorkspaceCandidateDto[];
  /** The path currently in the field — `''`, or something typed, shows nothing. */
  value: string;
  onChange: (path: string) => void;
}): JSX.Element {
  const chosen = candidates.find((c) => c.path === value);

  return (
    <Select.Root value={chosen === undefined ? '' : value} onValueChange={onChange}>
      <Select.Trigger
        data-testid="attach-workspace-trigger"
        className="field text-ink flex items-center justify-between gap-2"
        aria-label="Workspaces found on that machine"
      >
        {/* Not `Select.Value`: with an empty value Radix renders nothing at all,
            and an empty control reads as broken rather than as "nothing picked
            yet". Typing a path by hand lands here too — it is a real state, and
            the count is what says the list is still there to open. */}
        {/* `truncate-line` is load-bearing twice over: it ellipsises a long path
            *and*, because it sets `overflow: hidden`, it gives this flex item an
            automatic minimum size of zero — so a seventy-character workspace
            path cannot set the width of the row and push the Refresh button
            beside it off the edge of a 300px sidebar. */}
        <span className="truncate-line">
          {chosen === undefined ? (
            <span className="text-muted">
              Choose one of {candidates.length} found, or type a path below
            </span>
          ) : (
            chosen.path
          )}
        </span>
        <Select.Icon aria-hidden className="text-muted">
          ▾
        </Select.Icon>
      </Select.Trigger>

      <Select.Portal>
        <Select.Content
          position="popper"
          sideOffset={4}
          data-testid="attach-workspace-list"
          /* Capped at what the popper actually has and scrolled inside it, for
             the reason `RuntimeSelect` documents: laid out at full height, a
             list of thirty paths is placed past the edge of the window and its
             first entries can be seen and not clicked. */
          className="bg-panel border-line z-50 max-h-[var(--radix-select-content-available-height)] overflow-hidden rounded-[2px] border shadow-lg"
        >
          <Select.Viewport className="p-1">
            {GROUPS.map(({ kind, title }) => {
              const rows = candidates.filter((c) => c.kind === kind);
              if (rows.length === 0) return null;
              return (
                <Select.Group key={kind} data-testid={`attach-group-${kind}`}>
                  <Select.Label className="text-muted px-3 pt-2 pb-1 text-[11px]">
                    {title} ({rows.length})
                  </Select.Label>
                  {rows.map((c) => (
                    <Select.Item
                      key={c.path}
                      value={c.path}
                      data-testid="attach-candidate"
                      data-kind={c.kind}
                      data-path={c.path}
                      className="text-ink data-highlighted:bg-raised cursor-pointer rounded px-3 py-2 text-sm outline-hidden select-none"
                    >
                      <Select.ItemText>{c.path}</Select.ItemText>
                    </Select.Item>
                  ))}
                </Select.Group>
              );
            })}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
