import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import type { IconName, ProtectionStatus } from '../../shared/types';
import { api } from '../api';
import { Icon } from '../components/Icon';
import { Empty, ScreenHead } from '../components/ui';
import { timeAgo } from '../lib/format';
import { useStore } from '../state';
import './system.css';

const SIZE = 160;
const STROKE = 12;
const R = (SIZE - STROKE) / 2 - 2;
const C = 2 * Math.PI * R;
const WEEK = 7 * 24 * 3600 * 1000;

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function useCountUp(target: number, ms = 1200) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (prefersReducedMotion()) {
      setN(target);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      setN(Math.round(target * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return n;
}

type Level = 'good' | 'warn' | 'bad';

function ScoreRing({ score, level }: { score: number; level: Level }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const grad = `sy-ring-grad-${uid}`;
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const [drawn, setDrawn] = useState(0);
  const [still] = useState(prefersReducedMotion);
  const shown = useCountUp(clamped);

  useEffect(() => {
    const id = requestAnimationFrame(() => setDrawn(clamped));
    return () => cancelAnimationFrame(id);
  }, [clamped]);

  const c = SIZE / 2;
  return (
    <div className={`sy-ring is-${level}`} role="img" aria-label={`Protection score ${clamped} out of 100`}>
      <span className="sy-ring-glow" aria-hidden="true" />
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE} height={SIZE} aria-hidden="true">
        <defs>
          <linearGradient id={grad} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#2b4cff" />
            <stop offset="0.5" stopColor="#8a5cff" />
            <stop offset="1" stopColor="#ff5d8f" />
            {!still && (
              <animateTransform
                attributeName="gradientTransform"
                type="rotate"
                values="0 0.5 0.5;360 0.5 0.5"
                dur="9s"
                repeatCount="indefinite"
              />
            )}
          </linearGradient>
        </defs>
        <circle className="track" cx={c} cy={c} r={R} fill="none" strokeWidth={STROKE} />
        <circle
          className="arc"
          cx={c}
          cy={c}
          r={R}
          fill="none"
          stroke={`url(#${grad})`}
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - drawn / 100)}
        />
      </svg>
      <div className="sy-ring-in">
        <strong>{shown}</strong>
        <span>/ 100</span>
      </div>
    </div>
  );
}

type Tri = 'on' | 'off' | 'unknown';

function triTag(v: Tri, labels: [string, string] = ['On', 'Off']) {
  if (v === 'on') return <span className="tag sy-on">{labels[0]}</span>;
  if (v === 'off') return <span className="tag sy-offt">{labels[1]}</span>;
  return <span className="tag">Unknown</span>;
}

const tri = (b: boolean | null): Tri => (b === null ? 'unknown' : b ? 'on' : 'off');

export default function Protection() {
  const { toast } = useStore();
  const [status, setStatus] = useState<ProtectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      setStatus(await api.protection());
    } catch (e) {
      setFailed(true);
      toast(e instanceof Error ? e.message : 'Could not check protection', 'err');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const head = (
    <ScreenHead title="Protection" sub="A quick look at the security your system already has built in." />
  );

  if (!status) {
    return (
      <div className="screen sy-screen">
        {head}
        <div className="card-w">
          {loading || !failed ? (
            <div className="sy-center">
              <span className="spinner" />
              Checking your protection
            </div>
          ) : (
            <Empty icon="warning" title="Could not check protection" text="Something blocked the check. Try again in a moment.">
              <button type="button" className="btn" onClick={() => void load()}>
                Try again
              </button>
            </Empty>
          )}
        </div>
      </div>
    );
  }

  const now = Date.now();
  const defsFresh: Tri = status.definitionsUpdated === null ? 'unknown' : now - status.definitionsUpdated < WEEK ? 'on' : 'off';
  const scanFresh: Tri = status.lastScan === null ? 'unknown' : now - status.lastScan < 4 * WEEK ? 'on' : 'off';
  const issues = [!status.enabled, status.realtime === false, status.firewall === false, defsFresh === 'off'].filter(Boolean).length;
  const level: Level = issues === 0 && status.score >= 80 ? 'good' : !status.enabled || issues > 1 ? 'bad' : 'warn';

  // Linux has no built-in antivirus: the rows describe kernel access control and system updates instead.
  const hardening = status.kind === 'hardening';
  const facts: { label: string; state: Tri }[] = [
    { label: `${hardening ? 'Protection' : 'Antivirus'} ${status.enabled ? 'on' : 'off'}`, state: status.enabled ? 'on' : 'off' },
  ];
  if (status.realtime !== null) facts.push({ label: `${hardening ? 'Access control' : 'Real-time'} ${status.realtime ? 'on' : 'off'}`, state: tri(status.realtime) });
  if (status.firewall !== null) facts.push({ label: `Firewall ${status.firewall ? 'on' : 'off'}`, state: tri(status.firewall) });
  if (status.definitionsUpdated) facts.push({ label: `Updated ${timeAgo(status.definitionsUpdated, now)}`, state: defsFresh });

  const rows: { icon: IconName; label: string; detail: string; state: Tri; tag: ReactNode }[] = [
    {
      icon: 'shield',
      label: hardening ? 'Security' : 'Antivirus',
      detail: status.provider,
      state: status.enabled ? 'on' : 'off',
      tag: triTag(status.enabled ? 'on' : 'off'),
    },
    {
      icon: 'spark',
      label: hardening ? 'Access control' : 'Real-time protection',
      detail: hardening ? 'SELinux or AppArmor limits what each app may touch' : 'Checks files the moment they are opened or downloaded',
      state: tri(status.realtime),
      tag: triTag(tri(status.realtime)),
    },
    {
      icon: 'globe',
      label: 'Firewall',
      detail: 'Blocks unwanted network connections',
      state: tri(status.firewall),
      tag: triTag(tri(status.firewall)),
    },
    {
      icon: 'clock',
      label: hardening ? 'System updates' : 'Definitions updated',
      detail: status.definitionsUpdated ? timeAgo(status.definitionsUpdated, now) : 'Not reported by your system',
      state: defsFresh,
      tag: triTag(defsFresh, ['Up to date', 'Out of date']),
    },
    ...(hardening
      ? []
      : [
          {
            icon: 'scan' as IconName,
            label: 'Last scan',
            detail: status.lastScan ? timeAgo(status.lastScan, now) : 'Not reported by your system',
            state: scanFresh,
            tag: triTag(scanFresh, ['Recent', 'A while ago']),
          },
        ]),
  ];

  return (
    <div className="screen sy-screen">
      {head}

      <section className={`card-w sy-hero is-${level} rise`} style={{ animationDelay: '0.06s' }}>
        <div className="sy-hero-in">
          <div className="sy-hero-ring">
            <ScoreRing score={status.score} level={level} />
          </div>
          <div className="sy-hero-text">
            <span className={`eyebrow${level === 'warn' ? ' sy-warn' : level === 'bad' ? ' sy-bad' : ''}`}>
              <span className="dot" />
              {level === 'good' ? 'You are protected' : level === 'warn' ? 'Mostly protected' : 'Needs attention'}
            </span>
            <h2>{status.provider}</h2>
            <ul className="sy-facts" aria-label="Summary">
              {facts.map((f) => (
                <li key={f.label} className={`is-${f.state}`}>
                  <i />
                  {f.label}
                </li>
              ))}
            </ul>
            <p>
              Cleanly does not replace your antivirus. It checks that the protection built into your system is switched on and up to date,
              and tells you plainly when something is off.
            </p>
            <button type="button" className="btn" onClick={() => void load()} disabled={loading}>
              {loading ? <span className="spinner" /> : <Icon name="history" />}
              {loading ? 'Checking' : 'Check again'}
            </button>
          </div>
        </div>
      </section>

      <section className="card-w panel rise" style={{ animationDelay: '0.12s' }}>
        <div className="sy-sec-head">
          <h2>Status</h2>
          <span className="grow" />
          <span className={`sy-count${issues ? ' sy-count-warn' : ''}`}>{issues === 0 ? 'All good' : `${issues} to look at`}</span>
        </div>
        <div className="list sy-status">
          {rows.map((r) => (
            <div key={r.label} className={`row is-${r.state}`}>
              <span className={`chip-ico sy-st-${r.state}`}>
                <Icon name={r.icon} />
              </span>
              <div className="grow">
                <div className="title">{r.label}</div>
                <div className="sub" title={r.detail}>
                  {r.detail}
                </div>
              </div>
              {r.tag}
            </div>
          ))}
        </div>
      </section>

      {status.notes.length > 0 && (
        <section className="card-w panel rise" style={{ animationDelay: '0.18s' }}>
          <div className="sy-sec-head">
            <h2>Notes</h2>
          </div>
          <ul className="sy-notes">
            {status.notes.map((n, i) => (
              <li key={i}>
                <Icon name="spark" />
                <span>{n}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
