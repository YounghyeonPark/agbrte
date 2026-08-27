# Status — what is proven, and what is not

[← README](../README.md)

[DESIGN.md §15](../DESIGN.md) is the authority and says which part of a phase is
only partly true. This page is the summary.

| | Phase | |
| :-- | :-- | :-- |
| ✅ | **1 · Skeleton** · **2 · Persistence hardening** · **4 · Multi-session + dashboard** · **6 · Multi-agent and session hierarchy** | done |
| 🟡 | **5 · Remote execution and device independence** · **7 · Multimodal** | acceptance criteria met, with named substitutions |
| 🟡 | **3 · Three-shape proof** | half validated |
| 🔨 | **8 · Breadth + polish** | started |

## What works

A text session edits a real repository and its transcript survives an app
restart. Remote workspaces, hosts that outlive the app, and several clients on one
session are exercised against a real server — including a phone, over a browser,
on a tailnet. There is a dashboard, stall detection, quota parking that resumes on
its own, notifications, a CLI for headless machines, and a one-file installer. One
conformance suite runs against four deliberately different runtimes, including the
agent CLI you already have installed.

## What is not proven, named rather than glossed

**The model-provider axis has exactly one implementation** (`openai-compatible`),
so it describes one wire format rather than abstracting several; the runtime axis
has four. An abstraction validated against one implementation is not validated,
and this is the gap that says so.

**The remote-detached mechanism is verified against a real server but its model
half is not.** "An agent on a GPU box using that box's own model server" has never
run, because that box has no model server.

**Phase 7's acceptance sentence has run end to end**, with the agent local rather
than remote and unable to see the picture.

**OCR is not built**, so the redaction sweep reports `scanned: false` rather than
an empty match list.

**The published recording ages in a direction nothing checks.** The demo at
[agbrte.dev/app/](https://agbrte.dev/app/) replays a real socket log, so it is
honest the day it is taken and drifts from the app every day after. A channel
that starts answering with a new shape finds an old one in the file, and the
symptom is a card that opens onto a transcript rendered slightly wrong — no
error, no failing test, and nobody looking. `pages.yml` asserts the file is
*there*, which is a different question from whether it is *current*. Re-take it
with `npx playwright test recording --grep @recording` when the contract moves.

## And what a test suite cannot see

A whole class of defect is only visible on a real remote machine: binding to the
wrong folder, a host that cannot be found, a sidebar row with nothing under it.
The suite stays green through all of them. Where that has bitten, the fix is
recorded in the commit that made it — the commit messages here explain defects
rather than diffs, and are worth reading as a second history of the design.
