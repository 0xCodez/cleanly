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
    <div className={`sy-ring is-${level}`} role="img" aria-label={`安全防护评分 ${clamped} 分（满分 100 分）`}>
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

function triTag(v: Tri, labels: [string, string] = ['开启', '关闭']) {
  if (v === 'on') return <span className="tag sy-on">{labels[0]}</span>;
  if (v === 'off') return <span className="tag sy-offt">{labels[1]}</span>;
  return <span className="tag">未知</span>;
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
      toast(e instanceof Error ? e.message : '无法检查安全防护', 'err');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const head = (
    <ScreenHead title="安全防护" sub="快速查看系统自带的安全防护状态。" />
  );

  if (!status) {
    return (
      <div className="screen sy-screen">
        {head}
        <div className="card-w">
          {loading || !failed ? (
            <div className="sy-center">
              <span className="spinner" />
              正在检查你的安全防护
            </div>
          ) : (
            <Empty icon="warning" title="无法检查安全防护" text="检查时遇到了阻碍。请稍后重试。">
              <button type="button" className="btn" onClick={() => void load()}>
                重试
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

  const facts: { label: string; state: Tri }[] = [
    { label: status.enabled ? '杀毒软件已开启' : '杀毒软件已关闭', state: status.enabled ? 'on' : 'off' },
  ];
  if (status.realtime !== null) facts.push({ label: `实时防护${status.realtime ? '已开启' : '已关闭'}`, state: tri(status.realtime) });
  if (status.firewall !== null) facts.push({ label: `防火墙${status.firewall ? '已开启' : '已关闭'}`, state: tri(status.firewall) });
  if (status.definitionsUpdated) facts.push({ label: `${timeAgo(status.definitionsUpdated, now)}更新`, state: defsFresh });

  const rows: { icon: IconName; label: string; detail: string; state: Tri; tag: ReactNode }[] = [
    {
      icon: 'shield',
      label: '杀毒软件',
      detail: status.provider,
      state: status.enabled ? 'on' : 'off',
      tag: triTag(status.enabled ? 'on' : 'off'),
    },
    {
      icon: 'spark',
      label: '实时防护',
      detail: '在文件打开或下载时立即检查',
      state: tri(status.realtime),
      tag: triTag(tri(status.realtime)),
    },
    {
      icon: 'globe',
      label: '防火墙',
      detail: '阻止不需要的网络连接',
      state: tri(status.firewall),
      tag: triTag(tri(status.firewall)),
    },
    {
      icon: 'clock',
      label: '病毒库更新',
      detail: status.definitionsUpdated ? timeAgo(status.definitionsUpdated, now) : '系统未报告',
      state: defsFresh,
      tag: triTag(defsFresh, ['已是最新', '已过期']),
    },
    {
      icon: 'scan',
      label: '上次扫描',
      detail: status.lastScan ? timeAgo(status.lastScan, now) : '系统未报告',
      state: scanFresh,
      tag: triTag(scanFresh, ['近期', '较久以前']),
    },
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
              {level === 'good' ? '你已受到保护' : level === 'warn' ? '基本受到保护' : '需要关注'}
            </span>
            <h2>{status.provider}</h2>
            <ul className="sy-facts" aria-label="摘要">
              {facts.map((f) => (
                <li key={f.label} className={`is-${f.state}`}>
                  <i />
                  {f.label}
                </li>
              ))}
            </ul>
            <p>
              Cleanly 不会替代你的杀毒软件。它会检查系统自带的防护是否已开启且为最新状态，并在有项目关闭时明确告知你。
            </p>
            <button type="button" className="btn" onClick={() => void load()} disabled={loading}>
              {loading ? <span className="spinner" /> : <Icon name="history" />}
              {loading ? '正在检查' : '再次检查'}
            </button>
          </div>
        </div>
      </section>

      <section className="card-w panel rise" style={{ animationDelay: '0.12s' }}>
        <div className="sy-sec-head">
          <h2>状态</h2>
          <span className="grow" />
          <span className={`sy-count${issues ? ' sy-count-warn' : ''}`}>{issues === 0 ? '一切正常' : `${issues} 项需要查看`}</span>
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
            <h2>备注</h2>
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
