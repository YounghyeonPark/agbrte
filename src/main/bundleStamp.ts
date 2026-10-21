/**
 * Which build a host is running, computed the same way on both sides (§6.3).
 *
 * The out-of-date badge is `host.bundleVersion !== shippingVersion`, so the two
 * strings have to be made by the same hands or the badge means nothing. They
 * were not, and for two months it lit on every local host and never went out.
 *
 * ## How they came apart
 *
 * `442e008` stamped the host bundle at build time — `// agbrte-bundle: 0.0.43`,
 * the version alone — so a local host could say which bundle it ran. `8a77494`
 * then made the *shipping* stamp `<version>+<hash of the bundles>`, because a
 * version only changes when somebody bumps it and a remote kept yesterday's
 * host for ever. Its own message warned that "comparing a fingerprint against a
 * version would light the badge on every host", and fixed that for the remote
 * path, where the uploaded copy is stamped with the full string. The local path
 * still read the build's bare version. So `0.0.43` was compared with
 * `0.0.43+…`, every local host was "outdated", and pressing Update restarted it
 * into a host that reported the same bare version and was outdated again. Found
 * by somebody who updated the app and watched the button stay.
 *
 * The test that should have caught it handed both sides the same hand-written
 * string. This module is the fix and the reason it cannot recur: one function
 * computes the digest, and the app and the host both call it.
 */

import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The files whose contents are the build, relative to the directory the host
 * bundle sits in. Order matters: it is part of the digest.
 */
export const STAMPED_BUNDLES = ['agbrteHost.js', 'agentHost.js', '../cli/agbrte.js'] as const;

/**
 * The fingerprint of the bundles in `dir`: twelve hex characters of a SHA-256.
 *
 * A file that is not there is hashed by name, so the stamp stays stable and
 * still differs from a build that has it. Synchronous because the host needs it
 * before it answers its first handshake; it reads about a megabyte and a half,
 * once per start.
 */
export function bundleDigest(dir: string): string {
  const digest = createHash('sha256');
  for (const file of STAMPED_BUNDLES) {
    try {
      digest.update(readFileSync(join(dir, file)));
    } catch {
      digest.update(file);
    }
  }
  return digest.digest('hex').slice(0, 12);
}

/** What a client ships: the version in front for people, the digest behind it for the comparison. */
export function shippingStamp(version: string, dir: string): string {
  return `${version}+${bundleDigest(dir)}`;
}

/** The marker on a bundle's first line, written by the build and again by an upload. */
const STAMP_LINE = /^\/\/ agbrte-bundle: (.+)$/;

/**
 * What a host says it is running, from the script it was started as.
 *
 * Two kinds of file reach here. A copy uploaded to a remote carries the full
 * stamp on its first line, put there by `uploadHostBundle`, and is reported as
 * written. A build's own file — the local host, or one started by a desktop
 * install on another machine — carries only the version the build wrote; its
 * digest is computed here, from the files beside it, by the same function the
 * app uses, so a host started from the app's own bundle reports exactly the
 * string the app compares against.
 *
 * `null` when the file cannot be read or carries no stamp: nothing can be
 * claimed, and the badge reads that as "cannot tell" rather than as stale.
 */
export function readHostStamp(self: string | undefined): string | null {
  if (self === undefined) return null;
  let first: string;
  try {
    // Only the first line is needed to know which kind of file this is.
    const handle = openSync(self, 'r');
    try {
      const head = Buffer.alloc(256);
      const read = readSync(handle, head, 0, head.length, 0);
      first = head.subarray(0, read).toString('utf8').split('\n', 1)[0] ?? '';
    } finally {
      closeSync(handle);
    }
  } catch {
    return null;
  }
  const stamp = STAMP_LINE.exec(first.trim())?.[1]?.trim();
  if (stamp === undefined || stamp === '') return null;
  return stamp.includes('+') ? stamp : shippingStamp(stamp, dirname(self));
}
