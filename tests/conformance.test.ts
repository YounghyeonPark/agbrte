/**
 * The support matrix (DESIGN.md §3.13).
 *
 * > The matrix must distinguish *verified*, *declared*, and *not run*: a green
 * > cell earned by a scripted fixture is not the same claim as one earned
 * > against a live endpoint, and collapsing them would reintroduce exactly the
 * > confidence this table exists to remove.
 *
 * Nearly every test here is that one sentence. A matrix is only useful if its
 * green means "someone watched this happen" — the moment a declaration can be
 * painted the same colour as a run, the table stops removing confidence and
 * starts manufacturing it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMatrix, coverage, loadReport, type RuntimeUnderTest } from '@main/conformance.js';
import { DEFAULT_ECHO_CAPABILITIES } from '@main/runtime/runtimes/echo.js';
import type { ConformanceReport, MatrixCell, RuntimeCapabilities } from '@shared/types/index.js';

function runtime(over: Partial<RuntimeUnderTest> = {}): RuntimeUnderTest {
  return {
    runtimeId: 'echo',
    adapterVersion: '0.0.1',
    capabilities: DEFAULT_ECHO_CAPABILITIES,
    ...over,
  };
}

function caps(over: Partial<RuntimeCapabilities>): RuntimeCapabilities {
  return { ...DEFAULT_ECHO_CAPABILITIES, ...over };
}

function report(results: ConformanceReport['results']): ConformanceReport {
  return { ranAt: '2026-01-01T00:00:00Z', results };
}

const cell = (cells: MatrixCell[], scenarioId: string, runtimeId = 'echo'): MatrixCell =>
  cells.find((c) => c.scenarioId === scenarioId && c.runtimeId === runtimeId) as MatrixCell;

describe('what a cell is allowed to claim', () => {
  it('marks a scenario that ran and passed as verified, with what it ran against', () => {
    const cells = buildMatrix(
      [runtime()],
      report([
        {
          runtimeId: 'echo',
          scenarioId: 'stream-once',
          ok: true,
          evidence: 'real-subprocess',
          adapterVersion: '0.0.1',
        },
      ]),
    );
    expect(cell(cells, 'stream-once')).toMatchObject({
      status: 'verified',
      // Carried, not discarded: "passed against a real process" and "passed
      // against a response we wrote" are different sentences.
      evidence: 'real-subprocess',
    });
  });

  it('never promotes a declaration to a pass', () => {
    // `nativeResume` is what `resume-token-consistent` would check. Nothing ran.
    const cells = buildMatrix([runtime({ capabilities: caps({ nativeResume: true }) })], null);
    expect(cell(cells, 'resume-token-consistent').status).toBe('declared');
  });

  it('calls a declared "no" an answer rather than a gap', () => {
    const cells = buildMatrix([runtime({ capabilities: caps({ interruptible: false }) })], null);
    // "This adapter cannot be interrupted" is a fact the user can act on.
    // Showing it as not-run would make an honest declaration look like a to-do.
    expect(cell(cells, 'interrupt-mid-stream').status).toBe('unsupported');
  });

  it('says not-run where nothing ran and nothing was claimed', () => {
    const cells = buildMatrix([runtime()], null);
    // A contract obligation has no capability standing behind it: an adapter
    // does not get to *declare* that its stream is subscribable.
    expect(cell(cells, 'stream-before-send').status).toBe('not-run');
  });

  it('keeps a failure louder than an absence', () => {
    const cells = buildMatrix(
      [runtime()],
      report([
        {
          runtimeId: 'echo',
          scenarioId: 'explicit-stop',
          ok: false,
          evidence: 'scripted-fixture',
          adapterVersion: '0.0.1',
          detail: 'expected end_turn',
        },
      ]),
    );
    expect(cell(cells, 'explicit-stop')).toMatchObject({ status: 'failed', detail: 'expected end_turn' });
  });
});

describe('a result that no longer describes the adapter', () => {
  it('is stale rather than verified', () => {
    const cells = buildMatrix(
      [runtime({ adapterVersion: '0.0.2' })],
      report([
        {
          runtimeId: 'echo',
          scenarioId: 'stream-once',
          ok: true,
          evidence: 'in-process',
          adapterVersion: '0.0.1',
        },
      ]),
    );
    // A report records one moment. An adapter edited since then has not been
    // checked, however green the file looks.
    const found = cell(cells, 'stream-once');
    expect(found.status).toBe('stale');
    expect(found.detail).toMatch(/0\.0\.1.*0\.0\.2/);
  });

  it('is stale even when the recorded run failed', () => {
    // Checked before `ok`, so an edited adapter neither inherits the old pass
    // nor keeps wearing the old failure.
    const cells = buildMatrix(
      [runtime({ adapterVersion: '0.0.2' })],
      report([
        {
          runtimeId: 'echo',
          scenarioId: 'stream-once',
          ok: false,
          evidence: 'in-process',
          adapterVersion: '0.0.1',
        },
      ]),
    );
    expect(cell(cells, 'stream-once').status).toBe('stale');
  });
});

describe('coverage', () => {
  it('counts only what was verified', () => {
    const cells = buildMatrix(
      [runtime({ capabilities: caps({ nativeResume: true, interruptible: true }) })],
      report([
        {
          runtimeId: 'echo',
          scenarioId: 'stream-once',
          ok: true,
          evidence: 'in-process',
          adapterVersion: '0.0.1',
        },
      ]),
    );
    // A runtime that declares everything and proves nothing must not come out
    // ahead of one that proves a little.
    expect(coverage(cells).get('echo')).toEqual({ verified: 1, total: cells.length });
  });
});

describe('rows for runtimes that are not here', () => {
  it('are ignored rather than invented into columns', () => {
    const cells = buildMatrix(
      [runtime()],
      report([
        {
          runtimeId: 'cli:claude-code',
          scenarioId: 'stream-once',
          ok: true,
          evidence: 'real-subprocess',
          adapterVersion: '0.0.1',
        },
      ]),
    );
    // The report is written on a machine that may offer runtimes this host does
    // not. Showing a column for something you cannot select would be a matrix
    // about somebody else's setup.
    expect(cells.every((c) => c.runtimeId === 'echo')).toBe(true);
  });
});

describe('reading the report off disk', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agbrte-conf-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('merges every fragment, because each test file writes its own', async () => {
    await writeFile(
      join(dir, 'a.json'),
      JSON.stringify(report([{ runtimeId: 'echo', scenarioId: 'stream-once', ok: true, evidence: 'in-process', adapterVersion: '1' }])),
      'utf8',
    );
    await writeFile(
      join(dir, 'b.json'),
      JSON.stringify({
        ranAt: '2026-02-01T00:00:00Z',
        results: [{ runtimeId: 'echo', scenarioId: 'explicit-stop', ok: true, evidence: 'in-process', adapterVersion: '1' }],
      }),
      'utf8',
    );

    const loaded = await loadReport(dir);
    expect(loaded?.results).toHaveLength(2);
    // The oldest fragment's timestamp: stamping the matrix with the freshest one
    // would read as wholly current when part of it is a week old.
    expect(loaded?.ranAt).toBe('2026-01-01T00:00:00Z');
  });

  it('loses one broken fragment, not the whole report', async () => {
    await writeFile(join(dir, 'a.json'), '{ not json', 'utf8');
    await writeFile(
      join(dir, 'b.json'),
      JSON.stringify(report([{ runtimeId: 'echo', scenarioId: 'stream-once', ok: true, evidence: 'in-process', adapterVersion: '1' }])),
      'utf8',
    );
    expect((await loadReport(dir))?.results).toHaveLength(1);
  });

  it('returns null when there is nothing there', async () => {
    // Degrading to "nothing has been checked" is correct. Throwing would turn a
    // reporting feature into a failure to start.
    expect(await loadReport(join(dir, 'nowhere'))).toBeNull();
  });
});

describe('the report the suite actually wrote', () => {
  it('covers every runtime this repo ships an adapter for', async () => {
    // Guards the join the whole matrix rests on: a recorded `runtimeId` that
    // does not match the id a real registry hands out produces a column of
    // not-run beside a suite that passed, and nothing anywhere fails.
    const loaded = await loadReport(join(process.cwd(), 'conformance'));
    const ids = new Set(loaded?.results.map((r) => r.runtimeId));
    expect(ids).toContain('echo');
    expect(ids).toContain('agbrte-harness');
    expect(ids).toContain('agent-host');
    expect(ids).toContain('cli:claude-code');
  });
});
