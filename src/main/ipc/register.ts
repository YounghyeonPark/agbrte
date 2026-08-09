/**
 * The Electron transport over the API (DESIGN.md §7).
 *
 * Thin by design. Everything it drives lives in `api.ts` and knows nothing about
 * windows, so this is one of only two files in the app that import `electron` —
 * and the web server is its exact counterpart over a socket.
 *
 * The other is `capture/electron.ts`, and it is reached only from here. That is
 * the rule this file exists to keep: `electron` is imported where the transport
 * is chosen, never where the work is done.
 */

import { BrowserWindow, dialog, ipcMain } from 'electron';
import { CH } from '@shared/ipc/contract.js';
import { createApi, type IpcDeps } from './api.js';
import { electronScreenBackend } from '../capture/electron.js';

export type { IpcDeps, AgbrteApiHost } from './api.js';
export { createApi } from './api.js';

/**
 * Register every handler on `ipcMain`.
 *
 * Thin by design: everything above is transport-free, so this is the only place
 * that knows about `ipcMain`, and the web server is its exact counterpart.
 */
export function registerIpc(deps: Omit<IpcDeps, 'broadcast' | 'pickFolder'>): {
  dispose: () => void;
} {
  const windows = (): BrowserWindow[] =>
    BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());

  const api = createApi({
    ...deps,
    // The desktop client has a screen; the web one does not, and `api.ts` says
    // so rather than pretending it might (§12.1).
    screen: electronScreenBackend(),
    broadcast: (channel, payload) => {
      for (const win of windows()) win.webContents.send(channel, payload);
    },
    pickFolder: async () => {
      const win = windows()[0];
      const result = await dialog.showOpenDialog(win ?? new BrowserWindow({ show: false }), {
        title: 'Attach a workspace',
        properties: ['openDirectory', 'createDirectory'],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
  });

  for (const [channel, fn] of api.handlers) {
    ipcMain.handle(channel, async (_e, ...args: unknown[]) => fn(...args));
  }
  ipcMain.on(CH.ack, (_e, sessionId: string, seq: number) => api.ack(sessionId, seq));

  return {
    dispose: () => {
      api.dispose();
      for (const channel of Object.values(CH)) ipcMain.removeHandler(channel);
      ipcMain.removeAllListeners(CH.ack);
    },
  };
}
