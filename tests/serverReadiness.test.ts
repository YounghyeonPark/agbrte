/**
 * Telling somebody what their machine still needs (DESIGN.md §3.8, §3.3, §16).
 *
 * The app installs Ollama outright, and cannot do the same for vLLM or NIM —
 * not for want of effort, but because each has a prerequisite nobody can supply
 * on your behalf: vLLM has no native Windows build and its own docs name WSL2,
 * which needs administrator rights and a reboot; NIM's images are gated behind
 * an NGC account whose key `docker login nvcr.io` authenticates with.
 *
 * So the feature is a diagnosis, and the thing worth testing is the diagnosis
 * rather than the commands. Each of these is a way it could be confidently
 * wrong:
 *
 *  - telling a machine with no GPU to install WSL, which fixes nothing;
 *  - telling a Linux box to install WSL, which does not exist there;
 *  - reporting "not ready" for a server already running, which is the state
 *    somebody most wants recognised;
 *  - listing the NGC key last, after Docker and the toolkit, so a person who
 *    cannot have one finds out only after installing two things.
 */

import { describe, expect, it } from 'vitest';
import {
  nimReadiness,
  probeMachine,
  vllmReadiness,
  type MachineFacts,
} from '@main/host/serverReadiness.js';
import { RouteRefused } from '@main/host/provision.js';

const facts = (over: Partial<MachineFacts> = {}): MachineFacts => ({
  platform: 'Linux',
  gpu: 'NVIDIA GeForce RTX 4090',
  wslInstalled: null,
  dockerRunning: true,
  containerToolkit: true,
  alreadyServing: false,
  ...over,
});

const said = (steps: { what: string; command?: string }[]): string =>
  steps.map((s) => `${s.what} ${s.command ?? ''}`).join(' | ');

describe('vLLM', () => {
  it('says the GPU is the problem, and offers no install that would not help', () => {
    const answer = vllmReadiness(facts({ gpu: null }));

    /*
     * A machine with no NVIDIA GPU is told plainly rather than walked through an
     * install ending in disappointment. vLLM's CPU path exists and is slower
     * than the Ollama already on the same machine, so offering it would be
     * offering a worse version of what they have.
     */
    expect(answer.ready).toBe(false);
    expect(answer.summary).toContain('No NVIDIA GPU');
    expect(said(answer.steps)).not.toContain('pip install');
    expect(said(answer.steps)).not.toContain('wsl');
  });

  it('puts WSL first on Windows, and says why it is not a button', () => {
    const answer = vllmReadiness(facts({ platform: 'Windows', wslInstalled: false }));

    // Nothing can be installed until WSL is, so the reboot comes before the pip
    // install rather than after it.
    expect(answer.steps[0]?.command).toBe('wsl --install');
    expect(answer.summary).toContain('WSL is not installed');
    // The question a list of manual steps provokes, answered where it is asked.
    expect(answer.steps[0]?.why).toMatch(/restart|reboot/);
  });

  it('does not mention WSL on Linux, where it means nothing', () => {
    const answer = vllmReadiness(facts({ platform: 'Linux' }));
    expect(said(answer.steps)).not.toContain('wsl');
    expect(said(answer.steps)).toContain('pip install vllm');
  });

  it('skips the WSL step on a Windows machine that has it', () => {
    const answer = vllmReadiness(facts({ platform: 'Windows', wslInstalled: true }));
    expect(said(answer.steps)).not.toContain('wsl --install');
    expect(said(answer.steps)).toContain('pip install vllm');
  });

  it('recognises a server that is already running', () => {
    const answer = vllmReadiness(facts({ alreadyServing: true }));
    // The state somebody most wants recognised, and the one a checklist that
    // only knows how to install would report as "not ready".
    expect(answer.ready).toBe(true);
    expect(answer.steps).toEqual([]);
  });

  it('ends by pointing at this app, since a served model nobody added is unused', () => {
    const answer = vllmReadiness(facts());
    expect(answer.steps.at(-1)?.what).toContain('endpoint');
    // No key: a local server is §6.5's `target-local` row, with nothing to hold.
    expect(answer.steps.at(-1)?.what).toContain('no key');
  });
});

describe('NIM', () => {
  it('names the NGC key even on a machine that has everything else', () => {
    const answer = nimReadiness(facts({ dockerRunning: true, containerToolkit: true }));

    /*
     * The step nobody can do for you, and the reason this is a diagnosis rather
     * than an installer. It is a *step* rather than a refusal because a person
     * can go and get one — but it is named, because somebody who cannot should
     * learn that here rather than after installing Docker.
     */
    expect(said(answer.steps)).toContain('NGC');
    expect(answer.steps.find((s) => s.what.includes('NGC'))?.why).toMatch(/generate|Nothing here/);
  });

  it('lists only what is missing', () => {
    const ready = nimReadiness(facts({ dockerRunning: true, containerToolkit: true }));
    const bare = nimReadiness(facts({ dockerRunning: false, containerToolkit: false }));

    expect(said(ready.steps)).not.toContain('Install Docker');
    expect(said(bare.steps)).toContain('Install Docker');
    expect(said(bare.steps)).toContain('Container Toolkit');
  });

  it('asks for WSL on Windows, because the images are Linux', () => {
    const answer = nimReadiness(facts({ platform: 'Windows', wslInstalled: false }));
    expect(answer.steps[0]?.command).toBe('wsl --install');
  });

  it('says the GPU is the problem before anything else', () => {
    const answer = nimReadiness(facts({ gpu: null, dockerRunning: false }));
    // A missing GPU makes Docker irrelevant, so it must not be in the list.
    expect(said(answer.steps)).not.toContain('Docker');
    expect(answer.summary).toContain('No NVIDIA GPU');
  });

  it('recognises a container that is already serving', () => {
    expect(nimReadiness(facts({ alreadyServing: true })).ready).toBe(true);
  });
});

/*
 * The failure this file's guards exist for, kept as a test because it shipped.
 *
 * The first version of `probeMachine` caught every error from the runner and
 * answered `null`, and `null` for the GPU means "there is none". Run on this
 * Windows machine, where `localRunner` refuses every command by design, it
 * reported *No NVIDIA GPU on this machine* over an RTX 4090 — a confident wrong
 * answer built entirely out of questions that were never asked.
 *
 * §3.3 is about exactly this shape: an unknown must never render as a `no`.
 */
describe('a machine that cannot be asked', () => {
  const runner = (fn: (command: string) => Promise<{ code: number; stdout: string }>) => ({
    exec: async (_alias: string, command: string) => ({ ...(await fn(command)), stderr: '' }),
  });

  it('does not turn a refusal into a hardware fault', async () => {
    await expect(
      probeMachine(
        runner(() => {
          throw new RouteRefused('this machine runs Windows, and Agbrte sets a machine up …');
        }),
        'x',
        'Windows',
      ),
    ).rejects.toThrow(/runs Windows/);
  });

  it('still treats one missing command as the answer it is', async () => {
    // The distinction the rethrow above turns on: `nvidia-smi` exiting non-zero
    // is a fact about the machine, and only the runner declining to run
    // anything is not.
    const facts = await probeMachine(
      runner((command) =>
        Promise.resolve(
          // 7 for the curl: nothing is on the port, so the answer turns on the
          // GPU rather than short-circuiting to "already serving".
          command.startsWith('nvidia-smi')
            ? { code: 127, stdout: '' }
            : command.startsWith('curl')
              ? { code: 7, stdout: '' }
              : { code: 0, stdout: 'ok' },
        ),
      ),
      'x',
      'Linux',
    );
    expect(facts.gpu).toBeNull();
    expect(vllmReadiness(facts).summary).toContain('No NVIDIA GPU');
  });

  it('reads a refused connection as "nothing is serving", and a missing curl as unknown', async () => {
    /*
     * Two different non-zero exits, and collapsing them is how the Windows check
     * went wrong before: `cmd.exe` echoed a PowerShell one-liner and exited 0,
     * so the literal `'True'` in the script text was read as a live server. The
     * check is now curl's own exit code, and 7 is the only one that means the
     * port answered with a refusal.
     */
    const serving = async (code: number): Promise<boolean | null> =>
      (
        await probeMachine(
          runner((command) =>
            Promise.resolve(
              command.startsWith('curl') ? { code, stdout: '' } : { code: 1, stdout: '' },
            ),
          ),
          'x',
          'Linux',
        )
      ).alreadyServing;

    expect(await serving(0)).toBe(true);
    expect(await serving(7)).toBe(false);
    // 9009 is what a Windows shell answers for a program it cannot find. Not a
    // statement about the port, so not an answer about the port.
    expect(await serving(9009)).toBeNull();
  });
});
