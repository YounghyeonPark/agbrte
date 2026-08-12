/**
 * Who is on the other end of a connection (DESIGN.md §6.4, §7).
 *
 * ## The socket already answered this
 *
 * There is no `getpeereid` call here, and it is not an omission. Node exposes no
 * peer-credential API for unix sockets, and the usual reaction is to reach for a
 * native module — but the answer that module would return is one the kernel has
 * already enforced. The host's socket is `0600` and owned by the host's user
 * (`socketChannel.listen`), and connecting to a unix socket requires *write*
 * permission on it. So a connection existing at all is proof the peer is that
 * user. Asking the kernel to confirm what it just refused everyone else for
 * would be ceremony.
 *
 * The same holds through `ssh -L`: the forward terminates on the remote and
 * dials the socket locally, so it faces the same `0600` check, having already
 * passed ssh's own authentication as that user.
 *
 * This is why the chmod matters beyond hardening. It is not a fence around the
 * identity model — it *is* the identity model, and every claim below is worth
 * exactly what that file mode is worth.
 *
 * On Windows the equivalent is a named pipe's DACL, which grants the creating
 * user *and administrators*. An administrator connecting is indistinguishable
 * from the owner. That was once a `isPeerCredentialTrustworthy()` returning
 * `platform !== 'win32'`, which nothing called — and nothing could usefully have
 * done with it, because no role check fixes an administrator, and the common
 * case on Windows is that the owner of the machine *is* one. Refusing them
 * would break the ordinary use and stop nobody. So it is written down here,
 * where the identity model is stated, rather than left as a predicate that
 * reads like a guard and guards nothing.
 *
 * ## What this cannot yet distinguish
 *
 * One workspace owner, so today every client resolves to the same actor. That is
 * the truth on a machine where sessions live under one unix account, and
 * inventing per-person identity where the OS has none would be a fiction the log
 * then records as fact.
 *
 * What is *not* the same is the client. Two connections from one person — a
 * desk machine and a phone — are separately identifiable and separately
 * governable, which is the distinction that actually earns its keep: watching a
 * run from bed should not be one mistyped keystroke away from driving it.
 *
 * Real per-person identity arrives as another `IdentitySource` (`tailscale`,
 * `oidc`) resolving the same `Actor`. Nothing above this function changes when
 * it does — that is the point of it being a function.
 */

import { hostname, userInfo } from 'node:os';
import type { AccessRole, Actor } from '@shared/types/index.js';

export interface ResolvedIdentity {
  actor: Actor;
  /** The most this connection may be granted, whatever it asks for. */
  ceiling: AccessRole;
}

/**
 * The identity a connection to the host's own socket carries.
 *
 * `id` is the uid rather than the login name because names are reassigned and
 * uids are not, and a log outlives the account that wrote it.
 *
 * Except where there is no uid. Windows has none — `userInfo()` reports `-1` —
 * so that reasoning does not apply and this used to mint `uid:-1` for every
 * person on every Windows machine: one actor for everyone, and a number that
 * identifies nobody. Windows over ssh is a supported target and this value is
 * written into the log as §13 attribution, so "who answered this prompt" had a
 * single wrong answer.
 *
 * There it falls back to `user:<name>@<host>`. A name is the weaker identifier
 * the note above is about, and the host is included because `Administrator` and
 * `ubuntu` are the same name on a great many machines. Weaker and true beats
 * stronger-looking and false — and it is labelled `user:` rather than `uid:` so
 * nothing downstream mistakes one for the other.
 *
 * The parameters exist so both branches can be tested from either platform.
 */
export function localIdentity(
  info: { uid: number; username: string } = userInfo(),
  host: string = hostname(),
): ResolvedIdentity {
  return {
    actor: {
      id: info.uid >= 0 ? `uid:${info.uid}` : `user:${info.username}@${host}`,
      via: 'peer-credential',
      label: `${info.username}@${host}`,
    },
    ceiling: 'read-write',
  };
}

/**
 * The identity of a client that only stated one.
 *
 * Capped at `read-only` on purpose. An unverified claim is not a reason to
 * refuse a connection — watching a session harms nothing — but it is never a
 * reason to accept a command. The cap is here rather than at the call site so
 * that adding a source cannot accidentally skip it.
 */
export function assertedIdentity(label: string): ResolvedIdentity {
  return {
    actor: { id: `asserted:${label}`, via: 'asserted', label },
    ceiling: 'read-only',
  };
}

