# Status — what is proven, and what is not

[← README](../README.md)

[DESIGN.md §15](../DESIGN.md) is the authority and says which part of a phase is
only partly true. This page is the summary.

| | Phase | |
| :-- | :-- | :-- |
| ✅ | **1 · Skeleton** · **2 · Persistence hardening** · **4 · Multi-session + dashboard** · **6 · Multi-agent and session hierarchy** | done |
| 🟡 | **5 · Remote execution and device independence** · **7 · Multimodal** | acceptance criteria met, with named substitutions |
| ✅ | **3 · Three-shape proof** | done — four runtimes, and two provider wire formats |
| 🔨 | **8 · Breadth + polish** | started |
| ✅ | **9 · Workflows** | done — authored, validated, drawn, edited and run, and a run survives a host restart |

## What works

A text session edits a real repository and its transcript survives an app
restart. Remote workspaces, hosts that outlive the app, and several clients on one
session are exercised against a real server — including a phone, over a browser,
on a tailnet. There is a dashboard, stall detection, quota parking that resumes on
its own, notifications, a CLI for headless machines, and a one-file installer. One
conformance suite runs against four deliberately different runtimes, including the
agent CLI you already have installed.

## What is not proven, named rather than glossed

**The second model provider has never called the vendor, and will not here.**
The `anthropic` adapter exists to validate the provider boundary — one
implementation is not an abstraction — and it did that, finding two places where
`ModelEndpoint.providerId` was written and never read. Its mappings are tested
two ways: against a stubbed transport for the shapes, and against a real HTTP
server on loopback for the headers, the GET, the status codes and an abort in
flight. What no credential is available for is the last step, so nobody has seen
the service accept one of these requests. That is a permanent gap in this
project rather than a task waiting its turn, and it is the sort a first live call
closes in a minute — with whatever it finds being about the vendor's expectations
rather than about the boundary.

**The remote-detached mechanism is verified against a real server but its model
half is not.** "An agent on a GPU box using that box's own model server" has never
run, because that box has no model server.

**Phase 7's acceptance sentence has run end to end**, with the agent local rather
than remote and unable to see the picture.

**A session budget limits tokens, not money, and not per day.** A ceiling now
bounds both what a session spends itself — a turn that would start with nothing
left parks for a person instead — and what it may reserve for children, which is
never released, so a tree cannot outspend its root. What is *not* enforced is
anything denominated in currency or in time: §6.5's per-day and cost ceilings
belong to the ModelGateway, which remains unbuilt because the four other things
it does have no work in a deployment that uses no API key.

**A child on another machine is spawned by two hosts in one process, not by two
machines.** The three-step that makes it possible — prepare on the parent's host,
create on the target's, commit back on the parent's — now runs against two hosts
with their own workspaces, managers and sockets, over the platform's real socket
rather than an in-memory channel, so what crosses is genuinely encoded. What that
still cannot see is the pair *disagreeing*: two builds, two versions, a field one
side sends and the other has never heard of. Two spawned host processes would
show it, and are blocked on something real — a split begins with an agent calling
`propose_split`, which has no command on the wire by design, so nothing outside a
host process can make a session inside it propose anything.

**OCR is not built**, so the redaction sweep reports `scanned: false` rather than
an empty match list.

**A public host is confined, not isolated.** `--public` withdraws every
capability that reaches past the workspace directory, and that much is tested and
was verified end to end against a real model — an agent on a public host answers
"NO SHELL TOOL" where the same prompt on a private one runs `ls -la`. What it
does *not* do is separate visitors from each other: they share one workspace and
one session list, so anything one of them writes, the next one sees. That is
acceptable for a demo of what the program is and is not a foundation for
anything else. Per-visitor workspaces, session and turn caps, and a reset are not
built.

## And what a test suite cannot see

A whole class of defect is only visible on a real remote machine: binding to the
wrong folder, a host that cannot be found, a sidebar row with nothing under it.
The suite stays green through all of them. Where that has bitten, the fix is
recorded in the commit that made it — the commit messages here explain defects
rather than diffs, and are worth reading as a second history of the design.
