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
 */
export function localIdentity(): ResolvedIdentity {
  const info = userInfo();
  return {
    actor: {
      id: `uid:${info.uid}`,
      via: 'peer-credential',
      label: `${info.username}@${hostname()}`,
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

/** Windows has no uid; the pipe's DACL is the equivalent guarantee. */
export function isPeerCredentialTrustworthy(): boolean {
  // Named pipes are created with a DACL granting the creating user and
  // administrators. An administrator connecting would be indistinguishable from
  // the owner — true on Windows generally, and not something a role check can
  // fix, so it is recorded rather than pretended away.
  return process.platform !== 'win32';
}
