/**
 * Named secrets this machine holds (DESIGN.md §13, §17 Q20, §5.1).
 *
 * ## What this is for
 *
 * An MCP server needs `env` values, and those values are credentials. Q20's
 * answer was that they are typed at creation, reach the process, and are never
 * written anywhere — which is why "a resumed session does not silently
 * reconnect: the log deliberately cannot rebuild what it deliberately does not
 * hold". The cost of that was recorded honestly and is real: restarting a host
 * costs a running session its tools permanently, and the only cure is somebody
 * retyping the whole server definition.
 *
 * This is where the value can live instead, so a project can *name* what it
 * needs — `${SEARCH_API_KEY}` — and the machine can answer with a value nobody
 * has to retype.
 *
 * ## §13 is not being bent, and it is worth being precise about that
 *
 * §13's rule is that only key *names* reach "the log, the events, the UI, a
 * template or a reply" — a **file that travels**. `~/.agbrte` is the machine's
 * install area (§5.1): outside every workspace, in no repository, in no
 * template, on no wire except the one carrying the value to the process that
 * needs it. `endpoints.json` has kept an `apiKey` there since §3.8, under the
 * same argument and beside this file.
 *
 * What changes is Q20's *resume asymmetry*, deliberately: a host that holds the
 * value can rebuild the connection. That is the point. It buys back what the
 * asymmetry cost, and the price is the sentence the endpoint form already says
 * out loud — anyone who can read that home directory can use the key.
 *
 * ## Names travel, values do not
 *
 * `readSecretNames` is the only reader a client is ever given, and the only
 * reader that can be: a list of names is what a person needs in order to know
 * what is stored and remove one, and a list of values is what §13 exists to
 * prevent. `resolveSecrets` is for the spawn path on this machine and nothing
 * else. Two functions rather than one with a flag, because a flag is one typo
 * away from putting a key in a reply.
 */

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { machineRoot } from './machine.js';
import { restrictToOwner } from './ownerOnly.js';

/** Beside `endpoints.json`, in the machine's install area and never a workspace. */
export function secretsPath(): string {
  // Through `machineRoot` rather than joined here, so `AGBRTE_HOME` is honoured
  // — a `= homedir()` default once made every host in a test run share one
  // socket, and this file has the same shape of mistake available to it.
  return join(machineRoot(), 'secrets.json');
}

/**
 * The rule a name must follow, which is the environment's own.
 *
 * These become environment variables of a spawned process, so the allow-list is
 * what a POSIX shell and Windows both accept: a letter or underscore, then
 * letters, digits and underscores. Refused rather than sanitised — a name is
 * matched against `${…}` in a project's file, and one silently rewritten would
 * resolve nothing while looking like it should.
 */
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export class SecretRejected extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SecretRejected';
  }
}

interface Stored {
  /** Name → value. A flat map, because the name is the whole of the key. */
  secrets?: Record<string, string>;
}

async function read(path: string): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    // No file is a machine holding no secrets, which is the ordinary case and
    // not a failure.
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as Stored;
    const found = parsed.secrets;
    if (typeof found !== 'object' || found === null) return {};
    // Filtered on the way in as well as on the way out. A file edited by hand
    // may hold a name this build would refuse, and letting it through here
    // would put it in an environment by a route the validator never saw.
    return Object.fromEntries(
      Object.entries(found).filter(([k, v]) => NAME.test(k) && typeof v === 'string'),
    );
  } catch {
    /*
     * A corrupt file reads as empty rather than throwing.
     *
     * Unlike `endpoints.json`, where an unreadable file is refused loudly
     * because the fallback is *sending turns somewhere the user did not
     * configure*. The fallback here is a missing value, which surfaces as the
     * form asking for it — the same thing that happens on a machine that has
     * never held one, and a state the person can act on.
     */
    return {};
  }
}

/**
 * Which secrets this machine holds. **Names only**, sorted.
 *
 * The one reader a client is given. See the header: a name is what somebody
 * needs to know what is stored and to remove it, and there is no caller
 * anywhere for a list of values.
 */
export async function readSecretNames(path = secretsPath()): Promise<string[]> {
  return Object.keys(await read(path)).sort();
}

/**
 * The values for these names, for the process about to be spawned.
 *
 * Names that this machine does not hold are simply absent from the result
 * rather than empty strings: "not set" and "set to nothing" are different, and
 * the caller has to be able to ask for the missing one.
 */
export async function resolveSecrets(
  names: readonly string[],
  path = secretsPath(),
): Promise<Record<string, string>> {
  const held = await read(path);
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = held[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

async function write(path: string, secrets: Record<string, string>): Promise<void> {
  const dir = dirname(path);
  // `recursive` tolerates an existing directory; the explicit `chmod` is because
  // `mode` on `mkdir` is masked by the umask and a directory that already exists
  // keeps whatever it had. Copied from `addEndpoint`, which learnt it first.
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(dir, 0o700);
  // Sorted, so a file a person opens is readable and a rewrite is a one-line
  // diff rather than a reshuffle.
  const ordered = Object.fromEntries(Object.entries(secrets).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(path, `${JSON.stringify({ secrets: ordered }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  // `mode` does nothing on Windows, where the ACL is the permission. Same call
  // and same reason as the endpoints file beside it.
  await restrictToOwner(path, 'MCP credentials');
}

/**
 * Store one, replacing whatever was there under that name.
 *
 * **Replaced rather than refused**, which is the opposite of `addEndpoint` and
 * for the opposite reason. An endpoint id is what an agent's `AuthMode` names,
 * so overwriting one silently redirects agents already pointing at it. A secret
 * has no such referent: the name is a variable, and setting it again is what
 * somebody does when a key is rotated — refusing that would mean deleting
 * before setting, and a machine briefly holding neither.
 *
 * Nothing about `value` is returned, logged, or put in an error message. The
 * reply is the name, which the caller already had.
 */
export async function setSecret(
  name: string,
  value: string,
  path = secretsPath(),
): Promise<{ name: string }> {
  if (!NAME.test(name)) {
    throw new SecretRejected(
      `"${name}" is not an environment variable name — a letter or underscore, then letters, ` +
        'digits and underscores',
    );
  }
  if (value === '') {
    // Refused rather than stored, because an empty value is indistinguishable
    // from absent everywhere it is used, and storing one would make the form
    // stop asking for a key that is not there.
    throw new SecretRejected(`"${name}" was given no value — use delete to remove it instead`);
  }
  const held = await read(path);
  held[name] = value;
  await write(path, held);
  return { name };
}

/** Forget one. Absent is success: the caller wanted it gone, and it is. */
export async function deleteSecret(name: string, path = secretsPath()): Promise<{ name: string }> {
  const held = await read(path);
  if (name in held) {
    delete held[name];
    await write(path, held);
  }
  return { name };
}
