/**
 * The one list on the "Add an agent" screen (DESIGN.md §6.4, §3.7, §3.12).
 *
 * Asserted here rather than end to end because what that window shows depends
 * on what the machine running the suite happens to have: a developer with a
 * local Ollama and a developer without drive two different screens, and a
 * criterion that quietly stops being checked is worse than one that was never
 * claimed. `buildEntries` is a pure function of what a host reported, so here it
 * is checked in every state, including the ones no laptop in this room is in.
 *
 * The property under test is mostly **order**. This screen has been rebuilt
 * three times — a set-up panel with routes, then one Claude-first button, then a
 * model-first pair — and each rebuild was a re-ranking. The ranking is the
 * design, so it is the thing pinned: what is ready comes before what has to be
 * fetched, and the model this app runs itself comes before the vendor CLI that
 * runs its own.
 */

import { describe, expect, it } from 'vitest';
import {
  actionLabel,
  buildEntries,
  entryNote,
  plainName,
  sizeOf,
  type AgentEntry,
  type CatalogueModel,
  type EndpointAnswer,
  type RuntimeSummary,
} from '../src/renderer/setupRoutes.js';
import type { ModelCapabilityHint } from '../src/shared/types/index.js';

const HARNESS: RuntimeSummary = { id: 'agbrte-harness', model: 'required' };
const ECHO: RuntimeSummary = { id: 'echo', model: 'none' };
const CLAUDE: RuntimeSummary = { id: 'cli:claude-code', model: 'optional' };

const CATALOGUE: CatalogueModel[] = [
  { tag: 'llama3.2:3b', label: 'Llama 3.2 3B', note: 'Runs on a laptop.', bytes: 2_019_392_628 },
  { tag: 'qwen2.5:7b', label: 'Qwen 2.5 7B', note: 'Reliable at tool calling.', bytes: 4_683_086_845 },
];

const ENDPOINT = [{ id: 'local', label: 'Ollama (that machine)' }];
const labelOf = (id: string): string =>
  ({ 'agbrte-harness': 'Agbrte harness', echo: 'Echo (no model)', 'cli:claude-code': 'Claude Code (installed CLI)' })[
    id
  ] ?? id;

const served = (models: string[], canInstall = true): EndpointAnswer[] => [
  { endpointId: 'local', models, canInstall },
];

/**
 * A self-description in the shape Ollama's own answer produces.
 *
 * `hintFrom` turns `/api/show`'s `capabilities` into this: a list containing
 * `tools` becomes a `self-described` *native*, a list without it becomes a
 * `self-described` **none** — which is the strong direction, because Ollama
 * refuses a tool request for such a model outright rather than attempting it.
 */
const declares = (modelId: string, tools: boolean): ModelCapabilityHint => ({
  endpointId: 'local',
  modelId,
  tools: { value: tools ? 'native' : 'none', from: 'self-described' },
});

/** The same claim, but watched rather than reported — §3.3's strongest tier. */
const probed = (modelId: string, tools: boolean): ModelCapabilityHint => ({
  endpointId: 'local',
  modelId,
  tools: { value: tools ? 'native' : 'none', from: 'probed' },
});

/**
 * This machine, measured — `curl /api/tags` then `/api/show` for each.
 *
 * Written out rather than reduced to the two rows that make the point, because
 * the ordering bug is a property of the whole list: `qwen3:0.6b` first,
 * `qwen2.5:7b` fifth, and two `smollm2` tags in between that declare
 * `["completion"]` and nothing else. A two-model fixture would have gone green
 * against the old code by accident.
 */
const THIS_MACHINE: EndpointAnswer[] = [
  {
    endpointId: 'local',
    canInstall: true,
    models: ['qwen3:0.6b', 'smollm2:360m', 'llama3.2:1b', 'smollm2:135m', 'qwen2.5:7b'],
    capabilities: [
      // Declares tools, and does not deliver one. The model from the incident.
      declares('qwen3:0.6b', true),
      declares('smollm2:360m', false),
      declares('llama3.2:1b', true),
      declares('smollm2:135m', false),
      declares('qwen2.5:7b', true),
    ],
  },
];

describe('the list a person chooses from', () => {
  /*
   * The regression a stranger meets and nobody else does.
   *
   * This list is built in the order the host reports its runtimes, the echo
   * runtime is registered first, and the control defaults to whatever is at the
   * top. So somebody who ran the program for the first time, opened the picker
   * and pressed the one obvious button got an agent that repeats what they
   * typed — the worst possible first impression of a coding agent, and one that
   * reads as the whole thing being fake.
   *
   * Written with `ECHO` first in the input specifically because that is the
   * order the failure came in. A test that passed `[HARNESS, ECHO]` would go
   * green against the old code.
   */
  it('never opens on the runtime that only echoes', () => {
    const list = buildEntries([ECHO, HARNESS], served(['qwen2.5:7b']), ENDPOINT, CATALOGUE, [], labelOf);
    expect(list[0]?.runtimeId).not.toBe('echo');
    expect(list[0]?.modelId).toBe('qwen2.5:7b');
  });

  it('keeps the echo runtime, and keeps it among what is ready', () => {
    // Ranked down, not removed: it is how somebody checks the log, the gate and
    // the transcript without spending a turn, and it is genuinely here now — so
    // it stays on this side of the boundary that means "this will download".
    const list = buildEntries([ECHO, HARNESS], served(['qwen2.5:7b']), ENDPOINT, CATALOGUE, [], labelOf);
    const echo = list.find((e) => e.runtimeId === 'echo');
    expect(echo?.group).toBe('ready');
    expect(list.findIndex((e) => e.runtimeId === 'echo')).toBeLessThan(
      list.findIndex((e) => e.group === 'install'),
    );
  });

  /*
   * The same failure as the echo one, from a different direction and one that
   * survives having a real model server.
   *
   * A machine with Ollama has no echo problem — a model runtime is reported
   * before the diagnostic one — and it still opened on an agent that cannot
   * work, because the list was in the endpoint's order and this endpoint puts
   * `qwen3:0.6b` first. That model declares tool support and then fails to
   * produce a usable call, which is the whole reason `modelCapabilities.ts`
   * exists; the badge told the person afterwards, and this stops them being
   * pointed at it in the first place.
   */
  it('opens on a model that can do the work, not on whichever came back first', () => {
    const list = buildEntries([HARNESS, ECHO], THIS_MACHINE, ENDPOINT, CATALOGUE, [], labelOf);
    expect(list[0]?.modelId).toBe('qwen2.5:7b');
  });

  it('sends the models whose server declares no tools to the back', () => {
    const list = buildEntries([HARNESS], THIS_MACHINE, ENDPOINT, CATALOGUE, [], labelOf);
    const models = list.filter((e) => e.group === 'ready' && e.modelId !== null).map((e) => e.modelId);
    // Ranked, not hidden. A machine that has only these must still be able to
    // pick one, and the row's own badge is what says it can only chat.
    expect(models).toEqual([
      'qwen2.5:7b', // in the catalogue, and declares tools
      'qwen3:0.6b', // declares tools; the endpoint's order decides the tie
      'llama3.2:1b',
      'smollm2:360m', // declares `["completion"]` — cannot call a tool at all
      'smollm2:135m',
    ]);
  });

  /*
   * The answer to the one question the catalogue cannot answer: what about a
   * model that did not exist when the catalogue was written?
   *
   * The catalogue ships in a release. `--check` in `scripts/model-catalogue.mjs`
   * catches a tag that vanished and cannot catch one that appeared, so the list
   * rots in exactly the direction that matters, and a rank resting only on it
   * would put next year's model below `mistral:7b` forever.
   *
   * A probe does not rot. It is a fact about this machine, established by
   * running the model, and it is free to read because the picker already probes
   * whatever is selected on an endpoint that costs nothing. So somebody who
   * pulls a model we have never heard of and uses it once has ranked it, with no
   * release from us.
   */
  it('puts a model watched calling a tool above one we merely recommend', () => {
    const answer: EndpointAnswer[] = [
      {
        endpointId: 'local',
        canInstall: true,
        models: ['qwen2.5:7b', 'a-model-released-after-this-was-written'],
        capabilities: [
          // In the catalogue, and only the server's word for it.
          declares('qwen2.5:7b', true),
          // In no catalogue, and watched doing the thing.
          probed('a-model-released-after-this-was-written', true),
        ],
      },
    ];
    const list = buildEntries([HARNESS], answer, ENDPOINT, CATALOGUE, [], labelOf);
    expect(list[0]?.modelId).toBe('a-model-released-after-this-was-written');
  });

  it('does not let a probe rescue a model that cannot call a tool', () => {
    // The tiers are not a ladder to climb: `probed` is how a claim was
    // established, not a bonus. A model watched *failing* is the strongest
    // evidence here, and it points down.
    const answer: EndpointAnswer[] = [
      {
        endpointId: 'local',
        canInstall: true,
        models: ['watched-failing', 'llama3.2:3b'],
        capabilities: [probed('watched-failing', false), declares('llama3.2:3b', true)],
      },
    ];
    const list = buildEntries([HARNESS], answer, ENDPOINT, CATALOGUE, [], labelOf);
    expect(list.filter((e) => e.modelId !== null && e.group === 'ready').map((e) => e.modelId)).toEqual([
      'llama3.2:3b',
      'watched-failing',
    ]);
  });

  /*
   * The tie-break is *no* tie-break, and that is the claim worth pinning.
   *
   * Catalogue membership was chosen over catalogue position precisely so this
   * stays true: the catalogue's order is a download recommendation, decided by
   * what a laptop with no GPU can run, and reusing it here would answer "which
   * of the models you already have" with the answer to a different question.
   */
  it('leaves models the endpoint listed in an order it has no reason to change', () => {
    const answer: EndpointAnswer[] = [
      {
        endpointId: 'local',
        canInstall: true,
        // Both in the catalogue, and the catalogue lists them the other way round.
        models: ['qwen2.5:7b', 'llama3.2:3b'],
        capabilities: [declares('qwen2.5:7b', true), declares('llama3.2:3b', true)],
      },
    ];
    const list = buildEntries([HARNESS], answer, ENDPOINT, CATALOGUE, [], labelOf);
    expect(list.filter((e) => e.modelId !== null && e.group === 'ready').map((e) => e.modelId)).toEqual([
      'qwen2.5:7b',
      'llama3.2:3b',
    ]);
  });

  it('ranks inside an endpoint and never across them', () => {
    // §13: two endpoints are two recipients, one of them possibly the network,
    // and a list that interleaved them would make the row the only place that
    // could say which — after having just been reordered by us.
    const two = [
      { id: 'openai', label: 'OpenAI' },
      { id: 'local', label: 'Ollama (that machine)' },
    ];
    const answers: EndpointAnswer[] = [
      { endpointId: 'openai', models: ['gpt-nothing-we-know-about'], canInstall: false },
      {
        endpointId: 'local',
        canInstall: true,
        models: ['smollm2:135m', 'qwen2.5:7b'],
        capabilities: [declares('smollm2:135m', false), declares('qwen2.5:7b', true)],
      },
    ];
    const list = buildEntries([HARNESS], answers, two, CATALOGUE, [], labelOf);
    expect(list.filter((e) => e.modelId !== null && e.group === 'ready').map((e) => e.modelId)).toEqual([
      // The API's model stays first because its endpoint is first, even though
      // nothing here recommends it: we do not know an API's models, and moving
      // one machine's models above another's is not a ranking we were asked for.
      'gpt-nothing-we-know-about',
      'qwen2.5:7b',
      'smollm2:135m',
    ]);
  });

  it('is unchanged by a host too old to describe its models', () => {
    // `capabilities` is absent from a host older than v14, and an absent claim
    // is "nobody could tell" rather than a no — so only the catalogue speaks.
    const list = buildEntries(
      [HARNESS],
      served(['qwen3:0.6b', 'smollm2:135m', 'qwen2.5:7b']),
      ENDPOINT,
      CATALOGUE,
      [],
      labelOf,
    );
    expect(list.filter((e) => e.modelId !== null && e.group === 'ready').map((e) => e.modelId)).toEqual([
      'qwen2.5:7b',
      'qwen3:0.6b',
      'smollm2:135m',
    ]);
  });

  /*
   * The distinction that makes the rule principled rather than a hardcoded id.
   * `optional` is a runtime that brings its own model — a real agent somebody
   * installed on purpose — and demoting it alongside echo would bury the best
   * answer on a machine that has one.
   */
  it('does not demote a CLI that brings its own model', () => {
    const list = buildEntries([ECHO, CLAUDE], served([]), ENDPOINT, CATALOGUE, [], labelOf);
    expect(list[0]?.runtimeId).toBe('cli:claude-code');
    expect(list.findIndex((e) => e.runtimeId === 'cli:claude-code')).toBeLessThan(
      list.findIndex((e) => e.runtimeId === 'echo'),
    );
  });

  it('puts everything ready before everything that has to be fetched', () => {
    const list = buildEntries([HARNESS, ECHO], served(['qwen2.5:7b']), ENDPOINT, CATALOGUE, [], labelOf);
    const groups = list.map((e) => e.group);
    // Not "contains both" — the boundary is crossed exactly once, which is what
    // makes the heading a warning rather than a decoration.
    expect(groups.indexOf('install')).toBeGreaterThan(0);
    expect(groups.lastIndexOf('ready')).toBeLessThan(groups.indexOf('install'));
  });

  it('names an entry as the model and what will run it', () => {
    const list = buildEntries([HARNESS], served(['qwen2.5:7b']), ENDPOINT, CATALOGUE, [], labelOf);
    const entry = list.find((e) => e.modelId === 'qwen2.5:7b');
    expect(entry?.label).toBe('qwen2.5:7b');
    expect(entry?.hint).toBe('Agbrte harness');
    expect(entry?.group).toBe('ready');
  });

  it('says which endpoint only where the same name could mean two things', () => {
    // §13: with two endpoints, one model name is two different recipients — one
    // of them possibly the network — and the row is the only place that can say
    // which. With one endpoint, the line under the control says it once.
    const two = [
      { id: 'local', label: 'Ollama (that machine)' },
      { id: 'openai', label: 'OpenAI' },
    ];
    const list = buildEntries([HARNESS], served(['qwen2.5:7b']), two, CATALOGUE, [], labelOf);
    expect(list.find((e) => e.modelId === 'qwen2.5:7b')?.hint).toBe(
      'Agbrte harness · Ollama (that machine)',
    );
  });

  it('does not offer to download something already there', () => {
    const list = buildEntries([HARNESS], served(['qwen2.5:7b']), ENDPOINT, CATALOGUE, [], labelOf);
    expect(list.filter((e) => e.modelId === 'qwen2.5:7b')).toHaveLength(1);
    expect(list.find((e) => e.value === 'install::model::qwen2.5:7b')).toBeUndefined();
    expect(list.find((e) => e.value === 'install::model::llama3.2:3b')?.group).toBe('install');
  });

  it('carries the description and the size, which are the two facts a tag cannot', () => {
    const list = buildEntries([HARNESS], served([]), ENDPOINT, CATALOGUE, [], labelOf);
    const entry = list.find((e) => e.value === 'install::model::llama3.2:3b');
    expect(entry?.note).toBe('Runs on a laptop.');
    expect(entry?.hint).toContain('2.0 GB to download');
  });

  it('knows when a model has nowhere to go yet', () => {
    // No endpoint takes an install, so the machine has no model server at all —
    // and that is a second download, said before the click.
    const stuck = buildEntries([HARNESS], served([], false), ENDPOINT, CATALOGUE, [], labelOf);
    const entry = stuck.find((e) => e.value === 'install::model::llama3.2:3b');
    expect(entry?.plan).toEqual({
      kind: 'pull',
      tag: 'llama3.2:3b',
      bytes: 2_019_392_628,
      needsServer: true,
    });
    expect(entryNote(entry!, 'build-01')).toContain('Ollama will be installed there first');
    expect(actionLabel(entry!.plan)).toBe('Install Ollama, download and add');

    const ready = buildEntries([HARNESS], served([], true), ENDPOINT, CATALOGUE, [], labelOf);
    const cheap = ready.find((e) => e.value === 'install::model::llama3.2:3b');
    expect(actionLabel(cheap!.plan)).toBe('Download and add agent');
  });

  it('offers a vendor CLI once, wherever it is', () => {
    // Installed: one ready entry, its own model, and nothing to install.
    const has = buildEntries([HARNESS, CLAUDE], served([]), ENDPOINT, CATALOGUE, [], labelOf);
    expect(has.filter((e) => e.runtimeId === 'cli:claude-code')).toHaveLength(1);
    expect(has.find((e) => e.runtimeId === 'cli:claude-code')?.group).toBe('ready');
    // And named as a person names it, not as this codebase does.
    expect(has.find((e) => e.runtimeId === 'cli:claude-code')?.label).toBe('Claude Code');

    // Absent: one install entry, carrying the host's own reason.
    const hasnt = buildEntries(
      [HARNESS],
      served([]),
      ENDPOINT,
      CATALOGUE,
      [
        {
          id: 'cli:claude-code',
          label: 'Claude Code (installed CLI)',
          reason: '`claude` could not be started on this host (ENOENT) — not on the PATH',
        },
      ],
      labelOf,
    );
    const entry = hasnt.find((e) => e.value === 'install::cli::claude-code');
    expect(entry?.group).toBe('install');
    expect(entry?.note).toContain('not on the PATH');
    expect(actionLabel(entry!.plan)).toBe('Install Claude Code and add');
    // The half this app cannot do, before the click rather than after it.
    expect(entryNote(entry!, 'build-01')).toContain('signing it in there afterwards is yours');
  });

  it('keeps the escape hatch, so a list that failed to load is not a dead end', () => {
    // The whole of the old manual-entry path: `/v1/models` is optional, so a
    // server that cannot list what it serves must still be usable.
    const list = buildEntries([HARNESS], [], [], CATALOGUE, [], labelOf);
    const typed = list.find((e) => e.typed === true);
    expect(typed?.group).toBe('ready');
    expect(actionLabel(typed!.plan)).toBe('Add agent');
    expect(entryNote(typed!, 'build-01')).toBeNull();
  });

  it('always offers a way to point at an API, since a key cannot be guessed', () => {
    const list = buildEntries([HARNESS], served(['qwen2.5:7b']), ENDPOINT, CATALOGUE, [], labelOf);
    const entry = list.find((e) => e.value === 'install::endpoint');
    expect(entry?.group).toBe('install');
    expect(actionLabel(entry!.plan)).toBe('Add endpoint');
  });

  it('suggests no download where nothing could run it', () => {
    // A host with no model-taking runtime has nothing to point a pulled model
    // at, and a gigabyte spent on a dead end is worse than an absent row.
    const list = buildEntries([ECHO], served([]), ENDPOINT, CATALOGUE, [], labelOf);
    expect(list.some((e) => e.plan.kind === 'pull')).toBe(false);
  });

  it('never seats an agent on a promise: only ready entries claim to be ready', () => {
    const list = buildEntries([HARNESS], served(['qwen2.5:7b']), ENDPOINT, CATALOGUE, [], labelOf);
    for (const entry of list) {
      const immediate = entry.plan.kind === 'ready' || entry.plan.kind === 'typed';
      expect(immediate).toBe(entry.group === 'ready');
    }
  });

  it('rounds a size to the digit that changes a decision', () => {
    expect(sizeOf(2_019_392_628)).toBe('2.0 GB');
    expect(sizeOf(13_780_000_000)).toBe('13.8 GB');
  });
});

describe('the names the picker uses', () => {
  it('drops the parenthetical, which is our vocabulary and not theirs', () => {
    // These are the labels the host actually sends, and both were on screen
    // verbatim: "Claude Code (installed CLI) is not there now".
    expect(plainName('Claude Code (installed CLI)')).toBe('Claude Code');
    expect(plainName('Gemini CLI (installed, unverified manifest)')).toBe('Gemini CLI');
  });

  it('leaves a name that has none alone', () => {
    expect(plainName('Claude Code')).toBe('Claude Code');
    expect(plainName('Claude Code 1.2.3')).toBe('Claude Code 1.2.3');
    // Only the trailing one: a parenthetical in the middle is part of the name.
    expect(plainName('Claude Code (beta) 1.2.3')).toBe('Claude Code (beta) 1.2.3');
  });

  it('would rather say something jargon-y than nothing at all', () => {
    // A label that is *only* a parenthetical would strip to the empty string,
    // and a nameless row is worse than an ugly one.
    expect(plainName('(installed CLI)')).toBe('(installed CLI)');
  });
});

/*
 * The two entries that install nothing (DESIGN.md §3.8).
 *
 * They exist because the alternative was what shipped before them: somebody
 * with a GPU box types a vLLM address into the endpoint form, gets a connection
 * failure, and is told nothing about the WSL that was never installed. So the
 * list names the two servers it cannot install, and the button reads the
 * machine instead of pretending it can act on it.
 *
 * What is worth pinning is exactly that: the label must not promise an install.
 */
describe('the servers this app cannot install', () => {
  const list = (): ReturnType<typeof buildEntries> =>
    buildEntries([HARNESS], THIS_MACHINE, ENDPOINT, CATALOGUE, [], labelOf);

  it('offers vLLM and NIM, under the heading that means "not here yet"', () => {
    const servers = list().filter((e) => e.plan.kind === 'server');
    expect(servers.map((e) => (e.plan.kind === 'server' ? e.plan.server : null))).toEqual([
      'vllm',
      'nim',
    ]);
    expect(servers.every((e) => e.group === 'install')).toBe(true);
  });

  it('promises a check rather than an install', () => {
    // The button reports and changes nothing. A label reading "Install vLLM"
    // would be a promise the next screen immediately breaks — and on Windows it
    // would be a promise no button could keep, since the step it lands on is a
    // reboot.
    expect(actionLabel({ kind: 'server', server: 'vllm' })).toBe('Check this machine');
    expect(actionLabel({ kind: 'server', server: 'nim' })).not.toMatch(/install/i);
  });

  it('does not push a download that never happens into the note', () => {
    const vllm = list().find((e) => e.plan.kind === 'server');
    expect(vllm).toBeDefined();
    // `pull` and `cli` both say what will land on the machine. This one lands
    // nothing, and a byte count under it would be a lie about what the click does.
    expect(entryNote(vllm as AgentEntry, 'this machine') ?? '').not.toMatch(/onto this machine/);
  });
});
