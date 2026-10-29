import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { API_METHODS, channelFor, PROGRESS_CHANNEL, type CleanlyApi, type ScanProgress } from '../shared/types';

// Electron wraps main-process errors as "Error invoking remote method 'x': Error: msg"; the UI shows msg alone.
const cleanMessage = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']*':\s*(?:[A-Za-z]*Error:\s*)?/, '');

const api: Record<string, unknown> = {};
for (const method of API_METHODS) {
  api[method] = async (...args: unknown[]) => {
    try {
      return await ipcRenderer.invoke(channelFor(method), ...args);
    } catch (e) {
      throw new Error(cleanMessage(e));
    }
  };
}
api.onProgress = (cb: (p: ScanProgress) => void) => {
  const listener = (_e: IpcRendererEvent, p: ScanProgress) => cb(p);
  ipcRenderer.on(PROGRESS_CHANNEL, listener);
  return () => {
    ipcRenderer.removeListener(PROGRESS_CHANNEL, listener);
  };
};

contextBridge.exposeInMainWorld('cleanly', api as unknown as CleanlyApi);
