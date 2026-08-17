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

import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { join } from 'node:path';
import { ClipStore } from '../voice/clips.js';
import { findVoice, Speaker } from '../voice/tts.js';
import { CH } from '@shared/ipc/contract.js';
import { createApi, type IpcDeps } from './api.js';
import { electronScreenBackend } from '../capture/electron.js';
import { selectRegion } from '../capture/overlay.js';

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
    selectRegion,
    // Under `userData`, because a dictated clip belongs to this installation and
    // not to any workspace: §12.4 keeps it on the machine that recorded it, and
    // a workspace can be a folder on a shared disk.
    clips: new ClipStore(join(app.getPath('userData'), 'voice')),
    speaker: new Speaker(findVoice()),
    broadcast: (channel, payload) => {
      for (const win of windows()) {
        try {
          win.webContents.send(channel, payload);
        } catch {
          /*
           * A window that went away between the filter above and this line.
           *
           * Narrow on purpose: `send` on destroyed `webContents` throws, and the
           * one push that arrives at full rate — a terminal's output — is exactly
           * the one most likely to land mid-teardown, which is the moment a
           * window is closing while a PTY is still loud. Losing a frame of
           * output addressed to a window that no longer exists is not a failure;
           * taking the whole app down for it is. There is nothing to report:
           * the intended reader is gone, and every other window still got it.
           */
        }
      }
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
