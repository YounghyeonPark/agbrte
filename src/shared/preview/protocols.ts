/**
 * What is probably listening on a port, for the one decision it changes
 * (DESIGN.md §6.8, §12.1, §3.5).
 *
 * A forward is a **generic TCP tunnel** — `ssh -L`, no protocol anywhere in it —
 * and the session view has always presented one as a browser link, because §6.8
 * was written about dev servers and every port anybody forwarded was one.
 *
 * That made the forward do less than it could. Tunnelling `3389` brings a
 * Windows machine's *desktop* to a local port, which is the answer to "I want to
 * see the screen of the PC this remote session is running on" — and a better
 * answer than anything this app could render, because RDP and VNC clients do
 * hardware-accelerated video, input and the clipboard already. What stood in the
 * way was not the tunnel. It was a link to `http://127.0.0.1:54321`, which a
 * browser cannot speak RDP to: a control that fails on press (§3.5), in front of
 * an address that would have worked if it had been offered as text.
 *
 * So this answers one question — *may a browser be pointed at this?* — and it
 * answers it by naming the ports that are definitely something else. Guessing
 * the other way round is not available: a dev server can listen anywhere, so
 * "not on this list" has to mean "a browser is worth offering", and the cost of
 * being wrong there is a tab that does not load rather than a missing route.
 */

/** What a port is known to carry, where it is known at all. */
export interface KnownProtocol {
  /** Shown beside the port, so a number a person did not choose explains itself. */
  label: string;
  /**
   * Whether a browser is the wrong tool for it.
   *
   * The only consumer is whether to render a link, which is why this is a
   * boolean about *us* rather than a protocol family: `3389` and `5900` differ in
   * every way except the one that matters here.
   */
  browser: boolean;
}

/**
 * Ports this app will name, and the two it will not offer a browser for.
 *
 * Deliberately short. A long table is a long list of things to be wrong about,
 * and the value is concentrated in the desktop ones — those are the case the
 * link was actively wrong for, and the case somebody has to be told is possible
 * at all.
 */
const KNOWN: ReadonlyMap<number, KnownProtocol> = new Map([
  [3389, { label: 'remote desktop (RDP)', browser: false }],
  [5900, { label: 'remote desktop (VNC)', browser: false }],
  [5901, { label: 'remote desktop (VNC)', browser: false }],
  [22, { label: 'ssh', browser: false }],
  [5432, { label: 'postgres', browser: false }],
  [3306, { label: 'mysql', browser: false }],
  [6379, { label: 'redis', browser: false }],
  // Named rather than left blank because the label is the hint: somebody
  // reading `:11434 · ollama` knows what the tunnel is for.
  [11434, { label: 'ollama', browser: true }],
  [8080, { label: 'http', browser: true }],
]);

/** What is on this port, or `null` where this app has no opinion. */
export function protocolOn(port: number): KnownProtocol | null {
  return KNOWN.get(port) ?? null;
}

/**
 * Whether to offer a browser link for a forwarded port.
 *
 * Unknown means yes, and that asymmetry is the design: a dev server listens
 * wherever it was told to, so refusing a link unless the port is recognised
 * would break the case §6.8 exists for. Being wrong the other way costs a tab
 * that does not load.
 */
export function browserCanOpen(port: number): boolean {
  return protocolOn(port)?.browser ?? true;
}
