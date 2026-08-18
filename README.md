# Agbrte

**Ag**ent **Br**idge **Te**rminal. Said /ɛɡɯbɯɾɯtʰɯ/ *(AG-buh-ruh-teu)* or
/ˈæɡbərt/ *(AG-burt)*. Both are correct: it is a contraction rather than a word,
so there is nothing here to get wrong.

An agent-based development workbench. Many sessions, one model each, running on
your machine or on a server — and agent memory that survives the workspace
folder being moved.

## Status

[DESIGN.md §15](DESIGN.md) is the authority and says which part of a phase is
only partly true. In summary: **phases 1, 2, 4 and 6 are done; 5 and 7 met their
acceptance criteria with named substitutions; 3 is half validated; 8 is
started.**

A text session edits a real repository and its transcript survives an app restart.
Remote workspaces, hosts that outlive the app, and several clients on one session
are exercised against a real server — including a phone, over a browser, on a
tailnet. There is a dashboard, stall detection, quota parking that resumes on its
own, notifications, a CLI for headless machines, and a one-file installer. One
conformance suite runs against four deliberately different runtimes, including the
agent CLI you already have installed.

**What is not proven, named rather than glossed.** The model-provider axis has
exactly one implementation (`openai-compatible`), so it describes one wire format
rather than abstracting several; the runtime axis has four. The remote-detached
mechanism is verified against a real server but its model half is not — "an agent
on a GPU box using that box's own model server" has never run, because that box
has no model server. Phase 7's acceptance sentence *has* run end to end, with the
agent local rather than remote and unable to see the picture. **OCR is not built**,
so the redaction sweep reports `scanned: false` rather than an empty match list.

> **[The idea, and the shape it forces](https://younghyeonpark.github.io/agbrte/)** — the
> design concept as a page: the process model, how a remote host is bootstrapped
> and what does *not* cross the link, how a session tree reserves budget and
> bubbles blockage, and what is deliberately not built. Source in [docs/](docs/).

## The one idea

**A session runs on the bridge, not inside the terminal.** The bridge is a
workspace — a folder, on this machine or on a server — served by its own process
that owns the event log, the permission gate, and the turn queue. The terminal is
whatever you are sitting at: the desktop app, a browser on your phone, the CLI on
a machine with no display. All of them are clients, and none of them holds the
session.

Closing the app mid-run, driving one session from a second machine, and resuming
after a restart are not three features but three consequences of that. It is also
the whole name: **Ag**ent **Br**idge **Te**rminal, in the order the architecture
is built.

## What it does that a chat window does not

- **The run outlives the client, and the client is plural.** Quitting the app does
  not stop a turn. Two machines on one session see one transcript, and a
  permission prompt raised on either is answerable from the other — pending
  requests live in the log, not in a callback in some process's memory.
- **Everything resumes from its own log** — which agent ran, under which model and
  adapter version, what it was asked, what it did, and who approved each thing it
  needed permission for. A moved folder, a switched provider and a restarted
  machine are therefore one problem rather than three.
- **A session holds one agent, and a model change is recorded rather than
  swapped.** The seat you had is retired and the new one takes over, both written
  into the transcript, so it says what answered and when. Sessions built before
  that rule still run several agents under file leases, a git worktree each.
- **Work is decomposed into sessions, not into a roster.** A session too large to
  hold can propose splitting into a child with its own log and a slice of its
  budget, on another machine if that is where the work is. Sessions can also be
  *grouped* and reach each other one bounded `message_peer` at a time, carrying
  words and never authority — the recipient runs the woken turn under its own
  gate. **Grouping is one host only.** What a session may reach is likewise its
  own: MCP servers and skills attach from the new-session form, not from an
  app-wide registry somebody enabled months ago.
- **There is a real terminal, and it says when it is off the record.** One pane
  shows what a CLI seat printed; the other is a PTY running your shell, an agent
  CLI the host detected, or Agbrte's own CLI attached to the session on screen.
  That second pane writes no events, passes no permission gate, and spends your
  own allowance — and its header says so every time it is open.
- **You can point at things, and talk.** Black out what should not leave the
  machine and the blackout is painted into the pixels *before* anything is
  written, so the original never exists on disk to be pushed anywhere. Dictation
  is the same bargain: it runs on your machine, the recording never leaves it,
  and the text lands in the composer for you to edit rather than being sent.

### Attaching a server over ssh

The one flow worth spelling out, because the name field does more than it looks
like. `Attach host… → Remote`, then a name and a path. The name is an alias from
your `~/.ssh/config`, or `user@hostname`, which needs no config at all — Agbrte
shells out to `ssh`, so your keys, ports, jump hosts and `ProxyCommand`s already
apply, and any NAT-traversal tool that makes `ssh <name>` work makes this work
too. The first attach installs a private Node under `~/.agbrte` and copies the
session and agent host bundles there; nothing system-wide, no sudo, and later
attaches reuse them. A machine ssh has never reached fails in one of a few
specific ways — an unconfirmed host key, refused credentials, a name that does not
resolve — and Agbrte names which one and the command that settles it. It will not
accept a host key for you: that check only means something if a human compares the
fingerprint against something other than the connection presenting it.

## Running it

Needs Node 22+. For a local model, an [Ollama](https://ollama.com) server:

```bash
npm install
ollama pull qwen2.5:7b        # optional; the echo runtime needs no model

npm run dev                   # Vite + esbuild watch + Electron
npm start                     # build, then launch
npm run cli -- --help         # the terminal client, from a checkout
```

`npm run agbrte:direct` is not the CLI: it builds its own `SessionManager`
in-process to exercise adapters with no host in the way, which makes it useful
for adapter work and wrong for anything else — two of them on one workspace would
both own the log.

### From a terminal, with no GUI anywhere

`agbrte` is a client of the same host the window uses, so a session started at a
terminal is the same session the app opens — not a second, lesser mode. **`agbrte
--help` is the complete reference** for the commands (`attach`, `run`, `ls`,
`serve`, `web`, `interrupt`, `stop`, `update`) and every flag; `attach` is
line-based on purpose, because the first place it runs is an ssh session on a
machine with no display, likely in tmux, possibly with a `TERM` nobody has tested.

Two properties worth knowing before you script it. `agbrte run` puts its result in
the **exit code** — **0** done, **1** failed in a way rerunning will not fix, **2**
stopped short in a way a later rerun might get past (model unreachable, rate
limited, quota exhausted) — because a retry loop wants those apart. And a
permission request with no `--yes` is **denied, not queued**: in cron there is
nobody to ask, and waiting would be a job that never ends.

`agbrte web .` serves the same app in a browser — the renderer is unchanged and
talks to a WebSocket instead of Electron IPC, so what a phone sees is what the
desktop sees. **There is no login:** anyone who can reach the address can drive
the session, so the address is the entire boundary. It binds to loopback unless
you name something else, and a tailnet address (`--bind $(tailscale ip -4)`) is
the intended answer. Do not bind it to `0.0.0.0`.

### Two config files, since `--help` covers flags and not files

`~/.agbrte/endpoints.json` (mode `0600`) is the set of models a host can reach,
selected with `--endpoint <id>`. A file rather than an environment variable
because a host started over ssh runs a non-login shell and never sources your
profile; the key stays on the host and never reaches a client or a transcript.

```json
{ "endpoints": [{ "id": "local", "baseUrl": "http://127.0.0.1:11434/v1" },
                { "id": "vendor", "baseUrl": "https://api.example.com/v1",
                  "provider": "Example AI", "apiKey": "sk-..." }],
  "default": "local" }
```

A workspace's `.devagents/access.json` pins a client to watching rather than
driving — a seatbelt and not a lock, since the label is self-reported and anyone
who can reach the host's socket already owns the workspace.

```json
{ "rules": [{ "client": "agbrte-app@laptop-*", "role": "read-only" }] }
```

**DESIGN.md §3.8 and §8.2 are the full reference for both**, including why
credentials belong to the workspace rather than to whoever is attached.

### Installing on a server

One file, one command. Build it here, send it there:

```bash
npm run package                 # → dist/install-agbrte.sh, under a megabyte
scp dist/install-agbrte.sh server:
ssh server 'sh install-agbrte.sh'
```

`npm run package`, not `npm run build`. Building refreshes the bundles and leaves
`dist/install-agbrte.sh` untouched beside them, so a `scp` after a build ships
whatever was last packaged — silently, since the installer succeeds and the server
simply runs old code. Package before you send.

**Nothing needs to be on that machine** — no git, no npm, no registry, no
checkout, no build. The installer carries the CLI, the session host, the agent
host, the web bridge and the renderer, and downloads a private Node 22 only if the
machine has none. It works piped: `curl -fsSL <url> | sh`. The target needs a
POSIX shell, plus curl-or-wget and tar-with-xz only when it has no Node 22+.
Nothing is written outside `$HOME`, and `rm -rf ~/.agbrte` removes all of it.
**Upgrading a running host is `agbrte update`**, which stops it so the next attach
deploys this build; versions negotiate as a range, so a newer client connects to
an older host and says which commands that host predates.

### Testing it

`npm run check` (typecheck + Vitest over the headless core) is the everyday one;
`npm run smoke` drives a real window and a real host process, and `npm run e2e` is
the only layer that can verify §15's acceptance criteria, including closing the
app and relaunching it to prove a transcript survived. Tests that need a local
model **skip loudly** rather than passing: a criterion whose test was skipped is
not a criterion that holds.

## Where to read more

**[DESIGN.md](DESIGN.md) is the real specification** — 17 sections, including what
is deliberately unfinished and why. Read §1–§3 for the architecture, §5 for
durability, §6.4 and §8 for the host model, §13 for permissions, §15 for phase
status. The load-bearing decision behind all of it is that **the append-only event
log is the source of truth**: `rehydrate()` reconstructs context from that log for
a moved folder, a migrated machine, a switched provider and a resumed quota
window, and doubles as the in-session compactor, so the durable path is exercised
constantly and cannot rot.

## A note on the workspace

Agbrte stores everything in `.devagents/` inside the workspace, which means
**do not put a workspace inside a sync-managed folder** (Google Drive, Dropbox,
OneDrive). The log is append-only with byte-offset resume, and sync clients
rewrite files and create conflict copies. Use a git remote for backup instead;
the repository history is the durable copy.

## Using it in research, or in a patent

If this project — the code, or the design decisions written up in
[DESIGN.md](DESIGN.md) — feeds into a paper, a thesis, a technical report or a
patent application, a citation is appreciated. [CITATION.cff](CITATION.cff) has
the metadata, and GitHub turns it into a **Cite this repository** button at the
top of this page.

Archived releases carry a DOI: [![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.21906998.svg)](https://doi.org/10.5281/zenodo.21906998)

That is the **concept** DOI, which resolves to the newest archived version. Cite
it unless you specifically need to pin a reader to the exact release you used,
in which case take the version DOI from the Zenodo page it sends you to.

**This is a request, not a licence term.** Apache-2.0 requires that you keep the
copyright notice and [NOTICE](NOTICE) when you redistribute; it does not require
that you cite anything, and nothing in this section adds a condition to the
licence. You are free to use this without asking and without crediting a paper.
The asking is separate from the permission, and deliberately so — a licence that
quietly grew an academic obligation would be a worse licence.

**Patents.** Two things are worth knowing rather than discovering later. This
repository is public and its commits are dated, which makes it **prior art**:
that is useful to you if you are establishing what was already known, and it
limits what anyone — including me — can later claim as novel over it. And
Apache-2.0 §3 already grants you a patent licence for what the contributors put
into this work, with the usual retaliation clause: sue over the work infringing
your patent and that grant ends. If you are filing something that builds on this,
I would genuinely like to hear about it beforehand — not to object, but because
the interesting conversation is usually upstream of the filing.

**Collaboration.** If you are building on this seriously — a research group, a
product, a thesis — an email is welcome: **ypark.dev@gmail.com**. Issues and pull
requests are fine too. There is no obligation attached to any of this; the code
works the same either way.

## Licence

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). Chosen over MIT
for two things it adds: an explicit patent grant, and a trademark clause, so the
code can be forked freely while the name stays with the project.

**The one proprietary dependency is gone.** `@anthropic-ai/claude-agent-sdk`,
published under Anthropic's own terms, was a build dependency of an in-process
adapter; both were removed (DESIGN.md §3.14). It reached no shipped bundle — but
only because the adapter importing it happened not to be registered in a headless
entry point, and an accident that holds is not a guarantee. So the licence gate in
`npm run package`, which refuses to build the installer if any Anthropic code
appears in the bundles, stays now that the dependency is gone: the next
proprietary SDK will arrive as a convenience inside one adapter, and that script
is where redistribution would actually happen.

Every runtime dependency — React, `react-dom`, zustand, one Radix component,
xterm, `node-pty`, `electron-updater` — is MIT. The wider build tree is permissive
but not uniformly one licence; [NOTICE](NOTICE) carries the attribution.
