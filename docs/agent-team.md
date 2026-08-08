# Agbrte's sub-agent team

Eight project agents live in [`.claude/agents/`](../.claude/agents/). Each owns one part of the system and encodes that part's invariants from [DESIGN.md](../DESIGN.md), so the rules survive being forgotten between sessions.

| Agent | Owns | Writes code? | Invoke when |
|---|---|:---:|---|
| **architecture-guard** | the three-axis boundaries (harness / model / transport) | no — reviews | before merging anything touching `AgentSpec`, `AgentRuntime`, `ModelProvider`, `Transport`, `RuntimeCapabilities`, or orchestrator code |
| **session-orchestrator** | session lifecycle, state machines, the session tree, briefs and result contracts, hierarchical budgets, QuotaScheduler, roll-up | yes | SessionManager work; state transitions; split/spawn/reparent; budget or quota scheduling; a session stuck in a wrong state |
| **adapter-smith** | adapters, schema degrader, `ToolCallCodec`, CLI manifests, conformance suite | yes | adding or fixing an adapter; a model mis-calls tools; a vendor protocol changed |
| **durability-warden** | event log, checkpoints, `PathCodec`, attachments, identity, `rehydrate()`, mirror | yes | store/mirror/resume work; new event type; schema bump; resume misbehaves |
| **electron-shell** | process boundaries, typed IPC, backpressure, renderer memory, platform quirks | yes | main/preload/renderer wiring; new IPC method; UI lag or leak; capture or notification bugs |
| **remote-ops** | transports, `agbrte-agent-host`, detachment, tunneling, tails, forwarding | yes | any remote work; a detached run dies; reconnect loses or duplicates events |
| **security-auditor** | §13 commitments — credentials, gate honesty, redaction, trust boundaries | no — reports | before merging auth, credential, permission, capture, gateway, transport, or file-mode changes |
| **spec-keeper** | DESIGN.md truthfulness, decisions, matrices, risks, open questions | yes (docs) | after a phase milestone; doc and code disagree; an open question resolves |

`session-orchestrator` and `electron-shell` split along a line worth remembering: the orchestrator owns what the app *decides* (state transitions, tree semantics, budget math), the shell owns how those decisions *execute* (processes, IPC, rendering). Session hierarchy (§4.3) exposed this gap — it had been falling between the two.

## Why this split

Each agent maps to a class of mistake that is **cheap to make and expensive to discover late**:

- The three abstractions can leak invisibly — DESIGN.md §16 names abstraction ossification as risk number one, so it gets a dedicated reviewer.
- Persistence invariants (append-only, single-writer, `seq`-authoritative, workspace-relative paths) break silently and only surface when someone moves a folder months later.
- Electron process boundaries are violated by ordinary-looking code that happens to block main or grow an array forever.
- Remote detachment fails in ways that look like success until an overnight run vanishes.
- A permission gate that *claims* to be stronger than it is causes real harm, because the user acts on the claim.
- A pause misclassified as a failure discards hours of work — and there are five pause conditions, so there are five chances to get it wrong.

**Tests belong to whoever owns the invariant**, not to a separate QA agent: conformance to `adapter-smith`, golden-transcript continuity to `durability-warden`, the soak test to `electron-shell`, the Docker `sshd` fixture to `remote-ops`.

## Working conventions

**Two agents are read-only by design** — `architecture-guard` and `security-auditor` have no `Write` or `Edit`. They report; the owning agent fixes. This keeps review honest and stops a reviewer from quietly reshaping the thing it was meant to judge.

**Ownership is exclusive.** Each agent's prompt ends with non-goals so findings get routed rather than duplicated. If two agents seem to overlap on something, that is a signal the boundary in DESIGN.md is unclear — fix the doc, not the prompts.

**Run reviewers before merge, not after.** `architecture-guard` and `security-auditor` are cheapest when the diff is small. Both work from `git diff`.

**Adapter work verifies against vendor docs, not memory.** `adapter-smith`, `remote-ops`, and `spec-keeper` all have `WebFetch` for exactly this reason. Vendor CLI flags and event schemas change; the verified protocol tables in DESIGN.md §3.12 will rot otherwise, so re-verify and record what you checked against.

## Coverage by phase

| Phase (§15) | Lead | Reviewers |
|---|---|---|
| 1 Skeleton | electron-shell | architecture-guard |
| 2 Persistence hardening | durability-warden | architecture-guard |
| 3 Three-shape proof | adapter-smith | architecture-guard, security-auditor |
| 4 Multi-session + dashboard | session-orchestrator | electron-shell, architecture-guard |
| 5 Remote execution | remote-ops | security-auditor, durability-warden |
| 6 Multi-agent + session hierarchy | session-orchestrator | architecture-guard, durability-warden, security-auditor |
| 7 Multimodal | electron-shell | security-auditor |
| 8 Breadth + polish | adapter-smith | all |

`spec-keeper` runs at every phase boundary.

## Adding an agent

Only add one when a class of mistake has no owner. Symptoms that you need one: the same defect recurs across phases; a subsystem's rules keep having to be re-explained; or a reviewer is being asked to judge something outside its competence. Give the new agent explicit non-goals so it does not erode an existing boundary, and add it to the phase table above.

## Notes

- No `model:` is set in any definition, so agents inherit the session's model. Add `model: opus` (or another tier) to a definition's frontmatter to pin one — worth considering for `architecture-guard` and `security-auditor`, where judgment matters most, and for cheap mechanical agents if any are added later.
- These are project-scoped (`.claude/agents/`) and travel with the repo, so the team is shared with anyone who clones it.
