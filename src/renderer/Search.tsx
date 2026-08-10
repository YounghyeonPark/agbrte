/**
 * Finding the session where you did that thing (DESIGN.md §15 Phase 8).
 *
 * The backend for this landed a commit before the surface did, which is exactly
 * the shape §15 was rewritten over: pieces that pass their own tests and nothing
 * a person touches reaching them. So this is the half that makes it a feature.
 *
 * ## It searches on submit, not on keystroke
 *
 * A search-as-you-type box over a fleet sends a query to every attached machine
 * on every character — including one over ssh — so typing eight letters is eight
 * fan-outs, seven of them for prefixes nobody wanted. Debouncing hides that
 * rather than fixing it. Enter is also what a person already does.
 *
 * ## An unasked host is not an empty result
 *
 * §6 says an unreachable workspace stays "visible and searchable but not
 * resumable", and the fleet names the machines it could not reach. Showing "no
 * results" while a laptop was asleep would answer a question that was never
 * asked, so the ones that did not answer are named above the list.
 */

import { useState, type JSX } from 'react';
import type { SearchHitDto, SearchResults } from '../shared/ipc/contract.js';

/** What kind of thing matched, in words rather than an event name. */
const SAYS: Readonly<Record<string, string>> = {
  'user.turn': 'you said',
  'agent.text': 'agent said',
  'agent.tool_use': 'ran',
  'agent.tool_result': 'result',
  'agent.message': 'message',
  'permission.requested': 'asked to run',
  'content.downgraded': 'downgraded',
  'session.created': 'session',
};

export function Search({
  onOpen,
}: {
  onOpen: (sessionId: string, instanceId: string) => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResults | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (): Promise<void> => {
    if (query.trim() === '') {
      // Not a search. Clearing rather than querying, because an empty query
      // matching everything would look like a feature.
      setResults(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setResults(await window.agbrte.sessions.search(query));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <input
          className="field text-xs"
          data-testid="search-input"
          placeholder="Search every attached machine"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="btn-quiet text-xs" type="submit" disabled={busy}>
          {busy ? 'Searching…' : 'Search'}
        </button>
      </form>

      {error !== null && <p className="text-state-failed text-xs">{error}</p>}

      {results !== null && (
        <>
          {/* Named, not counted: "3 of 4 answered" cannot tell you which machine
              to go and wake. */}
          {results.unreachable.length > 0 && (
            <p className="text-muted text-[11px]" data-testid="search-unreachable">
              Could not reach {results.unreachable.join(', ')} — these results are
              from the machines that answered.
            </p>
          )}

          {results.hits.length === 0 ? (
            <p className="text-muted text-xs" data-testid="search-empty">
              Nothing matched
              {results.unreachable.length > 0 ? ' on the machines that answered' : ''}.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {results.hits.map((hit) => (
                <Hit key={`${hit.instanceId}:${hit.sessionId}:${hit.seq}`} hit={hit} onOpen={onOpen} />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function Hit({
  hit,
  onOpen,
}: {
  hit: SearchHitDto;
  onOpen: (sessionId: string, instanceId: string) => void;
}): JSX.Element {
  return (
    <li>
      <button
        type="button"
        data-testid="search-hit"
        className="border-line hover:border-accent w-full rounded border px-2 py-1.5 text-left"
        onClick={() => onOpen(hit.sessionId, hit.instanceId)}
      >
        <span className="flex items-baseline gap-2 text-[11px]">
          <span className="truncate font-medium">{hit.title}</span>
          {/* Which machine, always. A hit you cannot locate is a hit you cannot
              act on, and that is the whole of "cross-machine". */}
          <span className="text-muted shrink-0">{hit.host}</span>
          <span className="text-muted shrink-0">{SAYS[hit.kind] ?? hit.kind}</span>
        </span>
        <span className="text-muted truncate-line mt-0.5 block text-[11px]">{hit.snippet}</span>
      </button>
    </li>
  );
}
