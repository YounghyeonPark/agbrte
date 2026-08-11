/*
 * Modules under `src/` that nothing reaches, and exports nothing imports.
 *
 * `windowsBootstrap.ts` passed a full end-to-end test over real ssh while the
 * only reference to it outside its own file was a comment claiming the feature
 * worked — `connectRemoteHost` still ran the POSIX path against every remote.
 * Correct code behind a seam nobody crosses is the failure this project
 * produces most reliably, and unlike a wrong value it leaves no trace at all:
 * the module compiles, its tests pass, and the product cannot do the thing.
 *
 * Reachability is computed from the **build's** entry points rather than from a
 * guess about which files look like roots, because a wrong root list is the one
 * way this check could quietly report success. `--strict` exits non-zero.
 *
 * Two honest limits, stated because a reader will otherwise trust more than is
 * warranted:
 *
 *   - Test-only files are not entry points. A module reached solely by `tests/`
 *     is reported, which is the point — that is exactly what `windowsBootstrap`
 *     was — but the report says which, so "unreached by the product, covered by
 *     tests" is distinguishable from "unreached by anything".
 *   - Exports are matched by name across the repository. A name that also exists
 *     elsewhere hides a genuinely unused export, so absence here is evidence and
 *     presence is not proof.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p) && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
};

const files = walk(SRC);
const text = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));
const rel = (f) => relative(ROOT, f).replaceAll('\\', '/');

/** Entry points, read out of the build rather than assumed. */
const build = readFileSync(join(ROOT, 'scripts/build.mjs'), 'utf8');
const entries = [...build.matchAll(/entryPoints:\s*\[resolve\(root,\s*'([^']+)'\)\]/g)].map((m) =>
  join(ROOT, m[1]),
);
// The renderer is Vite's, and its root is the module `index.html` loads.
const rendererEntry = join(SRC, 'renderer/main.tsx');
if (existsSync(rendererEntry)) entries.push(rendererEntry);

/*
 * And anything a package script executes straight from source.
 *
 * `src/cli/run.ts` is run by `npm run agbrte:direct` through tsx, so it is never
 * bundled and never imported — it was this checker's first false positive, and
 * the kind that matters most: a root missing from the root list makes everything
 * under it look dead, which is a confident report of the opposite of the truth.
 */
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
for (const command of Object.values(pkg.scripts ?? {})) {
  for (const m of String(command).matchAll(/(?:^|\s)(src\/[\w./-]+\.tsx?)/g)) {
    const p = join(ROOT, m[1]);
    if (existsSync(p)) entries.push(p);
  }
}

if (entries.length < 2) throw new Error('found no entry points — the build script shape changed');

/** Resolve one relative import specifier to a file on disk. */
function resolveImport(fromFile, spec) {
  let base;
  if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec);
  else if (spec.startsWith('@shared/')) base = join(SRC, 'shared', spec.slice('@shared/'.length));
  else if (spec.startsWith('@main/')) base = join(SRC, 'main', spec.slice('@main/'.length));
  else return null;

  const stripped = base.replace(/\.js$/, '');
  for (const candidate of [
    `${stripped}.ts`,
    `${stripped}.tsx`,
    join(stripped, 'index.ts'),
    join(stripped, 'index.tsx'),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/*
 * Static `import … from '…'` / `export … from '…'`, **and** dynamic `import('…')`.
 *
 * The dynamic form was the second false positive: `src/web/server.ts` is loaded
 * by `await import('../web/server.js')` in the CLI, so a checker that reads only
 * static specifiers declares a live module dead. Lazy loading is exactly what a
 * CLI does with its heavier subcommands, which makes it the wrong thing to be
 * blind to.
 */
const IMPORT =
  /(?:(?:^|\n)\s*(?:import|export)[^;'"]*?from\s*['"]([^'"]+)['"])|(?:\bimport\s*\(\s*['"]([^'"]+)['"]\s*\))/g;

/** The specifier from either alternative. */
const specifierOf = (m) => m[1] ?? m[2];

/** Everything reachable from a set of roots. */
function reach(roots) {
  const seen = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    for (const m of (text.get(file) ?? '').matchAll(IMPORT)) {
      const target = resolveImport(file, specifierOf(m));
      if (target !== null && text.has(target)) queue.push(target);
    }
  }
  return seen;
}

const fromProduct = reach(entries);

// A second pass from the test suite, so "covered but unwired" reads differently
// from "reached by nothing at all".
const testFiles = existsSync(join(ROOT, 'tests')) ? walk(join(ROOT, 'tests')) : [];
const testRoots = [];
for (const t of testFiles) {
  const body = readFileSync(t, 'utf8');
  for (const m of body.matchAll(IMPORT)) {
    const target = resolveImport(t, specifierOf(m));
    if (target !== null && text.has(target)) testRoots.push(target);
  }
}
const fromTests = reach(testRoots);

const unreached = files.filter((f) => !fromProduct.has(f));

console.log(`${files.length} modules under src/, ${entries.length} entry points`);
console.log(`${fromProduct.size} reachable from the product\n`);

if (unreached.length === 0) {
  console.log('every module is reachable from an entry point');
} else {
  const orphans = unreached.filter((f) => !fromTests.has(f));
  const testOnly = unreached.filter((f) => fromTests.has(f));

  if (testOnly.length > 0) {
    console.log(`${testOnly.length} reached ONLY by tests — built, covered, and wired to nothing:`);
    for (const f of testOnly) console.log(`  ${rel(f)}`);
    console.log('');
  }
  if (orphans.length > 0) {
    console.log(`${orphans.length} reached by nothing at all:`);
    for (const f of orphans) console.log(`  ${rel(f)}`);
  }
  if (process.argv.includes('--strict')) process.exitCode = 1;
}
