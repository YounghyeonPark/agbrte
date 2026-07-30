/**
 * Runtime chooser, on Radix Select (DESIGN.md §14).
 *
 * §14 specifies Radix "for accessible dialogs/menus without hand-rolled focus
 * management", and a dropdown is the one place in Phase 1 where that pays: a
 * native `<select>` on Windows renders an OS-drawn popup that ignores the app's
 * palette entirely, and hand-rolling a styled replacement means writing the
 * roving focus, type-ahead, and escape handling that Radix already has right.
 *
 * `data-testid` on the trigger and each item, because Radix renders items into a
 * portal outside this component's DOM — a test cannot reach them by descending
 * from the trigger.
 */

import * as Select from '@radix-ui/react-select';
import type { JSX } from 'react';

export interface RuntimeOption {
  value: string;
  label: string;
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
        aria-label="Runtime"
      >
        {/* Not Select.Value: with an empty `value` — which happens while the host
            handshake is still in flight — Radix renders nothing at all, and an
            empty control reads as broken rather than as loading. */}
        <span className="truncate-line">{selected?.label ?? 'No runtime available'}</span>
        <Select.Icon aria-hidden className="text-muted">
          ▾
        </Select.Icon>
      </Select.Trigger>

      <Select.Portal>
        <Select.Content
          position="popper"
          sideOffset={4}
          data-testid="runtime-list"
          className="bg-panel border-line z-50 overflow-hidden rounded-md border shadow-lg"
        >
          <Select.Viewport className="p-1">
            {options.map((option) => (
              <Select.Item
                key={option.value}
                value={option.value}
                data-testid="runtime-option"
                data-value={option.value}
                className="text-ink data-highlighted:bg-raised cursor-pointer rounded px-2.5 py-1.5 text-sm outline-hidden select-none"
              >
                <Select.ItemText>{option.label}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
