/*
 * Class names the renderer uses that the built stylesheet does not define.
 *
 * `btn-quiet` was on ten buttons across six files and defined nowhere. Nothing
 * caught it: the markup is valid, the build succeeds, every test passes, and the
 * only place an inert class shows is the screen. This is the check that would
 * have.
 *
 * It compares against the *built* CSS rather than against the source, because
 * Tailwind generates most of these on demand — a class is real exactly when it
 * survives into the output, which is also precisely what the browser sees.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};

const cssFiles = walk('dist/renderer').filter((f) => f.endsWith('.css'));
if (cssFiles.length === 0) throw new Error('no built CSS — run `npm run build` first');
const css = cssFiles.map((f) => readFileSync(f, 'utf8')).join('\n');

// Class tokens out of every className/`class` string in the renderer.
const tokens = new Map(); // token -> Set(files)
for (const file of walk('src/renderer').filter((f) => /\.tsx?$/.test(f))) {
  const text = readFileSync(file, 'utf8');
  /*
   * Anchored on `className=`, but reading the whole expression after it.
   *
   * Two wrong versions preceded this one, and both failures are the ones this
   * check exists to catch, in miniature. The first matched only
   * `className="…"` and its simple braced forms, so it missed
   * `className={cond ? 'text-ok' : 'text-warn'}` — it reported one of that pair
   * and stayed silent about the other. The second gave up on anchoring and took
   * every string literal that *looked* like classes, which swept in `data-testid`
   * values and event names: 120 findings, four of them real. A report that is
   * mostly noise is one nobody reads, which is the same way a signal that marks
   * everything marks nothing.
   *
   * So: find `className=`, take the balanced `{…}` or the single quoted string
   * that follows, and pull the literals out of that region only.
   */
  for (const m of text.matchAll(/className=/g)) {
    let i = m.index + m[0].length;
    let region;
    if (text[i] === '{') {
      let depth = 0;
      const start = i;
      for (; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}' && --depth === 0) break;
      }
      region = text.slice(start + 1, i);
    } else if (text[i] === '"' || text[i] === "'" || text[i] === '`') {
      const quote = text[i];
      const start = ++i;
      while (i < text.length && text[i] !== quote) i++;
      region = text.slice(start, i);
      region = `${quote}${region}${quote}`;
    } else {
      continue;
    }

    for (const lit of region.matchAll(/(["'`])((?:[^\\]|\\.)*?)\1/g)) {
      for (const token of lit[2].replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) {
        if (token === '' || token.includes('$')) continue;
        if (!tokens.has(token)) tokens.set(token, new Set());
        tokens.get(token).add(file.replace('src/renderer/', ''));
      }
    }
  }
}

/** Is this class present in the built stylesheet? */
function defined(token) {
  // Tailwind escapes `[ ] ( ) . : # / % , ! *` with a backslash in selectors,
  // so allow an optional one before each.
  const pattern = token
    .split('')
    .map((ch) => (/[\w-]/.test(ch) ? ch : `\\\\?\\${ch}`))
    .join('');
  return new RegExp(`\\.${pattern}(?![\\w-])`).test(css);
}

const inert = [];
for (const [token, files] of tokens) {
  // Variants (`hover:`, `md:`) are emitted under their own selector shapes;
  // check the base utility, which is what an undefined name would fail on.
  const base = token.includes(':') ? token.slice(token.lastIndexOf(':') + 1) : token;
  if (!defined(token) && !defined(base)) inert.push({ token, files: [...files] });
}

console.log(`${tokens.size} distinct class tokens in the renderer`);
if (inert.length === 0) {
  console.log('none inert');
} else {
  console.log(`\n${inert.length} defined nowhere in the built CSS:\n`);
  for (const { token, files } of inert.sort((a, b) => b.files.length - a.files.length)) {
    console.log(`  ${token.padEnd(28)} ${files.join(', ')}`);
  }
  /*
   * Non-zero under `--strict`, which is how CI runs it.
   *
   * Written down rather than assumed, because a checker that only prints is a
   * checker that passes: the pipeline goes green, the finding scrolls by in a
   * log nobody opens, and the class stays inert. That is the shape of the bug
   * this is looking for, one level up.
   */
  if (process.argv.includes('--strict')) process.exitCode = 1;
}
