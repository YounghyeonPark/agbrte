/**
 * Which host this page talks to, and where that answer comes from (§7, §6.2).
 *
 * The browser client used to have exactly one answer: whoever served the page.
 * `new URL('/__agbrte/socket', location.href)` is correct — and only correct —
 * when the page came from a host, which was every case until the app could be
 * served from somewhere that is not one.
 *
 * A page on static hosting has no host of its own. It is a client looking for
 * one, and the one it wants may be a laptop, a build box on a tailnet, or a
 * server with a name. So the address becomes something the page is *told*,
 * from three places in a fixed order.
 *
 * ## The order, and why it is that way
 *
 *  1. **The page's own server**, when it had one. `agbrte web` stamps its origin
 *     onto the script tag it injects, so a page served by a host connects to
 *     that host and nothing else can talk it out of it. This is the case that
 *     must not change behaviour, and a stamped page never consults the other
 *     two.
 *  2. **The link**, which is how a host hands itself out: `#h=<origin>&t=<token>`
 *     is one string to paste into a phone. It wins over storage because it is
 *     what the person just did.
 *  3. **What was stored**, so the second visit is not the first visit again.
 *
 * ## The token is not optional and not remembered separately
 *
 * A host and a token are one fact. Storing them apart invites the state where a
 * new host is configured and an old token is still sitting beside it — which
 * fails at the handshake with a message about credentials for a machine the user
 * has already moved on from. They are written and read as a pair.
 */

/** Where the page should connect, and with what. */
export interface HostAddress {
  /** Origin, no trailing slash: `http://127.0.0.1:7717`. */
  origin: string;
  token: string;
}

/** Everything the resolution can read, so it can be resolved without a browser. */
export interface AddressSources {
  /** The origin `agbrte web` stamped on the script tag, when it served this page. */
  served?: string | undefined;
  /** `location.hash`, which may carry `#h=` and `#t=`. */
  hash?: string | undefined;
  /** What a previous visit stored, already parsed. */
  stored?: HostAddress | undefined;
}

/** One `#a=b&c=d` value, decoded, or undefined. */
function fromHash(hash: string, key: string): string | undefined {
  const found = new RegExp(`[#&]${key}=([^&]+)`).exec(hash)?.[1];
  return found === undefined ? undefined : decodeURIComponent(found);
}

/** Trailing slash removed, because it is an origin and not a path. */
function normalise(origin: string): string {
  return origin.replace(/\/+$/, '');
}

/**
 * Resolve the address, or `null` when this page does not know one yet.
 *
 * `null` is a first-class answer rather than a failure: it is what a visitor
 * arriving at a published page with nothing configured *is*, and the client
 * shows them a way to say where their host is rather than guessing at one and
 * failing at a socket.
 */
export function resolveHost(sources: AddressSources): HostAddress | null {
  const token = sources.hash === undefined ? undefined : fromHash(sources.hash, 't');

  /*
   * Served by a host: that host, and the token from the link it printed — or one
   * this same origin stored on an earlier visit, which is what makes a reload
   * work without going back to the terminal.
   *
   * The origin is compared rather than assumed. A remembered token belongs to
   * the host that minted it, and handing it to a *different* one would send a
   * secret to a machine it was never meant for — which is not merely useless.
   * The comparison is what separates "the same page again" from "some other
   * host's credential is lying around".
   */
  if (sources.served !== undefined && sources.served !== '') {
    const origin = normalise(sources.served);
    if (token !== undefined) return { origin, token };
    const remembered = sources.stored;
    if (remembered !== undefined && normalise(remembered.origin) === origin && remembered.token !== '') {
      return { origin, token: remembered.token };
    }
    return null;
  }

  const linked = sources.hash === undefined ? undefined : fromHash(sources.hash, 'h');
  if (linked !== undefined && token !== undefined) {
    return { origin: normalise(linked), token };
  }

  // A half-filled link is not a configuration. Falling back to storage here
  // would answer a deliberate act — somebody pasted a link — with a stale
  // address, and the failure would name a host they did not choose.
  if (linked !== undefined || token !== undefined) return null;

  return sources.stored ?? null;
}

/**
 * Whether an address is one this client can be pointed at.
 *
 * Refused rather than attempted, because the failure is otherwise a socket
 * error that says nothing: `wss://` to a host that speaks `ws://` and a typo are
 * the same opaque event to a browser, and the person typing has enough to go on
 * only if the client says which of the two it thinks happened.
 */
export function describeAddressProblem(origin: string, token: string): string | null {
  if (token.trim() === '') return 'the link is missing its token — copy the whole line the host printed';
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return `${origin} is not an address — it should look like http://127.0.0.1:7717`;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `${parsed.protocol} is not something a browser can connect to here — use http:// or https://`;
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    return `drop the path: ${parsed.origin} is the part this needs`;
  }
  return null;
}

/** The socket URL for an address, with the scheme the page's own demands. */
export function socketUrl(address: HostAddress): string {
  const url = new URL('/__agbrte/socket', `${address.origin}/`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}
