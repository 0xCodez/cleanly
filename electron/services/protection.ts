import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ProtectionStatus } from '../../shared/types';

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function run(file: string, args: string[], timeout = 15000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

const DAY = 24 * 60 * 60 * 1000;

function age(ms: number): string {
  const days = Math.floor((Date.now() - ms) / DAY);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  return `${days} 天前`;
}

function freshness(ms: number | null, fresh: number, stale: number, points: number): number {
  if (ms === null) return 0;
  const days = (Date.now() - ms) / DAY;
  if (days <= fresh) return points;
  if (days <= stale) return Math.round(points / 2);
  return 0;
}

/* ---------- Windows ---------- */

interface WinRaw {
  mp?: {
    AntivirusEnabled?: boolean;
    RealTimeProtectionEnabled?: boolean;
    AMRunningMode?: string;
    SigUpdated?: number | null;
    QuickScan?: number | null;
    FullScan?: number | null;
  } | null;
  av?: { name?: string; state?: number }[] | null;
  fw?: { Name?: string; Enabled?: boolean }[] | null;
}

// Dates are converted to epoch ms inside PowerShell; Windows PowerShell 5.1 serializes DateTime as "\/Date(...)\/".
const WIN_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
function ms($d) { if ($d -and $d.Year -gt 1601) { ([DateTimeOffset]$d).ToUnixTimeMilliseconds() } else { $null } }
$s = Get-MpComputerStatus
$mp = $null
if ($s) {
  $mp = [pscustomobject]@{
    AntivirusEnabled = [bool]$s.AntivirusEnabled
    RealTimeProtectionEnabled = [bool]$s.RealTimeProtectionEnabled
    AMRunningMode = [string]$s.AMRunningMode
    SigUpdated = ms $s.AntivirusSignatureLastUpdated
    QuickScan = ms $s.QuickScanEndTime
    FullScan = ms $s.FullScanEndTime
  }
}
$av = @(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct | ForEach-Object {
  [pscustomobject]@{ name = [string]$_.displayName; state = [int]$_.productState }
})
$fw = @(Get-NetFirewallProfile | ForEach-Object {
  [pscustomobject]@{ Name = [string]$_.Name; Enabled = ([string]$_.Enabled -eq 'True') }
})
[pscustomobject]@{ mp = $mp; av = $av; fw = $fw } | ConvertTo-Json -Depth 4 -Compress
`;

/** Security Center productState: bits 12-15 of the value are 1 when the product is on. */
const avIsOn = (state?: number) => typeof state === 'number' && ((state >> 12) & 0xf) === 1;
const avUpToDate = (state?: number) => typeof state === 'number' && ((state >> 4) & 0xf) === 0;
const isDefender = (name?: string) => /defender/i.test(name ?? '');

function asArray<T>(v: T[] | T | null | undefined): T[] {
  if (Array.isArray(v)) return v;
  return v ? [v] : [];
}

async function windowsStatus(): Promise<ProtectionStatus> {
  const res = await run(path.join(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WIN_SCRIPT], 30000);
  let raw: WinRaw = {};
  try {
    const json = res.stdout.trim();
    raw = json ? (JSON.parse(json) as WinRaw) : {};
  } catch {
    raw = {};
  }
  const notes: string[] = [];
  const mp = raw.mp ?? null;
  const avs = asArray(raw.av);
  const thirdParty = avs.filter((a) => a.name && !isDefender(a.name) && avIsOn(a.state));
  const defenderActive = Boolean(mp?.AntivirusEnabled) && !/passive|edr|not running/i.test(mp?.AMRunningMode ?? '');

  let provider = 'Microsoft Defender';
  let enabled = false;
  let realtime: boolean | null = null;
  let definitionsUpdated: number | null = null;
  let lastScan: number | null = null;

  if (thirdParty.length > 0) {
    provider = thirdParty[0].name!;
    enabled = true;
    realtime = true;
    notes.push(`${provider} 正在保护这台电脑`);
    notes.push(avUpToDate(thirdParty[0].state) ? '病毒库已是最新' : '病毒库可能已过期');
  } else if (mp) {
    enabled = defenderActive;
    realtime = defenderActive && Boolean(mp.RealTimeProtectionEnabled);
    definitionsUpdated = mp.SigUpdated ?? null;
    const scans = [mp.QuickScan, mp.FullScan].filter((t): t is number => typeof t === 'number');
    lastScan = scans.length ? Math.max(...scans) : null;
    notes.push(enabled ? '防病毒已开启' : '防病毒已关闭');
    notes.push(realtime ? '实时保护已开启' : '实时保护已关闭');
    if (definitionsUpdated !== null) notes.push(`病毒库更新：${age(definitionsUpdated)}`);
    notes.push(lastScan !== null ? `上次扫描：${age(lastScan)}` : '暂无扫描记录');
  } else if (avs.length > 0) {
    const any = avs.find((a) => avIsOn(a.state)) ?? avs[0];
    provider = any.name ?? provider;
    enabled = avIsOn(any.state);
    realtime = enabled;
    notes.push(enabled ? `${provider} 已开启` : `${provider} 已关闭`);
  } else {
    notes.push('无法读取防病毒状态');
  }

  const profiles = asArray(raw.fw).filter((p) => p.Name);
  let firewall: boolean | null = null;
  let firewallShare = 0;
  if (profiles.length > 0) {
    const off = profiles.filter((p) => !p.Enabled);
    firewall = off.length === 0;
    firewallShare = (profiles.length - off.length) / profiles.length;
    if (off.length === 0) notes.push('防火墙已开启');
    else if (off.length === profiles.length) notes.push('防火墙已关闭');
    else for (const p of off) notes.push(`${p.Name} 网络的防火墙已关闭`);
  } else {
    notes.push('无法读取防火墙状态');
  }

  const score = Math.round(
    (enabled ? 35 : 0)
    + (realtime ? 25 : 0)
    + 20 * firewallShare
    + (thirdParty.length > 0 ? (avUpToDate(thirdParty[0].state) ? 10 : 0) : freshness(definitionsUpdated, 3, 14, 10))
    + (thirdParty.length > 0 ? 10 : freshness(lastScan, 14, 45, 10)),
  );
  return { provider, enabled, realtime, firewall, definitionsUpdated, lastScan, score: clamp(score), notes };
}

/* ---------- macOS ---------- */

const XPROTECT_PLISTS = [
  '/Library/Apple/System/Library/CoreServices/XProtect.bundle/Contents/Info.plist',
  '/private/var/protected/xprotect/XProtect.bundle/Contents/Info.plist',
  '/System/Library/CoreServices/XProtect.bundle/Contents/Info.plist',
];

async function xprotect(): Promise<{ version: string; updated: number } | null> {
  let best: { version: string; updated: number } | null = null;
  for (const plist of XPROTECT_PLISTS) {
    let updated: number;
    try {
      updated = (await fs.stat(plist)).mtimeMs;
    } catch {
      continue;
    }
    const res = await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist], 5000);
    const version = res.ok ? res.stdout.trim() : '';
    if (!best || updated > best.updated) best = { version, updated };
  }
  return best;
}

async function macStatus(): Promise<ProtectionStatus> {
  const [gk, fw, sip, xp] = await Promise.all([
    run('/usr/sbin/spctl', ['--status'], 8000),
    run('/usr/libexec/ApplicationFirewall/socketfilterfw', ['--getglobalstate'], 8000),
    run('/usr/bin/csrutil', ['status'], 8000),
    xprotect(),
  ]);
  const notes: string[] = [];

  const gkText = `${gk.stdout} ${gk.stderr}`;
  const gatekeeper: boolean | null = /assessments enabled/i.test(gkText) ? true : /assessments disabled/i.test(gkText) ? false : null;
  notes.push(gatekeeper === null ? '无法读取 Gatekeeper 状态' : gatekeeper ? 'Gatekeeper 已开启' : 'Gatekeeper 已关闭');

  const fwText = fw.stdout;
  const firewall: boolean | null = /enabled|State = [12]/i.test(fwText) ? true : /disabled|State = 0/i.test(fwText) ? false : null;
  notes.push(firewall === null ? '无法读取防火墙状态' : firewall ? '防火墙已开启' : '防火墙已关闭');

  const sipText = sip.stdout;
  const sipOn: boolean | null = /status:\s*enabled/i.test(sipText) ? true : /status:\s*disabled/i.test(sipText) ? false : null;
  if (sipOn !== null) notes.push(sipOn ? '系统完整性保护已开启' : '系统完整性保护已关闭');

  if (xp) notes.push(`XProtect${xp.version ? ` ${xp.version}` : ''} 更新：${age(xp.updated)}`);
  else notes.push('找不到 XProtect');

  const enabled = Boolean(xp) && gatekeeper !== false;
  const score = Math.round(
    (gatekeeper ? 30 : 0)
    + (xp ? 20 : 0)
    + (sipOn === false ? 0 : sipOn ? 25 : 12)
    + (firewall ? 15 : 0)
    + freshness(xp?.updated ?? null, 30, 90, 10),
  );
  return {
    provider: 'XProtect + Gatekeeper',
    enabled,
    realtime: xp ? true : null,
    firewall,
    definitionsUpdated: xp?.updated ?? null,
    lastScan: null,
    score: clamp(score),
    notes,
  };
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, n));
}

export async function getProtection(): Promise<ProtectionStatus> {
  try {
    if (process.platform === 'win32') return await windowsStatus();
    if (process.platform === 'darwin') return await macStatus();
  } catch {
    // Fall through to the unknown status below.
  }
  return {
    provider: '未知',
    enabled: false,
    realtime: null,
    firewall: null,
    definitionsUpdated: null,
    lastScan: null,
    score: 0,
    notes: ['此系统无法获取防护状态'],
  };
}
