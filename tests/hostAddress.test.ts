/**
 * Which host the browser client talks to (§7, §6.2).
 *
 * This used to have one answer — whoever served the page — and that answer is
 * correct only while the page comes from a host. Once the app can be published
 * somewhere that is not one, the address becomes something the page is told, and
 * *which* of three tellers wins is the kind of ordering that is obvious while
 * writing it and impossible to reconstruct from the symptom: a client that
 * connects to yesterday's laptop instead of the machine in the link somebody
 * just pasted.
 */

import { describe, expect, it } from 'vitest';
import { describeAddressProblem, resolveHost, socketUrl } from '../src/web/hostAddress.js';

const STORED = { origin: 'http://stored:7717', token: 'stored-token' };

describe('where the client is pointed', () => {
  it('uses the host that served the page, over anything else', () => {
    // The case that must not change: `agbrte web` stamps its own origin, and a
    // page it served connects there whatever else is lying around.
    expect(
      resolveHost({ served: 'http://127.0.0.1:7717', hash: '#t=abc', stored: STORED }),
    ).toEqual({ origin: 'http://127.0.0.1:7717', token: 'abc' });
  });

  it('reuses a token this same host stored, so a reload is not a trip to the terminal', () => {
    // The link is read once and stripped from the address bar; without this a
    // refresh would land on the connect screen holding a host it already knew.
    expect(
      resolveHost({
        served: 'http://127.0.0.1:7717',
        stored: { origin: 'http://127.0.0.1:7717', token: 'minted-here' },
      }),
    ).toEqual({ origin: 'http://127.0.0.1:7717', token: 'minted-here' });
  });

  it('refuses to lend one host’s token to another', () => {
    /*
     * A token is minted by one host for one client. Handing a remembered one to
     * a different origin would send a secret to a machine it was never meant
     * for, which is worse than the failure it is trying to avoid — so the origin
     * is compared rather than assumed.
     */
    expect(resolveHost({ served: 'http://127.0.0.1:7717', stored: STORED })).toBeNull();
  });

  it('takes a whole link over what it remembers', () => {
    // Somebody just pasted this. Preferring storage would answer a deliberate
    // act with a stale address.
    expect(
      resolveHost({ hash: '#h=http%3A%2F%2Fbuild-01%3A7717&t=abc', stored: STORED }),
    ).toEqual({ origin: 'http://build-01:7717', token: 'abc' });
  });

  it('treats half a link as no link rather than as half a configuration', () => {
    // Both halves or neither. A host with a stored token from elsewhere would
    // fail at the handshake and name a machine the user did not choose.
    expect(resolveHost({ hash: '#h=http%3A%2F%2Fbuild-01%3A7717', stored: STORED })).toBeNull();
    expect(resolveHost({ hash: '#t=abc', stored: STORED })).toBeNull();
  });

  it('falls back to what it remembered, so a second visit is not the first', () => {
    expect(resolveHost({ stored: STORED })).toEqual(STORED);
  });

  it('answers null for a visitor who has configured nothing', () => {
    // Not a failure. It is what somebody arriving at a published page *is*, and
    // the client shows them how to say where their host is rather than guessing.
    expect(resolveHost({})).toBeNull();
  });

  it('drops a trailing slash, because an origin is not a path', () => {
    expect(resolveHost({ served: 'http://h:7717/', hash: '#t=a' })?.origin).toBe('http://h:7717');
  });
});

describe('what it refuses to try', () => {
  it('names the problem rather than letting a socket fail opaquely', () => {
    // A browser reports a typo and a wrong scheme identically, so anything the
    // client can decide before opening a socket is worth deciding.
    expect(describeAddressProblem('http://h:7717', '')).toMatch(/missing its token/);
    expect(describeAddressProblem('not a url', 'tok')).toMatch(/is not an address/);
    expect(describeAddressProblem('ftp://h', 'tok')).toMatch(/http:\/\/ or https:\/\//);
    expect(describeAddressProblem('http://h:7717/sessions', 'tok')).toMatch(/drop the path/);
  });

  it('passes an ordinary address', () => {
    expect(describeAddressProblem('http://127.0.0.1:7717', 'tok')).toBeNull();
    expect(describeAddressProblem('https://build-01.example', 'tok')).toBeNull();
  });
});

describe('the socket it opens', () => {
  it('follows the host’s scheme rather than the page’s', () => {
    /*
     * The page may be on https while the host is a plain-http box on a tailnet,
     * or the reverse. Deriving the scheme from `location` was right when the two
     * were the same origin and is wrong the moment they are not.
     */
    expect(socketUrl({ origin: 'http://127.0.0.1:7717', token: 't' })).toBe(
      'ws://127.0.0.1:7717/__agbrte/socket',
    );
    expect(socketUrl({ origin: 'https://build-01.example', token: 't' })).toBe(
      'wss://build-01.example/__agbrte/socket',
    );
  });
});
