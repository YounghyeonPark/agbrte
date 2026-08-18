/**
 * Installing a model into whatever is serving models here (DESIGN.md §3.8).
 *
 * ## "Install a model" is not one operation
 *
 * The OpenAI-compatible shape says how to *use* a model and nothing about how
 * one arrives, so every runner answers this differently and two of them do not
 * answer it at all:
 *
 *   Ollama      `POST /api/pull` — fetches into a local store while running.
 *   vLLM        the model is chosen with `--model` at launch. Changing it means
 *               restarting the server, which is not ours to do.
 *   llama.cpp   a GGUF file passed on the command line. Same shape as vLLM.
 *   NVIDIA NIM  one container image per model. Installing is `docker run`.
 *
 * A menu that offered "install" against all four would work against one and fail
 * against three, with an error about a 404 rather than about the situation. So
 * the runner is detected first and the ones that cannot are said so, by name,
 * with what to do instead. That is the same rule the transport table follows for
 * localities that are not built.
 *
 * ## Detection is a question, not an assumption
 *
 * `GET /api/version` exists on Ollama and nowhere else in this set, which makes
 * it a positive test rather than an inference from a port number. Anything that
 * does not answer it is treated as a generic OpenAI-compatible server —
 * *usable*, not *installable* — which is the safe direction to be wrong in: the
 * cost is a sentence telling somebody to install a model themselves, and the
 * cost of the other error is a button that cannot work.
 */

export type RunnerKind = 'ollama' | 'openai-compatible';

export interface RunnerInfo {
  endpointId: string;
  kind: RunnerKind;
  /** Version string when the runner reports one. */
  version?: string;
  /** Whether a model can be installed through this runner from here. */
  canInstall: boolean;
  /** When it cannot, what the person should do instead. */
  reason?: string;
}

export interface InstallProgress {
  endpointId: string;
  tag: string;
  /** The runner's own word for what it is doing, passed through unchanged. */
  status: string;
  completed: number;
  total: number;
  done: boolean;
  error?: string;
}

/** Ollama's native API sits at the root; the endpoint URL points at `/v1`. */
function nativeBase(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '');
}

export async function detectRunner(
  endpointId: string,
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RunnerInfo> {
  /*
   * Unreachable and not-Ollama are **not** the same answer, and treating them as
   * one produced a confidently wrong sentence.
   *
   * The comment here used to read "Unreachable or not Ollama. Both mean the same
   * thing here, and neither is worth distinguishing: what follows is true either
   * way." It was not true either way. A freshly attached machine with no model
   * server at all fell into this branch and the picker told the user *this
   * endpoint serves models but does not install them* — a sentence describing a
   * running vLLM, about an address where nothing is listening. It then sent them
   * to "add it there and restart that server", where there is no server.
   *
   * The `error` on the same row already said `fetch failed`, so the screen
   * carried both a true fact and a false explanation of it, which is worse than
   * carrying only the fact.
   */
  let reachable = false;
  try {
    const res = await fetchImpl(`${nativeBase(baseUrl)}/api/version`, {
      signal: AbortSignal.timeout(4000),
    });
    // A reply of any status proves something is listening — a 404 from a vLLM is
    // exactly the expected shape here, and is the case this distinguishes.
    reachable = true;
    if (res.ok) {
      const body = (await res.json()) as { version?: string };
      return {
        endpointId,
        kind: 'ollama',
        canInstall: true,
        ...(body.version !== undefined ? { version: body.version } : {}),
      };
    }
  } catch {
    // Connection refused, DNS, or a timeout. Nothing is there.
  }

  return {
    endpointId,
    kind: 'openai-compatible',
    canInstall: false,
    reason: reachable
      ? 'this endpoint serves models but does not install them — vLLM, llama.cpp and NIM ' +
        'each take their model at launch, so add it there and restart that server'
      : // Named as an absence, with the address, because that is the fact and
        // because it is the one this app can now do something about: it is the
        // state "Set up this machine" installs Ollama for.
        `nothing answered at ${nativeBase(baseUrl)} — no model server is running there, so ` +
        `there is nothing to install a model into yet`,
  };
}

/**
 * Pulls in the background, and remembers how far each one got.
 *
 * Started rather than awaited, because a model is gigabytes: a request that
 * blocks until a 14 GB download finishes is a request that times out somewhere
 * in the four layers between here and the button. The caller starts it and asks
 * again.
 *
 * Finished entries are kept rather than deleted. "It got to 100% and vanished"
 * and "it failed and vanished" look identical to a client that polls, and the
 * second one has to be reportable.
 */
export class ModelInstaller {
  private readonly runs = new Map<string, InstallProgress>();

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  progress(): InstallProgress[] {
    return [...this.runs.values()];
  }

  /** Start a pull. Returns the key it will report under. */
  start(endpointId: string, baseUrl: string, tag: string): string {
    const key = `${endpointId}::${tag}`;
    const existing = this.runs.get(key);
    // Already running is not an error and must not start a second download of
    // the same thing — a person pressing a button twice is a person, not a bug.
    if (existing !== undefined && !existing.done) return key;

    const state: InstallProgress = {
      endpointId,
      tag,
      status: 'starting',
      completed: 0,
      total: 0,
      done: false,
    };
    this.runs.set(key, state);
    void this.run(state, baseUrl, tag);
    return key;
  }

  private async run(state: InstallProgress, baseUrl: string, tag: string): Promise<void> {
    try {
      const res = await this.fetchImpl(`${nativeBase(baseUrl)}/api/pull`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: tag }),
      });
      if (!res.ok || res.body === null) {
        throw new Error(`the runner refused the pull: HTTP ${res.status}`);
      }

      /*
       * Newline-delimited JSON, read as it arrives.
       *
       * Buffered rather than split per chunk: a chunk boundary lands in the
       * middle of a line often enough that parsing each chunk on its own
       * produces a syntax error partway through every download.
       */
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      /*
       * Totals are per **layer**, and a model is several.
       *
       * Ollama reports `completed`/`total` for whichever blob it is currently
       * fetching, so assigning them straight onto the state makes the numbers
       * restart at every layer boundary. Watching a real pull, that showed as a
       * bar racing to 88%, jumping to a nonsense percentage when a 561-byte
       * config layer arrived, and *finishing* at `561/561` — a 271 MB download
       * reporting itself as half a kilobyte.
       *
       * Keyed by digest and summed, so the figure is about the model. Layers
       * already present locally are announced with their size and no progress,
       * which is why a cached pull can jump straight to complete: that is true,
       * and pretending otherwise would be the invented part.
       */
      const layers = new Map<string, { completed: number; total: number }>();
      const sum = (): void => {
        let completed = 0;
        let total = 0;
        for (const l of layers.values()) {
          completed += l.completed;
          total += l.total;
        }
        state.completed = completed;
        state.total = total;
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim() === '') continue;
          const update = JSON.parse(line) as {
            status?: string;
            digest?: string;
            completed?: number;
            total?: number;
            error?: string;
          };
          if (update.error !== undefined) throw new Error(update.error);
          if (update.status !== undefined) state.status = update.status;
          if (update.digest !== undefined && update.total !== undefined) {
            layers.set(update.digest, {
              total: update.total,
              completed: update.completed ?? 0,
            });
            sum();
          }
        }
      }
      state.status = 'installed';
      state.done = true;
      // Every layer is in by definition once the stream closes cleanly, and the
      // last update for a layer does not always carry its final `completed`.
      for (const l of layers.values()) l.completed = l.total;
      sum();
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
      state.status = 'failed';
      state.done = true;
    }
  }
}
