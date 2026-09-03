/*
 * What a machine still needs before it can serve a model (DESIGN.md §3.8, §16).
 *
 * The app can install Ollama, which is one installer and a `pull`. vLLM and NIM
 * are not that, and the difference is not effort — it is that each has a
 * prerequisite the app cannot supply:
 *
 *  - **vLLM does not support Windows natively.** Its own documentation names
 *    WSL2 as the Windows path, and installing WSL needs administrator rights and
 *    a reboot. An installer that reboots somebody's machine is not something
 *    this app should be doing on their behalf.
 *  - **NIM needs an NGC account and a personal API key**, which is what
 *    `docker login nvcr.io` authenticates with before the image can be pulled at
 *    all. Nobody can generate that for you.
 *
 * So this reports rather than installs, and the split is deliberate: §16's rule
 * is that an unbuilt locality must fail visibly rather than quietly run
 * somewhere else, and the same reasoning applies one step earlier. Somebody who
 * types a vLLM address into the endpoint form today gets a connection failure
 * and no mention of the missing WSL that caused it.
 *
 * ## Why the judgement is a pure function
 *
 * Collecting the facts needs a machine — `nvidia-smi`, `wsl --status`, `docker
 * info` — and that machine may be three time zones away, reached through the
 * same `ProvisionRunner` an install uses. Deciding what those facts *mean* needs
 * nothing, and it is the half that is easy to get subtly wrong: a missing GPU
 * and a missing driver are different problems with different remedies, and
 * "WSL is installed" on Windows is not the same claim as "WSL is installed" on
 * Linux, where it is meaningless.
 */

import { RouteRefused, type ProvisionRunner } from './provision.js';

/** What a probe found. Every field is a fact, and `null` means *could not ask*. */
export interface MachineFacts {
  /** `Windows`, `Linux`, `Darwin` — the shape `RemoteProbe.platform` uses. */
  platform: string;
  /** The `nvidia-smi` name line, or `null` where the command is absent. */
  gpu: string | null;
  /**
   * Whether WSL is *installed*, not whether `wsl.exe` exists.
   *
   * The distinction cost a measurement: on a stock Windows 11 the executable is
   * present and answers "The Windows Subsystem for Linux is not installed", so a
   * `which wsl` check reports ready on a machine where nothing can run.
   */
  wslInstalled: boolean | null;
  dockerRunning: boolean | null;
  /** Whether the NVIDIA container runtime is wired into Docker. */
  containerToolkit: boolean | null;
  /** Whether something already answers on the port this server would use. */
  alreadyServing: boolean | null;
}

/** One thing a person has to do, in the order they have to do it. */
export interface ReadinessStep {
  /** What to do, in a sentence. */
  what: string;
  /** The command, where there is one to give. */
  command?: string;
  /**
   * Why this cannot be done for them.
   *
   * Only on the steps the app is *choosing* not to automate — a reboot, an
   * account — because "why isn't this a button" is the question a list of manual
   * steps provokes, and leaving it unanswered reads as the feature being
   * unfinished rather than as a decision.
   */
  why?: string;
}

export interface Readiness {
  /** `true` when nothing is left to do and the server can be pointed at. */
  ready: boolean;
  /** What stands in the way, in order. Empty when ready. */
  steps: ReadinessStep[];
  /** The single sentence a person reads first. */
  summary: string;
}

/**
 * What still has to happen before vLLM can serve on this machine.
 *
 * Ordered by what blocks what: no GPU makes every later step pointless, and on
 * Windows nothing can be installed until WSL is, so the reboot comes before the
 * pip install rather than after it.
 */
export function vllmReadiness(facts: MachineFacts): Readiness {
  const steps: ReadinessStep[] = [];

  if (facts.alreadyServing === true) {
    return {
      ready: true,
      steps: [],
      summary: 'Something is already serving on the vLLM port — add it as an endpoint.',
    };
  }

  if (facts.gpu === null) {
    /*
     * Not a step, because there is no command for it. vLLM on CPU exists and is
     * experimental and slow enough that offering it would be offering a
     * disappointment; a machine without an NVIDIA GPU should be told plainly
     * rather than walked through an install that ends badly.
     */
    return {
      ready: false,
      steps: [
        {
          what: 'vLLM needs an NVIDIA GPU, and none was found here.',
          why: 'Its CPU path is experimental and far slower than Ollama on the same machine.',
        },
      ],
      summary: 'No NVIDIA GPU on this machine.',
    };
  }

  if (facts.platform === 'Windows') {
    if (facts.wslInstalled !== true) {
      steps.push({
        what: 'Install WSL, then reboot.',
        command: 'wsl --install',
        why: 'vLLM has no native Windows build — its own docs name WSL2 as the Windows path. This needs administrator rights and a restart, which the app will not do to your machine on its own.',
      });
    }
    steps.push({
      what: 'Inside WSL, install vLLM.',
      command: 'pip install vllm',
    });
    steps.push({
      what: 'Serve a model, and note the port.',
      command: 'vllm serve <model> --port 8000',
    });
  } else {
    steps.push({ what: 'Install vLLM.', command: 'pip install vllm' });
    steps.push({
      what: 'Serve a model, and note the port.',
      command: 'vllm serve <model> --port 8000',
    });
  }

  steps.push({
    what: 'Add it here as an endpoint, with that URL and no key.',
    command: 'http://127.0.0.1:8000/v1',
  });

  return {
    ready: false,
    steps,
    summary:
      facts.platform === 'Windows' && facts.wslInstalled !== true
        ? 'WSL is not installed, and vLLM needs it on Windows.'
        : 'vLLM is not serving yet.',
  };
}

/**
 * What still has to happen before a NIM container can serve here.
 *
 * The NGC key is listed as a step rather than as a refusal, because unlike the
 * missing GPU it is something a person can go and get — but it is named plainly,
 * since somebody who cannot have one should learn that before installing Docker
 * rather than after.
 */
export function nimReadiness(facts: MachineFacts): Readiness {
  if (facts.alreadyServing === true) {
    return {
      ready: true,
      steps: [],
      summary: 'Something is already serving on the NIM port — add it as an endpoint.',
    };
  }

  if (facts.gpu === null) {
    return {
      ready: false,
      steps: [
        {
          what: 'NIM needs an NVIDIA GPU, and none was found here.',
          why: 'The containers are built against CUDA; there is no CPU path.',
        },
      ],
      summary: 'No NVIDIA GPU on this machine.',
    };
  }

  const steps: ReadinessStep[] = [];
  const platform = facts.platform;

  if (platform === 'Windows' && facts.wslInstalled !== true) {
    steps.push({
      what: 'Install WSL, then reboot.',
      command: 'wsl --install',
      why: 'The NIM containers are Linux images, and Docker on Windows runs them through WSL2. This needs administrator rights and a restart.',
    });
  }
  if (facts.dockerRunning !== true) {
    steps.push({ what: 'Install Docker and start it.' });
  }
  if (facts.containerToolkit !== true) {
    steps.push({
      what: 'Install the NVIDIA Container Toolkit, so containers can reach the GPU.',
    });
  }

  steps.push({
    what: 'Get an NGC personal API key and log Docker in with it.',
    command: 'echo "$NGC_API_KEY" | docker login nvcr.io -u \'$oauthtoken\' --password-stdin',
    why: 'NVIDIA gates the images behind an account. Nothing here can generate that key, and without it the image cannot be pulled at all.',
  });
  steps.push({ what: 'Run the NIM container, and note the port it publishes.' });
  steps.push({
    what: 'Add it here as an endpoint, with that URL and no key.',
    command: 'http://127.0.0.1:8000/v1',
  });

  /*
   * The summary names the first blocker rather than the goal, which is what
   * vLLM's does. "NIM is not serving yet" over a list starting with a reboot is
   * true and useless — the sentence somebody reads first should be the one that
   * decides whether they carry on reading.
   */
  return {
    ready: false,
    steps,
    summary:
      platform === 'Windows' && facts.wslInstalled !== true
        ? 'WSL is not installed, and the NIM containers are Linux images.'
        : facts.dockerRunning !== true
          ? 'Docker is not running here, and NIM ships as a container.'
          : 'NIM is not serving yet — the NGC key is the step nothing here can do for you.',
  };
}

/**
 * Ask a machine the six questions, over whichever runner reaches it.
 *
 * The same `ProvisionRunner` an install uses, so a probe of the laptop and a
 * probe of a GPU box three time zones away are one code path — which is what
 * CLAUDE.md's first hazard is about, and the reason this takes a runner rather
 * than shelling out directly.
 *
 * Every command is a fixed string with no interpolation, so none of this is a
 * place user input could reach a shell (§16). Each is short and each failure is
 * an answer: a command that is not there exits non-zero, which is the fact.
 */
export async function probeMachine(
  runner: ProvisionRunner,
  alias: string,
  platform: string,
  /** The port the server would use, so "already serving" is a real check. */
  port = 8000,
): Promise<MachineFacts> {
  const ask = async (command: string): Promise<string | null> => {
    try {
      const { code, stdout } = await runner.exec(alias, command, { timeoutMs: 15_000 });
      return code === 0 ? stdout.trim() : null;
    } catch (err) {
      /*
       * A command that failed is an answer; a *runner* that will not run
       * anything is not, and telling them apart is the whole of §3.3 here.
       *
       * The first version caught both, and on this Windows machine it reported
       * "No NVIDIA GPU" over an RTX 4090 — `localRunner` refuses every command
       * on Windows, so `nvidia-smi` never ran, and "could not ask" was rendered
       * as a confident no. The refusal now travels: it carries its own sentence
       * about why this machine cannot be inspected, and `SetupProgress` prints
       * that verbatim rather than inventing a hardware fault.
       */
      if (err instanceof RouteRefused) throw err;
      // Anything else is the machine failing to answer one question, which is
      // the fact: `null` reads as "could not ask" at the other end.
      return null;
    }
  };

  /**
   * The same call, kept for its exit code rather than its output.
   *
   * `null` where `ask` would have refused to answer, and the refusal travels for
   * the same reason it does there.
   */
  const run = async (command: string): Promise<number | null> => {
    try {
      const { code } = await runner.exec(alias, command, { timeoutMs: 15_000 });
      return code;
    } catch (err) {
      if (err instanceof RouteRefused) throw err;
      return null;
    }
  };

  const gpu = await ask('nvidia-smi --query-gpu=name --format=csv,noheader');

  /*
   * `wsl --status`, not `where wsl`.
   *
   * Measured on a stock Windows 11: `wsl.exe` is present and answers "The
   * Windows Subsystem for Linux is not installed", exiting non-zero. A presence
   * check therefore reports ready on a machine where nothing can run, which is
   * the shape of wrong answer §3.3 spends three confidence tiers avoiding.
   */
  const wslInstalled = platform === 'Windows' ? (await ask('wsl --status')) !== null : null;

  const dockerRunning = (await ask('docker info --format "{{.ServerVersion}}"')) !== null;
  /*
   * Asked of Docker rather than of the filesystem: the toolkit being installed
   * and Docker being *configured* to use it are different states, and only the
   * second one lets a container reach the GPU.
   */
  const runtimes = await ask('docker info --format "{{.Runtimes}}"');
  const containerToolkit = runtimes === null ? null : runtimes.includes('nvidia');

  /*
   * One command on both platforms, judged by its exit code.
   *
   * The Windows branch used to be a PowerShell one-liner, and it produced a
   * *confident* wrong answer: `cmd.exe` printed the script back and exited 0, so
   * the literal `'True'` inside the script text matched the check looking for
   * it, and a machine with nothing on port 8000 was told a server was already
   * up. That is §6.2's recorded failure — a POSIX-shaped command handed to
   * `cmd.exe`, echoed rather than run — arriving one layer above where §6.2 put
   * the guard, and it is the reason there is no shell syntax left in here.
   *
   * `curl` ships with Windows 10 1803 and later, so one command covers both.
   * The codes are curl's own: 7 is a refused connection and 28 is a timeout,
   * which are both "nothing is serving", while anything else — 9009 for a
   * missing curl, a proxy error — is not an answer and stays unknown.
   */
  const reached = await run(
    `curl -sS -o ${platform === 'Windows' ? 'NUL' : '/dev/null'} --max-time 3 ` +
      `http://127.0.0.1:${String(port)}/v1/models`,
  );
  const alreadyServing = reached === 0 ? true : reached === 7 || reached === 28 ? false : null;

  return {
    platform,
    gpu: gpu === null || gpu === '' ? null : gpu,
    wslInstalled,
    dockerRunning,
    containerToolkit,
    alreadyServing,
  };
}
