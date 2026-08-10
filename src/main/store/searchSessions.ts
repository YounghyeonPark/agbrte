/**
 * Finding the session where you did that thing (DESIGN.md §15 Phase 8).
 *
 * The question this answers is "which session was that in", asked across every
 * machine you have attached. Sessions accumulate faster than names distinguish
 * them, and the log holds the only durable record of what was actually said.
 *
 * ## Scanning, not indexing, and why that is not a shortcut
 *
 * §14 chose `better-sqlite3` + FTS5 and §8 gives the indexer its own process.
 * Neither exists, and building them to answer a question that a scan answers in
 * milliseconds would be inventing a subsystem before the problem. A workspace
 * with two hundred sessions is a few megabytes of JSONL; reading it is faster
 * than the ssh round trip that carries the query.
 *
 * What an index buys is the *thousandth* session and substring queries that
 * cannot be answered by looking. Recorded in §14 rather than pre-built — and
 * with a correction, because `better-sqlite3` is a native module and this
 * project ships plain JS to a downloaded Node. `node:sqlite` is in the Node the
 * installer already pins, needs no build step, and is the answer that fits the
 * constraints the rest of the document keeps choosing.
 *
 * ## It runs where the logs are
 *
 * §6 says a search on a remote target "runs as one `find`-equivalent on the host
 * rather than N round trips", and this is that: the host scans its own logs and
 * returns hits. Shipping the logs to the app to grep them would move megabytes
 * over ssh to answer a question about kilobytes.
 *
 * ## Substring, not regex
 *
 * A person typing `parse.ts` into a search box means those characters. Regex
 * would make `.` match anything and turn an ordinary filename into a query that
 * matches too much, silently — the surprise lands on the result count, which is
 * the one place nobody checks their assumptions.
 */

import { readdir, readFile } from 'node:fs/promises';
import { sessionLayout, workspaceLayout } from './layout.js';
import type { AgbrteEvent, SessionId } from '@shared/types/index.js';

/** Characters either side of a match, so a hit reads as a sentence. */
const CONTEXT = 60;

export interface SearchHit {
  sessionId: string;
  /** From `session.json`, so a hit is identifiable before anything is opened. */
  title: string;
  seq: number;
  at: string;
  /** Which kind of event matched — a tool call and a sentence read differently. */
  kind: AgbrteEvent['type'];
  /** The matched text with a little either side, never the whole event. */
  snippet: string;
}

export interface SearchOptions {
  /** Stop after this many. A search box wants the first page, not everything. */
  limit?: number;
}

/**
 * Search every session in one workspace.
 *
 * Newest session first, because the thing you are looking for is usually recent
 * and a capped result set should spend its budget there.
 */
export async function searchWorkspace(
  workspaceRoot: string,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchHit[]> {
  const needle = query.trim().toLowerCase();
  // An empty query matches everything, which is not a search — and returning
  // every session would look like a feature rather than a mistake.
  if (needle === '') return [];

  const limit = opts.limit ?? 50;
  const { sessionsDir } = workspaceLayout(workspaceRoot);

  let ids: string[];
  try {
    ids = await readdir(sessionsDir);
  } catch {
    // No sessions here yet. An ordinary state, not an error.
    return [];
  }

  const hits: SearchHit[] = [];
  // Descending by id, which for uuidv7 is descending by time (§5.4) — no stat
  // call per directory to sort by mtime, and no dependency on a clock we did
  // not write.
  for (const id of [...ids].sort().reverse()) {
    if (hits.length >= limit) break;
    hits.push(...(await searchSession(workspaceRoot, id, needle, limit - hits.length)));
  }
  return hits;
}

async function searchSession(
  workspaceRoot: string,
  sessionId: string,
  needle: string,
  budget: number,
): Promise<SearchHit[]> {
  const layout = sessionLayout(workspaceRoot, sessionId as SessionId);

  let title = sessionId;
  try {
    const meta = JSON.parse(await readFile(layout.sessionFile, 'utf8')) as { title?: string };
    title = meta.title ?? sessionId;
  } catch {
    // A session directory without a readable record still has a log worth
    // searching; the id is a worse title than a name but a better one than none.
  }

  let raw: string;
  try {
    raw = await readFile(layout.eventLog, 'utf8');
  } catch {
    return [];
  }

  const hits: SearchHit[] = [];
  for (const line of raw.split('\n')) {
    if (hits.length >= budget) break;
    if (line === '') continue;
    // Cheap reject before parsing. Most lines in most sessions do not match, and
    // `JSON.parse` on every one of them is the whole cost of this function.
    if (!line.toLowerCase().includes(needle)) continue;

    let event: AgbrteEvent;
    try {
      event = JSON.parse(line) as AgbrteEvent;
    } catch {
      // A torn final line, which an append-only log can have after a crash
      // (§5.4). Skipped rather than fatal: one bad line must not make a session
      // unsearchable.
      continue;
    }

    const text = searchableText(event);
    const at = text.toLowerCase().indexOf(needle);
    if (at === -1) {
      // The needle was in the JSON but not in anything a person wrote — an id,
      // a hash, a field name. Not a hit worth showing.
      continue;
    }

    hits.push({
      sessionId,
      title,
      seq: event.seq,
      at: event.at,
      kind: event.type,
      snippet: snippetAround(text, at, needle.length),
    });
  }
  return hits;
}

/**
 * The part of an event a person would recognise.
 *
 * Deliberately not `JSON.stringify(event)`: that matches ids, hashes and field
 * names, so searching for `image` would hit every event carrying an
 * `imageMaxCount` capability. What is searchable is what somebody said, ran, or
 * was told.
 */
export function searchableText(event: AgbrteEvent): string {
  switch (event.type) {
    case 'user.turn':
      return event.content.map((b) => (b.type === 'text' ? b.text : '')).join(' ');
    case 'agent.text':
      return event.text;
    case 'agent.tool_use':
      return `${event.tool} ${typeof event.args === 'string' ? event.args : JSON.stringify(event.args)}`;
    case 'agent.tool_result':
      return event.summary;
    case 'agent.message':
      return event.message.content.map((b) => (b.type === 'text' ? b.text : '')).join(' ');
    case 'permission.requested':
      return `${event.tool} ${JSON.stringify(event.args)}`;
    case 'content.downgraded':
      return event.note.detail;
    case 'session.created':
      return `${event.title} ${event.goal}`;
    default:
      return '';
  }
}

function snippetAround(text: string, at: number, length: number): string {
  const start = Math.max(0, at - CONTEXT);
  const end = Math.min(text.length, at + length + CONTEXT);
  // Collapsed, because a matched line of code with its indentation intact
  // renders as a mostly-empty row in a list of results.
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
}
