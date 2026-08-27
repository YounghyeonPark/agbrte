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

What being in a group buys, for an agent on the `agbrte-harness` runtime:

| Tool | |
|---|---|
| `message_peer` | send a short message to another session; it wakes and answers in its own turn, under its own permission gate |
| `peer_history` | read what another session has been doing — the turns it was given, the tools it ran, what it concluded. `since` is a cursor, so checking in repeatedly only reads what is new |

**Not on a CLI-backed seat.** A `cli:claude-code` session brings the vendor's own
toolset, so it has neither of these. Grouping such a session is recorded and
changes nothing it can see.

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
