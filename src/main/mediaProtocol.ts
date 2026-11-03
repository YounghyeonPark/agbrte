/**
 * `agbrte-media:` — the URL a streamed player in the terminal plays from
 * (DESIGN.md §17 Q24, step 5).
 *
 * A `<video>` seeks by asking its source for byte ranges, and the bytes are on
 * a host — this machine's or one across ssh — reachable only through the
 * session socket. So this is a scheme the window's media elements can fetch
 * from, answered here in main with HTTP's own range semantics over
 * `shell.media` reads: `agbrte-media://pane/<shellId>/<token>`.
 *
 * Nothing in the URL is a path. The token is the host's (`mediaOffers.ts`), and
 * the host answers it only for the pane that gave it out, and only to this
 * client, which owns that pane; a guessed or copied URL from another pane
 * reads nothing.
 *
 * The answer is the range asked for, read from the host a megabyte at a time
 * as the player takes it (`mediaRanges.ts`, which says why not one megabyte
 * and done).
 */

import { protocol } from 'electron';
import { answer, type Read } from './mediaRanges.js';

export const MEDIA_SCHEME = 'agbrte-media';

/**
 * Before `ready`, as Electron requires. `stream` is what lets a media element
 * read a custom scheme in pieces rather than buffering the response whole;
 * `standard` and `secure` give the URL an origin the page's CSP can name.
 */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
  ]);
}

/** After `ready`: answer the scheme from `read`. */
export function handleMediaScheme(read: Read): void {
  protocol.handle(MEDIA_SCHEME, (request) => answer(request, read));
}
