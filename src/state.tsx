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
  settings: Settings | null;

  junk: JunkCategory[] | null;
  spaces: SpaceNode | null;
  /** the home-folder walk runs on its own, after the junk scan */
  spacesScanning: boolean;
  spacesError: boolean;
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
  scanSpaces: () => Promise<void>;
  cleanJunk: (ids: string[]) => Promise<CleanResult | null>;
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
  const [settings, setSettingsState] = useState<Settings | null>(null);
  const [junk, setJunk] = useState<JunkCategory[] | null>(null);
  const [spaces, setSpaces] = useState<SpaceNode | null>(null);
  const [spacesScanning, setSpacesScanning] = useState(false);
  const [spacesError, setSpacesError] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [lastScanAt, setLastScanAt] = useState<number | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [lastClean, setLastClean] = useState<CleanResult | null>(null);
  const [cleanPulse, setCleanPulse] = useState(0);
  const [lastCleanAt, setLastCleanAt] = useState<number | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const scanRef = useRef<Promise<void> | null>(null);
  const spacesRef = useRef<Promise<void> | null>(null);

  const toast = useCallback((text: string, kind: Toast['kind'] = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3800);
  }, []);

  const refreshDisk = useCallback(async () => {
    try {
      setDisk(await api.disk());
    } catch {
      /* keep the last value */
    }
  }, []);

  const scanSpaces = useCallback(async () => {
    if (spacesRef.current) return spacesRef.current;
    const run = (async () => {
      setSpacesScanning(true);
      setSpacesError(false);
      try {
        setSpaces(await api.scanSpaces());
      } catch (e) {
        setSpacesError(true);
        toast(e instanceof Error ? e.message : 'Could not measure your folders', 'err');
      } finally {
        setSpacesScanning(false);
        setProgress((p) => (p?.task === 'spaces' ? null : p));
        spacesRef.current = null;
      }
    })();
    spacesRef.current = run;
    return run;
  }, [toast]);

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

  const reclaimable = useMemo(() => sum((junk ?? []).filter((c) => c.safe).map((c) => c.size)), [junk]);

  const value: Store = {
    screen,
    go: setScreen,
    system,
    disk,
    settings,
    junk,
    spaces,
    spacesScanning,
    spacesError,
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

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore outside StoreProvider');
  return s;
}
