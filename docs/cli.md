# From a terminal, with no GUI anywhere

[← README](../README.md)

`agbrte` is a client of the same host the window uses, so a session started at a
terminal is the same session the app opens — not a second, lesser mode.

**`agbrte --help` is the complete reference** for the commands (`attach`, `run`,
`ls`, `serve`, `web`, `interrupt`, `stop`, `update`) and every flag; `attach` is
line-based on purpose, because the first place it runs is an ssh session on a
machine with no display, likely in tmux, possibly with a `TERM` nobody has tested.

## Two properties worth knowing before you script it

**`agbrte run` puts its result in the exit code** — **0** done, **1** failed in a
way rerunning will not fix, **2** stopped short in a way a later rerun might get
past (model unreachable, rate limited, quota exhausted) — because a retry loop
wants those apart.

**A permission request with no `--yes` is denied, not queued.** In cron there is
nobody to ask, and waiting would be a job that never ends.

## The same app in a browser

`agbrte web .` serves the app over a WebSocket instead of Electron IPC. The
renderer is unchanged, so what a phone sees is what the desktop sees.

**There is no login:** anyone who can reach the address can drive the session, so
the address is the entire boundary. It binds to loopback unless you name
something else, and a tailnet address (`--bind $(tailscale ip -4)`) is the
intended answer. Do not bind it to `0.0.0.0`.
