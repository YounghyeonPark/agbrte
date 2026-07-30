/**
 * Electron main process (DESIGN.md §7, §8).
 *
 * Owns the app lifecycle, one window, and the `SessionManager` that everything
 * else is a client of.
 *
 * ## Divergence from §8, recorded rather than smoothed over
 *
 * §8 places `AgentHost` in a local `utilityProcess`, one per workspace, so a
 * wedged tool subprocess or a runaway adapter cannot take the app down with it.
 * Phase 1 runs agent loops **in main**. The reason is sequencing, not
 * disagreement: the process split is only meaningful once the loop is proven,
 * and moving it later is a transport change behind `AgentRuntime` rather than a
 * redesign. What this costs today is real and should not be forgotten — a
 * crashing adapter takes the window with it, and a synchronous stall in a tool
 * freezes the UI. §16 carries the row.
 */

import { app, BrowserWindow, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SessionManager } from './sessionManager.js';
import { RuntimeRegistry } from './runtime/registry.js';
import { LoomHarnessRuntime } from './runtime/runtimes/loomHarness.js';
import { EchoRuntime } from './runtime/runtimes/echo.js';
import {
  OpenAiCompatibleProvider,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from './runtime/providers/openaiCompatible.js';
import { openWorkspace } from './store/identity.js';
import { registerIpc } from './ipc/register.js';
import type { RuntimeInfo, WorkspaceInfo } from '@shared/ipc/contract.js';
import type { ModelEndpoint } from '@shared/types/index.js';

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
let registry: RuntimeRegistry | null = null;

/**
 * The local OpenAI-compatible endpoint (§3.8).
 *
 * `app-local` locality, `dataHandling.provider: 'local'`: nothing leaves the
 * machine, which is the honest classification for a server on loopback and the
 * reason this path needs no credentials at all. Overridable so a user pointing
 * at vLLM or LM Studio on another port does not need a rebuild.
 */
function localEndpoint(): ModelEndpoint {
  return {
    endpointId: 'local-ollama',
    providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
    baseUrl: process.env['LOOM_MODEL_BASE_URL'] ?? 'http://127.0.0.1:11434/v1',
    auth: { kind: 'none' },
    locality: 'app-local',
    dataHandling: { provider: 'local' },
  };
}

function buildRegistry(): RuntimeRegistry {
  const reg = new RuntimeRegistry();

  // LoomHarness over a local model: the path that works on a fresh machine with
  // no credentials configured, which is why it is the default offered.
  reg.register(
    new LoomHarnessRuntime({
      provider: new OpenAiCompatibleProvider(),
      endpoint: localEndpoint(),
    }),
    { label: 'Loom harness (local model)', requiresModel: true },
  );

  // Registered because a UI with no available runtime is untestable, and because
  // it exercises the shell without a model server running at all.
  reg.register(new EchoRuntime(), { label: 'Echo (no model)', requiresModel: false });

  return reg;
}

function runtimeInfos(reg: RuntimeRegistry): RuntimeInfo[] {
  return reg.list().map((d) => {
    const runtime = reg.get(d.id);
    return {
      id: d.id,
      version: runtime.version,
      requiresModel: d.requiresModel,
      ...(runtime.toolVersion !== undefined ? { toolVersion: runtime.toolVersion } : {}),
    };
  });
}

async function loadWorkspace(root: string): Promise<WorkspaceInfo> {
  const identity = await openWorkspace(root);
  registry ??= buildRegistry();
  manager = new SessionManager({
    registry,
    workspaceRoot: root,
    instanceId: identity.instanceId,
  });
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

app.whenReady().then(async () => {
  const workspace = await loadWorkspace(app.getPath('userData'));

  ipc = registerIpc({
    manager: manager!,
    workspace,
    runtimes: () => runtimeInfos(registry!),
    onChooseWorkspace: async (root) => {
      // A new workspace means a new manager: session ids, the log, and the
      // instance identity are all per-workspace (§5.2). Reusing the old manager
      // would attribute new sessions to the previous workspace's instance.
      ipc?.dispose();
      const next = await loadWorkspace(root);
      ipc = registerIpc({
        manager: manager!,
        workspace: next,
        runtimes: () => runtimeInfos(registry!),
        onChooseWorkspace: async () => next,
      });
      return next;
    },
  });

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

app.on('before-quit', () => ipc?.dispose());
