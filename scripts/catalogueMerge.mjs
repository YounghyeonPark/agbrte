/*
 * Deciding what a registry answer means, and what the catalogue becomes.
 *
 * Split out of `model-catalogue.mjs` so it can be tested. That script is
 * top-level `await` against a live registry — importing it runs it — and the
 * two rules below are the ones worth pinning, because getting either wrong is
 * quiet:
 *
 *   - a `503` read as "this model is gone" turns an unrelated pull request red,
 *     and worse, makes `npm run models` *delete* the entry;
 *   - an unanswered tag that falls out of the merge is the same deletion
 *     arriving one step later, past a correct classification.
 *
 * Both happened. CI went red on a stylesheet change because a Windows runner
 * got `503` for three tags while ubuntu and macos got all fifteen in the same
 * minute.
 */

/**
 * What a registry response says about a tag.
 *
 * Only `404` and `410` are the model's absence. Everything else — a 5xx, a 429,
 * an auth wobble, a timeout, a DNS failure — is the registry declining to
 * answer, which says nothing about the model at all. §3.3 spends three tiers on
 * this same distinction for capabilities; it applies wherever a missing answer
 * could be mistaken for a negative one.
 */
export function classify(status) {
  return status === 404 || status === 410 ? 'gone' : 'unreachable';
}

/**
 * The catalogue after a run: fresh answers, minus what is gone, keeping the rest.
 *
 * `previous` is what the committed file already said. A tag nobody could ask
 * about keeps its old entry — which is what makes "could not ask" mean the
 * catalogue is *unchanged* rather than *smaller*. A tag that is genuinely gone
 * is dropped whatever the file said, because that is the fact this check exists
 * to catch.
 *
 * Ordered by `candidates` rather than by which answers arrived, so the file does
 * not churn on the order fifteen parallel requests happen to resolve in.
 */
export function mergeCatalogue(candidates, results, previous) {
  const byTag = new Map(results.map((r) => [r.tag, r]));
  const carried = new Map(previous.map((m) => [m.tag, m]));

  return candidates
    .map(({ tag }) => {
      const answer = byTag.get(tag);
      if (answer?.state === 'found') {
        const { label, note, bytes } = answer;
        return { tag, label, note, bytes };
      }
      if (answer?.state === 'gone') return null;
      return carried.get(tag) ?? null;
    })
    .filter((m) => m !== null);
}
