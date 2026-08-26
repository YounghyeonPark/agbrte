/**
 * The gate in front of `agbrte web` (DESIGN.md §6.2, §13).
 *
 * This server used to say, in its own header, that it did not authenticate — on
 * the reasoning that the address is the whole boundary "exactly as it is for the
 * unix socket the host already listens on". That comparison was the mistake.
 * `socketChannel.ts` narrows its unix socket to `0600` and relies on a Windows
 * named pipe's default DACL, precisely so that `grantRole`'s reasoning — that
 * *reaching the socket already proved who you are* — is true. A TCP port proves
 * nothing, which is why §6.2 mints a bearer for the loopback control channel.
 * This server is the same shape and was the one place that skipped it.
 *
 * It was not theoretical. On a real browser against a real host, a page on
 * `https://example.com` opened `ws://127.0.0.1:7717/__agbrte/socket` and read the
 * session list back — needing one Local Network Access prompt from the browser
 * and nothing at all from us. On a tailnet address there is no prompt.
 *
 * The wiring is exercised end to end in `web.spec.ts`. The *rule* is here,
 * because this suite runs in CI and that one does not, and a security gate that
 * only a manual suite can see is a gate that loosens without anybody noticing.
 */

import { describe, expect, it } from 'vitest';
import { admitsFrame } from '../src/web/server.js';
import { newControlToken } from '@shared/host/loopback.js';

const TOKEN = newControlToken();

describe('what the web socket admits', () => {
  it('admits exactly the right frame', () => {
    expect(admitsFrame({ t: 'auth', token: TOKEN }, TOKEN)).toBe(true);
  });

  it('refuses a wrong token, and one that is merely a prefix', () => {
    expect(admitsFrame({ t: 'auth', token: newControlToken() }, TOKEN)).toBe(false);
    // A comparison that stopped at the shorter string would pass this.
    expect(admitsFrame({ t: 'auth', token: TOKEN.slice(0, -1) }, TOKEN)).toBe(false);
    expect(admitsFrame({ t: 'auth', token: `${TOKEN}x` }, TOKEN)).toBe(false);
  });

  it('refuses an ordinary API call sent before the handshake', () => {
    /*
     * The frame that actually read a session list off a real host. It is a
     * *valid* request — that is the point: the gate cannot key on the frame
     * being malformed, only on it not being the handshake.
     */
    expect(admitsFrame({ id: 1, channel: 'agbrte:sessions.list', args: [] }, TOKEN)).toBe(false);
  });

  it('refuses everything that is not an object with a string token', () => {
    for (const frame of [
      null,
      undefined,
      'auth',
      42,
      [],
      {},
      { t: 'auth' },
      { t: 'auth', token: null },
      { t: 'auth', token: 123 },
      { t: 'auth-ok' },
      { token: TOKEN },
    ]) {
      expect(admitsFrame(frame, TOKEN), JSON.stringify(frame) ?? 'undefined').toBe(false);
    }
  });

  it('admits nobody when the server has no token, rather than everybody', () => {
    /*
     * The direction a mistake here has to fall. An empty string is what an
     * unset option, a stripped environment variable or a bad `--token ''` all
     * arrive as, and treating it as "no gate configured" would open the door on
     * exactly the deployments that got it wrong.
     */
    expect(admitsFrame({ t: 'auth', token: '' }, '')).toBe(false);
    expect(admitsFrame({ t: 'auth', token: 'anything' }, '')).toBe(false);
  });
});
