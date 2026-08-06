/**
 * The renderer's view of the preload bridge.
 *
 * Typed from the same `GilmokApi` main implements, so a handler signature change
 * breaks the renderer's build rather than failing at runtime in a click handler.
 */

import type { GilmokApi } from '../shared/ipc/contract.js';

declare global {
  interface Window {
    readonly gilmok: GilmokApi;
  }
}

declare module '*.css';
