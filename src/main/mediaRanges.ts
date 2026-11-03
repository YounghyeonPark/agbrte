/**
 * The HTTP half of `agbrte-media:` (`mediaProtocol.ts`): a range request
 * answered from `shell.media` reads. Apart from the scheme so it can be tested
 * without Electron.
 *
 * ## The whole range, read as it is taken
 *
 * The first version answered every request with one read — a `206` of a
 * megabyte, whatever was asked — on the theory that a player takes a short
 * answer and asks again. It does not when it asked without a `Range`: the
 * first request had none, got a megabyte, and the player took that for the
 * whole file — forty minutes of sound played as sixty-six seconds, which is a
 * megabyte of it.
 *
 * So the answer is what was asked — the range, or the whole file — with its
 * true length, and a body that reads one megabyte from the host each time the
 * player takes the last. A player that has enough stops taking, and one that
 * seeks cancels the body and asks for a range from the new place; either way
 * the host reads what is played and not the forty megabytes before it.
 */

import { MAX_READ } from './terminal/mediaOffers.js';

export type Read = (
  shellId: string,
  token: string,
  offset: number,
  length: number,
) => Promise<{ size: number; mime: string; data: Buffer } | null>;

/** The response to one request. */
export async function answer(request: Request, read: Read): Promise<Response> {
  const url = new URL(request.url);
  const [shellId, token] = url.pathname
    .split('/')
    .filter((p) => p !== '')
    .map((p) => decodeURIComponent(p));
  if (url.hostname !== 'pane' || shellId === undefined || token === undefined) {
    return new Response(null, { status: 404 });
  }
  const range = parseRange(request.headers.get('range'));
  if (range === 'unsatisfiable') return new Response(null, { status: 416 });
  const start = range?.start ?? 0;
  let first: Awaited<ReturnType<Read>>;
  try {
    // The first piece now: it says whether the token is good and how big the file is.
    first = await read(shellId, token, start, range?.end !== undefined ? range.end - start + 1 : MAX_READ);
  } catch {
    return new Response(null, { status: 502 });
  }
  // Gone: the pane closed, the shell exited, or the token was never this pane's.
  if (first === null) return new Response(null, { status: 404 });
  const size = first.size;
  if (start >= size && size > 0) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  const end = Math.max(start, Math.min(range?.end ?? size - 1, size - 1));
  const total = size === 0 ? 0 : end - start + 1;
  let at = start + first.data.length;
  const opening = new Uint8Array(first.data);
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        if (opening.length > 0) controller.enqueue(opening);
        if (at > end || opening.length === 0) controller.close();
      },
      async pull(controller) {
        try {
          const got = await read(shellId, token, at, Math.min(MAX_READ, end - at + 1));
          if (got === null || got.data.length === 0) {
            controller.close();
            return;
          }
          controller.enqueue(new Uint8Array(got.data));
          at += got.data.length;
          if (at > end) controller.close();
        } catch (err) {
          controller.error(err);
        }
      },
    },
    // One piece ahead and no more: what is not taken is not read.
    { highWaterMark: 1 },
  );
  return new Response(body, {
    status: range === null ? 200 : 206,
    headers: {
      'Content-Type': first.mime,
      'Content-Length': String(total),
      ...(range === null ? {} : { 'Content-Range': `bytes ${start}-${end}/${size}` }),
      'Accept-Ranges': 'bytes',
      // The same bytes for the same token for the life of the pane, but the
      // pane is a session's: nothing worth keeping past it.
      'Cache-Control': 'no-store',
    },
  });
}

/** `bytes=a-b` or `bytes=a-`; a suffix range or several ranges are not asked for by a player. */
export function parseRange(header: string | null): { start: number; end?: number } | null | 'unsatisfiable' {
  if (header === null) return null;
  const m = /^bytes=(\d+)-(\d*)$/u.exec(header.trim());
  if (m === null) return 'unsatisfiable';
  const start = Number(m[1]);
  if (m[2] === '') return { start };
  const end = Number(m[2]);
  return end < start ? 'unsatisfiable' : { start, end };
}
