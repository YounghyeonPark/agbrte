# From a terminal, with no GUI anywhere

[← README](../README.md)

`agbrte` is a client of the same host the window uses, so a session started at a
terminal is the same session the app opens — not a second, lesser mode.

**`agbrte --help` is the complete reference** for the commands (`attach`, `run`,
`ls`, `group`, `ungroup`, `serve`, `web`, `interrupt`, `stop`, `update`) and
every flag; `attach` is
line-based on purpose, because the first place it runs is an ssh session on a
machine with no display, likely in tmux, possibly with a `TERM` nobody has tested.

## Two properties worth knowing before you script it

**`agbrte run` puts its result in the exit code** — **0** done, **1** failed in a
way rerunning will not fix, **2** stopped short in a way a later rerun might get
past (model unreachable, rate limited, quota exhausted) — because a retry loop
wants those apart.

**A permission request with no `--yes` is denied, not queued.** In cron there is
nobody to ask, and waiting would be a job that never ends.

## A team of sessions, from a pipeline

Sessions that are in a **group** can reach each other. Grouping used to need the
desktop app, which was backwards: dividing a job across three sessions is what
you do on a build box over ssh.

```bash
agbrte ls | grep worker | agbrte group --name "the team"
```

Ids come from the arguments, or from stdin when there are none — and an id is
matched anywhere in a line, so a whole `ls` row pipes in without an `awk` in
front of it. `agbrte ls` then prints the group beside each title, and
`agbrte ungroup <id>` takes one back out.

What being in a group buys:

| Tool | |
|---|---|
| `message_peer` | send a short message to another session; it wakes and answers in its own turn, under its own permission gate |
| `peer_history` | read what another session has been doing — the turns it was given, the tools it ran, what it concluded. `since` is a cursor, so checking in repeatedly only reads what is new |

**These work from `agbrte`.** A session driven by `agbrte run` or `agbrte attach`
sits on the `agbrte-harness` runtime — the host registers it first, and the CLI
takes the host's first unless told otherwise — and that runtime is the one whose
tools these are. Nothing about a group needs the window.

**They are absent when the agent *is* a third-party CLI.** `--runtime
cli:claude-code` hands the turn to that vendor's own program, with that vendor's
own toolset, and neither of these is in it. Two different things get called "the
CLI" and only this one is the limitation: `agbrte` as a *client* is fine, an
installed agent CLI as the *runtime* is not. Grouping such a session is recorded
and changes nothing it can see.

## The same app in a browser

`agbrte web .` serves the app over a WebSocket instead of Electron IPC. The
renderer is unchanged, so what a phone sees is what the desktop sees.

**The link carries a token, and that link is the credential.** The socket admits
nothing until a client presents it, so reaching the address is no longer enough —
which it used to be, and which meant any web page that could reach your loopback
could read your sessions. A fresh token is minted per run; `--token <value>` pins
one so a phone bookmark survives a restart.

The address still decides who can *knock*. It binds to loopback unless you name
something else, and a tailnet address (`--bind $(tailscale ip -4)`) is the
intended answer. Do not bind it to `0.0.0.0`: a token is not a reason to put a
shell on the internet.

### `--public`, for a host strangers are meant to reach

Everything above assumes the person on the socket owns the machine. That is what
makes a token sufficient: somebody who can start a session on their own computer
could have opened a terminal instead. On a demo the driver is a stranger and that
argument disappears, so `--public` withdraws every capability that rested on it.

```bash
AGBRTE_HOME=/srv/agbrte-demo agbrte web /srv/demo-workspace --public --bind 0.0.0.0
```

The agent keeps `read`, `write`, `edit`, `glob` and `grep` — every path they take
goes through the workspace confinement, so the folder it was started in is the
whole of what it can touch. It loses `bash`, which runs a real shell and cannot
be confined from outside, and `screenshot`, which makes requests from wherever
the server sits. The client loses the terminal panel, screen capture, preview
servers, attaching machines or folders, and attaching MCP servers — an MCP server
is a command line the caller supplies, run on your machine.

Three things worth knowing before you run it:

- **It refuses to reuse a host it did not start.** The withdrawal happens in the
  process the session host forks, which inherits its environment from whoever
  spawned it — so a host already running was started under someone else's
  environment and cannot be trusted to be public. Give the demo its own
  `AGBRTE_HOME`, as above, and it gets its own machine identity and its own
  socket (§8).
- **The workspace is the blast radius.** Make it a throwaway directory with a
  sample project in it, not a checkout you care about. Every visitor shares it
  and any of them can edit it.
- **It is still not a multi-tenant system.** Visitors see each other's sessions.
  That is fine for a demo of what the program is and wrong for anything else.
