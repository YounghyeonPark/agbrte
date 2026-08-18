/**
 * Installing a model into whatever is serving models (DESIGN.md §3.8).
 *
 * The download itself is verified by doing it — a real Ollama, a real pull, and
 * a look at the numbers. What is tested here is the arithmetic and the refusals,
 * because those are the parts that were wrong when the real one ran and the
 * parts no amount of downloading would pin down afterwards.
 */

import { describe, expect, it } from 'vitest';
import { detectRunner, ModelInstaller } from '../src/host/modelInstall.js';

/** A `fetch` that streams the given NDJSON lines, one chunk each. */
function streaming(lines: string[]): typeof fetch {
  return (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const line of lines) controller.enqueue(new TextEncoder().encode(`${line}\n`));
          controller.close();
        },
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
}

const settled = async (installer: ModelInstaller): Promise<void> => {
  for (let i = 0; i < 200; i += 1) {
    if (installer.progress().every((p) => p.done)) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('the install never finished');
};

describe('which runner is behind an endpoint', () => {
  it('recognises Ollama by an endpoint only it answers', async () => {
    const fake = (async () => new Response(JSON.stringify({ version: '0.32.9' }), { status: 200 })) as
      unknown as typeof fetch;
    const runner = await detectRunner('local', 'http://127.0.0.1:11434/v1', fake);
    expect(runner).toMatchObject({ kind: 'ollama', canInstall: true, version: '0.32.9' });
  });

  /**
   * The case the whole feature turns on being honest about.
   *
   * vLLM, llama.cpp and NIM take their model at launch, so "install" against
   * them is not a slow operation — it is not an operation. A menu that offered
   * it anyway would produce a 404 and a person looking for the bug in the wrong
   * place.
   */
  it('treats anything else as usable but not installable, and says what to do', async () => {
    const fake = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    const runner = await detectRunner('remote', 'http://gpu-box:8000/v1', fake);
    expect(runner.kind).toBe('openai-compatible');
    expect(runner.canInstall).toBe(false);
    expect(runner.reason).toMatch(/vLLM|launch/i);
  });

  /**
   * An endpoint with nothing behind it is **not** the same answer, and saying it
   * was produced a confidently wrong sentence on the one screen that mattered.
   *
   * A freshly attached machine with no model server fell into the branch above
   * and was told *this endpoint serves models but does not install them* — a
   * description of a running vLLM, about an address where nothing is listening —
   * followed by "add it there and restart that server", where there is no
   * server. The row beside it already read `fetch failed`, so the screen carried
   * a true fact and a false explanation of it at once.
   */
  it('says nothing is there when nothing is there, and names the address', async () => {
    const fake = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const runner = await detectRunner('x', 'http://127.0.0.1:11434/v1', fake);
    expect(runner.canInstall).toBe(false);
    expect(runner.reason).toContain('nothing answered at http://127.0.0.1:11434');
    // Emphatically not the other sentence, which is about a server that exists.
    expect(runner.reason).not.toMatch(/vLLM/);
  });

  it('still distinguishes a server that answered with an error', async () => {
    // A 404 from `/api/version` proves something is listening — which is the
    // whole difference between "not Ollama" and "not there".
    const fake = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    const runner = await detectRunner('x', 'http://gpu-box:8000/v1', fake);
    expect(runner.reason).toMatch(/vLLM/);
  });
});

describe('how far the install has got', () => {
  /**
   * Totals are per **layer**, and a model is several.
   *
   * This is the bug the first real pull exposed. Assigning the runner's
   * `completed`/`total` straight onto the state makes the numbers restart at
   * every layer boundary: the bar raced to 88%, jumped to a nonsense percentage
   * when a 561-byte config layer arrived, and *finished* at `561/561` — a
   * 271 MB download reporting itself as half a kilobyte.
   */
  it('sums the layers instead of reporting whichever is in flight', async () => {
    const installer = new ModelInstaller(
      streaming([
        JSON.stringify({ status: 'pulling manifest' }),
        JSON.stringify({ status: 'pulling a', digest: 'a', total: 1_000, completed: 500 }),
        JSON.stringify({ status: 'pulling a', digest: 'a', total: 1_000, completed: 1_000 }),
        // A second, much smaller layer. Naively assigned, this is where the
        // total collapses from 1000 to 20 and the percentage goes wild.
        JSON.stringify({ status: 'pulling b', digest: 'b', total: 20, completed: 10 }),
      ]),
    );
    installer.start('local', 'http://127.0.0.1:11434/v1', 'demo:1b');
    await settled(installer);

    const [progress] = installer.progress();
    expect(progress?.total, 'the total shrank to the last layer').toBe(1_020);
    expect(progress?.completed).toBe(1_020);
    expect(progress?.status).toBe('installed');
    expect(progress?.done).toBe(true);
  });

  it('reports a failure as a value rather than losing it', async () => {
    const installer = new ModelInstaller(
      streaming([
        JSON.stringify({ status: 'pulling manifest' }),
        JSON.stringify({ error: 'model "nope:1b" not found' }),
      ]),
    );
    installer.start('local', 'http://127.0.0.1:11434/v1', 'nope:1b');
    await settled(installer);

    const [progress] = installer.progress();
    // Kept, not deleted: "it finished and vanished" and "it failed and
    // vanished" are identical to a client that polls, and only one of them is
    // acceptable.
    expect(progress?.error).toMatch(/not found/);
    expect(progress?.status).toBe('failed');
    expect(progress?.done).toBe(true);
  });

  it('does not start a second download of the same thing', async () => {
    let calls = 0;
    const counting = (async () => {
      calls += 1;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            // Held open, so the first pull is still running when the second
            // press arrives — which is what a person does with a slow button.
            c.enqueue(new TextEncoder().encode(`${JSON.stringify({ status: 'pulling' })}\n`));
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const installer = new ModelInstaller(counting);
    installer.start('local', 'http://x/v1', 'demo:1b');
    installer.start('local', 'http://x/v1', 'demo:1b');
    await new Promise((r) => setTimeout(r, 30));

    expect(calls).toBe(1);
    expect(installer.progress()).toHaveLength(1);
  });
});
