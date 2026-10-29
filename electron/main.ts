import './boot';
import { app, BrowserWindow, ipcMain, nativeTheme, shell } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  API_METHODS,
  channelFor,
  PROGRESS_CHANNEL,
  type CleanlyApi,
  type ScanProgress,
  type SystemInfo,
} from '../shared/types';
import { askAi } from './services/ai';
import { listApps, uninstallApp } from './services/apps';
import { getDisk } from './services/disk';
import { scanDuplicates } from './services/duplicates';
import { sendFeedback } from './services/feedback';
import { cleanJunk, scanJunk } from './services/junk';
import { scanLargeFiles } from './services/largeFiles';
import { getProtection } from './services/protection';
import { getSettings, setApiKey, setSettings } from './services/settings';
import { scanSpaces } from './services/spaces';
import { listStartup, setStartup } from './services/startup';
import { createTipCheckout, getTipsProfile } from './services/tips';
import { trashPaths } from './services/trash';

const here = path.dirname(fileURLToPath(import.meta.url));
const devServer = process.env.VITE_DEV_SERVER_URL;
let win: BrowserWindow | null = null;

const progress = (p: ScanProgress) => win?.webContents.send(PROGRESS_CHANNEL, p);

function systemInfo(): SystemInfo {
  const platform = process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux';
  return {
    platform,
    arch: process.arch,
    osVersion: typeof os.version === 'function' ? `${os.version()} (${os.release()})` : os.release(),
    appVersion: app.getVersion(),
    homeDir: os.homedir(),
  };
}

/** Only https links leave the app, and only into the user's default browser. */
function isSafeExternal(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

const indexHtml = path.join(here, '../dist/index.html');

/** Our own page only: any other local file:// page (e.g. a downloaded .html) must not reach the API. */
function isAppUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (devServer) return u.origin === new URL(devServer).origin;
    if (u.protocol !== 'file:') return false;
    const a = path.resolve(fileURLToPath(u));
    const b = path.resolve(indexHtml);
    return process.platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase();
  } catch {
    return false;
  }
}

/** Local absolute paths only. A UNC path (\\host\share) would make Explorer contact that host. */
function revealablePath(p: unknown): string {
  if (typeof p !== 'string' || p.length === 0 || p.length > 4096 || p.includes('\0')) throw new Error('That item cannot be shown');
  let abs = p;
  if (abs === '~' || abs.startsWith('~/') || abs.startsWith('~\\')) abs = path.join(os.homedir(), abs.slice(1));
  if (/^[\\/]{2}/.test(abs) || !path.isAbsolute(abs)) throw new Error('That item cannot be shown');
  if (process.platform === 'win32' && !/^[a-zA-Z]:[\\/]/.test(abs)) throw new Error('That item cannot be shown');
  return path.resolve(abs);
}

type Handlers = Omit<CleanlyApi, 'onProgress'>;

const handlers: Handlers = {
  system: async () => systemInfo(),
  disk: () => getDisk(),
  scanJunk: () => scanJunk(progress),
  cleanJunk: (ids) => cleanJunk(ids, progress),
  scanSpaces: () => scanSpaces(progress),
  scanLargeFiles: (minBytes) => scanLargeFiles(minBytes, progress),
  scanDuplicates: () => scanDuplicates(progress),
  trashPaths: (paths) => trashPaths(paths),
  revealPath: async (p) => {
    shell.showItemInFolder(revealablePath(p));
  },
  startupItems: () => listStartup(),
  setStartupItem: (id, enabled) => setStartup(id, enabled),
  installedApps: () => listApps(),
  uninstallApp: (id) => uninstallApp(id),
  protection: () => getProtection(),
  getSettings: () => getSettings(),
  setSettings: (patch) => setSettings(patch),
  setApiKey: (provider, key) => setApiKey(provider, key),
  askAi: (question, context) => askAi(question, context),
  tipsProfile: () => getTipsProfile(),
  startTip: async (req) => {
    const checkout = await createTipCheckout(req);
    if (isSafeExternal(checkout.url)) await shell.openExternal(checkout.url);
    return checkout;
  },
  sendFeedback: (payload) => sendFeedback(payload, systemInfo()),
  openExternal: async (url) => {
    if (isSafeExternal(url)) await shell.openExternal(url);
  },
};

function registerIpc() {
  for (const method of API_METHODS) {
    ipcMain.handle(channelFor(method), (event, ...args: unknown[]) => {
      // Only our own renderer may call into the main process.
      const from = event.senderFrame?.url ?? '';
      if (!isAppUrl(from)) throw new Error('Blocked IPC from an untrusted frame');
      const fn = handlers[method] as (...a: unknown[]) => unknown;
      return fn(...args);
    });
  }
}

function createWindow() {
  const isMac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 1120,
    minHeight: 740,
    show: false,
    backgroundColor: '#f2f3f6',
    title: 'Cleanly',
    titleBarStyle: 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 20, y: 16 } }
      : { titleBarOverlay: { color: '#00000000', symbolColor: '#3c4250', height: 44 } }),
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => {
    win = null;
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternal(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    if (isSafeExternal(url)) void shell.openExternal(url);
  });

  if (devServer) void win.loadURL(devServer);
  else void win.loadFile(indexHtml);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    nativeTheme.themeSource = 'light';
    registerIpc();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
