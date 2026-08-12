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
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${catalogue.models.length} verified models to src/shared/models/catalogue.json`);
}
