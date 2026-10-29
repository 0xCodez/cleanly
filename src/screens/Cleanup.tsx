import { useEffect, useMemo, useRef, useState } from 'react';
import type { JunkCategory } from '../../shared/types';
import { Icon } from '../components/Icon';
import { CleanButton, Empty, Progress, ScreenHead } from '../components/ui';
import { formatBytes, shortPath, splitBytes, sum } from '../lib/format';
import { useStore } from '../state';
import './files.css';

const isPermanent = (c: JunkCategory) => /recycle|trash/i.test(`${c.id} ${c.name}`);

export default function Cleanup() {
  const { junk, scanning, smartScan, progress, cleaning, cleanJunk, system, settings, toast } = useStore();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);

  // scan once on arrival; a failed scan leaves the retry button below instead of looping
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current || junk || scanning) return;
    asked.current = true;
    void smartScan();
  }, [junk, scanning, smartScan]);

  // a fresh scan result resets the selection to the safe categories
  useEffect(() => {
    setSelected(new Set((junk ?? []).filter((c) => c.safe && c.size > 0).map((c) => c.id)));
    setConfirming(false);
  }, [junk]);

  const items = useMemo(() => [...(junk ?? [])].sort((a, b) => Number(b.safe) - Number(a.safe) || b.size - a.size), [junk]);
  const chosen = items.filter((c) => selected.has(c.id) && c.size > 0);
  const total = sum(chosen.map((c) => c.size));
  const files = sum(chosen.map((c) => c.count));
  const hasPermanent = chosen.some(isPermanent);
  const cleanable = items.filter((c) => c.size > 0);
  const allOn = cleanable.length > 0 && cleanable.every((c) => selected.has(c.id));
  const home = system?.homeDir;
  const scanProg = progress?.task === 'junk' ? progress : null;
  const cleanProg = progress?.task === 'clean' ? progress : null;

  const toggle = (id: string) => {
    setDone(false);
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const toggleAll = () => setSelected(allOn ? new Set() : new Set(cleanable.map((c) => c.id)));

  const run = async () => {
    setConfirming(false);
    const ids = chosen.map((c) => c.id);
    const result = await cleanJunk(ids);
    if (!result) return;
    setDone(true);
    const extra = result.skipped.length
      ? ` · ${result.skipped.slice(0, 2).join(', ')}`
      : result.failed > 0
        ? ` · ${result.failed} in use, skipped`
        : '';
    toast(`Freed ${formatBytes(result.freed)}${extra}`);
  };

  const start = () => {
    if (!chosen.length) return;
    if (settings?.confirmBeforeClean === false) void run();
    else setConfirming(true);
  };

  const big = splitBytes(total);

  return (
    <div className="screen">
      <ScreenHead title="Cleanup" sub="Caches, temp files and logs your apps rebuild on their own. Safe items are picked for you.">
        <div className="fx-head-actions">
          <button type="button" className="btn small" onClick={() => void smartScan()} disabled={scanning || cleaning}>
            {scanning ? <span className="spinner" /> : <Icon name="scan" />}
            {scanning ? 'Scanning' : 'Rescan'}
          </button>
        </div>
      </ScreenHead>

      {!junk && scanning && (
        <section className="card-w rise">
          <div className="fx-wait">
            <span className="orb">
              <Icon name="broom" />
            </span>
            <h3>Looking for junk</h3>
            <p>{scanProg?.phase ?? 'Checking caches, temp folders and logs'}</p>
            <Progress value={scanProg && scanProg.total > 0 ? scanProg.done / scanProg.total : undefined} />
            {scanProg?.current && <div className="cur">{shortPath(scanProg.current, home)}</div>}
          </div>
        </section>
      )}

      {!junk && !scanning && (
        <section className="card-w rise">
          <Empty icon="scan" title="No scan yet" text="Run a quick scan to see what can be cleaned.">
            <button type="button" className="btn primary" onClick={() => void smartScan()}>
              <Icon name="scan" /> Scan now
            </button>
          </Empty>
        </section>
      )}

      {junk && (
        <section className="card-w fx-panel rise" style={{ animationDelay: '0.06s' }}>
          {scanning && (
            <div className="fx-strip">
              <span className="spinner" />
              <span>{scanProg?.phase ?? 'Rescanning'}</span>
              <Progress value={scanProg && scanProg.total > 0 ? scanProg.done / scanProg.total : undefined} />
            </div>
          )}
          <div className="fx-panel-head">
            <h2>What we found</h2>
            <span className="fx-count">
              {cleanable.length} of {items.length} have something to clean
            </span>
            <span className="grow" />
            <button type="button" className="fx-link" onClick={toggleAll} disabled={!cleanable.length || cleaning}>
              {allOn ? 'Select none' : 'Select all'}
            </button>
          </div>
          {cleanable.length === 0 && !scanning ? (
            <Empty icon="check" title="All clean" text="Nothing to remove right now. Check back in a few days." />
          ) : (
            <div className="list fx-list">
              {items.map((c) => {
                const empty = c.size <= 0;
                const on = selected.has(c.id) && !empty;
                const perm = isPermanent(c);
                return (
                  <label key={c.id} className={`row${on ? ' on' : ''}${empty ? ' off' : ''}`}>
                    <input type="checkbox" className="check" checked={on} disabled={empty || cleaning} onChange={() => toggle(c.id)} aria-label={c.name} />
                    <span className={`chip-ico${perm ? ' warm' : c.safe ? '' : ' mute'}`}>
                      <Icon name={c.icon} />
                    </span>
                    <div className="grow">
                      <div className="title">{c.name}</div>
                      <div className="fx-desc">{c.description}</div>
                      <div className="sub mono" title={c.locations.join('\n')}>
                        {c.locations.map((l) => shortPath(l, home)).join('  ·  ')}
                      </div>
                    </div>
                    <div className="tags">
                      {perm && (
                        <span className="tag keep">
                          <Icon name="warning" />
                          Permanent
                        </span>
                      )}
                      {!empty && <span className={`tag ${c.safe ? 'safe' : 'review'}`}>{c.safe ? 'Safe' : 'Review'}</span>}
                    </div>
                    <span className="size">{empty ? 'Clean' : formatBytes(c.size)}</span>
                  </label>
                );
              })}
            </div>
          )}
        </section>
      )}

      {junk && cleanable.length > 0 && (
        confirming ? (
          <div className="fx-dock" role="alertdialog" aria-label="Confirm cleanup">
            <span className={`chip-ico${hasPermanent ? ' warm' : ''}`}>
              <Icon name={hasPermanent ? 'warning' : 'broom'} />
            </span>
            <div className="grow">
              <div className="fx-dock-q">Delete {formatBytes(total)} of caches and junk?</div>
              {hasPermanent ? (
                <div className="fx-dock-note warn">Includes emptying the Trash. That part can't be undone.</div>
              ) : (
                <div className="fx-dock-note">They rebuild themselves when apps need them.</div>
              )}
            </div>
            <button type="button" className="btn ghost" onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button type="button" className={`btn primary${hasPermanent ? ' danger' : ''}`} onClick={() => void run()} autoFocus>
              Delete
            </button>
          </div>
        ) : (
          <div className="fx-dock">
            <div className="grow">
              <div className="fx-dock-num">
                {big.value}
                <small>{big.unit} selected</small>
              </div>
              <div className="fx-dock-sub">
                {cleaning
                  ? cleanProg?.phase ?? 'Cleaning'
                  : `${chosen.length} ${chosen.length === 1 ? 'category' : 'categories'} · ${files.toLocaleString()} items`}
              </div>
            </div>
            {cleaning && <Progress value={cleanProg && cleanProg.total > 0 ? cleanProg.done / cleanProg.total : undefined} />}
            <CleanButton
              label={cleaning ? 'Cleaning' : done && !chosen.length ? 'Done' : 'Clean'}
              sub={formatBytes(total)}
              busy={cleaning}
              done={done && !chosen.length}
              disabled={!chosen.length || scanning}
              onClick={start}
            />
          </div>
        )
      )}
    </div>
  );
}
