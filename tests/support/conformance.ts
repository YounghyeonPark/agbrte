/**
 * Recording what the conformance suite actually proved (DESIGN.md §3.13).
 *
 * The matrix in the app is only worth showing if its green cells come from runs
 * rather than from someone's memory of a run. So the tests write the report, and
 * this is the one place that knows how.
 *
 * **One file per producer.** Vitest runs each test file in its own worker, so
 * module state is not shared: a single shared collector would keep only the last
 * writer's rows, or need locking to append safely. Each producer writing its own
 * fragment needs neither, and `loadReport` merges the directory.
 *
 * **Evidence is per assertion, not per suite.** The same adapter can prove one
 * scenario against a real subprocess and another against a scripted response,
 * and §3.13's whole point is that those are different claims. Passing it at the
 * call site is what keeps them from being averaged into one colour.
 */

import { afterAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConformanceReport, ConformanceResult, Evidence } from '@shared/types/index.js';

/** Where the app looks. Committed, because it ships with the build it describes. */
export const CONFORMANCE_DIR = join(
  dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
  'conformance',
);

export class ConformanceRecorder {
  private readonly results: ConformanceResult[] = [];

  constructor(private readonly fragment: string) {}

  record(entry: {
    runtimeId: string;
    scenarioId: string;
    adapterVersion: string;
    evidence: Evidence;
    ok: boolean;
    detail?: string;
  }): void {
    this.results.push({
      runtimeId: entry.runtimeId,
      scenarioId: entry.scenarioId,
      adapterVersion: entry.adapterVersion,
      evidence: entry.evidence,
      ok: entry.ok,
      ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
    });
  }

  /**
   * Write the fragment, replacing whatever was there.
   *
   * Replaced rather than merged: a scenario deleted from the suite must vanish
   * from the matrix. Merging would leave its last green cell on the screen
   * forever, which is the most misleading state available — a claim with nothing
   * behind it and no way to notice.
   */
  write(): void {
    const report: ConformanceReport = { ranAt: new Date().toISOString(), results: this.results };
    mkdirSync(CONFORMANCE_DIR, { recursive: true });
    writeFileSync(
      join(CONFORMANCE_DIR, `${this.fragment}.json`),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8',
    );
  }
}

/** A recorder that writes itself out when the file's tests are done. */
export function recorderFor(fragment: string): ConformanceRecorder {
  const recorder = new ConformanceRecorder(fragment);
  afterAll(() => recorder.write());
  return recorder;
}

/**
 * Run an assertion and record the outcome under a scenario id.
 *
 * The assertion still throws, so a failing scenario fails the test run as well
 * as painting a red cell. A matrix that quietly absorbed failures would be a way
 * of turning a broken adapter into a slightly worse-looking table.
 */
export async function scenario(
  recorder: ConformanceRecorder,
  entry: { runtimeId: string; scenarioId: string; adapterVersion: string; evidence: Evidence },
  body: () => Promise<void> | void,
): Promise<void> {
  try {
    await body();
    recorder.record({ ...entry, ok: true });
  } catch (err) {
    recorder.record({ ...entry, ok: false, detail: (err as Error).message.split('\n')[0] ?? 'failed' });
    throw err;
  }
}
