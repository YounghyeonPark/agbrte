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
| ✅ | **9 · Workflows** | done — authored, validated, drawn, edited and run, a run survives a host restart, and one can be left on a routine |

## What works

A text session edits a real repository and its transcript survives an app
restart. Remote workspaces, hosts that outlive the app, and several clients on one
session are exercised against a real server — including a phone, over a browser,
on a tailnet. There is a dashboard, stall detection, quota parking that resumes on
its own, notifications, a CLI for headless machines, and a one-file installer. One
conformance suite runs against four deliberately different runtimes, including the
agent CLI you already have installed.

What a project uses is a file in that project: a skill, and an MCP server whose
declaration names a variable rather than holding a key — the machine keeps the
value, and the form asks for whatever is missing by name. The app knows a couple
of servers and writes the declaration when one is picked. A session reaches the
network through a named tool rather than a shell line, so which sites it read is
a question the log answers, and a forwarded port carries a dev server to a
browser or a remote machine's desktop to a remote-desktop client.

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

**A session budget limits billable tokens, not money, and not per day.** A
ceiling bounds what a session spends itself — a turn that would start with
nothing left parks for a person — and what it may reserve for children, which is
never released, so a tree cannot outspend its root. **Free tokens are not
counted**: a local model bills nobody, and stopping a long local run at a figure
chosen for a cost never incurred would be a limit imposed by the mechanism rather
than by anyone's intent. What is *not* enforced is anything denominated in
currency or in time: §6.5's per-day and cost ceilings belong to the ModelGateway,
which remains unbuilt because the four other things it does have no work in a
deployment that uses no API key.

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

**Nobody has followed the vLLM or NIM checklist to a running server.** Picking
either now reads the machine — GPU, WSL, Docker, the container runtime, and
whether something already answers on the port — and prints what is left to do.
The probes are exercised against this machine, where the answer is *WSL is not
installed*, and against stubbed runners for the branches this machine cannot
reach. What has never happened is the end of the list: no box available here has
vLLM or NIM on it, so the last step — add it as an endpoint and run a turn
through it — is unwalked, and with it the `alreadyServing: true` path that says
a machine is ready. Two confident wrong answers were already found by running
the probes rather than reasoning about them (a missing GPU reported on an RTX
4090; a port reported busy because `cmd.exe` echoed the script asking about it),
which is the reason to distrust the rest until somebody walks it.

**No server in the catalogue has been run against the thing it talks to.** The
mechanism is proven end to end and more than once: a declaration is read, the
names it asks for are resolved against the machine, a **real** stdio MCP server
is spawned, its tools land on the session, and a host restart brings it back —
all against `tests/fixtures/mcpServer.cjs`, which speaks the actual protocol. The
part nobody here has done is the vendor's half. Package names and the variables
each reads were taken off the npm registry and each package's own readme on the
date in `catalogue.json`, and the versions are pinned to what was checked; what
cannot be checked from this machine is whether a free tier is still free, or
whether the package still works. Running one needs a SearXNG instance — this
machine has no container runtime — or a key from a vendor.

**Nobody has put a desktop through the tunnel.** A forward is `ssh -L` and always
carried any TCP port; what changed is that the session view stopped presenting
every one as a browser link, since a browser cannot speak RDP. Both shapes the
row renders are tested. What has not happened is the end of it: `3389` forwarded
from a real machine with a screen, into a remote-desktop client. No host here has
a display.

**Two holes in the network tools are recorded rather than closed**, and both are
about a request that changes after it was vetted. `fetch` resolves a hostname,
checks every address, and then makes the request *by name* — a resolver that
answers differently the second time is not caught, and closing that means pinning
the connection to the vetted address, which needs a dependency this project does
not have. `screenshot` refuses the metadata address, but the browser follows
redirects itself, so a public page redirecting there is never seen by that check;
closing it means a proxy between the browser and the network. Neither is a task
waiting its turn — they are the known edges of a defence, written down because
one nobody recorded is worse than one whose limit is known.

**A schedule has been tested against a clock, never watched fire.** The
arithmetic is unit-tested at fixed times, the runner is driven by a fake clock,
and the end-to-end test writes one and reads it back off disk from the host that
will run it. Nobody has left one overnight and found the run in the morning,
which is the only thing that proves the part this feature exists for.

**OCR is not built**, so the redaction sweep reports `scanned: false` rather than
an empty match list.

**The remote screen has now been read off a real display, once.** A GNOME desktop
on the user's Ubuntu server came back at `:1 · 2944×1080`, `305ms · ~3.3/s` —
against the 0.13s grab plus 0.16s encode the design was built around, which is
the measurement holding on the machine it was taken from. What follows is what
that single confirmation does *not* cover.

The format decoder is tested against dumps built field by field — padded rows,
either byte order, 16/24/32 bits, masks in the wrong order, a colormap in the
way — and the driver is tested with `spawn` injected, including a display that
refuses the cookie and one that never answers. The end-to-end run proves the
whole path by asking a **Windows** host, which genuinely has no X display, and
getting that answer back through every layer. One frame off one Xorg desktop is
not a second machine, a second distribution, or a display that has to be argued
with.

Two limits are known rather than suspected. **Wayland**: `xwd -root` sees
XWayland's root and not the compositor's output, so a Wayland session may grab
little or nothing — the machine this was measured on runs Xorg on vt2. The
*capture* is still missing there and will stay missing until somebody builds the
portal path, but it is no longer silent: the host looks for a compositor socket
under `/run/user/<uid>/` and the viewer says so before the frame arrives, because
a black rectangle with nothing explaining it was the worst shape this feature
could fail in. Found on the filesystem rather than from `XDG_SESSION_TYPE`,
which a host started over ssh almost never has. Nobody has run it against a real
Wayland machine; what is tested is the detection, against built directories.

And **X authorisation**: a second display on that same machine refused with
`MIT-MAGIC-COOKIE`, and the refusal names `XAUTHORITY` rather than trying
candidate cookie paths, because a fallback chain never tested against a failing
display reports the wrong reason when all of it fails.

**The frame rate is a measurement, not a target.** 0.13s to grab 12.7MB plus
0.16s to encode 430KB, at 2944×1080, and `xwd` has no damage tracking — so every
frame is the whole screen and three to five a second is the ceiling. It is
rendered on screen for that reason. There is no video codec, no input, and no
agent tool; where a VNC server exists, the port forward is still the better
answer.

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

There is a second shape, and it is worse because the suite *does* see it. Four
specs failed in full runs and passed when run alone, over several days, and each
time the reflex was to call them flaky and move on. They were one product defect:
the runtime picker showed a preselection built before the models were known and
replaced it about a hundred milliseconds later, so a click landing in that tick
lost the list — and a person who read the first name and pressed the button in
that beat seated an agent they had not chosen. What found it was instrumenting
the thing rather than re-running it. **A test that only fails under load is
still a test that failed**, and "it passes alone" is a description rather than an
explanation.

**And it is not fully closed.** The same failure came back once in a full run
after that fix — `ports.spec.ts` timing out on `[data-testid=runtime-list]`, the
dropdown that "never appeared" — and the saved page snapshot rules out the cause
that was found last time: the picker had **settled**. It showed `8 ready on
build-01` and a local model already preselected, so `modelsBusy` was false, the
trigger was enabled, and Playwright's click landed. Something after that lost the
open.

**Both recorded candidates are now eliminated, and a third was ruled out by
reading.** `pickerRace.spec.ts` drives each condition on purpose rather than
waiting for a one-in-three failure:

- *The option list churning.* `applyHosts` sets a new array on every host push
  and the store then re-fetches `hosts.runtimes` for every host, so the picker's
  entire list is rebuilt several times a second under load. Pushed every eight
  milliseconds while the dropdown is opened: it opens, and stays open.
- *The controlled value moving.* `preferred` is derived from that answer, and a
  value changing in the tick Radix is opening is the exact mechanism of the
  defect that was found and fixed before. The runtime list is doctored to
  alternate, so the ranking really does move — **the test asserts that it moved**
  before asserting the open survived, because a version that quietly failed to
  create the condition would be a green test proving the opposite of its name.
- *An unmount.* The full-pane picker renders only while `active.agents.length ===
  0`, so anything seating an agent tears it out — which would lose the open for
  certain. The auto-add effect is the only spurious source, and it cannot fire
  here: it needs a remembered default, and every launch gets a throwaway profile.

What is left is environmental — a renderer starved of CPU by a full suite — and
no product change addresses that. So the value of this entry is now what it rules
*out*: the next person should not start at the models arriving, at the option
list, or at the ranking, and the tests are there to say why. The rest is recorded
rather than fixed, because the honest state is that it has not been reproduced. It passes alone, which the paragraph above says is a description; what
is new is the narrowing — whatever this is, it is *not* the models-arriving tick,
so the next person should not start there. Two candidates are visible in the code
and neither is evidence: `entries` is a `useMemo` over `runtimes`, which is
rebuilt on every host push, so the whole option list is a new array of new objects
several times a second under load; and `value` is derived from that list, so a
push that changes the ranking moves a controlled value the same way the original
defect did. The instrumenting-rather-than-re-running rule applies to both.

Worth knowing for anyone who meets it: the suite grew from 85 deterministic specs
to 89 when the display view landed, and the run from 8.3 to 8.9 minutes. That
does not cause a race, but it is more load on the machine that exposes one.
