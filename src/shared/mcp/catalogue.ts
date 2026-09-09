/**
 * MCP servers this app knows about (DESIGN.md §17 Q20, §17 Q12, §3.12).
 *
 * ## A catalogue, and deliberately not a registry
 *
 * Q20 refused an app-level MCP registry, and this is not one: nothing here
 * attaches itself, nothing is on by default, and a session still gets exactly
 * what somebody ticked when it was made. What this removes is the *typing* —
 * before it, using a well-known server meant hand-writing JSON, which is a
 * barrier that has nothing to do with the decision being made.
 *
 * The shape is `models/catalogue.json`'s, on purpose. That file offers models a
 * person picks from and installs; this offers servers a person picks from and
 * declares. Both carry a `verifiedAt`, because both are claims about somebody
 * else's registry that go stale without anybody here noticing.
 *
 * ## Picking one writes a file
 *
 * Not a hidden setting: choosing an entry writes `<id>.mcp.json` into the
 * workspace's tracked `templates/`, which is the same artifact a person writes
 * by hand. So a colleague gets it by cloning (§17 Q12), a diff records when it
 * arrived, and the catalogue is a shortcut to the file rather than a second way
 * of meaning the same thing — §4.4's convergence argument, borrowed.
 *
 * The key is never in it. `envFrom` maps the variable the server reads to the
 * name this machine keeps the value under, and the form asks for whatever is
 * missing when the server is ticked.
 *
 * ## What is deliberately short about it
 *
 * Two entries. `read`, `write`, `edit`, `glob`, `grep`, `bash` and `fetch` are
 * built in, so most of what a catalogue like this usually carries — a
 * filesystem server, a fetch server, a git server — would be a second, worse
 * copy of a tool that is already there and already gated. What is left is the
 * work that needs somebody else's account: searching the web, and reaching a
 * forge.
 */

import CATALOGUE from './catalogue.json' with { type: 'json' };

export interface CatalogueServer {
  /** The id the declaration is written under, and the prefix of its tool names. */
  id: string;
  label: string;
  note: string;
  command: string;
  args: string[];
  /** Variable the server reads → the name this machine keeps it under. */
  envFrom: Record<string, string>;
  /** Where a person goes to get the key, since "get a key" is not an instruction. */
  keyFrom?: string;
}

/** Every server the app can write a declaration for. */
export function catalogueServers(): CatalogueServer[] {
  return (CATALOGUE as { servers: CatalogueServer[] }).servers.map((s) => ({ ...s }));
}

/** When the package names above were last checked against the registry. */
export const CATALOGUE_VERIFIED_AT = (CATALOGUE as { verifiedAt: string }).verifiedAt;
