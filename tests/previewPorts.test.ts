/**
 * Finding the dev server on the far machine (DESIGN.md §6.8).
 *
 * > The host detects newly listening ports and offers to forward them.
 *
 * Driven by `/proc/net/tcp` captured from a real Linux host, because the format
 * is the whole risk: addresses are little-endian hex per 32-bit word and ports
 * are big-endian, which is the kind of asymmetry that reads fine either way in
 * a unit test written from the same misunderstanding as the parser.
 *
 * The fixtures are that capture with routable addresses replaced by TEST-NET-3.
 * Ports, states, uids, loopback and `0.0.0.0` are exactly as the kernel reported
 * them — those are what the parser reads, and the uid spread is the point.
 */

import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import {
  listListeningPorts,
  ownedByUs,
  parseLsof,
  parseNetstat,
  parseProcNetTcp,
  PortsUnavailable,
} from '@main/preview/ports.js';

const FIXTURES = join(__dirname, 'fixtures');

/** The capture, minus the `#` lines explaining where it came from. */
async function fixture(name: string): Promise<string> {
  const text = await readFile(join(FIXTURES, name), 'utf8');
  return text
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .join('\n');
}

describe('the kernel’s format, read off a real host', () => {
  it('decodes a loopback listener', async () => {
    // `0100007F:221B` — the `python3 -m http.server 8731 --bind 127.0.0.1`
    // started to produce this capture. Little-endian address, big-endian port.
    const ports = parseProcNetTcp(await fixture('procNetTcp.txt'), 1000, 'ipv4');
    const mine = ports.find((p) => p.port === 8731);
    expect(mine).toEqual({ port: 8731, address: '127.0.0.1', loopbackOnly: true, family: 'ipv4' });
  });

  it('distinguishes a server the machine can see from one the network can', async () => {
    /**
     * `0.0.0.0` and `127.0.0.1` are both ordinary and the difference is who can
     * reach it. Flattening them into "there is a server on 3000" is the kind of
     * simplification that reads as helpful and hides the only fact that matters
     * on a shared box.
     */
    const ports = parseProcNetTcp(await fixture('procNetTcp.txt'), 1000, 'ipv4');
    const exposed = ports.find((p) => !p.loopbackOnly);
    expect(exposed, 'the capture had a non-loopback listener for this uid').toBeDefined();
    expect(exposed?.address).not.toMatch(/^127\./);
  });

  it('decodes the v6 forms a person would recognise', async () => {
    // The kernel prints `::1` as four little-endian words, so a naive reading
    // gives `100::` — visibly wrong, but only if something looks.
    const ports = parseProcNetTcp(await fixture('procNetTcp6.txt'), 0, 'ipv6');
    expect(ports.map((p) => p.address)).toContain('::');
    const v6loopback = parseProcNetTcp(await fixture('procNetTcp6.txt'), 123, 'ipv6');
    for (const p of v6loopback) {
      expect(p.address, 'a v6 address decoded into something unreadable').not.toMatch(/^100:/);
    }
  });

  it('ignores everything that is not listening', async () => {
    // The file is mostly established connections. `0A` is `TCP_LISTEN`; a parser
    // that took every row would offer to forward the ssh session it arrived on.
    const text = await fixture('procNetTcp.txt');
    const rows = text.trim().split('\n').length - 1;
    const listening = parseProcNetTcp(text, 1000, 'ipv4').length;
    expect(rows).toBeGreaterThan(listening * 2);
  });
});

describe('other people’s ports are not a feature', () => {
  it('shows only this user’s listeners', async () => {
    /**
     * The design decision, and the capture demonstrates it rather than arguing
     * it. That real host has listeners under four uids: root's `sshd` and
     * `cups`, `systemd-resolved`'s two, and — the one that matters — **another
     * user's service on port 4000 bound to `0.0.0.0`**.
     *
     * Offering the whole list turns a preview feature into a reconnaissance
     * one: it tells you what your colleagues are running, on which ports, right
     * now, and it arrives as a helpful dropdown nobody asked for. §17 Q9 already
     * worries about exactly this machine.
     */
    const text = await fixture('procNetTcp.txt');

    const everyone = new Set<number>();
    for (const uid of [0, 123, 991, 1000]) {
      for (const p of parseProcNetTcp(text, uid, 'ipv4')) everyone.add(p.port);
    }
    expect(everyone.has(4000), 'the capture should contain another uid’s service').toBe(true);

    const ours = parseProcNetTcp(text, 1000, 'ipv4').map((p) => p.port);
    expect(ours).not.toContain(4000);
    expect(ours).not.toContain(22);
    expect(ours).toContain(8731);
  });

  it('drops the ports that are never a preview, and the host’s own', async () => {
    const read = async (path: string): Promise<string> =>
      fixture(path === '/proc/net/tcp' ? 'procNetTcp.txt' : 'procNetTcp6.txt');

    const ports = await listListeningPorts({ uid: 1000, platform: 'linux', read, exclude: [7001] });
    const numbers = ports.map((p) => p.port);

    expect(numbers).toContain(8731);
    // Excluded because the host itself is listening there — offering to forward
    // our own control channel is offering a loop.
    expect(numbers).not.toContain(7001);
    expect(numbers).not.toContain(22);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
  });

  it('lists one entry per port when a server binds both stacks', async () => {
    // A dual-stack dev server appears in both files. One port is one server to
    // the person choosing from a list.
    const read = async (path: string): Promise<string> =>
      path === '/proc/net/tcp'
        ? '  sl  local_address rem_address   st … uid\n   0: 0100007F:0BB8 00000000:0000 0A x x x 1000\n'
        : '  sl  local_address remote_address st … uid\n   0: 00000000000000000000000001000000:0BB8 x 0A x x x 1000\n';

    const ports = await listListeningPorts({ uid: 1000, platform: 'linux', read });
    expect(ports.map((p) => p.port)).toEqual([3000]);
    expect(ports[0]?.family).toBe('ipv4');
  });
});

describe('“cannot tell” is not “nothing is running”', () => {
  it('refuses on a platform it cannot read', async () => {
    /**
     * This asserted that macOS and Windows were refused, and failed the moment
     * they were implemented — which is the assertion working. What is left is
     * the genuine case: a platform with no enumerator at all.
     *
     * Refusing rather than returning `[]` is the point. "No dev server is
     * running" and "this host cannot tell you" are different answers, and the
     * second dressed as the first sends a user to debug a server that started
     * fine.
     */
    await expect(listListeningPorts({ platform: 'aix' })).rejects.toBeInstanceOf(PortsUnavailable);
    await expect(listListeningPorts({ platform: 'freebsd' })).rejects.toThrow(/freebsd/);
  });

  it('says so when the platform’s own tool is missing or fails', async () => {
    // `lsof` is on every macOS and `netstat` on every Windows, but a stripped
    // container or a locked-down image is a real thing — and it is the same
    // answer as an unknown platform: cannot tell, not nothing there.
    for (const platform of ['darwin', 'win32'] as const) {
      await expect(
        listListeningPorts({ platform, run: () => Promise.reject(new Error('ENOENT')) }),
      ).rejects.toBeInstanceOf(PortsUnavailable);
    }
  });

  it('refuses when neither file can be read', async () => {
    await expect(
      listListeningPorts({ platform: 'linux', uid: 0, read: () => Promise.reject(new Error('nope')) }),
    ).rejects.toBeInstanceOf(PortsUnavailable);
  });

  it('survives a kernel with an extra column or a torn read', async () => {
    // Skipping an unreadable row is right; throwing would take out a dropdown
    // because one line was odd.
    const read = async (): Promise<string> =>
      '  sl  local_address\n   0: short\n   1: 0100007F:0BB8 00000000:0000 0A a b c 1000 extra extra\n';
    const ports = await listListeningPorts({ platform: 'linux', uid: 1000, read });
    expect(ports.map((p) => p.port)).toEqual([3000]);
  });
});

describe('each OS is asked in its own language', () => {
  it('finds a listener this process actually owns, wherever it runs', async () => {
    /**
     * The one test that matters for "it controls the OS it runs on": a real
     * server on a real port, found by whatever mechanism this platform has —
     * `/proc/net/tcp` on Linux, `lsof -F` on macOS, `netstat -ano` on Windows.
     *
     * It is deliberately not skipped anywhere. A platform that cannot answer
     * fails here rather than quietly returning nothing, which is the whole
     * difference between "no dev server is running" and "this host cannot tell
     * you" — and CI runs it on all three.
     */
    const server = createServer(() => undefined);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    expect(port).toBeGreaterThan(0);

    try {
      const ports = await listListeningPorts();
      const found = ports.find((p) => p.port === port);
      expect(found, `${process.platform} did not find its own listener on ${port}`).toBeDefined();
      expect(found?.loopbackOnly, 'a 127.0.0.1 listener was not reported as loopback').toBe(true);
    } finally {
      server.close();
    }
  }, 30_000);

  it('does not offer a port nothing is listening on any more', async () => {
    const server = createServer(() => undefined);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    await new Promise<void>((r) => server.close(() => r()));

    // Not an assertion about timing: the socket is closed before this runs, and
    // an enumerator that still reported it would be reading a cache.
    expect((await listListeningPorts()).some((p) => p.port === port)).toBe(false);
  }, 30_000);
});

describe('macOS speaks lsof', () => {
  it('reads the field output lsof documents for programs', () => {
    // `-F pn` gives a `p<pid>` line per process and an `n<address>` line per
    // socket. The default table is aligned for humans and its columns move.
    const out = ['p412', 'n127.0.0.1:3000', 'n[::1]:8080', 'p900', 'n*:5000', ''].join('\n');
    expect(parseLsof(out)).toEqual([
      { port: 3000, address: '127.0.0.1', loopbackOnly: true, family: 'ipv4' },
      { port: 8080, address: '::1', loopbackOnly: true, family: 'ipv6' },
      // `*` is lsof's way of writing what `/proc` writes as `0.0.0.0`, and it
      // has to mean the same thing to `loopbackOnly` or the two platforms would
      // disagree about who can reach a server.
      { port: 5000, address: '0.0.0.0', loopbackOnly: false, family: 'ipv4' },
    ]);
  });

  it('asks lsof to do the owner filtering', async () => {
    // `/proc` needed a uid column for this and Windows has no cheap way at all;
    // `lsof -u` is given the answer for free, so it is used.
    const seen: string[][] = [];
    await listListeningPorts({
      platform: 'darwin',
      uid: 501,
      run: (_bin, args) => {
        seen.push(args);
        return Promise.resolve('p1\nn127.0.0.1:3000\n');
      },
    });
    expect(seen[0]).toContain('-u');
    expect(seen[0]).toContain('501');
    expect(seen[0]).toContain('-sTCP:LISTEN');
  });
});

describe('Windows speaks netstat', () => {
  it('keeps listeners and drops connections', () => {
    const out = [
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       2288',
      '  TCP    127.0.0.1:3000         0.0.0.0:0              LISTENING       4242',
      '  TCP    203.0.113.9:52310      93.184.216.34:443      ESTABLISHED     4242',
      '  UDP    0.0.0.0:5353           *:*                                    900',
    ].join('\n');
    expect(parseNetstat(out, () => true).map((p) => p.port)).toEqual([135, 3000]);
  });

  it('shows only processes this user can reach', () => {
    /**
     * The Windows answer to the uid column, and the only affordable one. The
     * obvious route — `tasklist /FI "USERNAME eq …"` — was **measured at 83
     * seconds** against `netstat`'s 68 ms, so it is not a filter, it is a hang.
     *
     * `kill(pid, 0)` opens the process, so `EPERM` means "exists and is not
     * ours". Three hundred probes took a millisecond.
     */
    const out = [
      '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       4',
      '  TCP    127.0.0.1:3000         0.0.0.0:0              LISTENING       4242',
    ].join('\n');
    const ours = new Set([4242]);
    expect(parseNetstat(out, (pid) => ours.has(pid)).map((p) => p.port)).toEqual([3000]);
  });

  it('reports another user’s process as not ours, and our own as ours', () => {
    // Against the real OS rather than a fake, since the whole claim is about
    // what `kill(pid, 0)` does here. Skipped off Windows, where `EPERM` for a
    // foreign process is not the mechanism.
    expect(ownedByUs(process.pid)).toBe(true);
    if (process.platform === 'win32') {
      // pid 4 is the Windows `System` process, which no ordinary user can open.
      expect(ownedByUs(4)).toBe(false);
    }
  });
});
