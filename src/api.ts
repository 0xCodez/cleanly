import type { CleanlyApi } from '../shared/types';
import { createMockApi } from './mock';

declare global {
  interface Window {
    cleanly?: CleanlyApi;
  }
}

/** True when the UI runs in a plain browser (npm run demo) instead of inside Electron. */
export const isDemo = !window.cleanly;

/** The bridge to the main process; in a browser it falls back to realistic demo data. */
export const api: CleanlyApi = window.cleanly ?? createMockApi();
