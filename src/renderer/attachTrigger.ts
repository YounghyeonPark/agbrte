/**
 * When to go and look, without being asked (DESIGN.md §6.2, §10).
 *
 * Discovery used to be a button. Choosing a machine and then pressing "look" is
 * two steps for one intention — the person who just named a machine needs
 * exactly one thing next, which is a path — and this app has been collapsing
 * those pairs everywhere else (the one-shot "New session in a folder" replaced
 * attach, create, add agent, pick model). So it runs on its own.
 *
 * The whole of the decision is here, as two pure functions, because "when does
 * an ssh connection open" is worth being able to test without a browser.
 *
 * ## Choosing is a signal; typing is not
 *
 * Picking `build-01` from the ssh-config list is unambiguous — that name is a
 * machine, the user said so, and waiting after it would only add lag. Typing
 * `user@10.0.0.9` passes through nine prefixes that are not machines, and firing
 * on each would open nine connections to nothing. Hence two answers rather than
 * one delay: a name the config knows goes immediately, anything else waits for
 * the typing to stop (or for the field to lose focus, which the panel treats as
 * "I have finished saying it").
 *
 * Nothing fires for a name that could not be a destination. That rule is
 * enforced for real in main by `assertSafeAlias` — this is only about whether to
 * *bother*, and duplicating it here keeps a leading `-` from becoming a rejected
 * promise the user never asked for.
 */

/** How long to wait after the last keystroke of a name nobody has configured. */
export const TYPED_DEBOUNCE_MS = 700;

/**
 * Whether this could name a machine at all.
 *
 * Deliberately the same shape as main's `assertSafeAlias`, and deliberately not
 * imported from it: the renderer cannot reach into main, and a copy that drifts
 * is harmless in the direction it can drift — main still refuses, and the worst
 * case here is a search that is not started.
 */
export function isPlausibleAlias(value: string): boolean {
  const alias = value.trim();
  if (alias === '') return false;
  // `ssh -oProxyCommand=… host` runs a command on *this* machine, so a leading
  // hyphen is never a destination.
  if (alias.startsWith('-')) return false;
  return !/[\s\u0000-\u001f]/.test(alias);
}

/**
 * How long to wait before looking on this machine — or `null` for "do not".
 *
 * `0` means the name came from the user's own config, so there is nothing to
 * wait for.
 */
export function autoDiscoverDelay(alias: string, known: readonly string[]): number | null {
  const value = alias.trim();
  if (!isPlausibleAlias(value)) return null;
  return known.includes(value) ? 0 : TYPED_DEBOUNCE_MS;
}
