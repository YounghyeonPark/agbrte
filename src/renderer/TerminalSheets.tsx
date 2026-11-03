/**
 * What the terminal opens over its tabs when the palette asks for a form
 * (DESIGN.md §17 Q24, step 2: retiring the classic view).
 *
 * Settings, the workflows, attaching a machine, opening a folder, setting up an
 * agent and searching the fleet were reached by switching the whole window to
 * the classic view — the sidebar, the dashboard, a session view — for a form
 * that has nothing to do with any of those. The person left the terminal to
 * change a setting and came back through the palette. A *sheet* is the form
 * alone, over the tabs, the way a terminal's settings open over its tabs; Esc
 * or × puts the terminal back exactly as it was, because nothing under it was
 * unmounted.
 *
 * The forms themselves are the classic view's components unchanged. They were
 * written as panels with their own state and callbacks, and the one place they
 * reached into `App` — the workflow documents and their schedules, which `App`
 * fetched when its pane opened — is `WorkflowsSheet` below, doing the same.
 */

import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import { Workflows, type WorkspaceWorkflows } from './Workflows.js';
import { useAgbrte } from './store.js';
import type { HostInfo } from '@shared/ipc/contract.js';
import type { Session, WorkflowSchedule } from '@shared/types/index.js';

export function Sheet({
  name,
  title,
  onClose,
  children,
}: {
  /** For the end-to-end suite: which form this is. */
  name: string;
  title: string;
  onClose: () => void;
  children: ReactNode;
}): JSX.Element {
  const frame = useRef<HTMLDivElement>(null);
  /*
   * Focus moves into the sheet, or the keys typed next go to the terminal under
   * it — which still has focus, being hidden by nothing but this layer — and a
   * person filling in a form would be typing into their shell.
   */
  useEffect(() => frame.current?.focus(), []);
  return (
    <div
      ref={frame}
      tabIndex={-1}
      data-testid="sheet"
      data-sheet={name}
      role="dialog"
      aria-label={title}
      className="bg-bg text-ink absolute inset-0 z-20 flex flex-col outline-none"
      onKeyDown={(e) => {
        // A form that used Esc for itself (a field's own menu) has said so.
        if (e.key === 'Escape' && !e.defaultPrevented) {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div className="border-line flex shrink-0 items-center justify-between border-b px-4 py-1 text-xs">
        <span className="font-mono">{title}</span>
        <button
          type="button"
          data-testid="sheet-close"
          aria-label={`Close ${title}`}
          title="Back to the terminal (Esc)"
          className="btn-quiet font-mono"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>
    </div>
  );
}

/**
 * The workflows pane, with what `App` used to fetch for it.
 *
 * Asked on open and not kept: a document is a file somebody edits by hand, and
 * a sheet left from an hour ago must not show what the file said then. One call
 * per host at once, a refusal read as `null`, and the schedules beside the
 * documents rather than with them — the reasons are `App`'s, at the same lines.
 */
export function WorkflowsSheet({
  hosts,
  sessions,
  onClose,
  onOpenRun,
}: {
  hosts: HostInfo[];
  sessions: readonly Session[];
  onClose: () => void;
  onOpenRun: (sessionId: string, instanceId: string) => void;
}): JSX.Element {
  const [workflows, setWorkflows] = useState<WorkspaceWorkflows[]>([]);
  const [schedules, setSchedules] = useState<Record<string, WorkflowSchedule[]>>({});
  const listAll = (): Promise<WorkspaceWorkflows[]> =>
    Promise.all(
      hosts.map(async (host) => ({
        host,
        found: await window.agbrte.workflows.list(host.instanceId).catch(() => null),
      })),
    );
  useEffect(() => {
    let live = true;
    void listAll().then((all) => {
      if (live) setWorkflows(all);
    });
    void Promise.all(
      hosts.map(
        async (host) =>
          [
            host.instanceId,
            await window.agbrte.workflows.schedules(host.instanceId).catch(() => []),
          ] as const,
      ),
    ).then((all) => {
      if (live) setSchedules(Object.fromEntries(all));
    });
    return () => {
      live = false;
    };
  }, [hosts]);
  return (
    <Workflows
      workspaces={workflows}
      sessions={sessions}
      onClose={onClose}
      onOpenRun={onOpenRun}
      schedules={schedules}
      onRun={(instanceId, workflowId, ceiling) =>
        useAgbrte.getState().runWorkflow(instanceId, workflowId, ceiling)
      }
      onSchedule={async (instanceId, wanted) => {
        // The host's answer, not the draft: it read the file back.
        const stored = await window.agbrte.workflows.setSchedules(instanceId, wanted);
        setSchedules((was) => ({ ...was, [instanceId]: stored }));
      }}
      onSave={async (instanceId, workflowId, workflow) => {
        const saved = await window.agbrte.workflows.save(instanceId, workflowId, workflow);
        // Re-read rather than patched: what is on disk is the host's answer.
        if (saved.problems.length === 0) setWorkflows(await listAll());
        return saved.problems;
      }}
    />
  );
}
