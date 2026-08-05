/**
 * Electron main process (DESIGN.md §7, §8).
 *
 * Owns the app lifecycle, one window, and the `Fleet` that everything else is a
 * client of.
 *
 * Agent loops run in separate `utilityProcess`es per §8 — main holds session
 * state, the logs, and the permission gate, and never runs an adapter. The
 * registry each `SessionManager` receives contains façades over its host's
 * control protocol, which is why no manager needs to know a process boundary
 * exists at all.
 *
 * Several hosts stay attached at once. §8's concurrency caps are per host and
 * §10's cards carry a target badge, so watching more than one place is the
 * designed behaviour; the single-workspace shape this replaced was a limitation.
 */

import { app, BrowserWindow, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { delimiter, dirname, join } from 'node:path';
import { registerIpc } from './ipc/register.js';
import { Fleet, type FleetRuntime } from './fleet.js';
import { spawnAgentHost } from './host/utilityHost.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Vite's dev server, when `npm run dev` started one. */
const DEV_URL = process.env['LOOM_DEV_SERVER'];

/**
 * Windows taskbar grouping and notification identity (§11). Without it,
 * notifications are attributed to `electron.exe` and every dev build shares one
 * taskbar slot.
 */
if (process.platform === 'win32') app.setAppUserModelId('dev.loom.app');

let fleet: Fleet | null = null;
let ipc: { dispose: () => void } | null = null;

/**
 * What an agent host is expected to offer, mirrored here because the renderer
 * asks before any host has finished starting.
 *
 * Each host's `ready` handshake reports the ids it actually registered, and
 * `Fleet.attach` reconciles the two per host: anything listed here but absent
 * there is dropped rather than offered and then failing at `addAgent`. Hosts
 * need not agree — a machine without a model server offers fewer.
 */
const HOST_RUNTIMES: FleetRuntime[] = [
  {
    id: 'loom-harness',
    label: 'Loom harness (local model)',
    version: '0.0.1',
    requiresModel: true,
  },
  { id: 'echo', label: 'Echo (no model)', version: '0.0.1', requiresModel: false },
];

/**
 * One fleet for the app's lifetime, holding as many hosts as are attached (§8).
 *
 * Previously main held a single manager and disposed the previous agent host on
 * every workspace change, so the app could watch exactly one place. The caps in
 * §8 are per host and §10's cards carry a target badge — the aggregate view is
 * the designed one, and the single-workspace shape was the limitation.
 */
function buildFleet(): Fleet {
  return new Fleet({
    runtimes: HOST_RUNTIMES,
    spawn: ({ workspaceRoot }) =>
      spawnAgentHost({ entry: join(HERE, 'agentHost.js'), workspaceRoot }),
  });
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

app.whenReady().then(async () => {
  fleet = buildFleet();

  // `LOOM_WORKSPACE_ROOT` lets a test — or a developer — start attached to a
  // known folder. Several may be given, separated by the platform's path
  // delimiter, which is how the e2e suite attaches two hosts at once.
  const configured = process.env['LOOM_WORKSPACE_ROOT'];
  const roots =
    configured === undefined || configured === ''
      ? [app.getPath('userData')]
      : configured.split(delimiter).filter((r) => r !== '');

  // Registered before attaching, so the window can render a host that failed to
  // come up rather than waiting on it.
  ipc = registerIpc({ fleet, runtimes: HOST_RUNTIMES });

  for (const root of roots) {
    try {
      await fleet.attach(root);
    } catch (err) {
      process.stderr.write(`could not attach ${root}: ${String(err)}
`);
    }
  }

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
  // Kill every host explicitly. A utilityProcess is not guaranteed to die with
  // its parent, and an orphaned host holding a model connection is invisible.
  void fleet?.detachAll();
});
