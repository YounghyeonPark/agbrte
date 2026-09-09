/**
 * Reading skill documents off disk (DESIGN.md §17 Q21, §17 Q12, §5.1).
 *
 * The properties here are the ones that decide whether a workspace's skills can
 * be *offered*, which is the whole point of moving them out of a form field.
 *
 * **A file that would be refused at creation is refused here.** `createSession`
 * throws on a bad id or an oversized body, and a list that offered such a file
 * would be offering a control that fails on press (§3.5) — after a session had
 * been made, which is the expensive time to find out. So the checks are the same
 * checks, and this file is what keeps them the same as `sessionManager`'s.
 *
 * **A broken file does not take the listing down**, for `workflowStore`'s
 * reason: the reason to look at the list is often that one of them is wrong.
 *
 * **An id is refused, never sanitised.** The id becomes `skill__<id>`, a tool
 * name that policy rules match on, so a file quietly renamed into a legal id
 * would put a rule on a name its author never wrote.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSkills, readSkill, SKILL_SUFFIX } from '../src/main/store/skills.js';

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function workspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agbrte-skills-'));
  made.push(root);
  await mkdir(join(root, '.agbrte', 'templates'), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(root, '.agbrte', 'templates', name), body, 'utf8');
  }
  return root;
}

const COMMITS = `---
description: How commit messages are written in this repository
---

They say why, and they record what broke.
`;

describe('reading one', () => {
  it('takes the id from the filename and the description from the frontmatter', async () => {
    const root = await workspace({ [`commits${SKILL_SUFFIX}`]: COMMITS });
    const found = await readSkill(root, 'commits');
    expect(found.problems).toEqual([]);
    expect(found.skill).toEqual({
      id: 'commits',
      description: 'How commit messages are written in this repository',
      instructions: 'They say why, and they record what broke.\n',
    });
  });

  it('reads a file written with CRLF as the same document', async () => {
    // A workspace is shared by `git pull` between a Windows laptop and a Linux
    // build box, and the person who wrote the file did not choose its line
    // endings. A frontmatter reader that only knows `\n` would report "no
    // frontmatter" on half the machines that hold the same repository.
    const root = await workspace({ [`commits${SKILL_SUFFIX}`]: COMMITS.replace(/\n/g, '\r\n') });
    expect((await readSkill(root, 'commits')).skill?.description).toBe(
      'How commit messages are written in this repository',
    );
  });

  it('says so when there is no frontmatter at all', async () => {
    const root = await workspace({ [`bare${SKILL_SUFFIX}`]: 'just some prose\n' });
    const found = await readSkill(root, 'bare');
    expect(found.skill).toBeUndefined();
    expect(found.problems[0]).toContain('no frontmatter');
  });

  it('refuses one with no description, because that is what the model reads', async () => {
    const root = await workspace({ [`x${SKILL_SUFFIX}`]: '---\nname: x\n---\n\nbody\n' });
    const found = await readSkill(root, 'x');
    expect(found.skill).toBeUndefined();
    expect(found.problems[0]).toContain('no description');
  });

  it('refuses one with nothing under the frontmatter', async () => {
    const root = await workspace({ [`x${SKILL_SUFFIX}`]: '---\ndescription: a thing\n---\n\n' });
    expect((await readSkill(root, 'x')).problems[0]).toContain('no instructions');
  });

  it('refuses an id the tool name could not carry, rather than rewriting it', async () => {
    const root = await workspace({ [`Review Notes${SKILL_SUFFIX}`]: COMMITS });
    // The stem is sanitised for the *path* — this string reaches `join()` — and
    // then refused as an *id*, which is the pair that matters: safe to open,
    // and never silently renamed into something a policy rule would match.
    const found = await readSkill(root, 'Review Notes');
    expect(found.skill).toBeUndefined();
    expect(found.problems[0]).toContain('cannot be a skill id');
  });

  it('refuses a body over the tool-output cap rather than truncating it', async () => {
    // §17 Q7's cap applies to every tool output. Instructions that arrived cut
    // off would silently teach half of what their author wrote, so the refusal
    // names the number — the same rule `createSession` enforces, checked here so
    // the offer never reaches the button.
    const root = await workspace({
      [`long${SKILL_SUFFIX}`]: `---\ndescription: a long one\n---\n\n${'x'.repeat(9_000)}`,
    });
    const found = await readSkill(root, 'long');
    expect(found.skill).toBeUndefined();
    expect(found.problems[0]).toContain('8,000');
  });

  it('reports a file that is not there as a problem, not a throw', async () => {
    const root = await workspace({});
    expect((await readSkill(root, 'missing')).problems[0]).toContain('could not be read');
  });
});

describe('listing a workspace', () => {
  it('finds the skills and leaves the other templates alone', async () => {
    const root = await workspace({
      [`commits${SKILL_SUFFIX}`]: COMMITS,
      // One directory holds three kinds of file and the suffix is what tells
      // them apart, so neither of these may appear in a listing of skills.
      'review.workflow.json': '{"id":"review","name":"r","goal":"g","nodes":[]}',
      'a-session.json': '{"id":"x","name":"not a skill"}',
    });
    const found = await listSkills(root);
    expect(found.map((f) => f.id)).toEqual(['commits']);
  });

  it('carries a broken one as a row with its reason, beside the good ones', async () => {
    const root = await workspace({
      [`commits${SKILL_SUFFIX}`]: COMMITS,
      [`bare${SKILL_SUFFIX}`]: 'no frontmatter here\n',
    });
    const found = await listSkills(root);
    // Both come back, sorted, and the good one is still usable: a bad file must
    // not take the listing down with it.
    expect(found.map((f) => f.id)).toEqual(['bare', 'commits']);
    expect(found.find((f) => f.id === 'bare')?.skill).toBeUndefined();
    expect(found.find((f) => f.id === 'commits')?.skill?.id).toBe('commits');
  });

  it('is an empty list, not a failure, where no templates directory exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agbrte-skills-'));
    made.push(root);
    expect(await listSkills(root)).toEqual([]);
  });
});
