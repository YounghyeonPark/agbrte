/**
 * Reading workflow documents off disk (DESIGN.md §4.4, §5.1).
 *
 * Two properties, and neither is about the validator — that has its own file.
 *
 * **A broken file does not take the listing down.** The reason to look at a list
 * of workflows is often that one of them is wrong, so an unparseable document
 * is a row carrying its problem rather than an exception thrown past the other
 * eleven. Same shape as `EndpointModels.error` (§3.8) and the same reasoning.
 *
 * **A workflow is validated on read.** The caller that reads a document is the
 * one that can still do something about it; a document reaching a runner
 * unvalidated is a decomposition nobody checked, which is what §4.4 exists to
 * prevent.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { listWorkflows, readWorkflow, saveWorkflow, WORKFLOW_SUFFIX } from '../src/main/store/workflows.js';

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

const GOOD = {
  id: 'review',
  name: 'review and fix',
  goal: 'find what is broken on this branch',
  nodes: [
    {
      id: 'scan',
      title: 'scan',
      scope: 'list every changed file',
      outOfScope: ['do not edit anything'],
      acceptance: ['every file named'],
      contract: { summaryMaxTokens: 800, artifacts: [] },
      tokenCeiling: 10_000,
    },
  ],
};

/** A workspace with a `templates/` directory and whatever files are named. */
async function workspace(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agbrte-wf-'));
  made.push(root);
  await mkdir(join(root, '.agbrte', 'templates'), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(root, '.agbrte', 'templates', name), body, 'utf8');
  }
  return root;
}

describe('finding workflows in a workspace', () => {
  it('reads the ones with the suffix and ignores session templates beside them', () => {
    // One directory, two kinds of template. The suffix is what lets either be
    // listed without opening the other's files to find out what they are.
    return workspace({
      [`review${WORKFLOW_SUFFIX}`]: JSON.stringify(GOOD),
      'some-session.json': JSON.stringify({ id: 'x', name: 'a session template' }),
    }).then(async (root) => {
      const found = await listWorkflows(root);
      expect(found.map((f) => f.id)).toEqual(['review']);
      expect(found[0]?.problems).toEqual([]);
    });
  });

  it('is an empty list, not a failure, when there is no templates directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agbrte-wf-bare-'));
    made.push(root);
    expect(await listWorkflows(root)).toEqual([]);
  });

  it('sorts, so a listing is the same twice and can be diffed', async () => {
    const root = await workspace({
      [`zeta${WORKFLOW_SUFFIX}`]: JSON.stringify(GOOD),
      [`alpha${WORKFLOW_SUFFIX}`]: JSON.stringify(GOOD),
      [`mid${WORKFLOW_SUFFIX}`]: JSON.stringify(GOOD),
    });
    expect((await listWorkflows(root)).map((f) => f.id)).toEqual(['alpha', 'mid', 'zeta']);
  });
});

describe('a file that cannot be used', () => {
  it('is a row with its reason, and the good ones still come back', async () => {
    const root = await workspace({
      [`good${WORKFLOW_SUFFIX}`]: JSON.stringify(GOOD),
      [`broken${WORKFLOW_SUFFIX}`]: '{ not json at all',
    });
    const found = await listWorkflows(root);
    expect(found).toHaveLength(2);
    expect(found.find((f) => f.id === 'good')?.problems).toEqual([]);
    expect(found.find((f) => f.id === 'broken')?.problems[0]?.message).toContain('not valid JSON');
    // The broken one has no document, which is how a caller tells the two apart
    // without re-parsing.
    expect(found.find((f) => f.id === 'broken')?.workflow).toBeUndefined();
  });

  it('says a file is the wrong shape once, not six times', async () => {
    // Six missing fields usually means the wrong file, not a workflow with
    // typos, and six findings would bury that.
    const root = await workspace({ [`odd${WORKFLOW_SUFFIX}`]: JSON.stringify({ hello: 'world' }) });
    const found = await listWorkflows(root);
    expect(found[0]?.problems).toHaveLength(1);
    expect(found[0]?.problems[0]?.message).toContain('is not a workflow');
  });

  it('reports a missing file rather than throwing', async () => {
    const root = await workspace();
    const found = await readWorkflow(root, 'nothing-here');
    expect(found.problems[0]?.message).toContain('could not be read');
  });
});

describe('an id that came from somewhere else', () => {
  it('cannot climb out of the templates directory', async () => {
    // This string reaches `join()`. `templates.ts` narrows its ids for the same
    // reason and it is worth doing here before anything but a test calls it.
    //
    // Asserted on the *resolved* path rather than on the absence of `..`: the
    // separators are replaced, so `../../../etc/passwd` becomes a file called
    // `..-..-..-etc-passwd` that sits harmlessly in the directory. Two dots in
    // a filename are not a traversal, and a test that read them as one would
    // fail against code that is correct — which is how it first failed.
    const root = await workspace({ [`review${WORKFLOW_SUFFIX}`]: JSON.stringify(GOOD) });
    const escaped = await readWorkflow(root, '../../../etc/passwd');
    const inside = join(root, '.agbrte', 'templates');
    expect(resolve(escaped.path).startsWith(resolve(inside))).toBe(true);
    expect(escaped.workflow).toBeUndefined();
  });
});

describe('writing one back', () => {
  it('is a fixed point: save what was read and the bytes do not move', async () => {
    /*
     * The property §4.4's approval argument rests on. These files are tracked
     * and reviewed as a diff, so an editor that opened and saved a document
     * without changing it must produce no diff at all — otherwise every review
     * carries noise nobody made, and a reviewer stops reading.
     *
     * Through the store rather than the serializer alone, because this is the
     * path an editor takes: read, hand back, write.
     */
    const root = await workspace();
    const first = await saveWorkflow(root, 'review', GOOD as never);
    expect(first.problems).toEqual([]);
    const path = join(root, '.agbrte', 'templates', `review${WORKFLOW_SUFFIX}`);
    const once = await readFile(path, 'utf8');

    const read = await readWorkflow(root, 'review');
    await saveWorkflow(root, 'review', read.workflow!);
    expect(await readFile(path, 'utf8')).toBe(once);
  });

  it('refuses a document the reader would refuse, and writes nothing', async () => {
    // A file that fails validation is not a saved workflow, it is a trap set for
    // later — and the findings come back rather than a bare failure, because the
    // editor already has them on screen and this is the same list.
    const root = await workspace();
    const bad = { ...GOOD, nodes: [{ ...GOOD.nodes[0], outOfScope: [] }] };
    const result = await saveWorkflow(root, 'bad', bad as never);
    expect(result.problems[0]?.message).toContain('outOfScope is required');
    expect((await listWorkflows(root)).length).toBe(0);
  });

  it('writes where a listing will find it', async () => {
    const root = await workspace();
    await saveWorkflow(root, 'fresh', GOOD as never);
    const found = await listWorkflows(root);
    expect(found.map((f) => f.id)).toEqual(['fresh']);
    expect(found[0]?.problems).toEqual([]);
  });

  it('narrows an id on the way in, as reading does', async () => {
    // Same reasoning as `readWorkflow`: this string reaches `join()`, and an id
    // that arrived over IPC is an id somebody else chose.
    const root = await workspace();
    const saved = await saveWorkflow(root, '../escape', GOOD as never);
    expect(saved.id).not.toContain('/');
    expect(saved.id).not.toContain('\\');
    const inside = join(root, '.agbrte', 'templates');
    expect(resolve(inside, `${saved.id}${WORKFLOW_SUFFIX}`).startsWith(resolve(inside))).toBe(true);
  });
});

describe('validated on read', () => {
  it('carries the findings, so nothing downstream has to re-check', async () => {
    const bad = {
      ...GOOD,
      nodes: [{ ...GOOD.nodes[0], outOfScope: [] }],
    };
    const root = await workspace({ [`bad${WORKFLOW_SUFFIX}`]: JSON.stringify(bad) });
    const found = await listWorkflows(root);
    expect(found[0]?.problems[0]?.message).toContain('outOfScope is required');
    // Still parsed: a document with a bad seam is a document, and an editor
    // needs to show it in order to fix it.
    expect(found[0]?.workflow?.name).toBe('review and fix');
  });

  it('checks the budget only when there is one to check against', async () => {
    const root = await workspace({ [`review${WORKFLOW_SUFFIX}`]: JSON.stringify(GOOD) });
    expect((await readWorkflow(root, 'review')).problems).toEqual([]);
    const short = await readWorkflow(root, 'review', {
      tokenCeiling: 5_000,
      spent: 0,
      reservedForChildren: 0,
    });
    expect(short.problems[0]?.message).toContain('short');
  });
});
