/**
 * Execution targets and transport capabilities (DESIGN.md §6.1, §6.2).
 *
 * A target answers "where does this run and how do we reach it". It knows
 * nothing about which harness drives the loop or which model answers — that
 * independence is the point (§1, three axes).
 */

export type ExecutionTarget =
  | { kind: 'local' }
  | {
      kind: 'ssh';
      alias?: string;
      host: string;
      user?: string;
      port?: number;
      identityFile?: string;
      jumpHosts?: string[];
      /** Delegate to system ssh so ~/.ssh/config is honored verbatim (§6.2). */
      useSystemConfig?: boolean;
    }
  | { kind: 'wsl'; distro: string }
  | { kind: 'container'; engine: 'docker' | 'podman'; containerId: string }
  | { kind: 'k8s'; context: string; namespace: string; pod: string; container?: string }
  | { kind: 'devcontainer'; configPath: string }
  /** Loop and sandbox both on the provider's infra; no Transport at all (§6.9). */
  | { kind: 'hosted'; serviceId: string; agentRef: string }
  | { kind: 'custom'; transportId: string; config: unknown };

export type TargetKind = ExecutionTarget['kind'];

/**
 * Where a workspace is, completely: which machine, and which directory on it.
 *
 * The two travel together because neither answers "where is this session" on its
 * own — a path is meaningless without the machine it is on, and that ambiguity
 * is exactly what a fleet spanning several hosts cannot afford.
 */
export interface HostLocation {
  target: ExecutionTarget;
  /** Absolute on whichever machine `target` names. */
  workspaceRoot: string;
}

/**
 * Enforced, not assumed. `persistentProcesses: false` disables detached runs
 * *with an explanation* rather than silently losing an overnight run.
 */
export interface TransportCapabilities {
  /** Can a process outlive the connection? Gates detached runs entirely. */
  persistentProcesses: boolean;
  /** Remote can reach local — required for tunneled model egress (§6.5). */
  portForwardIn: boolean;
  /** Local can reach remote — required for app preview (§6.8). */
  portForwardOut: boolean;
  /** Else fall back to a loopback TCP control port plus a bearer token. */
  unixSockets: boolean;
  fileTransfer: boolean;
  multiplexed: boolean;
  latencyClass: 'local' | 'lan' | 'wan';
}

/** A short, human-readable badge for the dashboard (§10). */
export function targetLabel(t: ExecutionTarget): string {
  switch (t.kind) {
    case 'local':
      return 'local';
    case 'ssh':
      return t.alias ?? t.host;
    case 'wsl':
      return `wsl:${t.distro}`;
    case 'container':
      return `${t.engine}:${t.containerId.slice(0, 12)}`;
    case 'k8s':
      return `k8s:${t.namespace}/${t.pod}`;
    case 'devcontainer':
      return 'devcontainer';
    case 'hosted':
      return `hosted:${t.serviceId}`;
    case 'custom':
      return t.transportId;
  }
}

/**
 * Whether two targets name the same place.
 *
 * Compared by the fields that decide *which machine*, not by deep equality: two
 * `ssh` targets differing only in a port they both default are the same box, and
 * refusing that would make an honest caller look like a liar.
 *
 * Lives here rather than in `sessionManager` because two layers now need the
 * same answer and they run in different processes — the session host refusing a
 * mislabelled child, and the fleet refusing a template aimed at another machine.
 * A second copy of a rule this quiet is how the two drift apart.
 */
export function sameTarget(a: ExecutionTarget, b: ExecutionTarget): boolean {
  if (a.kind !== b.kind) return false;
  const where = (t: ExecutionTarget): string => {
    const x = t as { alias?: string; host?: string; distro?: string; container?: string };
    return x.alias ?? x.host ?? x.distro ?? x.container ?? '';
  };
  return where(a) === where(b);
}

/** A target as a person would name it. */
export function describeTarget(target: ExecutionTarget): string {
  const x = target as { alias?: string; host?: string; distro?: string };
  return x.alias ?? x.host ?? x.distro ?? target.kind;
}
