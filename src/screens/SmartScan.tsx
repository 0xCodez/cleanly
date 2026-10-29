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
    const note = res.skipped.length ? ` · ${res.skipped.slice(0, 2).join(', ')}` : res.failed ? ` · ${res.failed} in use, skipped` : '';
    toast(`Freed ${formatBytes(res.freed)}${note}`);
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
    eyebrow = phase ? `Cleaning · ${phase}` : 'Cleaning…';
    dot = 'busy';
  } else if (scanning) {
    eyebrow = phase ? `Scanning · ${phase}` : 'Scanning…';
    dot = 'busy';
  } else if (afterClean && cleanedAt !== null) {
    eyebrow = `${allClear ? 'All clear' : 'Cleaned'} · ${timeAgo(cleanedAt, now)}`;
  } else if (lastScanAt) {
    eyebrow = `Scan complete · ${new Date(lastScanAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  } else {
    eyebrow = 'Not scanned yet';
    dot = 'idle';
  }

  const busyProgress = (scanning || cleaning) && progress && progress.total > 0 ? progress.done / progress.total : undefined;

  let hint: string;
  if (cleaning) hint = 'Deleting caches and temp files…';
  else if (scanning) hint = 'Looking for caches and temp files…';
  else if (armed) hint = 'Caches are deleted for good · press again';
  else if (itemCount) hint = `${itemCount.toLocaleString('en-US')} items · ${safeIds.length} ${safeIds.length === 1 ? 'group' : 'groups'} · ↵ to clean`;
  else if (lastScanAt) hint = 'Nothing safe to remove right now';
  else hint = 'Run a scan to see what can go';

  let ctaLabel = 'Clean';
  let ctaSub = reclaimable > 0 ? formatBytes(reclaimable) : 'Nothing to clean';
  if (cleaning) [ctaLabel, ctaSub] = ['Cleaning', formatBytes(reclaimable)];
  else if (scanning) [ctaLabel, ctaSub] = ['Scanning', phase ?? 'one moment'];
  else if (armed) [ctaLabel, ctaSub] = ['Clean now?', `${formatBytes(reclaimable)} for good`];
  else if (nothingLeft) [ctaLabel, ctaSub] = ['Rescan', allClear ? 'all clear' : 'nothing to clean'];
  else if (!lastScanAt) [ctaLabel, ctaSub] = ['Scan', 'find junk'];

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
        name: `+${rest.length} more`,
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
        ? `${stale} not used for 6+ months`
        : 'All used in the last 6 months'
      : 'Installed on this computer';

  const prot = protection.data;
  const protSub = prot ? (prot.notes[0] ?? `${prot.provider} is ${prot.enabled ? 'on' : 'off'}`) : '';
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
        <section className="hero card-w rise" style={delay(0.08)} aria-label="Scan result">
          <div className="hero-plume">
            <Flow mode="plume" calm={afterClean} pulse={cleanPulse} />
          </div>
          <div className="hero-in">
            <span className="eyebrow" title={eyebrow}>
              <span className={`dot ${dot}`} />
              <span className="eyebrow-t">{eyebrow}</span>
            </span>
            <h1>{afterClean ? 'Left to clean' : 'Ready to reclaim'}</h1>
            <div className="big" aria-live="polite">
              <span>{big.value}</span> <small>{big.unit}</small>
            </div>
            <p>Caches and temp files are deleted for good — they rebuild themselves. Your own files always go to Trash.</p>
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
                  Review what gets removed <Icon name="arrow" size={16} />
                </button>
                <span className="hint">{hint}</span>
                {(scanning || cleaning) && (
                  <div className="hero-progress">
                    <Progress value={busyProgress} />
                  </div>
                )}
                {armed && (
                  <button type="button" className="cancel" onClick={() => setArmed(false)}>
                    Cancel
                  </button>
                )}
              </div>
            </div>
          </div>
        </section>

        <section className="map card-w rise" style={delay(0.16)} aria-label="Space map">
          <div className="map-head">
            <b>Space map</b>
            <button type="button" className="link" onClick={() => go('spaces')}>
              Open ›
            </button>
          </div>
          <div className="map-body">
            {spaces ? (
              bubbles.length ? (
                <Bubbles items={bubbles} onSelect={() => go('spaces')} />
              ) : (
                <div className="map-empty">No folders to show yet</div>
              )
            ) : spacesError && !spacesScanning ? (
              <div className="map-empty">
                <button type="button" className="btn small" onClick={() => void scanSpaces()}>
                  <Icon name="scan" /> Measure again
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
                  <span>Badge: space you can free there</span>
                </>
              ) : (
                <span>{afterClean ? 'No folders left to clean' : 'Sized by how much space they take'}</span>
              )
            ) : spacesError && !spacesScanning ? (
              <span>Could not measure your folders</span>
            ) : (
              <>
                <span className="spinner" />
                <span>Measuring folders…</span>
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
            <b>Cleanup</b>
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
          <div className="lc-sub">{allClear ? 'Caches & temp files removed' : 'Caches · temp files · trash'}</div>
          <div className="lc-foot">
            {allClear ? (
              <span className="pill done">
                <Icon name="check" />
                Removed
              </span>
            ) : (
              <button type="button" className="pill" onClick={() => void clean()} disabled={!canClean}>
                {cleaning ? (
                  <>
                    <span className="spinner pill-spin" />
                    Removing
                  </>
                ) : armed ? (
                  <>
                    Confirm <Icon name="check" />
                  </>
                ) : (
                  <>
                    Remove <Icon name="arrow" />
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
            <b>Speed</b>
          </div>
          <div className="lc-num">
            {startupItems ? (
              <>
                <strong>{heavy}</strong>
                <em>{heavy === 1 ? 'heavy app' : 'heavy apps'}</em>
              </>
            ) : startup.error ? (
              <strong>—</strong>
            ) : (
              <span className="lc-skel" />
            )}
          </div>
          <div className="lc-sub">
            {startupItems
              ? `At login · ${enabledItems.length} of ${startupItems.length} items on`
              : startup.error
                ? 'Could not read login items'
                : 'Checking login items…'}
          </div>
          <div className="lc-foot">
            <button
              type="button"
              className={`slider${startupItems ? '' : ' loading'}`}
              aria-label="Manage apps that start at login"
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
          aria-label="Open Protection"
          onClick={openProtection}
          onKeyDown={onProtKey}
        >
          <span className="glow" style={{ left: 0, top: 100, '--bd': '7s' } as Vars} />
          <div className="lc-top">
            <span className="glass-ico">
              <Icon name="shield" />
            </span>
            <b>Protection</b>
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
            {prot ? protSub : protection.error ? 'Could not read protection status' : 'Checking protection…'}
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
            <b>Applications</b>
          </div>
          <div className="lc-num">
            {appList ? (
              <>
                <strong>{appList.length}</strong>
                <em>{appList.length === 1 ? 'app' : 'apps'}</em>
              </>
            ) : apps.error ? (
              <strong>—</strong>
            ) : (
              <span className="lc-skel" />
            )}
          </div>
          <div className="lc-sub">{appList ? appsSub : apps.error ? 'Could not list apps' : 'Listing installed apps…'}</div>
          <div className="lc-foot">
            <button type="button" className="pill" onClick={() => go('apps')}>
              Review <Icon name="arrow" />
            </button>
          </div>
        </article>
      </div>
    </div>
  );
}
