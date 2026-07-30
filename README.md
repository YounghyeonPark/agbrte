# Loom

An agent-based development workbench. Multiple sessions, multiple agents per
session, any model behind a pluggable adapter, running locally or on a remote
machine — and agent memory that survives the workspace folder being moved.

**Status: Phase 1 complete.** A single text session edits a real repository and
its transcript survives an app restart, verified end to end. Phases 2–8 (see
[DESIGN.md §15](DESIGN.md)) are not built yet — no dashboard, no remote
execution, no multi-agent, no multimodal.

## The shape of it

Three axes, deliberately independent, so adding a vendor never touches transport
code and vice versa:

| Axis | Interface | Means |
|---|---|---|
| Harness | `AgentRuntime` | who runs the loop — a vendor SDK, a CLI, or our own |
| Model | `ModelProvider` | which model answers |
| Location | `Transport` | where it executes (Phase 5) |

The load-bearing decision is that **the append-only event log is the source of
truth**, not any provider's session state. One function, `rehydrate()`,
reconstructs context from that log, and it serves four separate requirements: a
moved folder, a migrated machine, a switched provider, and a resumed quota
window. It is also the in-session compactor, so the durable path is exercised
constantly and cannot rot.

`DESIGN.md` is the real specification — 17 sections, including what is
deliberately unfinished and why. Read §1–§3 for the architecture, §5 for
durability, §13 for the permission model.

## Running it

Needs Node 22+. For a local model, an [Ollama](https://ollama.com) server:

```bash
npm install
ollama pull qwen2.5:7b        # optional; the echo runtime needs no model

npm run dev                   # Vite + esbuild watch + Electron
```

Then: choose a workspace folder, create a session, add an agent, and type.
Pick the `echo` runtime to exercise the UI without a model at all.

Headless, without the app:

```bash
npm run loom -- --workspace /path/to/repo --model qwen2.5:7b "add a test for the parser"
```

## Tests

Three layers, each with a different job:

```bash
npm test          # Vitest over the headless core — no Electron, ~1s
npm run smoke     # a real window + a real agent host process, 14 checks
npm run e2e       # Playwright drives the built app as a user
npm run check     # typecheck (node + web projects) then npm test
```

`npm test` is the one to run constantly. `npm run smoke` catches the class of
failure where the app opens and every button silently does nothing — a preload
built as ESM exposes nothing, with no error anywhere. `npm run e2e` is the only
layer that can verify §15's acceptance criteria, including closing the app and
relaunching it to prove a transcript survived.

Tests that need a local model **skip loudly** rather than passing. A criterion
whose test was skipped is not a criterion that holds.

## Layout

```
src/shared/      types, the IPC contract, the agent-host protocol
src/main/        session manager, event log, policy gate, IPC — no adapters
src/host/        the utilityProcess that runs agent loops and tools
src/preload/     the entire privileged surface the renderer gets
src/renderer/    React + Tailwind, windowed projection over the log
src/cli/         headless driver, useful for testing adapters
```

Agent loops run in a separate process, so a crashing adapter cannot take the
window down. Main keeps session state, the log, and the permission gate, and
never runs an adapter.

## A note on the workspace

Loom stores everything in `.devagents/` inside the workspace, which means
**do not put a workspace inside a sync-managed folder** (Google Drive, Dropbox,
OneDrive). The log is append-only with byte-offset resume, and sync clients
rewrite files and create conflict copies. Use a git remote for backup instead;
the repository history is the durable copy.
