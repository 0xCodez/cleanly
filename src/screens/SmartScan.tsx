import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { InstalledApp, ProtectionStatus, StartupItem } from '../../shared/types';
import { api } from '../api';
import { Bubbles, type BubbleDatum } from '../components/Bubbles';
import { Flow } from '../components/Flow';
import { Icon } from '../components/Icon';
import { CleanButton, Progress } from '../components/ui';
import { formatBytes, splitBytes, sum, timeAgo } from '../lib/format';
import { useStore } from '../state';
import './SmartScan.css';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
const MB = 1024 * 1024;
const SIX_MONTHS = 182 * 24 * 60 * 60 * 1000;

// The main column remounts on every screen switch, so anything that should survive a visit lives here.
const memo: {
  startup?: StartupItem[];
  protection?: ProtectionStatus;
  apps?: InstalledApp[];
} = {};

const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/** Eases a number toward its target on requestAnimationFrame. */
function useEased(target: number): number {
  const [shown, setShown] = useState(() => (reduceMotion() ? target : 0));
  const cur = useRef(shown);

  useEffect(() => {
    if (reduceMotion()) {
      cur.current = target;
      setShown(target);
      return;
    }
    const from = cur.current;
    const eps = Math.max(1, Math.abs(target - from) * 0.0005);
    let last = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const diff = target - cur.current;
      cur.current = Math.abs(diff) <= eps ? target : cur.current + diff * (1 - Math.exp(-dt * 5));
      setShown(cur.current);
      if (cur.current !== target) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);

  return shown;
}

/** Formats an in-between value in the unit of the final value, so the unit does not flicker mid-count. */
function eased(shown: number, target: number): { value: string; unit: string } {
  const t = splitBytes(target);
  const i = Math.max(0, UNITS.indexOf(t.unit));
  const decimals = t.value.includes('.') || target <= 0 ? 1 : 0;
  return { value: (Math.max(0, shown) / 1024 ** i).toFixed(decimals), unit: t.unit };
}

function useNow(every: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(id);
  }, [every]);
  return now;
}

type Loaded<T> = { data: T | null; error: boolean };

/** Loads one card's data on its own; shows the cached value from the last visit meanwhile. */
function useCardData<K extends 'startup' | 'protection' | 'apps'>(key: K, load: () => Promise<NonNullable<(typeof memo)[K]>>): Loaded<NonNullable<(typeof memo)[K]>> {
  const [state, setState] = useState<Loaded<NonNullable<(typeof memo)[K]>>>(() => ({ data: memo[key] ?? null, error: false }));
  const loadRef = useRef(load);

  useEffect(() => {
    let alive = true;
    loadRef
      .current()
      .then((data) => {
        memo[key] = data;
        if (alive) setState({ data, error: false });
      })
      .catch(() => {
        if (alive) setState((s) => ({ data: s.data, error: s.data === null }));
      });
    return () => {
      alive = false;
    };
  }, [key]);

  return state;
}

// custom properties feed the keyframes in app.css
type Vars = CSSProperties & Record<`--${string}`, string>;

const PARTICLES: Vars[] = [
  { left: '2%', top: 18, width: 12, height: 12, filter: 'blur(3px)', '--fd': '2.4s' },
  { left: '16%', top: 6, width: 9, height: 9, filter: 'blur(2px)', '--fd': '3s', '--fdl': '-0.6s' },
  { left: '30%', top: 20, width: 14, height: 14, filter: 'blur(4px)', '--fd': '2.7s', '--fdl': '-1.2s' },
  { left: '44%', top: 4, width: 8, height: 8, filter: 'blur(1px)', '--fd': '2.2s', '--fdl': '-0.3s' },
  { left: '57%', top: 18, width: 12, height: 12, filter: 'blur(3px)', '--fd': '3.2s', '--fdl': '-1.8s' },
  { left: '71%', top: 8, width: 10, height: 10, filter: 'blur(2px)', '--fd': '2.6s', '--fdl': '-0.9s' },
  { left: '85%', top: 20, width: 13, height: 13, filter: 'blur(4px)', '--fd': '2.9s', '--fdl': '-2.1s' },
];

const EMBERS: Vars[] = [
  { left: '18%', '--ed': '3.2s', '--edl': '0s' },
  { left: '36%', '--ed': '2.6s', '--edl': '-1.1s' },
  { left: '55%', '--ed': '3.6s', '--edl': '-2s' },
  { left: '72%', '--ed': '2.9s', '--edl': '-0.6s' },
  { left: '88%', '--ed': '3.4s', '--edl': '-1.7s' },
];

/** Compact badge text: 18.7 GB -> "−18.7G", 340 MB -> "−340M". */
function shortBadge(bytes: number): string {
  const { value, unit } = splitBytes(bytes);
  return `−${value}${unit.charAt(0)}`;
}

const delay = (s: number): CSSProperties => ({ animationDelay: `${s}s` });

export default function SmartScan() {
  const {
    go,
    junk,
    spaces,
    spacesScanning,
    spacesError,
    scanSpaces,
    reclaimable,
    scanning,
    progress,
    lastScanAt,
    cleaning,
    cleanPulse,
    lastCleanAt: cleanedAt,
    settings,
    smartScan,
    cleanJunk,
    toast,
  } = useStore();
  const now = useNow(30_000);

  const afterClean = !scanning && cleanedAt !== null && (lastScanAt === null || cleanedAt >= lastScanAt);
  const allClear = afterClean && reclaimable === 0;
  // with nothing to clean the capsule offers a rescan instead of sitting there disabled
  const nothingLeft = !!lastScanAt && !scanning && !cleaning && junk !== null && reclaimable === 0;

  const safe = useMemo(() => (junk ?? []).filter((c) => c.safe && c.size > 0), [junk]);
  const safeIds = useMemo(() => safe.map((c) => c.id), [safe]);
  const itemCount = sum(safe.map((c) => c.count));
  const canClean = !scanning && !cleaning && safeIds.length > 0;

  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(t);
  }, [armed]);

  const clean = useCallback(async () => {
    if (!canClean) return;
    if ((settings?.confirmBeforeClean ?? true) && !armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    const res = await cleanJunk(safeIds);
    if (!res) return;
    const note = res.skipped.length ? ` · ${res.skipped.slice(0, 2).join(', ')}` : res.failed ? ` · ${res.failed} 个正在使用，已跳过` : '';
    toast(`已释放 ${formatBytes(res.freed)}${note}`);
  }, [canClean, settings, armed, cleanJunk, safeIds, toast]);

  const rescan = useCallback(() => {
    void smartScan();
  }, [smartScan]);

  // Enter cleans, like the concept's hint says, unless focus is on something that handles Enter itself
  const cleanRef = useRef(clean);
  useEffect(() => {
    cleanRef.current = clean;
  }, [clean]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.repeat || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && t !== document.body && t.closest('button, a, input, textarea, select, [contenteditable="true"], [role="button"]')) return;
      void cleanRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const shown = useEased(reclaimable);
  const big = eased(shown, reclaimable);

  // eyebrow
  const phase = progress && (progress.task === 'junk' || progress.task === 'clean') ? progress.phase : null;
  let eyebrow: string;
  let dot = '';
  if (cleaning) {
    eyebrow = phase ? `正在清理 · ${phase}` : '正在清理…';
    dot = 'busy';
  } else if (scanning) {
    eyebrow = phase ? `正在扫描 · ${phase}` : '正在扫描…';
    dot = 'busy';
  } else if (afterClean && cleanedAt !== null) {
    eyebrow = `${allClear ? '全部清理完成' : '已清理'} · ${timeAgo(cleanedAt, now)}`;
  } else if (lastScanAt) {
    eyebrow = `扫描完成 · ${new Date(lastScanAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
  } else {
    eyebrow = '尚未扫描';
    dot = 'idle';
  }

  const busyProgress = (scanning || cleaning) && progress && progress.total > 0 ? progress.done / progress.total : undefined;

  let hint: string;
  if (cleaning) hint = '正在删除缓存和临时文件…';
  else if (scanning) hint = '正在查找缓存和临时文件…';
  else if (armed) hint = '缓存将被永久删除 · 再次点击确认';
  else if (itemCount) hint = `${itemCount.toLocaleString('zh-CN')} 项 · ${safeIds.length} 个分组 · 按 ↵ 清理`;
  else if (lastScanAt) hint = '目前没有可安全删除的内容';
  else hint = '运行扫描，看看哪些可以清理';

  let ctaLabel = '清理';
  let ctaSub = reclaimable > 0 ? formatBytes(reclaimable) : '无需清理';
  if (cleaning) [ctaLabel, ctaSub] = ['正在清理', formatBytes(reclaimable)];
  else if (scanning) [ctaLabel, ctaSub] = ['正在扫描', phase ?? '请稍候'];
  else if (armed) [ctaLabel, ctaSub] = ['确认清理？', `永久删除 ${formatBytes(reclaimable)}`];
  else if (nothingLeft) [ctaLabel, ctaSub] = ['重新扫描', allClear ? '全部清理完成' : '无需清理'];
  else if (!lastScanAt) [ctaLabel, ctaSub] = ['扫描', '查找垃圾文件'];

  const ctaAction = nothingLeft || (!lastScanAt && !scanning) ? rescan : clean;
  const ctaDisabled = !nothingLeft && !!lastScanAt && !canClean;

  // space map
  const bubbles = useMemo<BubbleDatum[]>(() => {
    const kids = [...(spaces?.children ?? [])].filter((n) => n.size > 0).sort((a, b) => b.size - a.size);
    const badge = (r: number) => (!afterClean && r > 100 * MB ? shortBadge(r) : undefined);
    const out: BubbleDatum[] = kids.slice(0, 7).map((n) => ({ id: n.path, name: n.name, size: n.size, icon: n.icon, badge: badge(n.reclaimable) }));
    const rest = kids.slice(7);
    if (rest.length) {
      out.push({
        id: '__more',
        name: `+${rest.length} 更多`,
        size: sum(rest.map((n) => n.size)),
        icon: 'more',
        badge: badge(sum(rest.map((n) => n.reclaimable))),
      });
    }
    return out;
  }, [spaces, afterClean]);
  const hasBadges = bubbles.some((b) => b.badge);

  // live cards
  const startup = useCardData('startup', () => api.startupItems());
  const protection = useCardData('protection', () => api.protection());
  const apps = useCardData('apps', () => api.installedApps());

  const startupItems = startup.data;
  const enabledItems = startupItems?.filter((i) => i.enabled) ?? [];
  const heavy = enabledItems.filter((i) => i.impact === 'high').length;
  const share = startupItems?.length ? enabledItems.length / startupItems.length : 0;
  const sliderFill: CSSProperties = { width: `max(24px, calc((100% - 10px) * ${share}))` };
  const sliderKnob: CSSProperties = { left: `clamp(2px, calc((100% - 10px) * ${share} - 25px), calc(100% - 36px))` };

  const appList = apps.data;
  const usageKnown = appList?.some((a) => a.lastUsed) ?? false;
  const stale = appList?.filter((a) => a.lastUsed && now - a.lastUsed > SIX_MONTHS).length ?? 0;
  const appsSub = !appList
    ? ''
    : usageKnown
      ? stale
        ? `${stale} 个超过 6 个月未使用`
        : '近 6 个月内均有使用'
      : '已安装在此电脑上';

  const prot = protection.data;
  const protSub = prot ? (prot.notes[0] ?? `${prot.provider} 已${prot.enabled ? '开启' : '关闭'}`) : '';
  const openProtection = () => go('protection');
  const onProtKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openProtection();
    }
  };

  return (
    <div className="screen home">
      <div className="home-top">
        <section className="hero card-w rise" style={delay(0.08)} aria-label="扫描结果">
          <div className="hero-plume">
            <Flow mode="plume" calm={afterClean} pulse={cleanPulse} />
          </div>
          <div className="hero-in">
            <span className="eyebrow" title={eyebrow}>
              <span className={`dot ${dot}`} />
              <span className="eyebrow-t">{eyebrow}</span>
            </span>
            <h1>{afterClean ? '待清理' : '可释放空间'}</h1>
            <div className="big" aria-live="polite">
              <span>{big.value}</span> <small>{big.unit}</small>
            </div>
            <p>缓存和临时文件将被永久删除——它们会自动重建。你的个人文件始终会移至回收站。</p>
            <div className="actions">
              <CleanButton
                label={ctaLabel}
                sub={ctaSub}
                icon={!lastScanAt && !scanning ? 'scan' : 'broom'}
                busy={cleaning || scanning}
                done={nothingLeft}
                disabled={ctaDisabled}
                onClick={() => void ctaAction()}
              />
              <div className="act-text">
                <button type="button" className="link" onClick={() => go('cleanup')}>
                  查看将删除的内容 <Icon name="arrow" size={16} />
                </button>
                <span className="hint">{hint}</span>
                {(scanning || cleaning) && (
                  <div className="hero-progress">
                    <Progress value={busyProgress} />
                  </div>
                )}
                {armed && (
                  <button type="button" className="cancel" onClick={() => setArmed(false)}>
                    取消
                  </button>
                )}
              </div>
            </div>
          </div>
        </section>

        <section className="map card-w rise" style={delay(0.16)} aria-label="空间地图">
          <div className="map-head">
            <b>空间地图</b>
            <button type="button" className="link" onClick={() => go('spaces')}>
              打开 ›
            </button>
          </div>
          <div className="map-body">
            {spaces ? (
              bubbles.length ? (
                <Bubbles items={bubbles} onSelect={() => go('spaces')} />
              ) : (
                <div className="map-empty">暂无可显示的文件夹</div>
              )
            ) : spacesError && !spacesScanning ? (
              <div className="map-empty">
                <button type="button" className="btn small" onClick={() => void scanSpaces()}>
                  <Icon name="scan" /> 重新测量
                </button>
              </div>
            ) : (
              <div className="map-skel" aria-hidden="true">
                <i style={{ left: '22%', top: '30%', width: 150, height: 150 }} />
                <i style={{ left: '64%', top: '22%', width: 104, height: 104, animationDelay: '-0.4s' }} />
                <i style={{ left: '70%', top: '64%', width: 120, height: 120, animationDelay: '-0.9s' }} />
                <i style={{ left: '30%', top: '74%', width: 84, height: 84, animationDelay: '-1.3s' }} />
                <i style={{ left: '48%', top: '50%', width: 62, height: 62, animationDelay: '-0.7s' }} />
              </div>
            )}
          </div>
          <div className="map-foot">
            {spaces ? (
              hasBadges ? (
                <>
                  <i className="hot-key" />
                  <span>角标：此处可释放的空间</span>
                </>
              ) : (
                <span>{afterClean ? '没有需要清理的文件夹了' : '气泡大小表示占用空间'}</span>
              )
            ) : spacesError && !spacesScanning ? (
              <span>无法测量你的文件夹</span>
            ) : (
              <>
                <span className="spinner" />
                <span>正在测量文件夹…</span>
              </>
            )}
          </div>
        </section>
      </div>

      <div className="home-cards">
        <article className={`lc c-clean rise${afterClean ? ' calm' : ''}`} style={delay(0.24)}>
          <span className="glow" style={{ left: 40, top: -70, '--bd': '5s' } as Vars} />
          {EMBERS.map((s, i) => (
            <i key={i} className="ember" style={s} />
          ))}
          <div className="lc-top">
            <span className="glass-ico">
              <Icon name="broom" />
            </span>
            <b>清理</b>
          </div>
          <div className="lc-num">
            {junk ? (
              <>
                <strong>{big.value}</strong>
                <em>{big.unit}</em>
              </>
            ) : (
              <span className="lc-skel" />
            )}
          </div>
          <div className="lc-sub">{allClear ? '缓存和临时文件已删除' : '缓存 · 临时文件 · 回收站'}</div>
          <div className="lc-foot">
            {allClear ? (
              <span className="pill done">
                <Icon name="check" />
                已删除
              </span>
            ) : (
              <button type="button" className="pill" onClick={() => void clean()} disabled={!canClean}>
                {cleaning ? (
                  <>
                    <span className="spinner pill-spin" />
                    正在删除
                  </>
                ) : armed ? (
                  <>
                    确认 <Icon name="check" />
                  </>
                ) : (
                  <>
                    删除 <Icon name="arrow" />
                  </>
                )}
              </button>
            )}
          </div>
        </article>

        <article className="lc c-speed rise" style={delay(0.3)}>
          <span className="glow" style={{ left: 20, top: 80, '--bd': '6s' } as Vars} />
          <div className="lc-top">
            <span className="glass-ico">
              <Icon name="gauge" />
            </span>
            <b>启动加速</b>
          </div>
          <div className="lc-num">
            {startupItems ? (
              <>
                <strong>{heavy}</strong>
                <em>个高影响应用</em>
              </>
            ) : startup.error ? (
              <strong>—</strong>
            ) : (
              <span className="lc-skel" />
            )}
          </div>
          <div className="lc-sub">
            {startupItems
              ? `登录时 · 已启用 ${startupItems.length} 项中的 ${enabledItems.length} 项`
              : startup.error
                ? '无法读取登录项'
                : '正在检查登录项…'}
          </div>
          <div className="lc-foot">
            <button
              type="button"
              className={`slider${startupItems ? '' : ' loading'}`}
              aria-label="管理登录时启动的应用"
              onClick={() => go('speed')}
            >
              <span className="fill" style={sliderFill} />
              <span className="knob" style={sliderKnob} />
            </button>
          </div>
        </article>

        <article
          className="lc c-prot rise tap"
          style={delay(0.36)}
          role="button"
          tabIndex={0}
          aria-label="打开安全防护"
          onClick={openProtection}
          onKeyDown={onProtKey}
        >
          <span className="glow" style={{ left: 0, top: 100, '--bd': '7s' } as Vars} />
          <div className="lc-top">
            <span className="glass-ico">
              <Icon name="shield" />
            </span>
            <b>安全防护</b>
          </div>
          <div className="lc-num">
            {prot ? (
              <>
                <strong>{Math.round(prot.score)}</strong>
                <em>/ 100</em>
              </>
            ) : protection.error ? (
              <strong>—</strong>
            ) : (
              <span className="lc-skel" />
            )}
          </div>
          <div className="lc-sub" title={protSub}>
            {prot ? protSub : protection.error ? '无法读取防护状态' : '正在检查防护状态…'}
          </div>
          <div className="lc-foot parts" aria-hidden="true">
            {PARTICLES.map((s, i) => (
              <i key={i} style={s} />
            ))}
          </div>
        </article>

        <article className="lc c-apps rise" style={delay(0.42)}>
          <span className="glow" style={{ left: 60, top: -60, '--bd': '6.5s' } as Vars} />
          <span className="shine" />
          <div className="lc-top">
            <span className="glass-ico">
              <Icon name="apps" />
            </span>
            <b>应用程序</b>
          </div>
          <div className="lc-num">
            {appList ? (
              <>
                <strong>{appList.length}</strong>
                <em>个应用</em>
              </>
            ) : apps.error ? (
              <strong>—</strong>
            ) : (
              <span className="lc-skel" />
            )}
          </div>
          <div className="lc-sub">{appList ? appsSub : apps.error ? '无法列出应用' : '正在列出已安装的应用…'}</div>
          <div className="lc-foot">
            <button type="button" className="pill" onClick={() => go('apps')}>
              查看 <Icon name="arrow" />
            </button>
          </div>
        </article>
      </div>
    </div>
  );
}
