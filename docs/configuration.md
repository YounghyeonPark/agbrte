# Configuration, and the workspace

[← README](../README.md)

Two files, since `--help` covers flags and not files.
**[DESIGN.md](../DESIGN.md) §3.8 and §8.2 are the full reference for both**,
including why credentials belong to the machine's host rather than to whoever is
attached.

## `~/.agbrte/endpoints.json` — the models a host can reach

Mode `0600`. Selected with `--endpoint <id>`. A file rather than an environment
variable because a host started over ssh runs a non-login shell and never sources
your profile; the key stays on the host and never reaches a client or a
transcript.

```json
{ "endpoints": [{ "id": "local", "baseUrl": "http://127.0.0.1:11434/v1" },
                { "id": "vendor", "baseUrl": "https://api.example.com/v1",
                  "provider": "Example AI", "apiKey": "sk-..." },
                { "id": "claude", "api": "anthropic", "apiKey": "sk-ant-..." }],
  "default": "local" }
```

`api` picks which adapter speaks to the endpoint: `openai-compatible` (the
default, and what every endpoint used before this field existed) or `anthropic`.
An unknown value is refused when the file is read, with the known ones listed —
a typo that fell back to the default would send your source code to an API you
did not name. `baseUrl` may be omitted when `api` names a service with one URL,
which is why the `claude` entry above has none.

`provider` is **not** routing. It is the disclosure shown wherever a turn's
destination is displayed, it is free text, and `"Anthropic (EU)"` is a perfectly
good value for it. `api` has to match an adapter's id exactly.

### Falling back when one will not answer

```json
{ "endpoints": [ … ], "default": "gpubox", "fallback": ["gpubox", "nim", "local"] }
```

`default` is where a turn starts and `fallback` is the order to try, with that
default as its first name — a `default` missing from `fallback` gets no failover
at all, since the chain has nowhere to continue from. The app writes both from
one ordered list so that combination cannot be produced by mistake; editing this
file by hand still reaches it.

`fallback` is the order to try. A turn stopped by a refusal, an unreachable
server, a rate limit or a spent allowance moves to the next name and carries on —
the conversation is rebuilt from the log rather than held by the server, so
nothing is lost in the move. The transcript records it with the reason, because
the model changed and its predecessor's reasoning could not come with it.

The order is also editable from the app — *Fallback order* under `Add an agent`,
which shows what is in force and lets it be rearranged. The host restarts onto a
saved order, because the process that walks the chain reads this file when it
starts.

**A move is not permanent.** The next turn starts at the top of the list again,
so a box that comes back is picked up with nothing to notice it — the cost is one
failed request per turn while it stays down, which is small and self-correcting.
Because coming back is silent, each turn records the endpoint that answered it:
the roster says *also sent to X* for anything the seat does not name, and an
export names every provider the conversation reached.

It does **not** move on everything. A malformed request, a token ceiling you set,
a filtered response and a missing credential all stay put: retrying those
elsewhere either repeats the same failure more slowly or answers a configuration
problem by sending your code to a vendor you did not name. And a next endpoint
that cannot do what the session is doing — no tool calling, when the agent is
mid-tool-loop — is skipped, because a silent downgrade is worse than the failure
it avoids.

Every name must be an endpoint in the list above; a typo is refused when the file
is read rather than ending the chain one step early.

**You do not have to edit this file.** The model picker's *Use a model API…* row
opens a form with the same four fields plus the API choice, and writes the entry
on whichever machine that host runs on — which is the point, since the file lives
next to the host and not next to you. A vLLM, an NVIDIA NIM, an Ollama on another
box: name it, give it the URL, leave the key empty if it needs none. Editing the
file by hand stays available and is the only way to change an endpoint that
already exists, because the write path refuses to redirect an id an agent may
already be pointing at.

## `<workspace>/.agbrte/access.json` — watching rather than driving

A seatbelt and not a lock, since the label is self-reported and anyone who can
reach the host's socket already owns the workspace.

```json
{ "rules": [{ "client": "agbrte-app@laptop-*", "role": "read-only" }] }
```

## A note on the workspace

Agbrte stores everything in `.agbrte/` inside the workspace, which means
**do not put a workspace inside a sync-managed folder** (Google Drive, Dropbox,
OneDrive). The log is append-only with byte-offset resume, and sync clients
rewrite files and create conflict copies. Use a git remote for backup instead;
the repository history is the durable copy.

Workspaces created before v0.0.12 use `.devagents/` instead. That name is read
forever and is never renamed for you: a rename would move an `events.jsonl` a
detached host may be appending to, would show up as deletions in your tracked
tree, and would hide your sessions from an older release. Both names work, side
by side, on the same machine.

## Moving an installation

`AGBRTE_HOME` is in [Installing Agbrte](install.md#two-installations-on-one-computer),
because what it moves is the installation rather than a preference.
