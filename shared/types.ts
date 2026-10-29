// Data contracts shared by the Electron main process and the renderer.
// Sizes are bytes, times are epoch milliseconds.

export type IconName =
  | 'scan' | 'broom' | 'shield' | 'gauge' | 'apps' | 'bubbles' | 'file' | 'dupes' | 'history' | 'assist'
  | 'user' | 'game' | 'down' | 'chip' | 'more' | 'check' | 'arrow' | 'heart' | 'chat' | 'gear'
  | 'trash' | 'folder' | 'photo' | 'video' | 'music' | 'doc' | 'code' | 'cloud' | 'mail' | 'globe'
  | 'layers' | 'lock' | 'power' | 'search' | 'close' | 'plus' | 'reveal' | 'spark' | 'warning' | 'clock';

export interface SystemInfo {
  platform: 'win32' | 'darwin' | 'linux';
  arch: string;
  osVersion: string;
  appVersion: string;
  homeDir: string;
}

export interface DiskInfo {
  mount: string;        // "C:\\" or "/"
  label: string;        // "Disk C:" or "Macintosh HD"
  total: number;
  free: number;
  used: number;
  /** the drive the OS (and the home folder) lives on */
  system: boolean;
}

export interface ScanProgress {
  task: 'junk' | 'spaces' | 'large' | 'dupes' | 'clean' | 'apps';
  phase: string;        // human readable, e.g. "Browser caches"
  done: number;
  total: number;        // 0 when unknown
  current?: string;     // path being looked at
}

/** A group of junk the app knows how to clean, e.g. "Browser caches". */
export interface JunkCategory {
  id: string;
  name: string;
  description: string;
  icon: IconName;
  size: number;
  count: number;          // number of top-level entries that would be trashed
  locations: string[];    // display paths (with ~ for home)
  safe: boolean;          // true = selected by default
}

export interface CleanResult {
  freed: number;
  removed: number;
  failed: number;
  skipped: string[];      // short human-readable notes ("12 files in use")
}

export interface SpaceNode {
  name: string;
  path: string;
  size: number;
  kind: 'folder' | 'file' | 'other';
  icon: IconName;
  reclaimable: number;    // bytes inside that are junk / old downloads
  children?: SpaceNode[];
}

export interface LargeFile {
  path: string;
  name: string;
  size: number;
  modified: number;
  accessed: number;
  kind: 'video' | 'archive' | 'disk-image' | 'installer' | 'audio' | 'photo' | 'document' | 'other';
}

export interface DuplicateGroup {
  hash: string;
  size: number;           // size of one copy
  files: { path: string; modified: number }[];
}

export interface StartupItem {
  id: string;
  name: string;
  command: string;
  location: string;       // "Registry (current user)", "Startup folder", "LaunchAgents"
  enabled: boolean;
  impact: 'high' | 'medium' | 'low';
  canToggle: boolean;
  /** toggling needs administrator rights (Windows shows a UAC prompt, macOS asks for the password) */
  needsAdmin: boolean;
}

export interface InstalledApp {
  id: string;
  name: string;
  version?: string;
  publisher?: string;
  size?: number;
  installed?: number;
  lastUsed?: number;
  path?: string;
  /** file to take the app's real icon from (exe, ico or .app); pass it to fileIcons() */
  iconPath?: string;
  canUninstall: boolean;
}

export interface ProtectionStatus {
  provider: string;              // "Microsoft Defender", "XProtect + Gatekeeper"
  enabled: boolean;
  realtime: boolean | null;
  firewall: boolean | null;
  definitionsUpdated: number | null;
  lastScan: number | null;
  score: number;                 // 0..100
  notes: string[];
}

export type AiProvider = 'claude' | 'chatgpt';
export type Background = 'mist' | 'grid' | 'dots' | 'grain';

export interface Settings {
  aiProvider: AiProvider;
  hasClaudeKey: boolean;
  hasOpenAiKey: boolean;
  background: Background;
  largeFileMinMb: number;
  confirmBeforeClean: boolean;
}

/** What the assistant may see: names, paths and sizes only, never file contents. */
export interface AiContext {
  junk?: { name: string; size: number; locations: string[] }[];
  largeFiles?: { path: string; size: number; modified: number }[];
  spaces?: { name: string; size: number }[];
  disk?: { total: number; free: number };
}

export interface AiAdvice {
  answer: string;
  suggestions: { path: string; verdict: 'safe' | 'review' | 'keep'; reason: string }[];
  provider: AiProvider;
}

export interface TipsProfile {
  name: string;
  tagline: string;
  currency: string;
  presets: number[];
  min: number;
  max: number;
  supporterCount: number;
}

export interface TipRequest {
  amount: number;
  monthly: boolean;
  name?: string;
  message?: string;
}

export interface FeedbackPayload {
  kind: 'idea' | 'bug' | 'love';
  message: string;
  rating: number | null;        // 1..5
  email?: string;
  includeSystemInfo: boolean;
}

export interface FeedbackResult {
  ok: boolean;
  via: 'endpoint' | 'email' | 'saved';
  message: string;
}

/** The API the preload script exposes as window.cleanly. Every method is an IPC round trip. */
export interface CleanlyApi {
  system(): Promise<SystemInfo>;
  disk(): Promise<DiskInfo>;
  /** every fixed local drive (C:, D: …), system drive first */
  disks(): Promise<DiskInfo[]>;
  /** real icons for files, folders or apps as PNG data URLs, keyed by the requested path; unknown paths are left out */
  fileIcons(paths: string[]): Promise<Record<string, string>>;
  scanJunk(): Promise<JunkCategory[]>;
  cleanJunk(ids: string[]): Promise<CleanResult>;
  /** root = undefined for the home folder, or the mount of a drive from disks() */
  scanSpaces(root?: string): Promise<SpaceNode>;
  /** scans the home folder plus every other fixed drive */
  scanLargeFiles(minBytes: number): Promise<LargeFile[]>;
  scanDuplicates(): Promise<DuplicateGroup[]>;
  trashPaths(paths: string[]): Promise<CleanResult>;
  revealPath(path: string): Promise<void>;
  startupItems(): Promise<StartupItem[]>;
  setStartupItem(id: string, enabled: boolean): Promise<StartupItem[]>;
  installedApps(): Promise<InstalledApp[]>;
  uninstallApp(id: string): Promise<{ ok: boolean; message: string }>;
  protection(): Promise<ProtectionStatus>;
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Omit<Settings, 'hasClaudeKey' | 'hasOpenAiKey'>>): Promise<Settings>;
  setApiKey(provider: AiProvider, key: string | null): Promise<Settings>;
  askAi(question: string, context: AiContext): Promise<AiAdvice>;
  tipsProfile(): Promise<TipsProfile>;
  startTip(req: TipRequest): Promise<{ url: string }>;
  sendFeedback(payload: FeedbackPayload): Promise<FeedbackResult>;
  openExternal(url: string): Promise<void>;
  onProgress(cb: (p: ScanProgress) => void): () => void;
}

/** Names of the request/response methods, used to wire IPC in preload and main. */
export const API_METHODS = [
  'system', 'disk', 'disks', 'fileIcons', 'scanJunk', 'cleanJunk', 'scanSpaces', 'scanLargeFiles', 'scanDuplicates', 'trashPaths',
  'revealPath', 'startupItems', 'setStartupItem', 'installedApps', 'uninstallApp', 'protection', 'getSettings',
  'setSettings', 'setApiKey', 'askAi', 'tipsProfile', 'startTip', 'sendFeedback', 'openExternal',
] as const satisfies readonly Exclude<keyof CleanlyApi, 'onProgress'>[];

export type ApiMethod = (typeof API_METHODS)[number];
export const PROGRESS_CHANNEL = 'cleanly:progress';
export const channelFor = (m: ApiMethod) => `cleanly:${m}`;
