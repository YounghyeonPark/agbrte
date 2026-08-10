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
import {
  listListeningPorts,
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
     * A `netstat` parser written blind for macOS would be a guess about an
     * output format nobody here can run. Returning `[]` instead would be worse
     * than refusing: the user concludes their dev server did not start, and goes
     * looking in the wrong place.
     */
    await expect(listListeningPorts({ platform: 'darwin' })).rejects.toBeInstanceOf(
      PortsUnavailable,
    );
    await expect(listListeningPorts({ platform: 'win32' })).rejects.toThrow(/win32/);
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
