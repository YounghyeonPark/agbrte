/**
 * Which clients may drive a session (DESIGN.md §7, §17 Q14).
 *
 * ## This is a seatbelt, not a lock
 *
 * Stated first because getting it backwards would be dangerous. A client's label
 * is self-reported, so this file governs clients that are honest about what they
 * are — which, on a `0600` socket, is all of them: reaching the socket already
 * proves you are the workspace owner, and the owner could connect under any
 * label they liked. Nothing here defends against that person, and nothing needs
 * to. They own the workspace.
 *
 * What it defends against is the mistake. The phone in your pocket showing a
 * live run is one mistyped keystroke from driving it, and "I did not mean to
 * send that" is a far more frequent event than an intruder. Pinning that client
 * to `read-only` costs nothing and removes the whole class.
 *
 * When identity stops being self-reported — a Tailscale `whois`, an OIDC `sub` —
 * the same rules become enforcement rather than advice, and the file does not
 * change shape. That is why it matches on a label now rather than on a device
 * type or a platform: the label is the thing that later becomes verified.
 *
 * ## Absent means unrestricted
 *
 * A workspace with no policy grants what a client asks for, which is what every
 * single-user workspace wants and what the host did before this existed. An
 * unreadable or malformed file is *not* treated as absent — it is reported and
 * the host refuses to start, because silently falling back to "unrestricted"
 * would turn a typo into a quiet widening of access.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AccessRole } from '@shared/types/index.js';
import { workspaceLayout } from '@main/store/layout.js';

export interface AccessRule {
  /** Glob against the client label, e.g. `loom-app@phone-*`. `*` matches any run. */
  client: string;
  role: AccessRole;
}

export interface AccessPolicy {
  rules: AccessRule[];
  /** Applied when no rule matches. Absent means "whatever was asked for". */
  fallback?: AccessRole;
}

export function accessPolicyPath(workspaceRoot: string): string {
  return join(workspaceLayout(workspaceRoot).devagents, 'access.json');
}

export class AccessPolicyInvalid extends Error {
  constructor(path: string, detail: string) {
    super(`${path} is not a usable access policy: ${detail}`);
    this.name = 'AccessPolicyInvalid';
  }
}

/** Read the workspace's policy. Returns null when there is none. */
export async function loadAccessPolicy(workspaceRoot: string): Promise<AccessPolicy | null> {
  const path = accessPolicyPath(workspaceRoot);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new AccessPolicyInvalid(path, (err as Error).message);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new AccessPolicyInvalid(path, (err as Error).message);
  }

  const body = parsed as Partial<AccessPolicy>;
  if (typeof body !== 'object' || body === null || !Array.isArray(body.rules)) {
    throw new AccessPolicyInvalid(path, 'expected { "rules": [...] }');
  }
  for (const rule of body.rules) {
    if (typeof rule?.client !== 'string' || !isRole(rule?.role)) {
      throw new AccessPolicyInvalid(
        path,
        `each rule needs { "client": "<glob>", "role": "read-write" | "read-only" }`,
      );
    }
  }
  if (body.fallback !== undefined && !isRole(body.fallback)) {
    throw new AccessPolicyInvalid(path, `"fallback" must be "read-write" or "read-only"`);
  }

  return {
    rules: body.rules,
    ...(body.fallback !== undefined ? { fallback: body.fallback } : {}),
  };
}

function isRole(value: unknown): value is AccessRole {
  return value === 'read-write' || value === 'read-only';
}

/**
 * Decide what a client gets.
 *
 * Never grants more than was asked for. A client that wants to watch is not
 * handed the ability to command because a rule said `read-write` — the rule is a
 * ceiling, and asking for less is a client's own business. Downgrades are what
 * this is for.
 *
 * First match wins, so a specific rule can precede a broad one without the file
 * needing a priority field.
 */
export function decideRole(
  policy: AccessPolicy | null,
  requested: AccessRole,
  client: string,
  ceiling: AccessRole = 'read-write',
): AccessRole {
  const matched = policy?.rules.find((rule) => globMatches(rule.client, client));
  const allowed = matched?.role ?? policy?.fallback ?? 'read-write';
  return narrowest(requested, allowed, ceiling);
}

function narrowest(...roles: AccessRole[]): AccessRole {
  return roles.includes('read-only') ? 'read-only' : 'read-write';
}

/** `*` only — enough to match a client family, too little to be a regex hazard. */
function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(value);
}
