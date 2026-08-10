/**
 * Bringing a remote dev server to a local port (DESIGN.md §6.8, §12.1).
 *
 * > `forwardOut(3000)` yields a local port; the session view offers **Open
 * > preview** and **Capture preview** (§12.1). Ports are listed per session and
 * > torn down with it.
 *
 * The point is §12.1's, not this file's: *preview-then-capture*. Forward the
 * port, open it in your browser, capture that window, annotate, send — you see
 * exactly what the model will see. Without the forward, an agent working on a
 * build box is writing a web page nobody can look at, and the only feedback loop
 * left is asking it whether the page looks right.
 *
 * ## The first reader of a declared capability
 *
 * `TransportCapabilities.portForwardOut` has existed since §6.2 was written and
 * has been read by nothing — the "recorded, not enforced" shape §16 keeps
 * turning up. This is what it was declared for, so this is where it gets
 * consulted, and a target that cannot forward says so instead of failing later
 * with a message about ssh.
 *
 * ## Scoped to a session, and torn down with it
 *
 * A forward is a live `ssh -N` process holding a local port. Left behind it is
 * both a leak and a lie: the port keeps answering after the session that
 * explained it is gone, so the next person to open `localhost:53112` sees
 * somebody's old dev server and has nothing to connect it to. Keyed by session
 * so closing one cannot take another's down, which is the failure that would
 * come from keying by port alone.
 *
 * ## The same remote port twice is one forward
 *
 * Asking again returns what is already open rather than starting a second `ssh`
 * to the same place. Two forwards to one server is two processes, two local
 * ports and two things to tear down, for a preview that is identical either way.
 */

import { connect } from 'node:net';
import type { ExecutionTarget, SessionId } from '@shared/types/index.js';
import { transportFor } from '../host/transports.js';

/**
 * How long a probe waits before calling a forward alive.
 *
 * A dead one closes in 4–5 ms over a low-latency link, so the signal is not
 * subtle — but that 4–5 ms is a round trip, and on a WAN it is however long the
 * link is. A second is generous enough that a false "nothing there" needs a
 * link on which previewing would be unpleasant anyway, and it is paid once per
 * forward rather than per request.
 */
export const PROBE_MS = 1_000;

/**
 * Does anything answer behind this local port?
 *
 * A connection that stays open is the only positive signal available: a dev
 * server says nothing until it is asked, so "it did not hang up" is what
 * "somebody is there" looks like at the TCP layer.
 */
export function probeLocalPort(localPort: number, waitMs = PROBE_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(localPort, '127.0.0.1');
    let settled = false;
    const done = (alive: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(alive);
    };
    const timer = setTimeout(() => done(true), waitMs);
    timer.unref?.();
    socket.once('error', () => done(false));
    socket.once('close', () => done(false));
  });
}

export interface ForwardHandle {
  close(): void;
}

/** Opens a tunnel from a local port to `remotePort` on the target. */
export type ForwardOpener = (
  target: ExecutionTarget,
  localPort: number,
  remotePort: number,
) => Promise<ForwardHandle>;

export interface Forward {
  sessionId: SessionId;
  remotePort: number;
  localPort: number;
  /** What to put in a browser. */
  url: string;
  /**
   * Whether anything answered at the far end, last time we looked.
   *
   * **`ssh -L` succeeds whether or not the remote port exists.** It binds the
   * local end immediately, so "the port answers" — which is how the transport
   * decides a forward is usable — is true for a port with nothing behind it.
   * Found by forwarding port 9 on a real host: the forward reported success and
   * the failure surfaced only at fetch time, as a connection reset. To a user
   * that reads as "the preview is broken" rather than "nothing is running
   * there", which sends them to debug the wrong machine.
   *
   * Measured rather than assumed: a dead forward closes the probe in **4–5 ms**
   * and a live one stays open indefinitely, so the two are not close.
   *
   * `false` is reported, **not refused**, and that is the important part. A dev
   * server that is still compiling looks exactly like a dead port, and it is the
   * normal case for a forward to be opened before the thing behind it is
   * listening. Tearing it down would break the ordinary flow to catch a typo;
   * saying "nothing is answering on 3000 yet" catches the typo and survives the
   * compile.
   */
  reachable: boolean;
}

export class ForwardRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ForwardRefused';
  }
}

interface Open extends Forward {
  handle: ForwardHandle;
}

export interface PreviewForwardsDeps {
  open: ForwardOpener;
  /** An ephemeral loopback port. Injected so a test need not race the OS. */
  freePort: () => Promise<number>;
  /** Whether anything is behind a local port. Injected so a test need not wait. */
  probe?: (localPort: number) => Promise<boolean>;
}

export class PreviewForwards {
  private readonly open = new Map<string, Open>();

  constructor(private readonly deps: PreviewForwardsDeps) {}

  private static key(sessionId: SessionId, remotePort: number): string {
    return `${sessionId}:${remotePort}`;
  }

  /**
   * Forward a remote port, or hand back the one already forwarded.
   *
   * A local target needs no forward and gets none: the port is already on this
   * machine, and starting a tunnel from localhost to localhost would be a
   * process, a port and a failure mode bought for nothing. It still returns a
   * `Forward`, because the caller's question is "what do I open" and the answer
   * exists either way.
   */
  async forward(
    sessionId: SessionId,
    target: ExecutionTarget,
    remotePort: number,
  ): Promise<Forward> {
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65_535) {
      throw new ForwardRefused(`${remotePort} is not a port`);
    }

    const existing = this.open.get(PreviewForwards.key(sessionId, remotePort));
    if (existing !== undefined) return strip(existing);

    const probe = this.deps.probe ?? ((port: number) => probeLocalPort(port));

    if (target.kind === 'local') {
      const here: Open = {
        sessionId,
        remotePort,
        localPort: remotePort,
        url: `http://127.0.0.1:${remotePort}`,
        // Probed here too. A local target has no tunnel to be wrong about, but
        // "nothing is listening on 3000" is the same useful answer.
        reachable: await probe(remotePort),
        // Nothing to close. Recorded anyway so the session's list is the whole
        // truth about what it has open, rather than the remote half of it.
        handle: { close: () => undefined },
      };
      this.open.set(PreviewForwards.key(sessionId, remotePort), here);
      return strip(here);
    }

    const transport = transportFor(target);
    if (!transport.capabilities.portForwardOut) {
      // The capability read that §6.2 promised and nothing performed. Refusing
      // here rather than downstream means the message names the locality instead
      // of describing whatever tool failed inside it.
      throw new ForwardRefused(
        `${transport.label} cannot forward a port to this machine, so a preview cannot be opened from it`,
      );
    }

    const localPort = await this.deps.freePort();
    const handle = await this.deps.open(target, localPort, remotePort);
    const opened: Open = {
      sessionId,
      remotePort,
      localPort,
      url: `http://127.0.0.1:${localPort}`,
      reachable: await probe(localPort),
      handle,
    };
    this.open.set(PreviewForwards.key(sessionId, remotePort), opened);
    return strip(opened);
  }

  /**
   * Look again.
   *
   * The reason `reachable: false` is not a refusal: a dev server that is still
   * starting reports exactly that, and a moment later it is serving. Without
   * this the only way to correct a stale "nothing there" would be to tear the
   * forward down and open another one, changing the local port under a browser
   * tab the user already has open.
   */
  async recheck(sessionId: SessionId, remotePort: number): Promise<Forward | null> {
    const found = this.open.get(PreviewForwards.key(sessionId, remotePort));
    if (found === undefined) return null;
    const probe = this.deps.probe ?? ((port: number) => probeLocalPort(port));
    found.reachable = await probe(found.localPort);
    return strip(found);
  }

  /** What this session has open, for the list §6.8 asks for. */
  list(sessionId: SessionId): Forward[] {
    return [...this.open.values()]
      .filter((f) => f.sessionId === sessionId)
      .map(strip)
      .sort((a, b) => a.remotePort - b.remotePort);
  }

  close(sessionId: SessionId, remotePort: number): boolean {
    const key = PreviewForwards.key(sessionId, remotePort);
    const found = this.open.get(key);
    if (found === undefined) return false;
    this.open.delete(key);
    found.handle.close();
    return true;
  }

  /** Everything this session opened. Called when it ends. */
  closeSession(sessionId: SessionId): number {
    let closed = 0;
    for (const [key, forward] of [...this.open]) {
      if (forward.sessionId !== sessionId) continue;
      this.open.delete(key);
      forward.handle.close();
      closed += 1;
    }
    return closed;
  }

  /** Everything, for shutdown. */
  closeAll(): void {
    for (const [key, forward] of [...this.open]) {
      this.open.delete(key);
      forward.handle.close();
    }
  }
}

function strip(open: Open): Forward {
  const { handle: _handle, ...rest } = open;
  return rest;
}
