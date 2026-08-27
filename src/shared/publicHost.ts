/**
 * Whether this host is reachable by people who do not own it (§13, §17 Q14).
 *
 * ## The assumption this switches off
 *
 * Everything else in this repository is built for a host whose user owns the
 * machine it runs on. `accessPolicy.ts` says so in its own first paragraph: a
 * client's label is self-reported, so a role is a seatbelt rather than a lock,
 * and that is *correct* when reaching the socket already proves you are the
 * workspace owner. The token on the web socket says who is admitted, not what
 * they may do, and the honest defence of that has always been that a person who
 * can start a session on their own machine could have opened a terminal.
 *
 * A public demo breaks that argument in one step: the person driving is not the
 * owner, and "they could have done it themselves anyway" stops being true. So
 * the capabilities whose safety rested on ownership are withdrawn, at the place
 * they are granted rather than at the place they are called.
 *
 * ## Read from the environment, and read fail-safe
 *
 * An environment variable because this has to cross two process boundaries the
 * moment it matters: the session host is spawned detached, and it forks the
 * agent host. A flag parsed in one of them would be a flag the other two do not
 * have, and the failure mode of *that* is a public host with a private host's
 * tools — the exact thing this exists to prevent.
 *
 * Anything other than an explicit `1` is private, which is the direction a
 * mistake should fall: a typo leaves a laptop working as a laptop. The reverse
 * default would mean a misread variable silently published a shell.
 */

/** The variable. Named for what it asserts about the network, not for "demo". */
export const PUBLIC_HOST_ENV = 'AGBRTE_PUBLIC_HOST';

/**
 * True when this process was told it serves strangers.
 *
 * Read at the call site rather than captured at import, because tests set it
 * around a call and a module-level constant would freeze whichever value
 * happened to be there when the file was first loaded — a bug that only appears
 * once something else imports this module earlier than the test does.
 */
export function isPublicHost(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PUBLIC_HOST_ENV] === '1';
}
