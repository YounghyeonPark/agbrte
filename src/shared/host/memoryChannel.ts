/**
 * A pair of linked in-memory channels (DESIGN.md §8).
 *
 * Not a mock. This is a real transport that happens to be in-process, and it
 * exists so the control protocol, the host server, and the main-side proxy can
 * all be exercised without booting Electron — including against the runtime
 * contract suite, which is the only way to know the proxy honors the same
 * `AgentHandle` contract as a direct adapter.
 *
 * Delivery is **asynchronous** via microtask, matching `postMessage`. Delivering
 * synchronously would make the tests pass for the wrong reason: any ordering bug
 * that depends on a message arriving after the current turn of the event loop —
 * exactly the class of bug this protocol can have — would be invisible.
 */

import type { HostChannel } from './protocol.js';

class MemoryChannel<Out, In> implements HostChannel<Out, In> {
  private handler: ((m: In) => void) | null = null;
  private closeHandler: ((reason?: string) => void) | null = null;
  private readonly backlog: In[] = [];
  private closed = false;

  peer!: MemoryChannel<In, Out>;

  post(message: Out): void {
    if (this.closed) return;
    queueMicrotask(() => this.peer.accept(message));
  }

  /** Buffers until a handler attaches, so no early message is lost. */
  private accept(message: In): void {
    if (this.closed) return;
    if (this.handler === null) {
      this.backlog.push(message);
      return;
    }
    this.handler(message);
  }

  onMessage(handler: (m: In) => void): void {
    this.handler = handler;
    const queued = this.backlog.splice(0);
    for (const message of queued) handler(message);
  }

  onClose(handler: (reason?: string) => void): void {
    this.closeHandler = handler;
  }

  close(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeHandler?.(reason);
    // The peer learns about it too, which is what lets a test simulate a host
    // crash and assert that in-flight requests fail rather than hang.
    queueMicrotask(() => this.peer.close(reason ?? 'peer closed'));
  }
}

export interface ChannelPair<A, B> {
  main: HostChannel<A, B>;
  host: HostChannel<B, A>;
  /** Simulate a process death from either side. */
  breakLink(reason?: string): void;
}

export function memoryChannelPair<A, B>(): ChannelPair<A, B> {
  const main = new MemoryChannel<A, B>();
  const host = new MemoryChannel<B, A>();
  main.peer = host;
  host.peer = main;
  return {
    main,
    host,
    breakLink: (reason) => host.close(reason ?? 'host exited'),
  };
}
