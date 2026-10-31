import type {
  AiAdvice,
  CleanResult,
  CleanlyApi,
  DiskInfo,
  DuplicateGroup,
  FeedbackResult,
  IconName,
  InstalledApp,
  JunkCategory,
  LargeFile,
  ProtectionStatus,
  ScanProgress,
  Settings,
  SpaceNode,
  StartupItem,
  SystemInfo,
  TipsProfile,
} from '../shared/types';

// In-browser stand-in for the Electron bridge, used by `npm run demo`.
// Stateful: cleaning and trashing change what later scans return.

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const HOME = 'C:\\Users\\Alex';
const now = Date.now();

const wait = (min = 300, max = 1200) => new Promise<void>((r) => setTimeout(r, min + Math.random() * (max - min)));
const clone = <T>(v: T): T => structuredClone(v);
const join = (...parts: string[]) => parts.join('\\');
const abs = (p: string) => /^[a-z]:\\/i.test(p);
const D = 'D:\\';
const tilde = (p: string) => '~' + p.slice(HOME.length).replace(/\\/g, '/');

function initialJunk(): JunkCategory[] {
  return [
    {
      id: 'user-temp',
      name: '临时文件',
      description: '应用运行时写入却忘了删除的残余文件。',
      icon: 'clock',
      size: 4.2 * GB,
      count: 2841,
      locations: [tilde(join(HOME, 'AppData', 'Local', 'Temp'))],
      safe: true,
    },
    {
      id: 'browser-caches',
      name: '浏览器缓存',
      description: 'Chrome 和 Edge 缓存的页面与图片。网站需要时会重新加载。',
      icon: 'globe',
      size: 3.4 * GB,
      count: 6,
      locations: [
        tilde(join(HOME, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default', 'Cache')),
        tilde(join(HOME, 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data', 'Default', 'Cache')),
      ],
      safe: true,
    },
    {
      id: 'update-cache',
      name: 'Windows 更新缓存',
      description: '已安装更新的安装文件。',
      icon: 'down',
      size: 2.1 * GB,
      count: 37,
      locations: ['C:/Windows/SoftwareDistribution/Download'],
      safe: true,
    },
    {
      id: 'crash-reports',
      name: '崩溃报告',
      description: '应用崩溃时产生的错误报告和内存转储。',
      icon: 'warning',
      size: 0.4 * GB,
      count: 112,
      locations: [tilde(join(HOME, 'AppData', 'Local', 'CrashDumps')), 'C:/ProgramData/Microsoft/Windows/WER'],
      safe: true,
    },
    {
      id: 'dev-caches',
      name: '开发者缓存',
      description: 'npm、pip 和 Gradle 的下载缓存。下次安装时会重建，需要一些时间。',
      icon: 'code',
      size: 1.6 * GB,
      count: 3,
      locations: [tilde(join(HOME, 'AppData', 'Local', 'npm-cache')), tilde(join(HOME, 'AppData', 'Local', 'pip', 'Cache')), tilde(join(HOME, '.gradle', 'caches'))],
      safe: false,
    },
    {
      id: 'recycle-bin',
      name: '回收站',
      description: '你已经删除的文件。清空后无法撤销。',
      icon: 'trash',
      size: 1.1 * GB,
      count: 214,
      locations: ['C:/$Recycle.Bin'],
      safe: false,
    },
    {
      id: 'old-downloads',
      name: '旧下载文件',
      description: '下载文件夹中 90 多天未打开的文件。它们会被移至回收站。',
      icon: 'down',
      size: 18.7 * GB,
      count: 146,
      locations: [tilde(join(HOME, 'Downloads'))],
      safe: false,
    },
  ];
}

function initialLargeFiles(): LargeFile[] {
  const f = (dir: string, name: string, size: number, ageDays: number, accessedDays: number, kind: LargeFile['kind']): LargeFile => ({
    path: abs(dir) ? join(dir, name) : join(HOME, dir, name),
    name,
    size,
    modified: now - ageDays * DAY,
    accessed: now - accessedDays * DAY,
    kind,
  });
  return [
    f('Downloads', 'Win11_24H2_English_x64.iso', 5.8 * GB, 210, 205, 'disk-image'),
    f('Videos', 'Family trip 2023 - raw.mp4', 4.6 * GB, 420, 300, 'video'),
    f('Downloads', 'ubuntu-24.04-desktop-amd64.iso', 5.7 * GB, 160, 158, 'disk-image'),
    f(join('Documents', 'Backups'), 'phone-backup-2024-03.zip', 3.9 * GB, 590, 560, 'archive'),
    f('Videos', 'Screen Recording 2025-02-11.mp4', 2.3 * GB, 260, 240, 'video'),
    f('Downloads', 'Blender-4.2-windows-x64.msi', 0.36 * GB, 120, 119, 'installer'),
    f('Downloads', 'project-assets-final.zip', 1.7 * GB, 95, 60, 'archive'),
    f(join('Videos', 'Captures'), 'Elden Ring 2025-05-03 21-14-07.mp4', 1.4 * GB, 180, 170, 'video'),
    f('Downloads', 'SteamSetup.exe', 2.3 * MB, 400, 399, 'installer'),
    f(join('Music', 'Stems'), 'session-master.wav', 0.84 * GB, 330, 330, 'audio'),
    f(join('Pictures', 'RAW'), 'DSC_0412.NEF', 62 * MB, 700, 400, 'photo'),
    f('Documents', 'Thesis - all drafts.pdf', 410 * MB, 800, 120, 'document'),
    f('Downloads', 'vs_community_installer_cache.zip', 2.9 * GB, 365, 365, 'archive'),
    f(join('AppData', 'Local', 'Docker', 'wsl'), 'ext4.vhdx', 9.2 * GB, 14, 1, 'disk-image'),
    f('D:\\Media\\Movies', 'Dune Part Two (2024) 2160p.mkv', 18.6 * GB, 240, 230, 'video'),
    f('D:\\Backups', 'phone-backup-2023-11.zip', 6.2 * GB, 700, 690, 'archive'),
    f('D:\\ISO', 'Windows Server 2022.iso', 4.9 * GB, 520, 515, 'disk-image'),
    f('D:\\Games\\Installers', 'Cyberpunk2077_setup_v2.1.exe', 1.2 * GB, 330, 330, 'installer'),
  ];
}

function initialDupes(): DuplicateGroup[] {
  const g = (hash: string, size: number, paths: [string, number][]): DuplicateGroup => ({
    hash,
    size,
    files: paths.map(([p, age]) => ({ path: abs(p) ? p : join(HOME, p), modified: now - age * DAY })),
  });
  return [
    g('a3f9c1', 1.7 * GB, [
      [join('Downloads', 'project-assets-final.zip'), 95],
      [join('Documents', 'Work', 'project-assets-final (1).zip'), 94],
    ]),
    g('7be210', 640 * MB, [
      [join('Videos', 'Wedding highlights.mp4'), 900],
      [join('Desktop', 'Wedding highlights.mp4'), 610],
      [join('Documents', 'Backups', 'Wedding highlights.mp4'), 590],
      ['D:\\Media\\Wedding highlights.mp4', 580],
    ]),
    g('c04d88', 212 * MB, [
      [join('Downloads', 'Figma-Setup.exe'), 140],
      [join('Downloads', 'Figma-Setup (2).exe'), 60],
    ]),
    g('19e7aa', 48 * MB, [
      [join('Pictures', 'Camera Roll', 'IMG_2041.HEIC'), 420],
      [join('Pictures', 'Imports', 'IMG_2041.HEIC'), 410],
      [join('OneDrive', 'Pictures', 'IMG_2041.HEIC'), 405],
    ]),
    g('5d6b03', 18 * MB, [
      [join('Documents', 'Taxes 2024.pdf'), 200],
      [join('Downloads', 'Taxes 2024.pdf'), 201],
    ]),
    g('e8812f', 6.4 * MB, [
      [join('Music', 'Phoebe Bridgers - Motion Sickness.flac'), 1000],
      [join('Music', 'Library', 'Motion Sickness.flac'), 980],
    ]),
  ];
}

function initialSpaces(): SpaceNode {
  const folder = (name: string, icon: SpaceNode['icon'], children: SpaceNode[], parent = HOME, reclaimable = 0): SpaceNode => {
    const path = join(parent, name);
    const fixed = children.map((c) => ({ ...c, path: c.path || join(path, c.name) }));
    return { name, path, kind: 'folder', icon, size: fixed.reduce((a, c) => a + c.size, 0), reclaimable, children: fixed };
  };
  const leaf = (name: string, size: number, icon: SpaceNode['icon'] = 'folder', kind: SpaceNode['kind'] = 'folder', reclaimable = 0): SpaceNode => ({
    name,
    path: '',
    size,
    kind,
    icon,
    reclaimable,
  });
  const children: SpaceNode[] = [
    folder('AppData', 'layers', [
      leaf('Local', 38.4 * GB, 'folder', 'folder', 9.2 * GB),
      leaf('Roaming', 11.6 * GB, 'folder'),
      leaf('LocalLow', 1.9 * GB, 'folder'),
    ], HOME, 9.2 * GB),
    folder('Downloads', 'down', [
      leaf('Win11_24H2_English_x64.iso', 5.8 * GB, 'file', 'file', 5.8 * GB),
      leaf('ubuntu-24.04-desktop-amd64.iso', 5.7 * GB, 'file', 'file', 5.7 * GB),
      leaf('vs_community_installer_cache.zip', 2.9 * GB, 'file', 'file', 2.9 * GB),
      leaf('project-assets-final.zip', 1.7 * GB, 'file', 'file'),
      leaf('Blender-4.2-windows-x64.msi', 0.36 * GB, 'file', 'file', 0.36 * GB),
      leaf('其他下载', 6.9 * GB, 'folder', 'other', 3.94 * GB),
    ], HOME, 18.7 * GB),
    folder('Videos', 'video', [
      leaf('Family trip 2023 - raw.mp4', 4.6 * GB, 'video', 'file'),
      leaf('Screen Recording 2025-02-11.mp4', 2.3 * GB, 'video', 'file'),
      leaf('Captures', 9.8 * GB, 'game'),
      leaf('Wedding highlights.mp4', 640 * MB, 'video', 'file'),
      leaf('Edits', 6.1 * GB, 'folder'),
    ]),
    folder('Pictures', 'photo', [
      leaf('Camera Roll', 14.2 * GB, 'photo'),
      leaf('RAW', 7.9 * GB, 'photo'),
      leaf('Screenshots', 1.3 * GB, 'photo'),
      leaf('Imports', 3.4 * GB, 'photo'),
    ]),
    folder('Documents', 'doc', [
      leaf('Backups', 8.7 * GB, 'cloud'),
      leaf('Work', 5.2 * GB, 'folder'),
      leaf('Thesis - all drafts.pdf', 410 * MB, 'doc', 'file'),
      leaf('其他文档', 2.6 * GB, 'doc', 'other'),
    ]),
    folder('Music', 'music', [
      leaf('Library', 21.4 * GB, 'music'),
      leaf('Stems', 4.8 * GB, 'music'),
    ]),
    folder('Games', 'game', [
      leaf('Steam', 96.5 * GB, 'game'),
      leaf('Epic Games', 41.2 * GB, 'game'),
    ]),
    folder('OneDrive', 'cloud', [
      leaf('Pictures', 6.3 * GB, 'photo'),
      leaf('Documents', 2.2 * GB, 'doc'),
    ]),
    folder('source', 'code', [
      leaf('cleanly', 1.4 * GB, 'code'),
      leaf('website', 0.9 * GB, 'code'),
      leaf('experiments', 3.1 * GB, 'code'),
    ]),
    folder('Desktop', 'folder', [
      leaf('Wedding highlights.mp4', 640 * MB, 'video', 'file'),
      leaf('其他文件', 1.1 * GB, 'file', 'other'),
    ]),
  ];
  return {
    name: 'Alex',
    path: HOME,
    kind: 'folder',
    icon: 'user',
    size: children.reduce((a, c) => a + c.size, 0),
    reclaimable: children.reduce((a, c) => a + c.reclaimable, 0),
    children: children.sort((a, b) => b.size - a.size),
  };
}

/** [name, icon, size in bytes or children, kind, reclaimable] */
type Spec = [string, IconName, number | Spec[], SpaceNode['kind']?, number?];

function grow(parent: string, [name, icon, body, kind, reclaimable = 0]: Spec): SpaceNode {
  const path = parent.endsWith('\\') ? parent + name : join(parent, name);
  if (typeof body === 'number') return { name, path, size: body, kind: kind ?? 'folder', icon, reclaimable };
  const children = body.map((s) => grow(path, s)).sort((a, b) => b.size - a.size);
  const size = children.reduce((a, c) => a + c.size, 0);
  return { name, path, kind: 'folder', icon, size, reclaimable: Math.min(size, children.reduce((a, c) => a + c.reclaimable, 0) + reclaimable), children };
}

function driveTree(mount: string, name: string, specs: Spec[]): SpaceNode {
  const children = specs.map((s) => grow(mount, s)).sort((a, b) => b.size - a.size);
  return {
    name,
    path: mount,
    kind: 'folder',
    icon: 'chip',
    size: children.reduce((a, c) => a + c.size, 0),
    reclaimable: children.reduce((a, c) => a + c.reclaimable, 0),
    children,
  };
}

function initialDriveD(): SpaceNode {
  return driveTree(D, 'D:', [
    ['Games', 'game', [
      ['SteamLibrary', 'game', 212 * GB],
      ['Epic Games', 'game', 64 * GB],
      ['Installers', 'down', [
        ['Cyberpunk2077_setup_v2.1.exe', 'file', 1.2 * GB, 'file'],
        ['其他安装程序', 'down', 3.4 * GB, 'other'],
      ]],
    ]],
    ['Media', 'video', [
      ['Movies', 'video', [
        ['Dune Part Two (2024) 2160p.mkv', 'video', 18.6 * GB, 'file'],
        ['其他电影', 'video', 121 * GB],
      ]],
      ['Photo archive', 'photo', 88 * GB],
      ['Wedding highlights.mp4', 'video', 640 * MB, 'file'],
    ]],
    ['Backups', 'cloud', [
      ['System image 2024', 'layers', 96 * GB],
      ['phone-backup-2023-11.zip', 'layers', 6.2 * GB, 'file'],
    ]],
    ['Projects', 'code', 18 * GB],
    ['ISO', 'chip', [
      ['Windows Server 2022.iso', 'chip', 4.9 * GB, 'file'],
      ['其他映像', 'chip', 7.1 * GB, 'other'],
    ]],
    ['$RECYCLE.BIN', 'trash', 3.1 * GB, 'folder', 3.1 * GB],
  ]);
}

/** The whole system drive, with the live home tree nested under Users. */
function driveC(home: SpaceNode): SpaceNode {
  const c = driveTree('C:\\', 'C:', [
    ['Windows', 'layers', [
      ['System32', 'layers', 9.8 * GB],
      ['WinSxS', 'layers', 11.4 * GB],
      ['SoftwareDistribution', 'down', 2.1 * GB, 'folder', 2.1 * GB],
      ['其他系统文件', 'layers', 4.6 * GB, 'other'],
    ]],
    ['Program Files', 'apps', [
      ['NVIDIA Corporation', 'apps', 3.2 * GB],
      ['Docker', 'apps', 2.6 * GB],
      ['Blender Foundation', 'apps', 1.1 * GB],
      ['其他应用', 'apps', 7.4 * GB, 'other'],
    ]],
    ['Program Files (x86)', 'apps', 7.6 * GB],
    ['ProgramData', 'layers', 4.3 * GB],
    ['pagefile.sys', 'file', 6 * GB, 'file'],
    ['hiberfil.sys', 'file', 3.2 * GB, 'file'],
  ]);
  const users: SpaceNode = {
    name: 'Users',
    path: 'C:\\Users',
    kind: 'folder',
    icon: 'user',
    size: home.size + 0.6 * GB,
    reclaimable: home.reclaimable,
    children: [home, { name: 'Public', path: 'C:\\Users\\Public', kind: 'folder', icon: 'folder', size: 0.6 * GB, reclaimable: 0 }],
  };
  c.children = [...(c.children ?? []), users].sort((a, b) => b.size - a.size);
  c.size += users.size;
  c.reclaimable += users.reclaimable;
  return c;
}

function initialStartup(): StartupItem[] {
  const reg = '注册表（当前用户）';
  return [
    { id: 'discord', name: 'Discord', command: `"${HOME}\\AppData\\Local\\Discord\\Update.exe" --processStart Discord.exe`, location: reg, enabled: true, impact: 'high', canToggle: true, needsAdmin: false },
    { id: 'spotify', name: 'Spotify', command: `"${HOME}\\AppData\\Roaming\\Spotify\\Spotify.exe" --autostart --minimized`, location: reg, enabled: true, impact: 'high', canToggle: true, needsAdmin: false },
    { id: 'teams', name: 'Microsoft Teams', command: 'ms-teams.exe msteams:system-initiated', location: '启动应用（商店）', enabled: true, impact: 'high', canToggle: true, needsAdmin: false },
    { id: 'onedrive', name: 'OneDrive', command: `"${HOME}\\AppData\\Local\\Microsoft\\OneDrive\\OneDrive.exe" /background`, location: reg, enabled: true, impact: 'medium', canToggle: true, needsAdmin: false },
    { id: 'steam', name: 'Steam', command: '"C:\\Program Files (x86)\\Steam\\steam.exe" -silent', location: reg, enabled: false, impact: 'medium', canToggle: true, needsAdmin: false },
    { id: 'adobe-updater', name: 'Adobe Updater', command: '"C:\\Program Files (x86)\\Common Files\\Adobe\\ARM\\1.0\\AdobeARM.exe"', location: '注册表（所有用户）', enabled: true, impact: 'low', canToggle: true, needsAdmin: true },
    { id: 'google-updater', name: 'Google Updater', command: `"${HOME}\\AppData\\Local\\Google\\GoogleUpdater\\updater.exe" --wake`, location: '任务计划程序', enabled: true, impact: 'low', canToggle: true, needsAdmin: false },
    { id: 'edge-update', name: 'Microsoft Edge Update', command: '"C:\\Program Files (x86)\\Microsoft\\EdgeUpdate\\MicrosoftEdgeUpdate.exe" /c', location: '任务计划程序', enabled: true, impact: 'low', canToggle: true, needsAdmin: true },
    { id: 'security-health', name: 'Windows Security notification icon', command: '%windir%\\system32\\SecurityHealthSystray.exe', location: '注册表（所有用户）', enabled: true, impact: 'low', canToggle: true, needsAdmin: true },
  ];
}

function initialApps(): InstalledApp[] {
  const a = (name: string, publisher: string, version: string, sizeMb: number, installedDays: number, lastUsedDays: number | null, canUninstall = true): InstalledApp => ({
    id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name,
    publisher,
    version,
    size: sizeMb * MB,
    installed: now - installedDays * DAY,
    lastUsed: lastUsedDays === null ? undefined : now - lastUsedDays * DAY,
    path: `C:\\Program Files\\${name}`,
    // the browser demo has no icons; fileIcons() returns {} and the letter avatar shows
    iconPath: `C:\\Program Files\\${name}\\${name}.exe`,
    canUninstall,
  });
  return [
    a('Google Chrome', 'Google LLC', '131.0.6778.86', 612, 640, 0),
    a('Microsoft Edge', 'Microsoft Corporation', '131.0.2903.70', 540, 700, 3, false),
    a('Discord', 'Discord Inc.', '1.0.9173', 420, 520, 0),
    a('Spotify', 'Spotify AB', '1.2.52.442', 380, 480, 1),
    a('Microsoft Teams', 'Microsoft Corporation', '24295.605.3225.8804', 690, 300, 9),
    a('Visual Studio Code', 'Microsoft Corporation', '1.95.3', 410, 600, 0),
    a('Steam', 'Valve Corporation', '2.10.91.91', 1250, 900, 2),
    a('Epic Games Launcher', 'Epic Games, Inc.', '17.2.0', 980, 410, 64),
    a('Adobe Acrobat Reader', 'Adobe', '24.004.20272', 1100, 800, 41),
    a('Zoom Workplace', 'Zoom Video Communications', '6.2.11', 330, 520, 120),
    a('Slack', 'Slack Technologies', '4.41.105', 520, 450, 33),
    a('Notion', 'Notion Labs, Inc.', '3.17.0', 460, 380, 6),
    a('Figma', 'Figma, Inc.', '124.6.5', 360, 200, 18),
    a('Blender', 'Blender Foundation', '4.2.3', 1020, 120, 96),
    a('OBS Studio', 'OBS Project', '30.2.3', 450, 350, 72),
    a('VLC media player', 'VideoLAN', '3.0.21', 160, 1000, 150),
    a('7-Zip', 'Igor Pavlov', '24.08', 6, 1000, 25),
    a('Git', 'The Git Development Community', '2.47.0', 340, 600, 0),
    a('Node.js', 'OpenJS Foundation', '24.11.0', 105, 90, 0),
    a('Python 3.12', 'Python Software Foundation', '3.12.7', 210, 400, 12),
    a('Docker Desktop', 'Docker Inc.', '4.35.1', 2200, 260, 30),
    a('WinRAR', 'win.rar GmbH', '7.01', 9, 1200, 400),
    a('CCleaner', 'Piriform Software', '6.29', 95, 1100, 380),
    a('Logitech G HUB', 'Logitech', '2024.8.6', 610, 700, 210),
    a('NVIDIA App', 'NVIDIA Corporation', '11.0.1.163', 850, 150, 4, false),
    a('Microsoft OneDrive', 'Microsoft Corporation', '24.211.1020', 290, 900, 0, false),
  ];
}

function initialSettings(): Settings {
  return {
    aiProvider: 'claude',
    hasClaudeKey: false,
    hasOpenAiKey: false,
    background: 'mist',
    largeFileMinMb: 500,
    confirmBeforeClean: true,
  };
}

/** Subtract `bytes` from every node on the way to `path` and drop the node itself if it matches exactly. */
function removeFromTree(node: SpaceNode, path: string, bytes: number): boolean {
  const lower = path.toLowerCase();
  const self = node.path.toLowerCase();
  if (!(lower === self || lower.startsWith(self.endsWith('\\') ? self : self + '\\'))) return false;
  node.size = Math.max(0, node.size - bytes);
  node.reclaimable = Math.max(0, Math.min(node.size, node.reclaimable - bytes));
  if (node.children) {
    const exact = node.children.findIndex((c) => c.path.toLowerCase() === lower);
    if (exact >= 0) node.children.splice(exact, 1);
    else for (const c of node.children) if (removeFromTree(c, path, bytes)) break;
  }
  return true;
}

export function createMockApi(): CleanlyApi {
  const listeners = new Set<(p: ScanProgress) => void>();
  const emit = (p: ScanProgress) => listeners.forEach((cb) => cb(p));

  let junk = initialJunk();
  let large = initialLargeFiles();
  let dupes = initialDupes();
  const tree = initialSpaces();
  const treeD = initialDriveD();
  let startup = initialStartup();
  let apps = initialApps();
  let settings = initialSettings();
  const total = 512 * GB;
  let used = 389 * GB;
  const totalD = 1024 * GB;
  let usedD = treeD.size + 0.6 * GB;
  const onD = (p: string) => p.toUpperCase().startsWith(D);

  const system: SystemInfo = {
    platform: 'win32',
    arch: 'x64',
    osVersion: 'Windows 11 Pro (10.0.26100)',
    appVersion: '0.1.0',
    homeDir: HOME,
  };

  const disk = (): DiskInfo => ({ mount: 'C:\\', label: '磁盘 C:', total, used, free: total - used, system: true });
  const diskD = (): DiskInfo => ({ mount: D, label: '数据 D:', total: totalD, used: usedD, free: totalD - usedD, system: false });

  /** Steps through phases with small pauses, emitting progress as it goes. */
  async function walk(task: ScanProgress['task'], phases: { phase: string; current?: string }[], totalMs: number) {
    const step = totalMs / Math.max(1, phases.length);
    for (let i = 0; i < phases.length; i++) {
      emit({ task, phase: phases[i].phase, done: i, total: phases.length, current: phases[i].current });
      await new Promise((r) => setTimeout(r, step * (0.7 + Math.random() * 0.6)));
    }
    emit({ task, phase: '完成', done: phases.length, total: phases.length });
  }

  function sizeOf(path: string): number {
    const lf = large.find((f) => f.path === path);
    if (lf) return lf.size;
    const g = dupes.find((d) => d.files.some((f) => f.path === path));
    if (g) return g.size;
    const find = (n: SpaceNode): number => {
      if (n.path === path) return n.size;
      for (const c of n.children ?? []) {
        const s = find(c);
        if (s) return s;
      }
      return 0;
    };
    return find(onD(path) ? treeD : tree);
  }

  return {
    async system() {
      await wait(100, 300);
      return { ...system };
    },

    async disk() {
      await wait(150, 400);
      return disk();
    },

    async disks() {
      await wait(150, 400);
      return [disk(), diskD()];
    },

    async fileIcons(paths) {
      if (!Array.isArray(paths)) throw new Error('需要提供路径列表');
      await wait(20, 60);
      // no real icons in a browser; screens fall back to their glyphs
      return {};
    },

    async scanJunk() {
      await walk(
        'junk',
        junk.map((c) => ({ phase: c.name, current: c.locations[0] })),
        2200,
      );
      return clone(junk);
    },

    async cleanJunk(ids) {
      const picked = junk.filter((c) => ids.includes(c.id) && c.size > 0);
      let freed = 0;
      let removed = 0;
      let failed = 0;
      const skipped: string[] = [];
      for (let i = 0; i < picked.length; i++) {
        const c = picked[i];
        emit({ task: 'clean', phase: c.name, done: i, total: picked.length, current: c.locations[0] });
        await wait(350, 800);
        let bytes = c.size;
        if (c.id === 'user-temp') {
          // a few temp files are always held open by running apps
          failed += 14;
          bytes -= 38 * MB;
          skipped.push('14 个临时文件正在使用中，已跳过');
        }
        freed += bytes;
        removed += c.count;
      }
      emit({ task: 'clean', phase: '完成', done: picked.length, total: picked.length });
      junk = junk.map((c) => (ids.includes(c.id) ? { ...c, size: 0, count: 0 } : c));
      used = Math.max(0, used - freed);
      const appData = tree.children?.find((c) => c.name === 'AppData');
      const downloads = tree.children?.find((c) => c.name === 'Downloads');
      const appFreed = picked.filter((c) => ['user-temp', 'browser-caches', 'crash-reports', 'dev-caches'].includes(c.id)).reduce((a, c) => a + c.size, 0);
      // a path *inside* AppData\Local shrinks it and its parents without dropping the node
      if (appData && appFreed > 0) removeFromTree(tree, join(HOME, 'AppData', 'Local', 'x'), appFreed);
      if (downloads && picked.some((c) => c.id === 'old-downloads')) {
        const cut = downloads.reclaimable;
        downloads.children = (downloads.children ?? [])
          .filter((c) => c.reclaimable < c.size)
          .map((c) => ({ ...c, size: c.size - c.reclaimable, reclaimable: 0 }));
        downloads.size = Math.max(0, downloads.size - cut);
        downloads.reclaimable = 0;
        tree.size = Math.max(0, tree.size - cut);
        tree.reclaimable = Math.max(0, tree.reclaimable - cut);
        large = large.filter((f) => !(f.path.startsWith(join(HOME, 'Downloads')) && now - f.accessed > 90 * DAY));
      }
      const result: CleanResult = { freed, removed, failed, skipped };
      return result;
    },

    async scanSpaces(root) {
      if (root !== undefined && typeof root !== 'string') throw new Error('未知位置');
      const key = root?.replace(/[\\/]+$/, '').toUpperCase();
      const target = key === undefined ? tree : key === 'C:' ? driveC(clone(tree)) : key === 'D:' ? treeD : null;
      if (!target) throw new Error('该驱动器不可用');
      await walk(
        'spaces',
        (target.children ?? []).map((c) => ({ phase: `正在测量 ${c.name}`, current: c.path })),
        key ? 3400 : 2600,
      );
      return clone(target);
    },

    async scanLargeFiles(minBytes) {
      await walk('large', [{ phase: '下载' }, { phase: '视频' }, { phase: '文档' }, { phase: '图片' }, { phase: '其他所有内容' }, { phase: 'D 盘', current: D }], 1800);
      return clone(large.filter((f) => f.size >= minBytes).sort((a, b) => b.size - a.size));
    },

    async scanDuplicates() {
      await walk('dupes', [{ phase: '正在列出文件' }, { phase: '正在按大小分组' }, { phase: '正在比较内容' }], 1800);
      return clone(dupes.filter((g) => g.files.length > 1));
    },

    async trashPaths(paths) {
      await wait(400, 1000);
      let freed = 0;
      let removed = 0;
      for (const p of paths) {
        const bytes = sizeOf(p);
        if (!bytes) continue;
        freed += bytes;
        removed++;
        large = large.filter((f) => f.path !== p);
        dupes = dupes
          .map((g) => ({ ...g, files: g.files.filter((f) => f.path !== p) }))
          .filter((g) => g.files.length > 1);
        if (onD(p)) {
          removeFromTree(treeD, p, bytes);
          usedD = Math.max(0, usedD - bytes);
        } else {
          removeFromTree(tree, p, bytes);
          used = Math.max(0, used - bytes);
        }
      }
      const failed = paths.length - removed;
      return { freed, removed, failed, skipped: failed ? [`${failed} 个项目未找到`] : [] };
    },

    async revealPath() {
      await wait(50, 120);
    },

    async startupItems() {
      await wait();
      return clone(startup);
    },

    async setStartupItem(id, enabled) {
      const item = startup.find((s) => s.id === id);
      if (!item) throw new Error('该启动项已不存在');
      if (!item.canToggle) throw new Error(`${item.name} 由 Windows 管理，无法在此修改`);
      // stands in for the administrator prompt
      await (item.needsAdmin ? wait(900, 1400) : wait(300, 700));
      startup = startup.map((s) => (s.id === id ? { ...s, enabled } : s));
      return clone(startup);
    },

    async installedApps() {
      await walk('apps', [{ phase: '正在读取已安装的程序' }, { phase: '正在测量大小' }], 1100);
      return clone(apps);
    },

    async uninstallApp(id) {
      await wait(800, 1200);
      const app = apps.find((a) => a.id === id);
      if (!app) return { ok: false, message: '该应用已不再安装' };
      if (!app.canUninstall) return { ok: false, message: `${app.name} 是 Windows 的一部分，无法在此移除` };
      apps = apps.filter((a) => a.id !== id);
      if (app.size) used = Math.max(0, used - app.size);
      return { ok: true, message: `${app.name} 已卸载` };
    },

    async protection() {
      await wait(400, 900);
      const status: ProtectionStatus = {
        provider: 'Microsoft Defender',
        enabled: true,
        realtime: true,
        firewall: true,
        definitionsUpdated: now - 5 * HOUR,
        lastScan: now - 2 * DAY,
        score: 92,
        notes: ['实时保护已开启', '病毒库已是最新', '上次快速扫描在 2 天前'],
      };
      return status;
    },

    async getSettings() {
      await wait(80, 200);
      return { ...settings };
    },

    async setSettings(patch) {
      await wait(80, 250);
      settings = { ...settings, ...patch };
      return { ...settings };
    },

    async setApiKey(provider, key) {
      await wait(200, 500);
      const has = !!key && key.trim().length > 0;
      settings = provider === 'claude' ? { ...settings, hasClaudeKey: has } : { ...settings, hasOpenAiKey: has };
      return { ...settings };
    },

    async askAi(question, context) {
      await wait(900, 1200);
      const safeJunk = (context.junk ?? []).filter((j) => j.size > 0);
      const bigOnes = (context.largeFiles ?? []).slice().sort((a, b) => b.size - a.size).slice(0, 3);
      const gb = (n: number) => `${(n / GB).toFixed(1)} GB`;
      const junkTotal = safeJunk.reduce((a, j) => a + j.size, 0);
      const parts: string[] = [];
      if (question.trim()) parts.push(`关于“${question.trim().slice(0, 80)}”，我会这样处理。`);
      if (junkTotal > 0) parts.push(`缓存和临时文件共计 ${gb(junkTotal)}。应用会自行重建它们，因此清理它们是安全的。`);
      if (bigOnes.length) parts.push(`你最大的几个文件是数月未打开的安装程序和磁盘映像。删除前请先确认；它们会先移至回收站。`);
      if (context.disk) parts.push(`之后你将有约 ${gb(context.disk.free + junkTotal)} 的可用空间。`);
      parts.push('除非你清楚其用途，否则不要动 AppData\\Roaming 以及 Documents 下的任何内容。');
      const advice: AiAdvice = {
        answer: parts.join(' '),
        suggestions: [
          ...safeJunk.slice(0, 3).map((j) => ({ path: j.locations[0] ?? j.name, verdict: 'safe' as const, reason: `${j.name}：会自动重新生成` })),
          ...bigOnes.map((f) => ({ path: f.path, verdict: 'review' as const, reason: `${gb(f.size)}，上次修改在 ${Math.round((now - f.modified) / DAY)} 天前` })),
          { path: tilde(join(HOME, 'Documents')), verdict: 'keep' as const, reason: '你自己的工作文件。只删除你认识的文件。' },
        ],
        provider: settings.aiProvider,
      };
      return advice;
    },

    async tipsProfile() {
      await wait(300, 700);
      const profile: TipsProfile = {
        name: 'Beyond Apps',
        tagline: '小巧、诚实、无广告的应用',
        currency: 'usd',
        presets: [5, 10, 25, 50],
        min: 1,
        max: 1000,
        supporterCount: 128,
      };
      return profile;
    },

    async startTip(req) {
      if (!Number.isFinite(req.amount) || req.amount < 1 || req.amount > 1000) throw new Error('请选择 $1 到 $1,000 之间的金额');
      await wait(500, 900);
      const url = 'https://beyond-media.ai/tips?creator=beyond-apps';
      window.open(url, '_blank', 'noopener,noreferrer');
      return { url };
    },

    async sendFeedback(payload) {
      if (payload.message.trim().length < 3) throw new Error('请再多写几个字');
      await wait(600, 1100);
      const result: FeedbackResult = { ok: true, via: 'saved', message: '演示模式：你的反馈仅保存在此浏览器标签页中。' };
      return result;
    },

    async openExternal(url) {
      try {
        if (new URL(url).protocol === 'https:') window.open(url, '_blank', 'noopener,noreferrer');
      } catch {
        /* ignore malformed links */
      }
    },

    onProgress(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}
