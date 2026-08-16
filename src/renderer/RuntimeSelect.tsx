/**
 * The agent chooser, on Radix Select (DESIGN.md §14).
 *
 * §14 specifies Radix "for accessible dialogs/menus without hand-rolled focus
 * management", and a dropdown is the one place in Phase 1 where that pays: a
 * native `<select>` on Windows renders an OS-drawn popup that ignores the app's
 * palette entirely, and hand-rolling a styled replacement means writing the
 * roving focus, type-ahead, and escape handling that Radix already has right.
 *
 * One list, not two: an option names *what will run* — a model on an endpoint,
 * or a runtime that needs neither — and the runtime falls out of it. See
 * `AgentChoice` in App.tsx for why the two questions collapsed into one.
 *
 * `data-testid` on the trigger and each item, because Radix renders items into a
 * portal outside this component's DOM — a test cannot reach them by descending
 * from the trigger. `data-runtime` / `data-model` alongside `data-value` so a
 * test can address an entry by what it means rather than by an encoded string:
 * the encoding is this file's business and is free to change.
 */

import * as Select from '@radix-ui/react-select';
import type { JSX } from 'react';
import { CapabilityBadges } from './CapabilityBadges.js';
import type { CapabilityBadge } from './modelCapabilities.js';

export interface RuntimeOption {
  value: string;
  label: string;
  /** Secondary text: the endpoint a model is served from, or the runtime. */
  hint?: string;
  runtimeId?: string;
  /** The model this entry runs. `null` where it runs none. */
  modelId?: string | null;
  /** The "another model…" entry, which reveals a text field when chosen. */
  typed?: boolean;
  /**
   * What this entry can do, at the moment of choosing it (§3.3).
   *
   * Rendered *outside* `ItemText` on purpose. Radix matches type-ahead against
   * that element's text, and two endpoints serving the same model name are told
   * apart by the hint — folding "no tools · 8k ctx" into the same string would
   * make typing `qwen` stop matching and would read the badges aloud to a screen
   * reader as part of the option's name. They are decorations on a row whose
   * name is the model.
   */
  badges?: CapabilityBadge[];
}

export function RuntimeSelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: RuntimeOption[];
}): JSX.Element {
  const selected = options.find((o) => o.value === value);

  return (
    <Select.Root value={value} onValueChange={onChange}>
      <Select.Trigger
        data-testid="runtime-trigger"
        className="field text-ink flex items-center justify-between gap-2"
        aria-label="What will run"
      >
        {/* Not Select.Value: with an empty `value` — which happens while the host
            handshake is still in flight — Radix renders nothing at all, and an
            empty control reads as broken rather than as loading. */}
        <span className="truncate-line">
          {selected === undefined ? (
            'No runtime available'
          ) : (
            <>
              {selected.label}
              {selected.hint !== undefined && <span className="text-muted"> · {selected.hint}</span>}
            </>
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
          data-testid="runtime-list"
          /*
           * Bounded by the space the popper actually has, and scrolled inside.
           *
           * Without the cap the list is laid out at its full height and the
           * popper is left to place something taller than the window: entries
           * end up off-screen — the *first* one included, once shifting runs out
           * of room — where they can be seen and not clicked. It went unnoticed
           * while every row was one line, and the capability badges below make
           * each model row two; a host serving five models is then past the
           * edge. The height is a property of the viewport, so it is read from
           * Radix's own measurement rather than guessed at in `rem`.
           */
          className="bg-panel border-line z-50 max-h-[var(--radix-select-content-available-height)] overflow-hidden rounded-[2px] border shadow-lg"
        >
          {/* Radix gives the viewport `overflow: auto`; the cap above is what
              gives it something to scroll. */}
          <Select.Viewport className="p-1">
            {options.map((option) => (
              <Select.Item
                key={option.value}
                value={option.value}
                data-testid="runtime-option"
                data-value={option.value}
                {...(option.runtimeId !== undefined ? { 'data-runtime': option.runtimeId } : {})}
                {...(option.modelId !== undefined && option.modelId !== null
                  ? { 'data-model': option.modelId }
                  : {})}
                {...(option.typed === true ? { 'data-typed': 'true' } : {})}
                className="text-ink data-highlighted:bg-raised cursor-pointer rounded px-3 py-2 text-sm outline-hidden select-none"
              >
                <Select.ItemText>
                  {option.label}
                  {/* Inside ItemText, so Radix's type-ahead matches what is read
                      — two endpoints can serve the same model name, and the
                      hint is the only thing telling those entries apart. */}
                  {option.hint !== undefined && <span className="text-muted"> · {option.hint}</span>}
                </Select.ItemText>
                {option.badges !== undefined && option.badges.length > 0 && (
                  <span className="mt-0.5 flex flex-wrap gap-1">
                    <CapabilityBadges badges={option.badges} />
                  </span>
                )}
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
