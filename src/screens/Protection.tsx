import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { IconName, ProtectionStatus } from '../../shared/types';
import { api } from '../api';
import { Icon } from '../components/Icon';
import { Empty, ScreenHead } from '../components/ui';
import { timeAgo } from '../lib/format';
import { useStore } from '../state';
import './system.css';

const R = 74;
const C = 2 * Math.PI * R;
const WEEK = 7 * 24 * 3600 * 1000;

function useCountUp(target: number, ms = 1200) {
  const [n, setN] = useState(0);
  useEffect(() => {
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

function ScoreRing({ score }: { score: number }) {
  const [drawn, setDrawn] = useState(0);
  const shown = useCountUp(score);
  useEffect(() => {
    const id = requestAnimationFrame(() => setDrawn(score));
    return () => cancelAnimationFrame(id);
  }, [score]);
  return (
    <div className="sy-ring" role="img" aria-label={`Protection score ${score} out of 100`}>
      <svg viewBox="0 0 176 176">
        <defs>
          <linearGradient id="sy-ring-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#2b4cff" />
            <stop offset="0.55" stopColor="#8a5cff" />
            <stop offset="1" stopColor="#ff5d8f" />
          </linearGradient>
        </defs>
        <circle cx="88" cy="88" r={R} fill="none" stroke="#eef0f6" strokeWidth="12" />
        <circle
          className="arc"
          cx="88"
          cy="88"
          r={R}
          fill="none"
          stroke="url(#sy-ring-grad)"
          strokeWidth="12"
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - Math.max(0, Math.min(100, drawn)) / 100)}
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
      <div className="screen">
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
  const level = issues === 0 && status.score >= 80 ? 'good' : !status.enabled || issues > 1 ? 'bad' : 'warn';

  const rows: { icon: IconName; label: string; detail: string; tag: ReactNode }[] = [
    {
      icon: 'shield',
      label: 'Antivirus',
      detail: status.provider,
      tag: triTag(status.enabled ? 'on' : 'off'),
    },
    {
      icon: 'spark',
      label: 'Real-time protection',
      detail: 'Checks files the moment they are opened or downloaded',
      tag: triTag(tri(status.realtime)),
    },
    {
      icon: 'globe',
      label: 'Firewall',
      detail: 'Blocks unwanted network connections',
      tag: triTag(tri(status.firewall)),
    },
    {
      icon: 'clock',
      label: 'Definitions updated',
      detail: status.definitionsUpdated ? timeAgo(status.definitionsUpdated, now) : 'Not reported by your system',
      tag: triTag(defsFresh, ['Up to date', 'Out of date']),
    },
    {
      icon: 'scan',
      label: 'Last scan',
      detail: status.lastScan ? timeAgo(status.lastScan, now) : 'Not reported by your system',
      tag: triTag(scanFresh, ['Recent', 'A while ago']),
    },
  ];

  return (
    <div className="screen">
      {head}

      <section className="card-w sy-hero rise" style={{ animationDelay: '0.06s' }}>
        <ScoreRing score={status.score} />
        <div className="sy-hero-text">
          <span className={`eyebrow${level === 'warn' ? ' sy-warn' : level === 'bad' ? ' sy-bad' : ''}`}>
            <span className="dot" />
            {level === 'good' ? 'You are protected' : level === 'warn' ? 'Mostly protected' : 'Needs attention'}
          </span>
          <h2>{status.provider}</h2>
          <p>
            Cleanly does not replace your antivirus. It checks that the protection built into your system is switched on and up to date, and
            tells you plainly when something is off.
          </p>
          <button type="button" className="btn" onClick={() => void load()} disabled={loading}>
            {loading ? <span className="spinner" /> : <Icon name="history" />}
            {loading ? 'Checking' : 'Check again'}
          </button>
        </div>
      </section>

      <section className="card-w panel rise" style={{ animationDelay: '0.12s' }}>
        <div className="sy-sec-head">
          <h2>Status</h2>
          <span className="grow" />
          <span className="sy-count">{issues === 0 ? 'All good' : `${issues} to look at`}</span>
        </div>
        <div className="list">
          {rows.map((r) => (
            <div key={r.label} className="row">
              <span className="chip-ico">
                <Icon name={r.icon} />
              </span>
              <div className="grow">
                <div className="title">{r.label}</div>
                <div className="sub">{r.detail}</div>
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
