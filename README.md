# Agbrte

**Ag**ent **Br**idge **Te**rminal. Said *AG-bruh-teh* or *AG-burt* — 애그브르테 or
애그버트. Both are correct: it is a contraction rather than a word, so there is
nothing here to get wrong.

An agent-based development workbench. Multiple sessions, multiple agents per
session, any model behind a pluggable adapter, running on your machine or on a
server — and agent memory that survives the workspace folder being moved.

**Status: phases 1, 2, 4, 5 and 6 done; 3 and 7 partly.** A text session edits a
real repository and its transcript survives an app restart. Remote workspaces,
hosts that outlive the app, and several clients on one session are exercised
against a real server — including a phone, over a browser, on a tailnet. There
is a dashboard with a Needs-you rail, stall detection, quota parking that
resumes on its own, an inbox, notifications, a CLI for headless machines, and a
one-file installer. One conformance suite runs against five deliberately
different runtimes, including the agent CLI you already have installed.

Several agents can work one session under file leases, message each other on the
record, or take a git worktree each. A session too large to hold can propose
splitting into a child with its own log and a slice of its budget — a person
approves it — and a permission prompt raised three levels down surfaces at the
top of the dashboard.

You can point at things. Drag a region of your own screen, black out the parts
that should not leave the machine, circle what is wrong, and send it — the
blackout is painted into the pixels *before* anything is written, so the original
never exists on disk to be pushed anywhere. Every other mark stays editable and
arrives with a sentence describing it, because a weaker vision model often reads
only the sentence. An agent can screenshot a page it is serving and look at its
own output. And you can hold a key and talk: the transcription runs on your
machine, the recording never leaves it, and the text lands in the composer for
you to edit rather than being sent.

**Not built yet:** a second cloud provider (phase 3); OCR and text-to-speech
(phase 7). Glyph rendering is refused rather than pending — annotation text
travels as words beside the picture, which is the part a model actually reads.

**Built but never run as one flow:** capture a region of a remote preview, circle
it, say what is wrong, and have the remote agent fix it and screenshot its own
fix. Every piece of that works and has been exercised against real hardware — a
real display, a real ssh transfer, a real speech engine — but the whole sentence
has only been run with a stub agent at the far end.

[DESIGN.md §15](DESIGN.md) says what each phase covers and what is deliberately
unfinished; where something is only partly true, it says which part.

> **[The idea, and the shape it forces](https://younghyeonpark.github.io/agbrte/)** — the
> design concept as a page: the process model, how a remote host is bootstrapped
> and what does *not* cross the link, how a session tree reserves budget and
> bubbles blockage, and what is deliberately not built. Source in
> [docs/](docs/).

## The one idea

**A session runs on the bridge, not inside the terminal.** The bridge is a
workspace — a folder, on this machine or on a server — served by its own process
that owns the event log, the permission gate, and the turn queue. The terminal is
whatever you are sitting at: the desktop app, a browser on your phone, the CLI on
a machine with no display. All of them are clients, and none of them holds the
session.

Closing the app mid-run, driving one session from a second machine, and resuming
after a restart are not three features. They are three consequences of that.

That is the whole name: **Ag**ent **Br**idge **Te**rminal, in the order the
architecture is built.

## Ways to use it

### 1. A folder on this machine

`Attach host… → Use a folder on this machine`. Create a session, add an agent,
type. Pick the `echo` runtime to exercise everything without a model at all.

### 2. A server over ssh

`Attach host… → Remote`, then a name and a path. The name is an alias from your
`~/.ssh/config` if you have one, or `user@hostname`, which needs no config at
all — Agbrte shells out to `ssh`, so your keys, ports, jump hosts and
`ProxyCommand`s already apply, and any NAT-traversal tool that makes `ssh <name>`
work makes this work too.

The first attach to a machine installs a private Node under `~/.agbrte` and copies
two ~100 KB bundles there. Nothing system-wide, no sudo. Later attaches reuse
them.

If ssh has never connected to that machine, it will fail in one of a few
specific ways — an unconfirmed host key, refused credentials, a name that does
not resolve — and Agbrte names which one and the command that settles it. It will
not accept a host key for you: that check only means something if a human
compares the fingerprint against something other than the connection presenting
it.

### 3. Close the app; the run keeps going

The host is detached, so quitting the app does not stop a turn. Reopen and
attach the same workspace to land back on the session, mid-turn if it is still
working. The same holds for a link that breaks rather than an app that closes: a
dropped tunnel or a closed laptop lid marks the host `reconnecting` rather than
removing it, retries until it is back, and replays exactly what was missed —
`seq` is monotonic per session, so catch-up loses nothing and repeats nothing. Detaching a host in the app (`×`) drops the connection and leaves the
run alone; a host with nothing attached and nothing running then exits on its
own after a while rather than lingering forever.

There is no button to stop a host that is still busy, and that is the honest
state rather than a design: the protocol has a shutdown that refuses while work
is in flight, but nothing in the UI sends it yet.

`agbrte interrupt` stops whatever is running in a workspace, which is also the
way past a turn that **died** rather than finished. A session whose agent went
away mid-turn stays `working` — correctly, since a stall is a suspicion and an
agent may simply be slow — and `agbrte stop` then refuses on its behalf. An
explicit interrupt resolves it and gives the host back.

### 4. The same session from a second machine

Attach the same remote workspace from another computer. Both clients see one
transcript because there is one session; commands from either queue in arrival
order. A permission prompt raised on one is answerable from the other, because
pending requests live in the log rather than in a callback in some process's
memory.

### 5. Watch without being able to type

A client asks for `read-write` or `read-only` at handshake and the host decides —
enforcement is the owner's, never the client's. To pin a machine to watching,
put this in the workspace's `.devagents/access.json`:

```json
{ "rules": [{ "client": "agbrte-app@laptop-*", "role": "read-only" }] }
```

A rule is a ceiling: it never grants more than a client asked for. This is a
seatbelt, not a lock — the label is self-reported, and anyone who can reach the
host's socket is already the workspace's owner. It exists because a live run on
a screen you are only watching is one keystroke from being driven.

### 6. Find out who did what

Every event a person caused carries an actor — who sent that turn, who approved
that shell command. Events with no actor were caused by no person; agent output
and state transitions carry none. With one user this is a nicety. With a host
several people attach to, "the gate said yes" is not an answer to "who let it
run that".

### 7. From a terminal, with no GUI anywhere

`agbrte` is a client of the same host the window uses, so a session started at a
terminal is the same session the app opens — not a second, lesser mode.

```bash
agbrte                      # drive the workspace here, interactively
agbrte /srv/api             # or one elsewhere on this machine
agbrte ls                   # one session per line, greppable
agbrte run . "add a test for the parser"
agbrte stop                 # asks; refuses while work is in flight
```

`agbrte run` is the scriptable half: no prompts, output on stdout, and the result
in the exit code — **0** done, **1** failed in a way rerunning will not fix
(misconfigured, no auth, a limit you set, something needed permission), **2**
stopped short in a way a later rerun might get past (model unreachable, rate
limited, quota exhausted). A retry loop wants those apart. A permission request with no `--yes` is **denied, not queued**: in cron
there is nobody to ask, and waiting would be a job that never ends. The denial
reaches the agent as a reason it can adapt to.

`agbrte attach` is line-based on purpose — no full-screen interface, no cursor
addressing. It is meant for an ssh session on a machine with no display, likely
in tmux, possibly with a `TERM` nobody has tested. Ctrl-C interrupts the turn;
Ctrl-D leaves and the run keeps going.

A host can reach several models. List them in `~/.agbrte/endpoints.json` (mode
`0600`) and an agent picks one:

```json
{
  "endpoints": [
    { "id": "local",  "baseUrl": "http://127.0.0.1:11434/v1" },
    { "id": "gpu",    "baseUrl": "http://gpu-box:8000/v1" },
    { "id": "vendor", "baseUrl": "https://api.example.com/v1",
      "provider": "Example AI", "apiKey": "sk-..." }
  ],
  "default": "local"
}
```

```bash
agbrte run . --endpoint vendor --model some-model "..."
```

A file rather than an environment variable because a host started over ssh by the
app runs a non-login shell and never sources your profile. The key stays on the
host — it is never put on an endpoint object, never sent to a client, and never
written to a transcript; the provider fetches it only where the request is made.

**Credentials belong to the workspace, not to whoever is attached.** One
workspace has one host process running as one user, so a second person driving
that session spends the owner's budget. The log still says who: every
human-caused event carries an actor. If that is not the arrangement you want,
give people separate accounts and separate workspaces.

`provider` is shown in the agent picker before the first turn, so you can see
where your code is about to go while you can still choose otherwise.

Installing on a server is one file and one command. Build it here, send it there:

```bash
npm run package                        # → dist/install-agbrte.sh, ~100 KB
scp dist/install-agbrte.sh server:
ssh server 'sh install-agbrte.sh'
```

`npm run package`, not `npm run build`. Building refreshes the bundles and
leaves `dist/install-agbrte.sh` untouched beside them, so a `scp` after a build
ships whatever was last packaged — silently, since the installer succeeds and
the server simply runs old code. Package before you send.

**Upgrading a running host is `agbrte stop` and start it again.** That used to
be untrue across a protocol change: the stop command speaks the *new* protocol
and the old host refused it at the handshake, so the tool that would shut it
down was the one that could no longer talk to it, and upgrading meant `kill`.
Versions are now a range rather than an equality — a newer client connects to an
older host, loses only the commands that host predates, and says which. Killing
is still safe if you need it, since the log is the truth and every session
reopens from it.

**Nothing needs to be on that machine** — no git, no npm, no registry, no
checkout, no build. The installer carries the three bundles that are Agbrte on a
headless machine (~280 KB), and downloads a private Node 22 only if the machine
has none. It works piped, too, if you have somewhere to host it:
`curl -fsSL <url> | sh`.

Requirements on the target: a POSIX shell, plus curl-or-wget and tar-with-xz only
when it has no Node 22+.

Nothing is written outside `$HOME`: the runtime and the app land in `~/.agbrte`, the
binary in `~/.agbrte/bin/agbrte`, and `rm -rf ~/.agbrte` removes all of it. No sudo, no
package manager, no service. On a machine that already has the source and Node,
`npm i -g .` does the same job.

### 8. Open it in a browser — a phone, over your VPN

```bash
agbrte web .                       # loopback only
agbrte web . --bind $(tailscale ip -4)
```

The same app, not a cut-down one: the renderer is unchanged and talks to a
WebSocket instead of Electron IPC, so what a phone sees is what the desktop sees.

**There is no login.** Anyone who can reach the address can drive the session, so
the address is the entire boundary — which is why it binds to loopback unless you
name something else, and why a tailnet address is the intended answer. Your phone
is already on that private network; nothing is exposed to the internet, and the
network has already established who is connecting. Do not bind this to `0.0.0.0`.

### 9. Resume anything

Every session on disk reopens from its own log — which agent ran, under which
model and adapter version, what it was asked, what it did, and who approved
each thing it needed permission for. The log is the truth, not a cache of some
provider's session state, which is why a moved folder, a switched provider and a
restarted machine are all the same problem.

## Running it

Needs Node 22+. For a local model, an [Ollama](https://ollama.com) server:

```bash
npm install
ollama pull qwen2.5:7b        # optional; the echo runtime needs no model

npm run dev                   # Vite + esbuild watch + Electron
npm start                     # build, then launch
npm run cli -- --help         # the terminal client, from a checkout
```

`npm run agbrte:direct` is a different thing and is not the CLI: it builds its own
`SessionManager` in-process to exercise adapters with no host in the way, which
makes it useful for adapter work and wrong for anything else — two of them on one
workspace would both own the log.

## The shape of it

Three axes, deliberately independent, so adding a vendor never touches transport
code and vice versa:

| Axis | Interface | Means |
|---|---|---|
| Harness | `AgentRuntime` | who runs the loop — a vendor SDK, a CLI, or our own |
| Model | `ModelProvider` | which model answers |
| Location | `HostChannel` | where it executes — in-memory, a forked process, a socket, an ssh forward |

The load-bearing decision is that **the append-only event log is the source of
truth**. One function, `rehydrate()`, reconstructs context from that log, and it
serves four separate requirements: a moved folder, a migrated machine, a
switched provider, and a resumed quota window. It is also the in-session
compactor, so the durable path is exercised constantly and cannot rot.

`DESIGN.md` is the real specification — 17 sections, including what is
deliberately unfinished and why. Read §1–§3 for the architecture, §5 for
durability, §6.4 and §8 for the host model, §13 for permissions.

## Tests

Four layers, each with a different job:

```bash
npm test          # Vitest over the headless core — no Electron, ~3s
npm run smoke     # a real window + a real host process, 15 checks
npm run e2e       # Playwright drives the built app as a user
npm run check     # typecheck (node + web projects) then npm test
```

`npm test` is the one to run constantly. `npm run smoke` catches the class of
failure where the app opens and every button silently does nothing — a preload
built as ESM exposes nothing, with no error anywhere. `npm run e2e` is the only
layer that can verify §15's acceptance criteria, including closing the app and
relaunching it to prove a transcript survived.

Tests that need a local model **skip loudly** rather than passing. A criterion
whose test was skipped is not a criterion that holds. The remote transport's
tests cover its decisions without a server; whether `ssh -L` reaches a remote
unix socket, and whether a detached child outlives its session, cannot be faked
and are not pretended at — those were established against a real machine.

## Layout

```
src/shared/      types, the IPC contract, the agent + session protocols
src/main/        the app side: fleet, host connections, ssh transport, IPC
src/host/        the session host — owns sessions, the log, the gate, the queue
src/preload/     the entire privileged surface the renderer gets
src/renderer/    React + Tailwind, windowed projection over the log
src/cli/         the terminal client — a peer of the window, not a subset
```

Three processes per workspace, not two: the app holds no session state, the host
owns sessions and the log, and a forked agent host runs the loops and tools. A
crashing adapter cannot take down the session, and a closing window cannot take
down the run.

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

Apache License 2.0 — see [LICENSE](LICENSE). Chosen over MIT for two things it
adds: an explicit patent grant, and a trademark clause, so the code can be forked
freely while the name stays with the project.

**One dependency is not open source.** `@anthropic-ai/claude-agent-sdk` is
published under Anthropic's own terms and covers the optional `claude-agent-sdk`
runtime adapter. It is a *build* dependency, not a runtime one — nothing this
project distributes contains it. `dist/install-agbrte.sh` carries only the CLI,
the session host, and the agent host, and `npm run package` refuses to build the
installer if any Anthropic code appears in them, so the exclusion cannot lapse by
accident. Anyone wanting that adapter installs the SDK themselves and accepts
Anthropic's terms directly. Everything else in the tree is MIT, ISC, BSD, 0BSD or
public domain. See [NOTICE](NOTICE).
