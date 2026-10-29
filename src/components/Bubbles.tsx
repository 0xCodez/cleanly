import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from 'react';
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
  /** real system icon (data URL); shown instead of the glyph when present */
  img?: string;
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

// physics tuning (px, seconds)
const SPRING = 70;
const DAMP = 7.5;
const GAP = 3;
const BOUNCE = 0.55;
const WALL = 0.5;
const HOVER_REACH = 26;
const HOVER_PUSH = 42;
const MAX_V = 2600;
const GRAB_SCALE = 1.06;
const DRAG_MIN = 4;

/** Physics body: rest position comes from pack(), the offset (ox, oy) is what the loop animates. */
interface Body {
  id: string;
  rx: number;
  ry: number;
  r: number;
  im: number;
  ox: number;
  oy: number;
  vx: number;
  vy: number;
}

interface Drag {
  id: string;
  pid: number;
  el: HTMLElement | null;
  sx: number;
  sy: number;
  gx: number;
  gy: number;
  left: number;
  top: number;
  tx: number;
  ty: number;
  vx: number;
  vy: number;
  t: number;
  moved: boolean;
}

interface Sim {
  map: Map<string, Body>;
  list: Body[];
  els: Map<string, HTMLDivElement>;
  w: number;
  h: number;
  raf: number;
  last: number;
  calm: number;
  drag: Drag | null;
  hover: string | null;
  suppress: string | null;
  reduced: boolean;
}

const clamp = (v: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, v)));
const cap = (v: number) => clamp(v, -MAX_V, MAX_V);
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function step(s: Sim, h: number) {
  const { list, drag } = s;
  const held = drag?.moved ? s.map.get(drag.id) : undefined;
  const hov = s.hover ? s.map.get(s.hover) : undefined;

  // springs toward rest + hover nudge, semi-implicit Euler
  for (const b of list) {
    if (b === held && drag) {
      b.ox = drag.tx - b.rx;
      b.oy = drag.ty - b.ry;
      b.vx = drag.vx;
      b.vy = drag.vy;
      continue;
    }
    let ax = -SPRING * b.ox - DAMP * b.vx;
    let ay = -SPRING * b.oy - DAMP * b.vy;
    if (hov && hov !== b) {
      const dx = b.rx + b.ox - (hov.rx + hov.ox);
      const dy = b.ry + b.oy - (hov.ry + hov.oy);
      const d = Math.hypot(dx, dy);
      const reach = b.r + hov.r + HOVER_REACH;
      if (d > 0.01 && d < reach) {
        const f = (reach - d) * HOVER_PUSH;
        ax += (dx / d) * f;
        ay += (dy / d) * f;
      }
    }
    b.vx = cap(b.vx + ax * h);
    b.vy = cap(b.vy + ay * h);
    b.ox += b.vx * h;
    b.oy += b.vy * h;
  }

  // circle-circle contacts; inverse mass ~ 1/area, the held bubble is immovable
  for (let it = 0; it < 2; it++) {
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      const ia = a === held ? 0 : a.im;
      const ra = a === held ? a.r * GRAB_SCALE : a.r;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        const ib = b === held ? 0 : b.im;
        if (!ia && !ib) continue;
        const min = ra + (b === held ? b.r * GRAB_SCALE : b.r) + GAP;
        let dx = b.rx + b.ox - (a.rx + a.ox);
        let dy = b.ry + b.oy - (a.ry + a.oy);
        if (Math.abs(dx) >= min || Math.abs(dy) >= min) continue;
        let d = Math.hypot(dx, dy);
        if (d >= min) continue;
        if (d < 0.01) {
          dx = 1;
          dy = 0;
          d = 1;
        }
        const nx = dx / d;
        const ny = dy / d;
        const sum = ia + ib;
        const push = min - d;
        a.ox -= nx * push * (ia / sum);
        a.oy -= ny * push * (ia / sum);
        b.ox += nx * push * (ib / sum);
        b.oy += ny * push * (ib / sum);
        if (it) continue;
        const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (vn < 0) {
          const imp = (-(1 + BOUNCE) * vn) / sum;
          a.vx -= nx * imp * ia;
          a.vy -= ny * imp * ia;
          b.vx += nx * imp * ib;
          b.vy += ny * imp * ib;
        }
      }
    }
  }

  // container walls
  for (const b of list) {
    if (b === held) continue;
    const x = b.rx + b.ox;
    const y = b.ry + b.oy;
    if (x < b.r) {
      b.ox += b.r - x;
      if (b.vx < 0) b.vx = -b.vx * WALL;
    } else if (x > s.w - b.r) {
      b.ox -= x - (s.w - b.r);
      if (b.vx > 0) b.vx = -b.vx * WALL;
    }
    if (y < b.r) {
      b.oy += b.r - y;
      if (b.vy < 0) b.vy = -b.vy * WALL;
    } else if (y > s.h - b.r) {
      b.oy -= y - (s.h - b.r);
      if (b.vy > 0) b.vy = -b.vy * WALL;
    }
  }
}

function paint(s: Sim, snap = false) {
  for (const b of s.list) {
    const el = s.els.get(b.id);
    if (!el) continue;
    if (snap && Math.abs(b.ox) < 0.3 && Math.abs(b.oy) < 0.3) b.ox = b.oy = b.vx = b.vy = 0;
    el.style.transform = b.ox || b.oy ? `translate3d(${b.ox.toFixed(2)}px, ${b.oy.toFixed(2)}px, 0)` : '';
  }
}

export function Bubbles({ items, onSelect, selectedId }: { items: BubbleDatum[]; onSelect?: (id: string) => void; selectedId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const simRef = useRef<Sim | null>(null);
  if (!simRef.current) {
    simRef.current = {
      map: new Map(),
      list: [],
      els: new Map(),
      w: 0,
      h: 0,
      raf: 0,
      last: 0,
      calm: 0,
      drag: null,
      hover: null,
      suppress: null,
      reduced: reducedMotion(),
    };
  }
  const sim = simRef.current;

  const tick = (now: number) => {
    const dt = Math.min(1 / 30, Math.max(0.001, (now - sim.last) / 1000));
    sim.last = now;
    const n = Math.ceil(dt * 120);
    for (let k = 0; k < n; k++) step(sim, dt / n);
    let maxV = 0;
    for (const b of sim.list) maxV = Math.max(maxV, Math.abs(b.vx), Math.abs(b.vy));
    sim.calm = maxV < 3 && !sim.drag?.moved ? sim.calm + 1 : 0;
    if (sim.calm > 12) {
      sim.raf = 0;
      paint(sim, true);
      return;
    }
    paint(sim);
    sim.raf = requestAnimationFrame(tick);
  };

  const wake = () => {
    sim.calm = 0;
    if (sim.raf || sim.reduced || !sim.list.length) return;
    sim.last = performance.now();
    sim.raf = requestAnimationFrame(tick);
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    const on = () => {
      sim.reduced = !!mq?.matches;
      if (!sim.reduced) return;
      cancelAnimationFrame(sim.raf);
      sim.raf = 0;
      sim.drag?.el?.removeAttribute('data-grab');
      sim.drag = null;
      sim.hover = null;
      for (const b of sim.list) b.ox = b.oy = b.vx = b.vy = 0;
      paint(sim);
    };
    mq?.addEventListener('change', on);
    return () => {
      mq?.removeEventListener('change', on);
      cancelAnimationFrame(sim.raf);
      sim.raf = 0;
    };
  }, [sim]);

  const placed = useMemo(() => pack(items, box.w, box.h), [items, box.w, box.h]);

  // sync bodies with the new layout; offsets survive so a moved bubble glides to its new rest spot
  useEffect(() => {
    const next = new Map<string, Body>();
    for (const p of placed) {
      const b = sim.map.get(p.id) ?? { id: p.id, rx: p.x, ry: p.y, r: p.r, im: 0, ox: 0, oy: 0, vx: 0, vy: 0 };
      b.rx = p.x;
      b.ry = p.y;
      b.r = p.r;
      b.im = 1 / (p.r * p.r);
      next.set(p.id, b);
    }
    sim.map = next;
    sim.list = [...next.values()];
    sim.w = box.w;
    sim.h = box.h;
    if (sim.drag && !next.has(sim.drag.id)) sim.drag = null;
    if (sim.hover && !next.has(sim.hover)) sim.hover = null;
    wake();
    // wake/sim are stable for the component's life
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placed, box.w, box.h]);

  const down = (e: RPointerEvent<HTMLElement>, id: string) => {
    sim.suppress = null;
    if (sim.reduced || e.button !== 0 || sim.drag) return;
    const b = sim.map.get(id);
    const wrap = ref.current;
    if (!b || !wrap) return;
    const rect = wrap.getBoundingClientRect();
    const cx = b.rx + b.ox;
    const cy = b.ry + b.oy;
    sim.drag = {
      id,
      pid: e.pointerId,
      el: sim.els.get(id) ?? null,
      sx: e.clientX,
      sy: e.clientY,
      gx: e.clientX - rect.left - cx,
      gy: e.clientY - rect.top - cy,
      left: rect.left,
      top: rect.top,
      tx: cx,
      ty: cy,
      vx: 0,
      vy: 0,
      t: e.timeStamp,
      moved: false,
    };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already gone */
    }
  };

  const move = (e: RPointerEvent<HTMLElement>) => {
    const d = sim.drag;
    if (!d || d.pid !== e.pointerId) return;
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < DRAG_MIN) return;
      d.moved = true;
      d.el?.setAttribute('data-grab', '');
    }
    const b = sim.map.get(d.id);
    if (!b) return;
    const x = clamp(e.clientX - d.left - d.gx, b.r, sim.w - b.r);
    const y = clamp(e.clientY - d.top - d.gy, b.r, sim.h - b.r);
    const dt = Math.max(4, e.timeStamp - d.t) / 1000;
    d.vx = cap(d.vx * 0.5 + ((x - d.tx) / dt) * 0.5);
    d.vy = cap(d.vy * 0.5 + ((y - d.ty) / dt) * 0.5);
    d.tx = x;
    d.ty = y;
    d.t = e.timeStamp;
    wake();
  };

  const up = (e: RPointerEvent<HTMLElement>, cancelled = false) => {
    const d = sim.drag;
    if (!d || d.pid !== e.pointerId) return;
    sim.drag = null;
    if (!d.moved) return;
    d.el?.removeAttribute('data-grab');
    sim.suppress = d.id;
    const b = sim.map.get(d.id);
    if (b) {
      // a throw only counts if the pointer was still moving when released
      const fresh = !cancelled && e.timeStamp - d.t < 80;
      b.vx = fresh ? d.vx : 0;
      b.vy = fresh ? d.vy : 0;
    }
    wake();
  };

  const hover = (id: string | null) => {
    if (sim.reduced || sim.hover === id) return;
    sim.hover = id;
    wake();
  };

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
          <div
            key={b.id}
            ref={(el) => {
              if (el) sim.els.set(b.id, el);
              else sim.els.delete(b.id);
            }}
            className={`bubble${small ? ' small' : ''}${b.badge ? ' hot' : ''}`}
            style={style}
          >
            <div className="b-float">
              <button
                type="button"
                className="disc"
                title={`${b.name} · ${formatBytes(b.size)}`}
                onPointerDown={(e) => down(e, b.id)}
                onPointerMove={move}
                onPointerUp={(e) => up(e)}
                onPointerCancel={(e) => up(e, true)}
                onLostPointerCapture={(e) => up(e, true)}
                onPointerEnter={(e) => e.pointerType === 'mouse' && hover(b.id)}
                onPointerLeave={(e) => e.pointerType === 'mouse' && sim.hover === b.id && hover(null)}
                onClick={(e) => {
                  // the click that ends a drag is not a selection (keyboard clicks have detail 0)
                  if (e.detail !== 0 && sim.suppress === b.id) {
                    sim.suppress = null;
                    return;
                  }
                  onSelect?.(b.id);
                }}
              >
                {!small && b.img ? (
                  <span className="b-ico img">
                    <img src={b.img} alt="" draggable={false} />
                  </span>
                ) : (
                  b.icon &&
                  !small && (
                    <span className="b-ico">
                      <Icon name={b.icon} />
                    </span>
                  )
                )}
                <b>{b.name}</b>
                <span className="sz">{formatBytes(b.size)}</span>
              </button>
              {b.badge && <span className="badge">{b.badge}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
