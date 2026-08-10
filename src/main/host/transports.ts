/**
 * Which localities exist, what each can do, and what happens when one does not
 * exist yet (DESIGN.md §6.1, §6.2, §6.9).
 *
 * §6.2 calls the transport layer *pluggable* and `ExecutionTarget` names eight
 * kinds. Two are implemented. The other six were handled by a single `if` in the
 * app's connector —
 *
 *     if (target.kind === 'ssh') { …remote… }
 *     return connectOrSpawnHost({ workspaceRoot, … })
 *
 * — so asking for a container ran the work **on the laptop instead**, quietly
 * and successfully. That is worse than an unsupported feature: an error is a
 * thing a person can act on, while a session badged `docker:…` that is actually
 * writing to their own home directory is a wrong belief they have no reason to
 * question. It never fired, because only the two implemented kinds can be built
 * from the UI — which is the definition of a latent bug rather than an argument
 * that there wasn't one.
 *
 * ## The registry is a `Record<TargetKind, …>` on purpose
 *
 * That is the whole enforcement mechanism. Adding a ninth member to
 * `ExecutionTarget` stops compiling here until somebody says what it can do and
 * whether it works, so the next transport cannot be half-added the way six of
 * them already were. An `if` chain and a `switch` with a `default` both accept
 * silence as an answer; a total map does not.
 *
 * ## Capabilities, declared where the refusal is written
 *
 * §6.1's `TransportCapabilities` existed as six booleans and a latency class
 * that **nothing in the program read** — the same "recorded, not enforced" shape
 * §16 keeps turning up, and its own comment claims the opposite ("Enforced, not
 * assumed"). They are read now, by the refusal: a target that is not implemented
 * says which capability is the reason, which is the difference between "not yet"
 * and "not by swapping a command runner".
 *
 * That distinction is concrete. `SshRunner` is `exec` / `upload` / `forward`,
 * and the first two are a one-line change for WSL (`wsl -d <distro> -- sh -c …`)
 * or a container (`docker exec`). `forward` is not, because the host listens on
 * a **unix socket** and the app reaches it with `ssh -L`. Nothing forwards a
 * Linux unix socket out of a WSL2 VM to Windows — the `\\wsl$` share is 9p, and
 * an `AF_UNIX` path does not survive it. §6.1 already anticipated this ("Else
 * fall back to a loopback TCP control port plus a bearer token") and that
 * fallback does not exist. So the honest statement about WSL is not "not written
 * yet" but "needs the control channel §6.1 describes and nothing implements",
 * and the capability table is where that is written down instead of being
 * rediscovered by whoever tries next.
 *
 * **These declarations are researched, not measured.** The two implemented rows
 * are observed — the ssh row is what a real host does. The six unimplemented
 * rows are what the mechanism is documented to allow, and each will need
 * confirming against a real one when it is built. Saying which is which is the
 * point; a table that mixes them is a table nobody can trust a row of.
 */

import type {
  ExecutionTarget,
  TargetKind,
  TransportCapabilities,
} from '@shared/types/index.js';

export interface TransportDescriptor {
  kind: TargetKind;
  /** What to call it in a sentence addressed to a person. */
  label: string;
  capabilities: TransportCapabilities;
  /**
   * Whether the declaration was observed or read.
   *
   * `'observed'` means a host has actually run over it. `'documented'` means the
   * mechanism says so and nobody has checked.
   */
  evidence: 'observed' | 'documented';
  /**
   * `null` when it works. Otherwise what is missing, in the user's terms.
   *
   * Written as the sentence they will read, because it is the only thing they
   * get: there is no fallback behind it, deliberately.
   */
  unimplemented: string | null;
}

/** Every locality, whether or not it works. */
export const TRANSPORTS: Record<TargetKind, TransportDescriptor> = {
  local: {
    kind: 'local',
    label: 'this machine',
    evidence: 'observed',
    capabilities: {
      persistentProcesses: true,
      portForwardIn: true,
      portForwardOut: true,
      unixSockets: true,
      fileTransfer: true,
      multiplexed: true,
      latencyClass: 'local',
    },
    unimplemented: null,
  },

  ssh: {
    kind: 'ssh',
    label: 'a machine over SSH',
    evidence: 'observed',
    capabilities: {
      // All observed against a real host: the process outlives the session that
      // started it, `-L` forwards to a remote unix socket, and one connection
      // carries many channels.
      persistentProcesses: true,
      portForwardIn: true,
      portForwardOut: true,
      unixSockets: true,
      fileTransfer: true,
      multiplexed: true,
      latencyClass: 'wan',
    },
    unimplemented: null,
  },

  wsl: {
    kind: 'wsl',
    label: 'a WSL distribution',
    evidence: 'documented',
    capabilities: {
      persistentProcesses: true,
      // WSL2 forwards localhost in both directions; what it does not do is carry
      // a unix socket across the VM boundary, which is the one this host needs.
      portForwardIn: true,
      portForwardOut: true,
      unixSockets: false,
      fileTransfer: true,
      multiplexed: true,
      latencyClass: 'local',
    },
    unimplemented:
      'running in WSL needs the loopback control port §6.1 describes — the host ' +
      'listens on a unix socket, and a Linux socket inside WSL2 cannot be reached ' +
      'from Windows.',
  },

  container: {
    kind: 'container',
    label: 'a Docker or Podman container',
    evidence: 'documented',
    capabilities: {
      // A container's lifetime is the container's, not a connection's — but only
      // while it is running, and `docker exec` processes die with a stop.
      persistentProcesses: true,
      portForwardIn: false,
      portForwardOut: true,
      // A socket inside a container is reachable only through a bind mount that
      // has to be arranged when the container starts, which is not ours to do.
      unixSockets: false,
      fileTransfer: true,
      multiplexed: true,
      latencyClass: 'local',
    },
    unimplemented:
      'running in a container is not built yet — it needs the loopback control ' +
      'port §6.1 describes, and a way for the container to reach the model gateway.',
  },

  k8s: {
    kind: 'k8s',
    label: 'a Kubernetes pod',
    evidence: 'documented',
    capabilities: {
      // A pod outlives a `kubectl` session, but the scheduler may move it, which
      // is a kind of impermanence ssh does not have.
      persistentProcesses: true,
      portForwardIn: false,
      portForwardOut: true,
      unixSockets: false,
      fileTransfer: true,
      multiplexed: false,
      latencyClass: 'wan',
    },
    unimplemented:
      'running in a Kubernetes pod is not built yet — it needs the loopback ' +
      'control port §6.1 describes, and a pod that can be rescheduled underneath a ' +
      'detached run.',
  },

  devcontainer: {
    kind: 'devcontainer',
    label: 'a dev container',
    evidence: 'documented',
    capabilities: {
      persistentProcesses: true,
      portForwardIn: false,
      portForwardOut: true,
      unixSockets: false,
      fileTransfer: true,
      multiplexed: true,
      latencyClass: 'local',
    },
    unimplemented:
      'dev containers are not built yet — they need the container transport first, ' +
      'plus reading devcontainer.json to know what to start.',
  },

  hosted: {
    kind: 'hosted',
    label: 'a hosted agent service',
    evidence: 'documented',
    capabilities: {
      // §6.9: there is no transport at all. Everything here is false because
      // there is nothing to be true about — the loop and the sandbox are both on
      // the provider's side, and this is driven by an adapter from main.
      persistentProcesses: true,
      portForwardIn: false,
      portForwardOut: false,
      unixSockets: false,
      fileTransfer: false,
      multiplexed: false,
      latencyClass: 'wan',
    },
    unimplemented:
      'hosted agent services are not built yet — §6.9 makes them a locality with ' +
      'no transport and an app-side store, which is a different path rather than a ' +
      'harder version of this one.',
  },

  custom: {
    kind: 'custom',
    label: 'a custom transport',
    evidence: 'documented',
    capabilities: {
      // Unknowable by definition: whatever registers one declares its own. The
      // conservative row is the right default, because assuming a capability a
      // plugin does not have fails at the worst moment.
      persistentProcesses: false,
      portForwardIn: false,
      portForwardOut: false,
      unixSockets: false,
      fileTransfer: false,
      multiplexed: false,
      latencyClass: 'wan',
    },
    unimplemented:
      'there is no transport plugin API yet, so a custom transport has nothing to ' +
      'register with.',
  },
};

export class TransportUnsupported extends Error {
  constructor(
    readonly kind: TargetKind,
    reason: string,
  ) {
    super(reason);
    this.name = 'TransportUnsupported';
  }
}

export function transportFor(target: ExecutionTarget): TransportDescriptor {
  return TRANSPORTS[target.kind];
}

/**
 * The gate. Refuse a locality that does not work, by name.
 *
 * Deliberately not inside the app's connector, which is where the `if` was.
 * `Fleet` takes its connector as a dependency, so a rule living in one
 * implementation of it is a rule the CLI does not have, the tests do not have,
 * and the next connector will not have either — which is how the guarantee got
 * lost the first time. It belongs above the injection point.
 */
export function requireTransport(target: ExecutionTarget): TransportDescriptor {
  const transport = TRANSPORTS[target.kind];
  if (transport.unimplemented !== null) {
    throw new TransportUnsupported(target.kind, transport.unimplemented);
  }
  return transport;
}

/** Kinds that work today, for anything offering a choice. */
export function supportedTargetKinds(): TargetKind[] {
  return (Object.keys(TRANSPORTS) as TargetKind[]).filter(
    (kind) => TRANSPORTS[kind].unimplemented === null,
  );
}
