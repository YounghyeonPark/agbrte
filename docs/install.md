# Installing Agbrte

[← README](../README.md)

Three ways in, depending on where you want the work to run: a desktop build, a
checkout, or one file sent to a server.

## A desktop build

**[Releases](https://github.com/YounghyeonPark/agbrte/releases/latest)** carries
macOS, Windows and Linux, x64 and arm64.

Builds are **unsigned and say so**: macOS will report an unidentified developer
and Windows SmartScreen will warn, which is exactly what an unsigned build is.
No certificates are referenced anywhere in the release workflow, and wiring them
in later needs nothing but the secrets.

## From a checkout

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

## On a server

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

You do not have to do this by hand for a machine you can already reach by ssh —
[attaching one from the app](remote.md) installs the same thing on first attach.

## Two installations on one computer

`AGBRTE_HOME` moves the `~/.agbrte` directory, and it moves the whole installation
with it: the machine id, the host record, the list of open workspaces, the
credentials, and therefore the socket, which is named from the machine id. Set it
when you want two builds on one computer to stay out of each other's way — a
release and a checkout are two installations, and without it they fight over one
host.

**Upgrading a running host is `agbrte update`**, which stops it so the next attach
deploys this build; versions negotiate as a range, so a newer client connects to
an older host and says which commands that host predates.

## Testing it

`npm run check` (typecheck + Vitest over the headless core) is the everyday one;
`npm run smoke` drives a real window and a real host process, and `npm run e2e` is
the only layer that can verify [DESIGN.md](../DESIGN.md) §15's acceptance
criteria, including closing the app and relaunching it to prove a transcript
survived. Tests that need a local model **skip loudly** rather than passing: a
criterion whose test was skipped is not a criterion that holds.
