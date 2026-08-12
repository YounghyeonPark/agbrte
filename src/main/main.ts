/**
 * Electron main process (DESIGN.md §7, §8).
 *
 * Owns the app lifecycle, one window, and the `Fleet` that everything else is a
 * client of.
 *
 * **Main owns no session state.** Sessions, their logs, and the permission gate
 * belong to a `agbrte-host` process per workspace; this process connects to them.
 * That is what makes closing the app a non-event for a running session, and what
 * makes a second device another connection rather than a second copy.
 *
 * Several hosts stay attached at once. §8's concurrency caps are per host and
 * §10's cards carry a target badge, so watching more than one place is the
 * designed behaviour; the single-workspace shape this replaced was a limitation.
 */

import { loadReport } from './conformance.js';
import { app, BrowserWindow, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { delimiter, dirname, join } from 'node:path';
import { registerIpc } from './ipc/register.js';
import { Notifier } from './notify.js';
import { Fleet, type FleetRuntime } from './fleet.js';
import { connectOrSpawnHost } from './host/connectOrSpawn.js';
import { connectRemoteHost } from './host/connectRemote.js';
import { transportFor, TransportUnsupported } from './host/transports.js';
import { PreviewForwards } from './preview/forwards.js';
import { freeLoopbackPort, systemSshRunner } from './host/sshTransport.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Vite's dev server, when `npm run dev` started one. */
const DEV_URL = process.env['AGBRTE_DEV_SERVER'];

/**
 * Windows taskbar grouping and notification identity (§11). Without it,
 * notifications are attributed to `electron.exe` and every dev build shares one
 * taskbar slot.
 */
if (process.platform === 'win32') app.setAppUserModelId('dev.agbrte.app');

let fleet: Fleet | null = null;
let ipc: { dispose: () => void } | null = null;
let previews: PreviewForwards | null = null;

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
    id: 'agbrte-harness',
    label: 'Agbrte harness (local model)',
    version: '0.0.1',
    model: 'required',
  },
  { id: 'echo', label: 'Echo (no model)', version: '0.0.1', model: 'none' },
];

/**
 * One fleet for the app's lifetime, holding as many hosts as are attached (§8).
 *
 * The app no longer *runs* sessions — it connects to the processes that do. A
 * host it starts is detached and outlives this window, which is the whole point:
 * closing the app is not a reason to stop work.
 */
function buildFleet(): Fleet {
  return new Fleet({
    runtimes: HOST_RUNTIMES,
    // One connector, two transports. Everything above this line — the fleet, the
    // IPC layer, the renderer — is identical for a workspace on this machine and
    // one on a build box, which is the whole point of the boundary.
    connect: async ({ target, workspaceRoot }) => {
      if (target.kind === 'ssh') {
        const alias = target.alias ?? target.host;
        const { connection } = await connectRemoteHost({
          alias,
          workspaceRoot,
          bundles: {
            host: join(HERE, 'agbrteHost.js'),
            agent: join(HERE, 'agentHost.js'),
          },
          // The app's own version, so a rebuilt app redeploys and an unchanged
          // one does not pay for an upload it does not need.
          bundleVersion: app.getVersion(),
          onProgress: (step) => process.stderr.write(`[${alias}] ${step}
`),
        });
        return connection;
      }
      if (target.kind === 'local') {
        return connectOrSpawnHost({ workspaceRoot, hostEntry: join(HERE, 'agbrteHost.js') });
      }
      // Not a fallback. `Fleet.attach` has already refused every kind that is not
      // implemented, so reaching this means a kind became implemented in the
      // registry and nobody taught the connector to dial it — which must be an
      // error, because the alternative is what this replaced: an unhandled kind
      // silently running on the user's own machine under a badge saying it was
      // somewhere else.
      throw new TransportUnsupported(
        target.kind,
        `${transportFor(target).label} is listed as supported but this connector cannot dial it`,
      );
    },
  });
}

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    show: false,
    /*
     * The ground the window paints before the renderer has loaded.
     *
     * It was `#16161a`, the old blue-black, and the restyle walked straight past
     * it: a literal outside the stylesheet is invisible to a change made in
     * `@theme`, which is exactly how four hardcoded panel colours survived in the
     * TSX. Here it shows as a cold flash at every launch, a moment before the
     * warm neutral arrives. Kept in step with `--color-bg` by hand, because
     * Electron needs this before any CSS exists to read.
     */
    backgroundColor: '#121211',
    /*
     * Packaged builds take their icon from the executable, which electron-builder
     * embeds from `build/`. Unpackaged ones — `npm start`, the e2e suite, anyone
     * running from a checkout — had none, and showed Electron's own.
     */
    icon: join(HERE, '../../build/icon.png'),
    title: 'Agbrte',
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

  // `AGBRTE_WORKSPACE_ROOT` lets a test — or a developer — start attached to a
  // known folder. Several may be given, separated by the platform's path
  // delimiter, which is how the e2e suite attaches two hosts at once.
  const configured = process.env['AGBRTE_WORKSPACE_ROOT'];
  const roots =
    configured === undefined || configured === ''
      ? [app.getPath('userData')]
      : configured.split(delimiter).filter((r) => r !== '');

  // Registered before attaching, so the window can render a host that failed to
  // come up rather than waiting on it.
  // Subscribed here rather than inside the IPC layer: a notification is not a
  // message to a renderer, it is what happens when no renderer is being looked
  // at. Wiring it there would have made it fire once per window.
  const notifier = new Notifier({
    focused: () => BrowserWindow.getAllWindows().some((w) => w.isFocused()),
  });
  const attached = fleet;
  attached.on('session', (_instanceId: unknown, session: unknown) =>
    notifier.consider(session as Parameters<Notifier['consider']>[0]),
  );
  attached.on('detached', () => {
    void attached
      .list()
      .then((sessions) => notifier.prune(sessions))
      .catch(() => undefined);
  });

  /**
   * Preview forwarding (§6.8), on this machine because the URL it produces names
   * this machine.
   *
   * The opener dispatches the same way the connector does, and for the same
   * reason: an unimplemented locality must not fall through to something that
   * silently works differently.
   */
  previews = new PreviewForwards({
    freePort: freeLoopbackPort,
    open: (target, localPort, remotePort) => {
      if (target.kind !== 'ssh') {
        throw new TransportUnsupported(
          target.kind,
          `${transportFor(target).label} cannot forward a port yet`,
        );
      }
      // `127.0.0.1:<port>` on the far side: the dev server is bound to the
      // remote's loopback, which is exactly why it needs a tunnel at all.
      return systemSshRunner().forward(
        target.alias ?? target.host,
        localPort,
        `127.0.0.1:${remotePort}`,
      );
    },
  });

  ipc = registerIpc({
    fleet,
    runtimes: HOST_RUNTIMES,
    previews,
    // Beside the app, so a build ships the report that describes that build.
    loadConformance: () => loadReport(join(app.getAppPath(), 'conformance')),
  });

  for (const root of roots) {
    try {
      await fleet.attach({ target: { kind: 'local' }, workspaceRoot: root });
    } catch (err) {
      process.stderr.write(`could not attach ${root}: ${String(err)}
`);
    }
  }

  await createWindow();

  /*
   * Look for a new version, download it, and apply it when the person quits.
   *
   * After the window rather than before: an update check is never the reason a
   * workbench takes longer to appear, and being offline — a normal state for a
   * laptop, and a fine one for this program, whose hosts may be elsewhere — must
   * not delay startup by a timeout.
   *
   * Nothing here quits the app. §6.4's detached hosts mean a restart interrupts
   * a *view* rather than a run, which is what makes downloading in the
   * background reasonable; it is not what would make closing someone's window
   * for them reasonable. See `update.ts`.
   */
  const { buildFacts, startUpdates } = await import('./update.js');
  const { autoUpdater } = await import('electron-updater');
  const facts = await buildFacts();
  updates = startUpdates({
    build: facts,
    updater: autoUpdater as unknown as Parameters<typeof startUpdates>[0]['updater'],
    onState: (state) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('update:state', state);
      }
    },
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

/**
 * The updater handle, so a quit can stop its timer.
 *
 * Module-level because `whenReady` is where it can first be built and `will-quit`
 * is where it must be torn down, and those are two different callbacks.
 */
let updates: ReturnType<typeof import('./update.js').startUpdates> | undefined;

app.on('will-quit', () => updates?.stop());

// Closing the window ends the app on Windows and Linux. This is temporary and
// wrong for Agbrte's purpose: §8's parking model exists so long runs continue
// while you are not watching, which needs a tray presence to return to. Until
// that exists, quitting on close is at least honest about what is running.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // Every `ssh -N` this app started. A forward outliving the app is a port that
  // keeps answering with nothing to explain it.
  previews?.closeAll();
  ipc?.dispose();
  // Disconnect, do **not** stop. A host outliving the app is the feature, not a
  // leak: a session started here keeps running, and the next app to open — on
  // this machine or another device — reattaches to it. Hosts exit on their own
  // after an idle spell (§8's parking), which is what stops them accumulating.
  void fleet?.detachAll();
});
