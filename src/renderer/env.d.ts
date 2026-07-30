/**
 * The renderer's view of the preload bridge.
 *
 * Typed from the same `LoomApi` main implements, so a handler signature change
 * breaks the renderer's build rather than failing at runtime in a click handler.
 */

import type { LoomApi } from '../shared/ipc/contract.js';

declare global {
  interface Window {
    readonly loom: LoomApi;
  }
}

declare module '*.css';
