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
  type CatalogueModel,
  type EndpointAnswer,
  type RuntimeSummary,
} from '../src/renderer/setupRoutes.js';

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

describe('the list a person chooses from', () => {
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
