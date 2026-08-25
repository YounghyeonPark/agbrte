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
                  "provider": "Example AI", "apiKey": "sk-..." }],
  "default": "local" }
```

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
