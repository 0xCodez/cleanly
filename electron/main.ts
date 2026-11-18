import { perfMark } from './boot';
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
  type Theme,
} from '../shared/types';
import { askAi } from './services/ai';
import { listApps, uninstallApp } from './services/apps';
import { getDisk, listDisks } from './services/disk';
import { getFileIcons } from './services/icons';
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

// Throttle progress IPC: the walkers tick every ~120ms across several categories, and forwarding
// every tick to the renderer used to flood the main thread during startup. Cap at ~15 Hz; the final
// message of each task always passes so the UI never gets stuck mid-progress.
let lastProgressAt = 0;
let lastProgressTask = '';
let lastProgressPhase = '';
const progress = (p: ScanProgress) => {
  if (!win || win.isDestroyed()) return;
  if (p.phase !== lastProgressPhase || p.task !== lastProgressTask) {
    perfMark(`scan:${p.task}:${p.phase}`);
    lastProgressPhase = p.phase;
  }
  const now = Date.now();
  const isFinal = p.phase === 'Done' || (p.total > 0 && p.done >= p.total);
  const taskChanged = p.task !== lastProgressTask;
  if (!isFinal && !taskChanged && now - lastProgressAt < 66) return;
  lastProgressAt = now;
  lastProgressTask = p.task;
  win.webContents.send(PROGRESS_CHANNEL, p);
};

// Window chrome per resolved theme: the paper colour behind the page and the Windows caption glyphs.
const CHROME = {
  light: { background: '#f2f3f6', symbol: '#3c4250' },
  dark: { background: '#161618', symbol: '#c7c7cc' },
} as const;
const chrome = () => CHROME[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'];

/** Follow the saved appearance; 'system' hands the choice back to the OS. The renderer's prefers-color-scheme follows too. */
function applyTheme(theme: Theme) {
  if (nativeTheme.themeSource !== theme) nativeTheme.themeSource = theme;
  syncChrome();
}

function syncChrome() {
  if (!win || win.isDestroyed()) return;
  const c = chrome();
  win.setBackgroundColor(c.background);
  if (process.platform !== 'darwin') win.setTitleBarOverlay({ color: '#00000000', symbolColor: c.symbol, height: 44 });
}

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

// Short-lived in-memory cache for expensive OS queries (WMI / registry). These values change slowly;
// the startup screen and their own pages can request the same data within seconds. Sharing one in-flight
// promise and caching the result avoids spawning multiple PowerShell processes and cutting the first paint short.
const TTL_MS = 30_000;
function cached<T>(fn: () => Promise<T>): () => Promise<T> {
  let value: T | undefined;
  let at = 0;
  let inflight: Promise<T> | null = null;
  return () => {
    if (inflight) return inflight;
    if (value !== undefined && Date.now() - at < TTL_MS) return Promise.resolve(value);
    inflight = fn().then(
      (v) => { value = v; at = Date.now(); inflight = null; return v; },
      (e) => { inflight = null; throw e; },
    );
    return inflight;
  };
}

const handlers: Handlers = {
  system: async () => systemInfo(),
  disk: cached(() => getDisk()),
  disks: cached(() => listDisks()),
  fileIcons: (paths) => getFileIcons(paths),
  scanJunk: () => scanJunk(progress),
  cleanJunk: (ids) => cleanJunk(ids, progress),
  scanSpaces: (root) => scanSpaces(progress, root),
  scanLargeFiles: (minBytes) => scanLargeFiles(minBytes, progress),
  scanDuplicates: () => scanDuplicates(progress),
  trashPaths: (paths) => trashPaths(paths),
  revealPath: async (p) => {
    shell.showItemInFolder(revealablePath(p));
  },
  startupItems: cached(() => listStartup()),
  setStartupItem: (id, enabled) => setStartup(id, enabled),
  installedApps: cached(() => listApps()),
  uninstallApp: (id) => uninstallApp(id),
  protection: cached(() => getProtection()),
  getSettings: () => getSettings(),
  setSettings: async (patch) => {
    const next = await setSettings(patch);
    applyTheme(next.theme);
    return next;
  },
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

const TRACKED = new Set<string>(['system', 'disk', 'disks', 'scanJunk', 'scanSpaces', 'cleanJunk', 'installedApps', 'startupItems', 'protection']);
function registerIpc() {
  for (const method of API_METHODS) {
    ipcMain.handle(channelFor(method), (event, ...args: unknown[]) => {
      // Only our own renderer may call into the main process.
      const from = event.senderFrame?.url ?? '';
      if (!isAppUrl(from)) throw new Error('Blocked IPC from an untrusted frame');
      const fn = handlers[method] as (...a: unknown[]) => unknown;
      const track = TRACKED.has(method);
      if (track) perfMark(`ipc:${method}:start`);
      const result = fn(...args);
      if (track && result && typeof (result as Promise<unknown>).then === 'function') {
        return Promise.resolve(result).then(
          (v) => { perfMark(`ipc:${method}:end`); return v; },
          (e) => { perfMark(`ipc:${method}:end`); throw e; },
        );
      }
      return result;
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
    backgroundColor: chrome().background,
    title: 'Cleanly',
    titleBarStyle: 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 20, y: 16 } }
      : { titleBarOverlay: { color: '#00000000', symbolColor: chrome().symbol, height: 44 } }),
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => {
    perfMark('ready-to-show');
    win?.show();
  });
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

  app.whenReady().then(async () => {
    perfMark('app-ready');
    // before the first window, so it opens in the right colours without a flash
    const saved = await getSettings().catch(() => null);
    perfMark('settings-loaded');
    nativeTheme.themeSource = saved?.theme ?? 'system';
    nativeTheme.on('updated', syncChrome);
    registerIpc();
    perfMark('ipc-registered');
    createWindow();
    perfMark('window-created');
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
