# Working in this repo

[README.md](README.md) says what Agbrte is and what is not proven yet.
[DESIGN.md](DESIGN.md) is the authority — 2,000 lines, numbered `§`, and worth
citing by section in code comments the way the existing ones do. This file is
neither: it is what a session needs to *work* here without rediscovering it.

## Green means all of these

```
npm run typecheck     # two projects: node and web
npm test              # vitest, ~1,670 tests
npm run lint:classes  # renderer classes that style nothing
npm run lint:reach    # modules no entry point reaches
npm run lint:race     # state read before an await and written after it
npm run e2e           # Playwright against real Electron — NOT in CI
```

Four things about that list are load-bearing:

- **`npm test` runs files in parallel, and that is deliberate.** Adding
  `--no-file-parallelism` to "reduce noise" hides the class of bug where two
  hosts share a socket. One shipped that way and only CI caught it.
- **The e2e suite is not in CI.** Nothing else exercises the renderer, the
  preload, the IPC surface or a real pty, so run it before finishing anything
  that touches them. It takes about five minutes.
- **A version bump needs a build before the tests pass.** A test compares the
  built bundle's content stamp with `package.json`; a stale `dist/` fails it and
  the message is about a hash, not about the build.
- The three lints are not optional extras. They have each caught something.

## Releasing

Bump → `npm run build` → commit → push `main` → **wait for CI to be green** →
tag → the release workflow builds the artifacts.

Never tag first. `v0.0.12` and `v0.0.13` are tags with failed builds behind them,
and they are why the order is written down. Releases are created as drafts.

## The comments here are unusual, and matching them is part of the work

They say *why*, and they record what broke. A comment in this codebase often
names the bug that produced the line, what the wrong version cost, and which
alternative was rejected — in prose, in paragraphs, sometimes at length. That is
the house style, not accidental verbosity: several of them are the only record of
a failure that took a day to find. Match the density of the file you are in. A
bare `// set the flag` reads as damage here.

The same applies to commit messages: they explain the defect and the reasoning,
not the diff.

## Hazards that have already cost real time

1. **The remote path forgets what the local path passes.** This exact shape has
   produced at least four separate bugs — the workspace name in `hello`, the pty
   module, the CLI bundle, host discovery. Every remote test attaches exactly one
   folder, which is the case where such an omission cannot be seen. When touching
   `host/connectRemote.ts` or `host/sshTransport.ts`, diff the behaviour against
   `host/connectOrSpawn.ts` and ask what the local side sends that this does not.

2. **One host per machine (§8).** The socket is named from `machineId` in
   `~/.agbrte/machine.json`. Anything computing a machine directory must honour
   `AGBRTE_HOME`; a `= homedir()` default once made every host in a test run
   share one socket, which only failed in CI, because CI runs parallel.

3. **A record is a hint; a socket answering is a fact.** `host.json` outlives the
   process that wrote it — `kill -9`, a reboot, a lost bind race. Prove a host is
   there by connecting to it, never by reading a file (§6.4).

4. **Credentials (§13).** API keys and MCP `env` values travel over the session
   socket to the process that needs them. Only key *names* reach the log, the
   events, the UI, a template or a reply. Never a shell argv, never a file that
   travels. Two paths now attach an MCP server; both must keep this, which is why
   they share one function.

5. **Windows.** Heredocs through the Bash tool eat backslashes — use Write/Edit,
   or `String.fromCharCode(92)`. `DETACHED_PROCESS` ignores `CREATE_NO_WINDOW`,
   so `windowsHide` belongs on what the detached process spawns, not on the
   detached spawn itself.

6. **`cbk_ws_one` is the user's real server.** Never point an installer, a
   bootstrap or a destructive test at it.

## What this machine cannot verify

A whole class of defect is only visible on a real remote host: binding to the
wrong folder, a host that cannot be found, a sidebar row with nothing under it.
The suite stays green through all of them. When work touches the remote path, say
plainly what the user has to exercise on their server, and wait for the screenshot
rather than assuming.

## Where the truth lives

- `events.jsonl` is the record. `session.json` is a hint that corrects itself.
- `SESSION_PROTOCOL_VERSION` moves whenever the shape does; a new command goes in
  `COMMAND_SINCE` so an older host is refused by name rather than by silence.
- `.claude/agents/` holds specialists — `spec-keeper` keeps DESIGN.md truthful as
  code lands, `durability-warden` owns the log and resume, `remote-ops` the
  transports, `security-auditor` the credential boundaries.
