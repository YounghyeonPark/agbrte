/**
 * Find state read before an `await` and written after it, in one function.
 *
 * This is the shape of a bug that cost a day and that no test caught. `append`
 * read `this.seq`, awaited the file write, and incremented afterwards, so every
 * append starting during that await was issued the same number. The log then
 * held two events at one `seq`, the renderer deduped by `seq` as the design lets
 * it, and a recorded permission decision vanished from the transcript. Nothing
 * threw. Nothing logged. A gate that had run looked like a gate that never had.
 *
 * JavaScript's single thread makes this feel impossible right up until the
 * moment the function is called twice before it finishes.
 *
 * Deliberately narrow, because a noisy checker is a checker people stop reading:
 *
 *  - the read and the write must be on the same `this.<field>`
 *  - both must sit *directly* in the same function body, not in a nested
 *    callback — a write inside `.then(...)` is sequenced by the chain it is in
 *  - order must be read → await → write
 *
 * It reports positions, not certainties. A finding is a question: *can this run
 * twice at once?* If it cannot, say so where the field is declared.
 */

import ts from 'typescript';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const strict = process.argv.includes('--strict');

/** Every .ts file under src/, excluding declarations. */
function sources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

/** `this.foo` → "foo", for a plain property access only. */
function thisField(node) {
  return ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword
    ? node.name.text
    : null;
}

const isFunctionLike = (node) =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isConstructorDeclaration(node) ||
  ts.isGetAccessor(node) ||
  ts.isSetAccessor(node);

/**
 * Collect reads, awaits and writes that belong to *this* function's own body,
 * descending through blocks and expressions but stopping at nested functions.
 */
function scan(body) {
  const reads = [];
  const writes = [];
  const awaits = [];

  const visit = (node) => {
    if (isFunctionLike(node)) return; // a different scope, with its own ordering

    if (ts.isAwaitExpression(node)) awaits.push({ pos: node.getStart(), node });

    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      const assigns =
        op === ts.SyntaxKind.EqualsToken ||
        (op >= ts.SyntaxKind.FirstCompoundAssignment && op <= ts.SyntaxKind.LastCompoundAssignment);
      const field = assigns ? thisField(node.left) : null;
      if (field !== null) {
        writes.push({ field, pos: node.getStart(), node });
        // A compound assignment reads as well, but its read is adjacent to its
        // own write, so it is not the pattern. Only the right-hand side counts.
        ts.forEachChild(node.right, visit);
        return;
      }
    }

    if (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) {
      const op = node.operator;
      const field = thisField(node.operand);
      if (
        field !== null &&
        (op === ts.SyntaxKind.PlusPlusToken || op === ts.SyntaxKind.MinusMinusToken)
      ) {
        writes.push({ field, pos: node.getStart(), node });
        return;
      }
    }

    const field = thisField(node);
    if (field !== null) reads.push({ field, pos: node.getStart() });

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(body, visit);
  return { reads, writes, awaits };
}

/**
 * Whether two nodes sit in branches that cannot both run.
 *
 * The first version of this checker flagged the semaphore, where the shape is
 * `if (full) { await queued } else { this.held += 1 }`. Read, then await, then
 * write — in source order, and never in execution: taking the await means never
 * reaching the increment. A checker that cannot tell those apart teaches people
 * to skim past it, which costs more than the bug it was written for.
 */
function mutuallyExclusive(a, b) {
  const chain = new Map();
  for (let node = a, child = null; node !== undefined; child = node, node = node.parent) {
    chain.set(node, child);
  }
  for (let node = b, child = null; node !== undefined; child = node, node = node.parent) {
    if (!chain.has(node)) continue;
    const other = chain.get(node);
    if (other === null || child === null || other === child) return false;

    if (ts.isIfStatement(node)) return true; // then vs else
    if (ts.isConditionalExpression(node)) return true; // ? vs :
    if (ts.isCaseBlock(node)) return true; // different switch clauses
    return false;
  }
  return false;
}

const findings = [];

for (const path of sources(join(ROOT, 'src'))) {
  const text = readFileSync(path, 'utf8');
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true);

  const walk = (node) => {
    if (isFunctionLike(node) && node.body !== undefined) {
      const { reads, writes, awaits } = scan(node.body);
      if (awaits.length > 0) {
        for (const write of writes) {
          const read = reads.find((r) => r.field === write.field && r.pos < write.pos);
          if (read === undefined) continue;
          const gate = awaits.find(
            (a) =>
              a.pos > read.pos && a.pos < write.pos && !mutuallyExclusive(a.node, write.node),
          );
          if (gate === undefined) continue;

          const { line } = file.getLineAndCharacterOfPosition(read.pos);
          const at = file.getLineAndCharacterOfPosition(write.pos);
          findings.push({
            file: relative(ROOT, path).replace(/\\/g, '/'),
            field: write.field,
            readLine: line + 1,
            writeLine: at.line + 1,
          });
        }
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(file);
}

for (const f of findings) {
  console.log(`${f.file}:${f.readLine} — reads this.${f.field}, awaits, writes it at line ${f.writeLine}`);
}
console.log(
  findings.length === 0
    ? '\nno state read before an await and written after it'
    : `\n${findings.length} place(s) where two overlapping calls would collide`,
);

if (strict && findings.length > 0) process.exit(1);
