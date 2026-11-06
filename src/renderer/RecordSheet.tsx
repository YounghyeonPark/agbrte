/**
 * A session's record, over its tab (DESIGN.md §17 Q24, step 2).
 *
 * The last thing the palette sent the window to the classic view for. The
 * terminal shows what is happening now; the record is what happened — every
 * event in the log, the agents that held the seat and what each was gated by,
 * what the turns produced, the workspace's files, and for a workflow run the
 * graph of its parts. Reaching it used to swap the whole window for a sidebar
 * and a session pane, and the way back was a palette line called "Back to the
 * terminal". Over the tab, Esc is the way back and the shell underneath never
 * stopped.
 *
 * ## What it is not
 *
 * Not a second place to talk to the agent: there is no composer here. The tab
 * is where a message is typed, and two inputs for one session — one of them
 * hidden behind the other — is how a message ends up sent from the wrong one.
 *
 * It does answer what the terminal cannot. A split an agent proposes (§4.3) has
 * no line in the terminal, so until this sheet the only place to approve one on
 * the desktop was the classic view; and a permission request is shown here as
 * well as on the tab's `allow?` line, because pending requests live in the log
 * (§5) and answering from either is answering the same request.
 *
 * ## Borrowing the store's open session
 *
 * The classic components read *the* open session — `active` and its `events`
 * in the store — and so does this, by opening the session on mount and closing
 * it on unmount, rather than fetching a second copy of the log. A second copy
 * would be a second subscription to keep in step with the first, and the store
 * already applies every event batch to the open session. The classic view is
 * hidden on the desktop, and `App` seats nothing while it is (`seats`), so
 * borrowing its open session changes nothing anybody can see.
 */

import { useEffect, useState, type JSX } from 'react';
import { useAgbrte } from './store.js';
import { Artifacts } from './Artifacts.js';
import { FileBrowser, FileViewer } from './FileBrowser.js';
import { Roster } from './Roster.js';
import { RunGraph } from './RunGraph.js';
import { EventRow, PermissionPrompt, SplitPrompt, Transcript, summarize } from './Transcript.js';
import { agentLabel } from './attribution.js';

export function RecordSheet({
  sessionId,
  instanceId,
  hostLabel,
  onOpen,
}: {
  sessionId: string;
  instanceId: string;
  hostLabel: string;
  /** Another session's record, in place of this one: a child a row names. */
  onOpen: (sessionId: string, instanceId: string) => void;
}): JSX.Element {
  const store = useAgbrte();
  const active = useAgbrte((s) => s.active);
  const events = useAgbrte((s) => s.events);
  const pending = useAgbrte((s) => s.pending);
  const sessions = useAgbrte((s) => s.sessions);
  /** One agent's lines only, or `null` for the whole timeline — the roster's choice. */
  const [agent, setAgent] = useState<string | null>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [viewerWidth, setViewerWidth] = useState(420);

  useEffect(() => {
    setAgent(null);
    setOpenFile(null);
    void useAgbrte.getState().openSession(sessionId, instanceId);
    /*
     * Closed again when the sheet goes, so the next sheet that reads the store's
     * open session — or a phone-width window falling back to the classic view —
     * does not find this one still open under it.
     */
    return () => useAgbrte.getState().closeSession();
  }, [sessionId, instanceId]);

  // Until the open lands the store still holds whatever it held before, and a
  // record drawn from that would be another session's under this one's name.
  if (active === null || active.sessionId !== sessionId) {
    return (
      <p data-testid="record-opening" className="text-muted m-auto p-6 text-xs">
        Reading the session’s log…
      </p>
    );
  }

  const shown = agent === null ? events : events.filter((e) => e.agentId === agent);
  return (
    <div data-testid="record" className="flex min-h-0 flex-1 flex-col">
      <div className="border-line flex shrink-0 flex-wrap items-baseline gap-x-3 gap-y-1 border-b px-4 py-2 text-xs">
        <span className="text-ink font-mono">{active.title}</span>
        <span data-testid="record-state" className="text-muted">
          {active.state.replace(/_/gu, ' ')}
        </span>
        <span className="text-muted">on {hostLabel}</span>
        <span className="text-muted">{events.length} events</span>
        <button
          type="button"
          data-testid="record-files"
          aria-pressed={filesOpen}
          className={`ml-auto ${filesOpen ? 'btn' : 'btn-quiet'} text-xs`}
          onClick={() => setFilesOpen((was) => !was)}
        >
          Files
        </button>
      </div>
      {active.workflow !== undefined && (
        <RunGraph
          run={active}
          sessions={sessions}
          documents={(id) => window.agbrte.workflows.list(id)}
        />
      )}
      <div className="mx-auto w-full max-w-3xl shrink-0 px-6 pt-2">
        <Roster
          agents={active.agents}
          selected={agent}
          onSelect={setAgent}
          onEffort={(agentId, mode) => store.setReasoning(agentId, mode)}
        />
      </div>
      <Artifacts events={events} load={(sha256, mime) => store.loadBlob(sha256, mime)} />
      {/* The same row the classic pane has, for the same reason: the rails
          cost width, never the transcript's height. */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden lg:min-w-44">
          <Transcript
            events={shown}
            renderRow={(e) => (
              <EventRow
                key={e.seq}
                event={e}
                by={agentLabel(active.agents, e.agentId)}
                onOpenChild={(childId, childHost) => onOpen(childId, childHost)}
              />
            )}
            working={active.state === 'working'}
          />
        </div>
        {filesOpen && (
          <FileBrowser
            key={active.instanceId}
            instanceId={active.instanceId}
            selected={openFile}
            onOpenFile={setOpenFile}
            onClose={() => setFilesOpen(false)}
          />
        )}
        {openFile !== null && (
          <FileViewer
            key={`${active.instanceId}:${openFile}`}
            instanceId={active.instanceId}
            path={openFile}
            width={viewerWidth}
            onWidth={setViewerWidth}
            onClose={() => setOpenFile(null)}
          />
        )}
      </div>
      {(pending.length > 0 || active.pendingSplits.length > 0) && (
        <div className="mx-auto flex w-full max-w-3xl shrink-0 flex-col gap-2 px-6 pb-4">
          {pending.map((p) => (
            <PermissionPrompt
              key={p.requestId}
              tool={p.tool}
              args={summarize(p.args)}
              onDecide={(allow) => void store.respond(p.requestId, allow)}
            />
          ))}
          {active.pendingSplits.map((p) => (
            <SplitPrompt
              key={p.proposalId}
              proposal={p}
              budgeted={active.budget !== undefined}
              onDecide={(approved) => void store.respondSplit(p.proposalId, approved)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
