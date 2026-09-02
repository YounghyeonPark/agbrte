/**
 * A registry that will not answer is not a model that is gone.
 *
 * `model-catalogue.mjs --check` runs on every CI job, and it read any non-`ok`
 * response as the tag having vanished. A Windows runner got `503` for three
 * tags while ubuntu and macos got all fifteen in the same minute, and the build
 * went red on a commit that had changed a stylesheet.
 *
 * The red build is the *visible* half and the smaller one. The same
 * classification drives `npm run models`, which rewrites the committed
 * catalogue from the answers it got — so a bad minute at the registry deletes
 * three working suggestions from a file somebody then commits, with nothing
 * anywhere saying why the list got shorter.
 *
 * §3.3 spends three tiers of confidence on exactly this distinction for model
 * capabilities, with the rule that an unknown must never render as a `no`. It
 * turns out to be a rule about answers in general, and it was missing in a
 * build script where nobody had thought to look for it.
 */

import { describe, expect, it } from 'vitest';
// @ts-expect-error — a build script, JS with no types, imported for its logic.
import { classify, mergeCatalogue } from '../scripts/catalogueMerge.mjs';

interface Entry {
  tag: string;
  label: string;
  note: string;
  bytes: number;
}

const CANDIDATES = [{ tag: 'a' }, { tag: 'b' }, { tag: 'c' }];
const previous: Entry[] = [
  { tag: 'a', label: 'A', note: 'first', bytes: 1 },
  { tag: 'b', label: 'B', note: 'second', bytes: 2 },
  { tag: 'c', label: 'C', note: 'third', bytes: 3 },
];
const found = (tag: string, bytes: number) => ({ tag, label: tag.toUpperCase(), note: 'n', state: 'found', bytes });

describe('what a status means', () => {
  it('treats 404 and 410 as the model being gone', () => {
    expect(classify(404)).toBe('gone');
    expect(classify(410)).toBe('gone');
  });

  it('treats a server or rate-limit answer as could-not-ask', () => {
    // The one that cost a build. A 503 says something about the registry's
    // minute and nothing whatever about the model.
    expect(classify(503)).toBe('unreachable');
    expect(classify(500)).toBe('unreachable');
    expect(classify(429)).toBe('unreachable');
    expect(classify(401)).toBe('unreachable');
  });
});

describe('what the catalogue becomes', () => {
  it('keeps an unanswered tag exactly as the file already had it', () => {
    const results = [
      found('a', 10),
      { tag: 'b', state: 'unreachable', status: '503' },
      found('c', 30),
    ];

    /*
     * The assertion the whole change is for. Classifying `b` correctly is not
     * enough on its own — it still has to survive the merge, or the deletion
     * simply happens one step later past a correct label.
     */
    const models = mergeCatalogue(CANDIDATES, results, previous) as Entry[];
    expect(models).toHaveLength(3);
    expect(models.find((m) => m.tag === 'b')).toEqual({
      tag: 'b',
      label: 'B',
      note: 'second',
      bytes: 2,
    });
  });

  it('drops one that is genuinely gone', () => {
    const results = [found('a', 10), { tag: 'b', state: 'gone', status: '404' }, found('c', 30)];
    // This is the failure the check exists to catch, and it must still catch it:
    // a tag pulled from the registry has to leave, whatever the file said.
    const models = mergeCatalogue(CANDIDATES, results, previous) as Entry[];
    expect(models.map((m) => m.tag)).toEqual(['a', 'c']);
  });

  it('takes fresh sizes over remembered ones', () => {
    const results = [found('a', 999), found('b', 2), found('c', 3)];
    const models = mergeCatalogue(CANDIDATES, results, previous) as Entry[];
    // An answer beats a memory. Otherwise a model that grew would keep reporting
    // the size it had when it was first asked about.
    expect(models.find((m) => m.tag === 'a')?.bytes).toBe(999);
  });

  it('leaves the catalogue whole when the registry answers nothing at all', () => {
    const results = CANDIDATES.map(({ tag }) => ({ tag, state: 'unreachable', status: 'TimeoutError' }));
    // Measured against the real script by pointing it at a host that does not
    // resolve: twelve models in, twelve models out. Before the change that run
    // would have written an empty list.
    expect(mergeCatalogue(CANDIDATES, results, previous)).toEqual(previous);
  });

  it('has nothing to carry on a first run, and says so by staying empty', () => {
    const results = [{ tag: 'a', state: 'unreachable', status: '503' }];
    // No previous file and no answer is genuinely nothing known. Inventing an
    // entry here would be the opposite mistake to the one being fixed.
    expect(mergeCatalogue([{ tag: 'a' }], results, [])).toEqual([]);
  });

  it('keeps the order of the candidate list, not of whichever answer arrived first', () => {
    const results = [found('c', 30), found('a', 10), found('b', 20)];
    // Fifteen parallel requests resolve in whatever order they like, and a file
    // that reordered on every run would produce a diff nobody can read.
    const models = mergeCatalogue(CANDIDATES, results, previous) as Entry[];
    expect(models.map((m) => m.tag)).toEqual(['a', 'b', 'c']);
  });
});
