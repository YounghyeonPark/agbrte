/*
 * The suggested-model list, verified against the registry rather than recalled.
 *
 * A menu of models is only useful if the tags in it exist, and a tag is exactly
 * the kind of detail that is easy to be confidently wrong about. Writing this by
 * hand, I put `kimi-k2:1t` in the list; the registry returned 404, and so did
 * every other Kimi tag tried — it is not in Ollama's official library at all.
 * That is one invented entry caught by asking, in a list of eight.
 *
 * So every entry here is checked against `registry.ollama.ai` before it ships,
 * and its size comes from the manifest rather than from memory. Run this to
 * refresh; `--check` fails if the committed file no longer matches what the
 * registry says, which is what CI runs.
 *
 * ## This is a starting point, not a boundary
 *
 * The install field takes any tag. The list exists so that somebody who wants "a
 * good small coding model" does not have to already know it is called
 * `qwen2.5-coder:7b` — it is not an allow-list, and nothing is prevented by
 * being absent from it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(root, 'src/shared/models/catalogue.json');

/**
 * When somebody last read the list below and asked whether it is still the list.
 *
 * ## The gap this closes, which was the whole of it
 *
 * `--check` compares the committed file against the registry, so it catches a
 * tag that **vanished** or changed size. It cannot catch the failure that
 * actually happens: a tag that **appeared**. There is no signal anywhere for
 * "a new generation shipped" — `CANDIDATES` is written by hand, the registry has
 * nothing to ask about a model nobody has named, and `verifiedAt` in the output
 * is read by no code at all. So the list rots in exactly one direction, silently,
 * and stays green the whole way.
 *
 * That was tolerable while the catalogue only suggested downloads. It stopped
 * being tolerable when `readyRank` began using catalogue membership to order the
 * models a machine already has: a stale list now mis-ranks a model somebody went
 * and got. (`readyRank` puts a probed model above the catalogue for this reason,
 * so the two halves of the answer are in the two files.)
 *
 * ## Why the date is here and not in the generated file
 *
 * `verifiedAt` is written by this script, so `npm run models` bumps it without
 * anybody thinking — a staleness check reading it would be satisfied by the one
 * command that cannot possibly fix the problem. This constant is the opposite:
 * nothing writes it, and the only way to move it is to open this file, which is
 * the file the list is in. The chore and the thing it is a chore about are the
 * same edit.
 *
 * Ninety days because that is roughly how fast open-weight generations move.
 * Shorter turns an unrelated pull request red for a reason its author cannot act
 * on; longer and a whole generation ships inside one interval. Set to the date
 * the list was last actually touched rather than to the day this check was
 * added — starting a clock by claiming a review that did not happen is the one
 * way to make it lie from the first day.
 */
const REVIEWED = '2026-08-12';
const REVIEW_EVERY_DAYS = 90;

/**
 * Candidates, with the one thing the registry cannot supply: why you would pick
 * this one. Sizes and existence come from the registry below.
 */
const CANDIDATES = [
  { tag: 'llama3.2:3b', label: 'Llama 3.2 3B', note: 'Small and general. Runs on a laptop without a discrete GPU.' },
  { tag: 'llama3.1:8b', label: 'Llama 3.1 8B', note: 'The usual default when there is a GPU to spare.' },
  { tag: 'qwen2.5:7b', label: 'Qwen 2.5 7B', note: 'Strong general model; reliable at tool calling.' },
  { tag: 'qwen2.5-coder:7b', label: 'Qwen 2.5 Coder 7B', note: 'Tuned for code. A good default for this program.' },
  { tag: 'qwen3:8b', label: 'Qwen 3 8B', note: 'Newer Qwen generation.' },
  { tag: 'gemma3:4b', label: 'Gemma 3 4B', note: "Google's small open model." },
  { tag: 'gemma3:12b', label: 'Gemma 3 12B', note: 'Larger Gemma; wants a GPU.' },
  { tag: 'gpt-oss:20b', label: 'GPT-OSS 20B', note: "OpenAI's open-weight release. Large; check disk first." },
  { tag: 'deepseek-r1:7b', label: 'DeepSeek-R1 7B', note: 'Reasoning-tuned.' },
  { tag: 'phi4:14b', label: 'Phi-4 14B', note: 'Microsoft; strong for its size.' },
  { tag: 'mistral:7b', label: 'Mistral 7B', note: 'Long-standing, well understood.' },
  { tag: 'smollm2:135m', label: 'SmolLM2 135M', note: 'Tiny. For checking the plumbing, not for work.' },
];

/** Ask the registry whether a tag exists, and what it weighs. */
async function verify({ tag, label, note }) {
  const [name, version = 'latest'] = tag.split(':');
  const url = `https://registry.ollama.ai/v2/library/${name}/manifests/${version}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) return { tag, label, note, ok: false, status: res.status };
  const manifest = await res.json();
  const bytes = (manifest.layers ?? []).reduce((n, l) => n + (l.size ?? 0), 0);
  return { tag, label, note, ok: true, bytes };
}

const results = await Promise.all(CANDIDATES.map(verify));
const found = results.filter((r) => r.ok);
const missing = results.filter((r) => !r.ok);

for (const m of missing) console.log(`  dropped ${m.tag} — registry said ${m.status}`);

const catalogue = {
  // Not a version of this file so much as a date on a claim: these tags existed
  // and had these sizes when somebody last asked.
  verifiedAt: new Date().toISOString().slice(0, 10),
  registry: 'registry.ollama.ai',
  models: found.map(({ tag, label, note, bytes }) => ({ tag, label, note, bytes })),
};

const text = `${JSON.stringify(catalogue, null, 2)}\n`;

/**
 * How long ago somebody last looked at `CANDIDATES`, in days.
 *
 * Whole days from UTC midnights, so a run at 09:00 and a run at 23:00 on the
 * same day give the same answer and the check cannot flip inside one afternoon.
 */
function daysSinceReview() {
  const then = Date.parse(`${REVIEWED}T00:00:00Z`);
  if (Number.isNaN(then)) throw new Error(`REVIEWED is not a date: ${REVIEWED}`);
  const today = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  return Math.round((today - then) / 86_400_000);
}

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    current = '';
  }
  // Compared without the date, which changes on every run and would make this
  // fail for the one reason that is not a problem.
  const strip = (s) => s.replace(/"verifiedAt":\s*"[^"]*",\n\s*/, '');
  if (strip(current) === strip(text)) {
    console.log(`catalogue matches the registry (${catalogue.models.length} models)`);
  } else {
    console.log('catalogue is out of date — run `node scripts/model-catalogue.mjs`');
    process.exitCode = 1;
  }

  /*
   * Reported after the registry answer and separately from it, because they are
   * different problems with different remedies: one is fixed by running a
   * command, and this one cannot be. Both are printed even when both are wrong,
   * so a red build says everything it knows in one go.
   */
  const age = daysSinceReview();
  if (age > REVIEW_EVERY_DAYS) {
    console.log(
      `the suggested-model list was last reviewed ${age} days ago (${REVIEWED}).\n` +
        '  Nothing here can tell you a new model exists — that is what the review is.\n' +
        '  Open scripts/model-catalogue.mjs, look at CANDIDATES against what the\n' +
        '  registry now publishes, change what should change, and move REVIEWED.\n' +
        '  Running `npm run models` will not clear this, deliberately.',
    );
    process.exitCode = 1;
  } else {
    console.log(`suggested-model list reviewed ${age} days ago (every ${REVIEW_EVERY_DAYS})`);
  }
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${catalogue.models.length} verified models to src/shared/models/catalogue.json`);
}
