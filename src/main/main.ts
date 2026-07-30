/**
 * Electron main process (DESIGN.md §7, §8).
 *
 * Owns the app lifecycle, one window, and the `SessionManager` that everything
 * else is a client of.
 *
 * Agent loops run in a separate `utilityProcess` per §8 — main holds session
 * state, the log, and the permission gate, and never runs an adapter. The
 * registry it hands `SessionManager` contains façades over the host's control
 * protocol, which is why the manager needs no knowledge that a process boundary
 * exists at all.
 */

import { app, BrowserWindow, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SessionManager } from './sessionManager.js';
import { RuntimeRegistry } from './runtime/registry.js';
import { openWorkspace } from './store/identity.js';
import { registerIpc } from './ipc/register.js';
import { HostSupervisor } from './host/supervisor.js';
import { spawnAgentHost } from './host/utilityHost.js';
import type { RuntimeInfo, WorkspaceInfo } from '@shared/ipc/contract.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Vite's dev server, when `npm run dev` started one. */
const DEV_URL = process.env['LOOM_DEV_SERVER'];

/**
 * Windows taskbar grouping and notification identity (§11). Without it,
 * notifications are attributed to `electron.exe` and every dev build shares one
 * taskbar slot.
 */
if (process.platform === 'win32') app.setAppUserModelId('dev.loom.app');

let manager: SessionManager | null = null;
let ipc: { dispose: () => void } | null = null;
let supervisor: HostSupervisor | null = null;

/**
 * What the agent host offers, mirrored here because main advertises it to the
 * renderer before any host has been spawned.
 *
 * The host's `ready` handshake reports the ids it actually registered, and
 * `loadWorkspace` reconciles the two: anything listed here but absent there is
 * dropped rather than offered and then failing at `addAgent`.
 */
const HOST_RUNTIMES = [
  {
    id: 'loom-harness',
    label: 'Loom harness (local model)',
    version: '0.0.1',
    requiresModel: true,
  },
  { id: 'echo', label: 'Echo (no model)', version: '0.0.1', requiresModel: false },
];

let advertised: RuntimeInfo[] = [];

async function loadWorkspace(root: string): Promise<WorkspaceInfo> {
  const identity = await openWorkspace(root);

  // One host per workspace (§8). Replacing it on a workspace change matters:
  // tools resolve paths against the host's own workspace root.
  supervisor?.dispose();
  supervisor = new HostSupervisor({
    spawn: () => spawnAgentHost({ entry: join(HERE, 'agentHost.js'), workspaceRoot: root }),
    runtimes: HOST_RUNTIMES,
    onRestart: (attempt, reason) => {
      // Logged rather than surfaced: an open turn already failed with a
      // `transport` stop, which retries and rehydrates (§8).
      process.stderr.write(`agent host restarted (attempt ${attempt}): ${reason ?? 'unknown'}\n`);
    },
  });

  const registry = new RuntimeRegistry();
  for (const entry of supervisor.runtimes()) {
    registry.register(entry.runtime, { label: entry.label, requiresModel: entry.requiresModel });
  }

  manager = new SessionManager({
    registry,
    workspaceRoot: root,
    instanceId: identity.instanceId,
  });

  // Reconcile against what the host really has. A failure here means the host
  // could not start at all, which must not stop the window from opening — the
  // UI shows no runtimes and the transcript of any existing session still loads.
  try {
    const ids = new Set(await supervisor.advertised());
    advertised = HOST_RUNTIMES.filter((r) => ids.has(r.id)).map((r) => ({
      id: r.id,
      version: r.version,
      requiresModel: r.requiresModel,
    }));
  } catch (err) {
    advertised = [];
    process.stderr.write(`agent host unavailable: ${String(err)}\n`);
  }

  return { root, lineageId: identity.lineageId, instanceId: identity.instanceId };
}

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: '#16161a',
    title: 'Loom',
    webPreferences: {
      // §7. All three, and none of them are negotiable: the renderer displays
      // model output, which is untrusted content reaching a privileged process.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(HERE, 'preload.cjs'),
    },
  });

  // A link in model output must not be able to replace the app's own window or
  // open an arbitrary Electron window with our preload attached.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:$/.test(new URL(url).protocol)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const target = new URL(url);
    const isDev = DEV_URL !== undefined && url.startsWith(DEV_URL);
    if (!isDev && target.protocol !== 'file:') event.preventDefault();
  });

  win.once('ready-to-show', () => win.show());

  if (DEV_URL !== undefined) {
    await win.loadURL(DEV_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    await win.loadFile(join(HERE, '../renderer/index.html'));
  }
}

/**
 * Point the IPC layer at the current manager.
 *
 * Re-registered wholesale on a workspace change rather than mutated, because a
 * new workspace means a new manager, a new host, and a new instance identity
 * (§5.2) — the push-channel subscriptions are bound to the manager they were
 * created for, and leaving them attached would forward the old workspace's
 * events into a window now showing a different one.
 */
async function wireIpc(workspace: WorkspaceInfo): Promise<void> {
  ipc?.dispose();
  ipc = registerIpc({
    manager: manager!,
    workspace,
    runtimes: () => advertised,
    onChooseWorkspace: async (root) => {
      const next = await loadWorkspace(root);
      await wireIpc(next);
      return next;
    },
  });
}

app.whenReady().then(async () => {
  // `LOOM_WORKSPACE_ROOT` lets a test — or a developer — start against a known
  // folder instead of the profile directory. The default is `userData` rather
  // than cwd so a fresh install has somewhere valid to put `.devagents/` before
  // anyone has chosen a real workspace.
  const root = process.env['LOOM_WORKSPACE_ROOT'] ?? app.getPath('userData');

  await wireIpc(await loadWorkspace(root));
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

// Closing the window ends the app on Windows and Linux. This is temporary and
// wrong for Loom's purpose: §8's parking model exists so long runs continue
// while you are not watching, which needs a tray presence to return to. Until
// that exists, quitting on close is at least honest about what is running.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  ipc?.dispose();
  // Kill the host explicitly. A utilityProcess is not guaranteed to die with its
  // parent, and an orphaned host holding a model connection is invisible.
  supervisor?.dispose();
});
