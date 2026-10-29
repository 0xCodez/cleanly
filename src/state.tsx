import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  AiProvider,
  CleanResult,
  DiskInfo,
  JunkCategory,
  ScanProgress,
  Settings,
  SpaceNode,
  SystemInfo,
} from '../shared/types';
import { api } from './api';
import { sum } from './lib/format';

export type Screen =
  | 'scan' | 'cleanup' | 'protection' | 'speed' | 'apps'
  | 'spaces' | 'large' | 'dupes' | 'assistant'
  | 'support' | 'feedback' | 'settings';

export interface Toast {
  id: number;
  text: string;
  kind: 'ok' | 'err';
}

interface Store {
  screen: Screen;
  go: (s: Screen) => void;

  system: SystemInfo | null;
  disk: DiskInfo | null;
  /** every fixed drive, system drive first; null until the first answer */
  disks: DiskInfo[] | null;
  settings: Settings | null;

  junk: JunkCategory[] | null;
  /** map of the home folder (same as spaceMaps['']) */
  spaces: SpaceNode | null;
  /** the home-folder walk runs on its own, after the junk scan */
  spacesScanning: boolean;
  spacesError: boolean;
  /** cached space maps by root: '' = home folder, otherwise a drive mount from disks */
  spaceMaps: Record<string, SpaceNode>;
  /** roots being measured right now */
  spacesBusy: string[];
  /** roots whose last walk failed */
  spacesFailed: string[];
  /** total size of junk categories marked safe — what one tap of Clean frees */
  reclaimable: number;
  scanning: boolean;
  progress: ScanProgress | null;
  lastScanAt: number | null;

  cleaning: boolean;
  lastClean: CleanResult | null;
  /** increments after every successful clean, so visuals can react */
  cleanPulse: number;
  lastCleanAt: number | null;

  smartScan: () => Promise<void>;
  /** (re)measures a root; no argument = the home folder */
  scanSpaces: (root?: string) => Promise<void>;
  cleanJunk: (ids: string[]) => Promise<CleanResult | null>;
  /** reloads the system disk and the drive list */
  refreshDisk: () => Promise<void>;
  updateSettings: (patch: Partial<Omit<Settings, 'hasClaudeKey' | 'hasOpenAiKey'>>) => Promise<void>;
  setApiKey: (provider: AiProvider, key: string | null) => Promise<void>;

  toasts: Toast[];
  toast: (text: string, kind?: Toast['kind']) => void;
}

const Ctx = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [screen, setScreen] = useState<Screen>('scan');
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [disk, setDisk] = useState<DiskInfo | null>(null);
  const [disks, setDisks] = useState<DiskInfo[] | null>(null);
  const [settings, setSettingsState] = useState<Settings | null>(null);
  const [junk, setJunk] = useState<JunkCategory[] | null>(null);
  const [spaceMaps, setSpaceMaps] = useState<Record<string, SpaceNode>>({});
  const [spacesBusy, setSpacesBusy] = useState<string[]>([]);
  const [spacesFailed, setSpacesFailed] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [lastScanAt, setLastScanAt] = useState<number | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [lastClean, setLastClean] = useState<CleanResult | null>(null);
  const [cleanPulse, setCleanPulse] = useState(0);
  const [lastCleanAt, setLastCleanAt] = useState<number | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const scanRef = useRef<Promise<void> | null>(null);
  const spacesRef = useRef(new Map<string, Promise<void>>());

  const toast = useCallback((text: string, kind: Toast['kind'] = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3800);
  }, []);

  const refreshDisk = useCallback(async () => {
    // each keeps its last value on failure
    await Promise.all([
      api.disk().then(setDisk, () => undefined),
      api.disks().then(
        (list) => setDisks(Array.isArray(list) ? list : null),
        () => undefined,
      ),
    ]);
  }, []);

  const scanSpaces = useCallback(
    async (root?: string) => {
      // tolerate being wired straight to onClick, which passes an event
      const target = typeof root === 'string' && root ? root : undefined;
      const key = target ?? '';
      const inflight = spacesRef.current.get(key);
      if (inflight) return inflight;
      const run = (async () => {
        setSpacesBusy((b) => (b.includes(key) ? b : [...b, key]));
        setSpacesFailed((f) => f.filter((k) => k !== key));
        try {
          const tree = await api.scanSpaces(target);
          setSpaceMaps((m) => ({ ...m, [key]: tree }));
        } catch (e) {
          setSpacesFailed((f) => (f.includes(key) ? f : [...f, key]));
          const fallback = target ? `Could not measure ${target.replace(/[\\/]+$/, '')}` : 'Could not measure your folders';
          toast(e instanceof Error && e.message ? e.message : fallback, 'err');
        } finally {
          spacesRef.current.delete(key);
          setSpacesBusy((b) => b.filter((k) => k !== key));
          if (!spacesRef.current.size) setProgress((p) => (p?.task === 'spaces' ? null : p));
        }
      })();
      spacesRef.current.set(key, run);
      return run;
    },
    [toast],
  );

  const smartScan = useCallback(async () => {
    if (scanRef.current) return scanRef.current;
    const run = (async () => {
      setScanning(true);
      try {
        const [j] = await Promise.all([api.scanJunk(), refreshDisk()]);
        setJunk(j);
        setLastScanAt(Date.now());
        // the space map walks the whole home folder; let it finish in the background
        void scanSpaces();
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Scan failed', 'err');
      } finally {
        setScanning(false);
        setProgress((p) => (p?.task === 'junk' ? null : p));
        scanRef.current = null;
      }
    })();
    scanRef.current = run;
    return run;
  }, [refreshDisk, scanSpaces, toast]);

  const cleanJunk = useCallback(
    async (ids: string[]) => {
      if (!ids.length) return null;
      setCleaning(true);
      try {
        const result = await api.cleanJunk(ids);
        setLastClean(result);
        setCleanPulse((n) => n + 1);
        setLastCleanAt(Date.now());
        setJunk((prev) => (prev ? prev.map((c) => (ids.includes(c.id) ? { ...c, size: 0, count: 0 } : c)) : prev));
        await refreshDisk();
        return result;
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Cleaning failed', 'err');
        return null;
      } finally {
        setCleaning(false);
        setProgress((p) => (p?.task === 'clean' ? null : p));
      }
    },
    [refreshDisk, toast],
  );

  const updateSettings = useCallback<Store['updateSettings']>(async (patch) => {
    setSettingsState(await api.setSettings(patch));
  }, []);

  const setApiKey = useCallback<Store['setApiKey']>(async (provider, key) => {
    setSettingsState(await api.setApiKey(provider, key));
  }, []);

  useEffect(() => {
    const off = api.onProgress(setProgress);
    api.system().then(setSystem).catch(() => undefined);
    api.getSettings().then(setSettingsState).catch(() => undefined);
    void smartScan();
    return off;
  }, [smartScan]);

  const spaces = spaceMaps[''] ?? null;
  const spacesScanning = spacesBusy.includes('');
  const spacesError = spacesFailed.includes('');

  const reclaimable = useMemo(() => sum((junk ?? []).filter((c) => c.safe).map((c) => c.size)), [junk]);

  const value: Store = {
    screen,
    go: setScreen,
    system,
    disk,
    disks,
    settings,
    junk,
    spaces,
    spacesScanning,
    spacesError,
    spaceMaps,
    spacesBusy,
    spacesFailed,
    reclaimable,
    scanning,
    progress,
    lastScanAt,
    cleaning,
    lastClean,
    cleanPulse,
    lastCleanAt,
    smartScan,
    scanSpaces,
    cleanJunk,
    refreshDisk,
    updateSettings,
    setApiKey,
    toasts,
    toast,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** "C:" for Windows drive letters, the volume name elsewhere */
export const driveName = (d: DiskInfo): string => (/^[a-z]:[\\/]?$/i.test(d.mount) ? d.mount.slice(0, 2).toUpperCase() : d.label);

const slashes = (p: string) => p.replace(/\\/g, '/');
const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);

/**
 * Where a path lives when it is outside the home folder: the drive's short name and the
 * parent folder relative to that drive ("/Games/Installers"). Null for anything inside home.
 */
export function driveOf(path: string, home: string | undefined, disks: DiskInfo[] | null): { name: string; dir: string } | null {
  const p = slashes(path);
  const lower = p.toLowerCase();
  if (home) {
    const h = trimSlash(slashes(home)).toLowerCase();
    if (lower === h || lower.startsWith(h + '/')) return null;
  }
  const parent = p.slice(0, Math.max(0, p.lastIndexOf('/')));
  const under = (mount: string) => {
    const m = trimSlash(slashes(mount)).toLowerCase();
    return m === '/' || lower.startsWith(m + '/');
  };
  const rel = (mount: string) => '/' + parent.slice(Math.min(parent.length, trimSlash(slashes(mount)).length)).replace(/^\/+/, '');
  const hit = (disks ?? []).filter((d) => under(d.mount)).sort((a, b) => b.mount.length - a.mount.length)[0];
  if (hit) return { name: driveName(hit), dir: rel(hit.mount) };
  const letter = /^([a-z]:)\//i.exec(p);
  return letter ? { name: letter[1].toUpperCase(), dir: rel(letter[1]) } : null;
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore outside StoreProvider');
  return s;
}
