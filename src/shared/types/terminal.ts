/**
 * What a client may ask a host to start in a terminal (DESIGN.md §7, §3.12).
 *
 * A **selector, not a command line.** The whole security property of the
 * terminal surface is that a client cannot name a binary, a path, or an
 * argument: it names one of a closed set of *roles*, and the host maps that role
 * onto something it has already detected for itself. There is deliberately no
 * `command`, no `args`, no `cwd` and no `env` here, because any one of them
 * would turn "give me a terminal" into "run this for me" — a general execution
 * RPC wearing a terminal's name, through which a renderer would have widened its
 * own reach just by asking politely (§7).
 *
 * `cliId` looks like the one hole in that and is not. It is matched against the
 * host's own `CLI_MANIFESTS`, which is a constant in the host's bundle, and an
 * id the host did not *detect* is refused even when the manifest exists. So the
 * set of things this type can express is: the user's login shell, one of at most
 * a handful of vendor CLIs that are installed on that machine — the same set the
 * runtime picker offers, by construction rather than by agreement — or Agbrte's
 * own CLI, which the host resolves beside its own bundle and nowhere else.
 *
 * Absent means `{ kind: 'shell' }`. That is what a client older than this field
 * effectively asked for, and it is the choice with the fewest assumptions.
 */
export type ShellProgram =
  /** The machine's own login shell — how somebody fixes a PATH or runs `git`. */
  | { kind: 'shell' }
  /**
   * An installed agent CLI, run **interactively**.
   *
   * Not the headless argv a turn composes (`-p --output-format stream-json …`):
   * this is the vendor's own full-screen interface, which is the only place
   * things like `claude /login` exist at all. The id is the manifest's `cliId`,
   * e.g. `claude-code` — the same string `cli:claude-code` is built from.
   */
  | { kind: 'cli'; cliId: string }
  /**
   * **Agbrte's own CLI, attached to the session the pane is showing.**
   *
   * The one program in this union that is not somebody else's: `agbrte attach
   * --session <id>` is a *client of this host*, over the same socket the window
   * uses, so a turn typed here is queued by the same owner, answered by the same
   * agent, and written to the same log (§8.1, §17 Q15). It is the answer for a
   * seat with no vendor binary — a harness on a local model has no full-screen
   * interface of its own, and before this the pane could only offer a prompt.
   *
   * That makes it the exception to what the other two kinds promise, and the
   * exception is the interesting part: a shell and a vendor CLI are outside the
   * record on purpose, and this is inside it on purpose. A pane running this
   * must not repeat the "nothing here enters the transcript" sentence, because
   * for this program that sentence is false.
   *
   * Still a selector and still not a name: the host resolves the entry beside
   * its own bundle, runs it with the runtime it is running under, and points it
   * at a session **it** can name — the client sends no path, no argv and no id
   * that is not already a session on that host.
   */
  | { kind: 'agbrte' };
