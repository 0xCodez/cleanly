import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { IconName } from '../../shared/types';
import { formatBytes } from '../lib/format';
import { Icon } from './Icon';

export interface BubbleDatum {
  id: string;
  name: string;
  size: number;
  icon?: IconName;
  /** short badge text, e.g. "−18.7"; marks the bubble as having something to clean */
  badge?: string;
}

// glass rim + icon gradients, picked in order
const PALETTE: { c1: string; c2: string; sh: string }[] = [
  { c1: '#6d7bff', c2: '#a77bff', sh: '109, 123, 255' },
  { c1: '#4f9bff', c2: '#7fd3ff', sh: '79, 155, 255' },
  { c1: '#a77bff', c2: '#ff8fc8', sh: '167, 123, 255' },
  { c1: '#3fd6a0', c2: '#5fc6ff', sh: '63, 190, 170' },
  { c1: '#8e95b8', c2: '#b8a8ff', sh: '120, 125, 170' },
  { c1: '#ff8fc8', c2: '#c48cff', sh: '220, 120, 200' },
];
const HOT = { c1: '#ffb347', c2: '#ff7aa8', sh: '255, 150, 120' };

interface Placed extends BubbleDatum {
  x: number;
  y: number;
  r: number;
}

/** Greedy circle packing: biggest first, each next one on the closest free spot of a spiral around the centre. */
function pack(items: BubbleDatum[], w: number, h: number): Placed[] {
  const data = items.filter((d) => d.size > 0).sort((a, b) => b.size - a.size);
  if (!data.length || w < 40 || h < 40) return [];
  const gap = 10;
  const cx = w / 2;
  const cy = h / 2;
  for (let fill = 0.5; fill > 0.12; fill -= 0.04) {
    const total = data.reduce((s, d) => s + d.size, 0);
    const k = Math.sqrt((fill * w * h) / Math.PI / total);
    // with only a few bubbles let them grow, otherwise a folder with two items looks empty
    const maxR = Math.min(w, h) * (data.length <= 2 ? 0.4 : data.length <= 4 ? 0.36 : 0.33);
    const placed: Placed[] = [];
    let ok = true;
    for (const d of data) {
      const r = Math.max(28, Math.min(maxR, Math.sqrt(d.size) * k));
      let spot: { x: number; y: number } | null = null;
      for (let step = 0; step < 900 && !spot; step++) {
        const a = step * 0.37;
        const dist = step * 1.1;
        const x = cx + Math.cos(a) * dist;
        const y = cy + Math.sin(a) * dist * 0.85;
        if (x - r < 4 || y - r < 4 || x + r > w - 4 || y + r > h - 4) continue;
        if (placed.every((p) => Math.hypot(p.x - x, p.y - y) >= p.r + r + gap)) spot = { x, y };
      }
      if (!spot) {
        ok = false;
        break;
      }
      placed.push({ ...d, ...spot, r });
    }
    if (ok) {
      // centre the cluster as a whole
      const minX = Math.min(...placed.map((p) => p.x - p.r));
      const maxX = Math.max(...placed.map((p) => p.x + p.r));
      const minY = Math.min(...placed.map((p) => p.y - p.r));
      const maxY = Math.max(...placed.map((p) => p.y + p.r));
      const dx = (w - minX - maxX) / 2;
      const dy = (h - minY - maxY) / 2;
      return placed.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy }));
    }
  }
  return [];
}

export function Bubbles({ items, onSelect, selectedId }: { items: BubbleDatum[]; onSelect?: (id: string) => void; selectedId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const placed = useMemo(() => pack(items, box.w, box.h), [items, box.w, box.h]);

  return (
    <div className="bubbles" ref={ref}>
      {placed.map((b, i) => {
        const pal = b.badge ? HOT : PALETTE[i % PALETTE.length];
        const d = b.r * 2;
        const style = {
          left: b.x - b.r,
          top: b.y - b.r,
          width: d,
          height: d,
          '--c1': pal.c1,
          '--c2': pal.c2,
          '--shadow': `rgba(${pal.sh}, ${selectedId === b.id ? 0.4 : 0.2})`,
          '--inner': `rgba(${pal.sh}, 0.08)`,
          '--chip': `${Math.round(Math.max(24, Math.min(44, d * 0.24)))}px`,
          '--spin': `${11 + (i % 3) * 2.5}s`,
          '--dur': `${5.5 + (i % 3) * 0.8}s`,
          '--delay': `${-i * 0.7}s`,
        } as CSSProperties;
        const small = d < 84;
        return (
          <div key={b.id} className={`bubble${small ? ' small' : ''}${b.badge ? ' hot' : ''}`} style={style}>
            <button type="button" className="disc" onClick={() => onSelect?.(b.id)} title={`${b.name} · ${formatBytes(b.size)}`}>
              {b.icon && !small && (
                <span className="b-ico">
                  <Icon name={b.icon} />
                </span>
              )}
              <b>{b.name}</b>
              <span className="sz">{formatBytes(b.size)}</span>
            </button>
            {b.badge && <span className="badge">{b.badge}</span>}
          </div>
        );
      })}
    </div>
  );
}
