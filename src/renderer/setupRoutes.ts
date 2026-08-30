/**
 * What the one list on "Add an agent" contains, and in what order (§6.4, §3.7).
 *
 * Pure functions, out here rather than in the component, for a reason that is
 * not tidiness: what that window shows depends on what the machine running the
 * tests happens to have installed, so an end-to-end assertion about the list
 * would hold on some laptops and silently stop holding on others. A criterion
 * that quietly stops being checked is worse than one that was never claimed.
 * Here it is a function of what a host reported, and it is checked in states no
 * laptop in this room is in.
 *
 * The *order* is the design and so it is the thing pinned. This screen has been
 * rebuilt three times — a panel of routes, one Claude-first button, a
 * model-first pair — and every rebuild was a re-ranking of the same four
 * remedies. Ranking them is work the app can do better than the person can, and
 * `buildEntries` is where it is done once.
 */

import type { ModelCapabilityHint } from '../shared/types/index.js';

/**
 * A runtime's name with our own parenthetical taken off.
 *
 * The detection notes carry labels built for the agent picker — `Claude Code
 * (installed CLI)`, `Gemini CLI (installed, unverified manifest)` — where the
 * suffix earns its place: §3.12 wants a manifest nobody has verified against
 * the vendor's current build to say so on the row where an agent is configured.
 *
 * On the setup panel it is noise at best and misdirection at worst. Somebody
 * who has just attached a server is being told a CLI is missing; the
 * verification status of the manifest for a program that is not installed is
 * not a fact they can use, and "installed CLI" beside "is not installed" is a
 * sentence that has to be decoded before it can be dismissed. Vocabulary this
 * codebase needs is not vocabulary the person needs.
 *
 * Only a trailing parenthetical, and never the whole string: a label that is
 * nothing but a parenthetical stays as it is, because a nameless line is worse
 * than a jargon-y one.
 */
export function plainName(label: string): string {
  const stripped = label.replace(/\s*\([^()]*\)\s*$/, '').trim();
  return stripped === '' ? label : stripped;
}

// --------------------------------------------------------------- the one list

/**
 * What has to happen before the chosen thing can run.
 *
 * The screen this replaces asked the same question three times — a set-up panel
 * with its own routes, a "what will run" dropdown, and a catalogue with its own
 * Install buttons — and a person had to know which of our three mechanisms
 * applied to them before they could answer any of it. They are one question:
 * *what should run this session*. So there is one list, and the difference
 * between its entries is not which panel they came from but whether pressing the
 * button seats an agent immediately or has to fetch something first.
 */
export type EntryPlan =
  /** Everything is already there. Seat it. */
  | { kind: 'ready' }
  /** The escape hatch: a model id the host did not list, typed by hand. */
  | { kind: 'typed' }
  /** Pull a model, and install the server that will hold it if there is none. */
  | { kind: 'pull'; tag: string; bytes: number; needsServer: boolean }
  /** Install a vendor CLI, which brings its own model and its own sign-in. */
  | { kind: 'cli'; cli: 'claude-code' | 'gemini-cli' }
  /** Take a key and write an endpoint on that machine. */
  | { kind: 'endpoint' };

/**
 * One line in the only list on the screen.
 *
 * `label · hint` is the shape asked for and the shape that reads: the model
 * first, because that is what somebody is choosing between, then what will run
 * it. `note` is the second line — a model's description, or the host's own
 * reason a CLI is not offered — and it is the one piece of prose here that has
 * been asked for twice, because "Small and general. Runs on a laptop without a
 * discrete GPU" is not deducible from a tag and a byte count.
 */
export interface AgentEntry {
  /** The select's value. Stable across refreshes; see `buildEntries`. */
  value: string;
  label: string;
  hint?: string;
  note?: string;
  runtimeId: string;
  modelId: string | null;
  endpointId?: string;
  typed?: boolean;
  plan: EntryPlan;
  /** Which of the two groups this sits in. `ready` sorts first, always. */
  group: 'ready' | 'install';
}

/** A catalogue row, as `shared/models/catalogue.json` carries it. */
export interface CatalogueModel {
  tag: string;
  label: string;
  note: string;
  bytes: number;
}

/** What one host answered about one endpoint, narrowed to what a list needs. */
export interface EndpointAnswer {
  endpointId: string;
  models: string[];
  canInstall?: boolean;
  /**
   * What each listed model says about itself, where anything says anything
   * (§3.3).
   *
   * Here for the *order* rather than for the badges — those are read off the
   * DTO in the component, beside the row they describe. `buildEntries` needs
   * one claim out of this, and the reason it is worth threading through is that
   * it arrives with the list: nothing has to be run to know it.
   */
  capabilities?: ModelCapabilityHint[];
}

/** A runtime the host advertised, narrowed the same way. */
export interface RuntimeSummary {
  id: string;
  model: 'required' | 'optional' | 'none';
}

/** The two vendor CLIs this app can install, in the order they are offered. */
export const INSTALLABLE_CLIS: ReadonlyArray<{
  cli: 'claude-code' | 'gemini-cli';
  runtimeId: string;
  label: string;
}> = [
  { cli: 'claude-code', runtimeId: 'cli:claude-code', label: 'Claude Code' },
  { cli: 'gemini-cli', runtimeId: 'cli:gemini-cli', label: 'Gemini CLI' },
];

/** GB to one decimal, which is the only precision that changes a decision. */
export function sizeOf(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

/**
 * Where one already-present model sits among the others, lower first.
 *
 * These rows used to come out in whatever order the endpoint answered in, and
 * on a real machine that is close to arbitrary. This one lists `qwen3:0.6b`
 * first and `qwen2.5:7b` fifth. The control opens on the first entry, so the
 * first agent a stranger was handed was a 0.6B model that declares tool support,
 * does not then produce a usable tool call, and can therefore only chat.
 *
 * That is the incident `modelCapabilities.ts` was written for, arriving one step
 * earlier. There the person is told what they picked; here they are not steered
 * into it. Both are needed — this ranks, it does not hide, and the badge on the
 * row is still the thing that says what a model can do.
 *
 * ## Three signals, and none of them costs a request
 *
 * **A model watched calling a tool here comes first.** The strongest evidence
 * available, and the only one that does not go stale: it is a fact about this
 * machine rather than an opinion shipped in a release. It is free to read —
 * `probe()` caches, and the picker already probes whatever is selected on an
 * endpoint that costs nothing — and it is what keeps the catalogue from
 * outranking a model that did not exist when the catalogue was written. Somebody
 * who pulls next year's model and uses it once has ranked it, without us.
 *
 * **A server that declares no tools sends its model last.** `hintFrom` in
 * `openaiCompatible.ts` argues why a declared *no* is much stronger evidence
 * than a declared yes — Ollama refuses such a request outright rather than
 * attempting it — so this is settled rather than guessed, and a model that
 * cannot call a tool cannot do any of the work this program exists to do.
 * Measured on the machine this was written on: both `smollm2` tags answer
 * `["completion"]` and nothing more, while `qwen3:0.6b` answers `["completion",
 * "tools","thinking"]` and is the liar.
 *
 * **A model in the catalogue comes before one that is not.** That file is the
 * only place this codebase has written down which models are worth suggesting —
 * it exists because "reliable at tool calling" is not deducible from a tag and a
 * byte count — and a model somebody has already pulled *and* we already
 * recommend is the best answer obtainable without running anything. It is third
 * rather than first because it is the one signal here with a shelf life: it
 * ships in a release and says nothing about a model released after it.
 *
 * ## What is deliberately not used
 *
 * **How recently the model was pulled**, which is available — `/v1/models`
 * carries `created`, and Ollama's own `/api/tags` carries `modified_at` — and
 * which ranks this machine exactly backwards:
 *
 * ```
 * qwen3:0.6b    2026-08-13   newest, and the model from the incident
 * smollm2:360m  2026-08-12
 * llama3.2:1b   2026-08-12
 * smollm2:135m  2026-08-12
 * qwen2.5:7b    2026-05-31   oldest, and the one that works
 * ```
 *
 * It looked like the answer to catalogue staleness and it is the opposite of
 * one: people pull small models to try them and install the model they work with
 * once, long ago. Measured before it was believed, which is the only reason it
 * is not in the list above.
 *
 * Size, name, and **position within the catalogue**. That order is a download
 * recommendation, where a 2 GB model that runs on a laptop with no discrete GPU
 * beats a better 5 GB one; which of the models already here should be first is a
 * different question, asked on a machine whose hardware has already answered it.
 * Reusing the one order for both would quietly answer each with the other. So
 * membership only, which leaves ties — and a tie keeps the endpoint's order,
 * because a stable sort changes nothing it was not asked to.
 */
function readyRank(
  model: string,
  hint: ModelCapabilityHint | undefined,
  catalogue: CatalogueModel[],
): number {
  const tools = hint?.tools;
  if (tools?.value === 'none') return 3;
  if (tools?.from === 'probed') return 0;
  return catalogue.some((c) => c.tag === model) ? 1 : 2;
}

/**
 * Every way this host could run a session, as one ordered list.
 *
 * **Ready first, always.** A returning user's choice is a model that is already
 * there, and it must not move down the list because a catalogue grew. The
 * grouping is the whole of the warning about cost: nothing in the second group
 * happens without a download, and nothing in the first group does.
 *
 * **Within `ready`, the models are ranked rather than listed.** See `readyRank`
 * for the two signals and for the machine that made it necessary; the short of
 * it is that the endpoint's own order put a model that cannot call a tool at the
 * top, and the top is what the control opens on.
 *
 * The structural invariant from the version this replaces is kept: **every
 * model-taking runtime yields at least one entry**, so a model list that failed
 * to load cannot make a runtime unpickable — its "another model…" entry is the
 * old manual path, and it is always there.
 *
 * Nothing is hidden for being unavailable. A route that cannot work on this
 * machine is refused by the host with a sentence naming the reason and the way
 * round it (§7 puts enforcement there, because a client cannot police itself);
 * an entry that silently vanished would teach nothing at all.
 */
export function buildEntries(
  runtimes: RuntimeSummary[],
  answers: EndpointAnswer[],
  endpoints: Array<{ id: string; label: string }>,
  catalogue: CatalogueModel[],
  notes: Array<{ id: string; label: string; reason: string }>,
  labelOf: (runtimeId: string) => string,
): AgentEntry[] {
  const ready: AgentEntry[] = [];
  /**
   * Runnable, and nobody's answer to "what should run my work".
   *
   * Ranked below everything else in `ready` rather than dropped, because it is
   * genuinely useful: it is how you find out whether the log, the permission
   * gate and the transcript work without spending a turn on a model. It is also
   * the wrong thing to hand somebody as their first agent, and it *was* being
   * handed to them — this list is built in the order the host reports its
   * runtimes, the echo runtime is registered first, and the control defaults to
   * whatever is at the top. A stranger who pressed the one obvious button got a
   * program that repeats what they typed, which is the worst possible first
   * impression of a coding agent and reads as a fake.
   *
   * Selected by `model === 'none'` rather than by id, and the distinction is
   * real: `optional` is a runtime that brings its own model — an installed CLI,
   * which is a genuine agent and stays at the top. `none` is a runtime that
   * neither takes a model nor has one, which is a diagnostic by definition.
   */
  const diagnostic: AgentEntry[] = [];
  const install: AgentEntry[] = [];
  const here = new Set(answers.flatMap((a) => a.models));
  const canInstallInto = answers.some((a) => a.canInstall === true);
  const modelRuntime = runtimes.find((r) => r.model === 'required');

  for (const runtime of runtimes) {
    if (runtime.model !== 'required') {
      // `optional` lands here with `none`: an installed CLI has its own model
      // configured where it lives, and asking again in this window offered a
      // second answer to a question the CLI had already settled.
      (runtime.model === 'none' ? diagnostic : ready).push({
        value: runtime.id,
        runtimeId: runtime.id,
        modelId: null,
        label: plainName(labelOf(runtime.id)),
        hint: runtime.model === 'none' ? 'no model — for checking the plumbing' : 'brings its own model',
        plan: { kind: 'ready' },
        group: 'ready',
      });
      continue;
    }
    for (const answer of answers) {
      /*
       * Ranked within the endpoint and never across endpoints.
       *
       * Sorting the whole set together would interleave two recipients — one of
       * them possibly the network — and §13 wants the recipient legible at the
       * moment of choosing. So the endpoints keep the order the host listed them
       * in, and only what is inside one of them moves.
       */
      const ranked = answer.models
        .map((model) => ({
          model,
          rank: readyRank(
            model,
            answer.capabilities?.find((c) => c.modelId === model),
            catalogue,
          ),
        }))
        .sort((a, b) => a.rank - b.rank);
      for (const { model } of ranked) {
        const described = catalogue.find((c) => c.tag === model);
        ready.push({
          value: `${runtime.id}::${answer.endpointId}::${model}`,
          runtimeId: runtime.id,
          modelId: model,
          endpointId: answer.endpointId,
          label: model,
          /*
           * What runs it, and — only where it is ambiguous — where from.
           *
           * §13 wants the recipient legible at the moment of choosing, and with
           * two endpoints the same model name means two different things, one of
           * them possibly the network. With one endpoint the recipient line
           * under the control says it once, and repeating it on every row would
           * be noise rather than honesty.
           */
          hint:
            endpoints.length > 1
              ? `${labelOf(runtime.id)} · ${endpoints.find((e) => e.id === answer.endpointId)?.label ?? answer.endpointId}`
              : labelOf(runtime.id),
          ...(described !== undefined ? { note: described.note } : {}),
          plan: { kind: 'ready' },
          group: 'ready',
        });
      }
    }
    ready.push({
      value: `${runtime.id}::__type__`,
      runtimeId: runtime.id,
      modelId: null,
      typed: true,
      label: 'Another model…',
      hint: labelOf(runtime.id),
      plan: { kind: 'typed' },
      group: 'ready',
    });
  }

  /*
   * Models worth suggesting, minus the ones already here.
   *
   * Only where something can run them: with no model-taking runtime this host
   * has nothing to point a pulled model at, and offering the download would be
   * a gigabyte spent on a dead end.
   */
  if (modelRuntime !== undefined) {
    for (const model of catalogue) {
      if (here.has(model.tag)) continue;
      install.push({
        value: `install::model::${model.tag}`,
        runtimeId: modelRuntime.id,
        modelId: model.tag,
        label: model.tag,
        hint: `${labelOf(modelRuntime.id)} · ${sizeOf(model.bytes)} to download`,
        note: model.note,
        plan: {
          kind: 'pull',
          tag: model.tag,
          bytes: model.bytes,
          // No endpoint that takes an install means the machine has no model
          // server at all, so one has to be put there first. That is a second
          // download, and it is said before the click rather than after it.
          needsServer: !canInstallInto,
        },
        group: 'install',
      });
    }
  }

  for (const cli of INSTALLABLE_CLIS) {
    // Already installed: it is in `runtimes`, and has a ready entry above.
    if (runtimes.some((r) => r.id === cli.runtimeId)) continue;
    const note = notes.find((n) => n.id === cli.runtimeId);
    install.push({
      value: `install::cli::${cli.cli}`,
      runtimeId: cli.runtimeId,
      modelId: null,
      label: cli.label,
      hint: 'brings its own model',
      // The host's own words about why it is not offering this already, which
      // is the difference between installing a second copy and fixing a PATH.
      ...(note !== undefined ? { note: note.reason } : {}),
      plan: { kind: 'cli', cli: cli.cli },
      group: 'install',
    });
  }

  install.push({
    value: 'install::endpoint',
    runtimeId: modelRuntime?.id ?? 'agbrte-harness',
    modelId: null,
    label: 'Use a model API…',
    hint: 'a key kept on that machine',
    plan: { kind: 'endpoint' },
    group: 'install',
  });

  /*
   * Still inside the `ready` group, and that is deliberate. The heading below
   * separates "here now" from "this will download something", and the echo
   * runtime is very much here now — it is last among what is ready, not exiled
   * past a boundary that means something else.
   */
  return [...ready, ...diagnostic, ...install];
}

/**
 * What the one button will do, in its own words.
 *
 * Named after the work rather than after the control, because the work is what
 * varies: the same button seats an agent instantly, spends four minutes and a
 * gigabyte, or opens a form. A label reading "Add agent" over all three would be
 * a promise about duration that two of them break.
 */
export function actionLabel(plan: EntryPlan, fallback = 'Add agent'): string {
  switch (plan.kind) {
    case 'ready':
    case 'typed':
      return fallback;
    case 'pull':
      return plan.needsServer ? 'Install Ollama, download and add' : 'Download and add agent';
    case 'cli':
      return `Install ${plan.cli === 'claude-code' ? 'Claude Code' : 'Gemini CLI'} and add`;
    case 'endpoint':
      return 'Add endpoint';
  }
}

/**
 * The one line under the control: what it is, then what it will cost.
 *
 * Both halves earn their place. The description is why the catalogue existed at
 * all, and it is the thing a tag and a byte count cannot say. The cost is the
 * fact that decides a download, and saying it after the click is how somebody
 * ends up with an unexpected gigabyte on a machine they were lent.
 */
export function entryNote(entry: AgentEntry, where: string): string | null {
  const parts: string[] = [];
  if (entry.note !== undefined) parts.push(entry.note);
  switch (entry.plan.kind) {
    case 'pull':
      parts.push(
        entry.plan.needsServer
          ? `${sizeOf(entry.plan.bytes)} onto ${where}, and Ollama will be installed there first.`
          : `${sizeOf(entry.plan.bytes)} onto ${where}.`,
      );
      break;
    case 'cli':
      parts.push(`Installed on ${where}; signing it in there afterwards is yours to do.`);
      break;
    default:
      break;
  }
  return parts.length === 0 ? null : parts.join(' ');
}
