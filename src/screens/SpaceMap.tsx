import { useEffect, useMemo, useState } from 'react';
import type { SpaceNode } from '../../shared/types';
import { api } from '../api';
import { Bubbles, type BubbleDatum } from '../components/Bubbles';
import { Icon } from '../components/Icon';
import { Empty, Progress, ScreenHead } from '../components/ui';
import { formatBytes, shortPath, splitBytes } from '../lib/format';
import { useStore } from '../state';
import './files.css';

const MAX_BUBBLES = 12;
const HINT_MIN = 50 * 1024 * 1024;
const REST_ID = '__rest';

const bySize = (a: SpaceNode, b: SpaceNode) => b.size - a.size;
// "Loose files" and "N more items" reuse their parent's path, so the path alone is not unique
const nodeId = (n: SpaceNode) => `${n.path}|${n.name}`;

export default function SpaceMap() {
  const { spaces, spacesScanning: busy, scanSpaces, scanning, progress, system, toast, go } = useStore();
  const [trail, setTrail] = useState<SpaceNode[]>([]);
  const [focus, setFocus] = useState<string | null>(null);

  const tree = spaces;
  const home = system?.homeDir;
  const prog = progress?.task === 'spaces' ? progress : null;

  useEffect(() => {
    setTrail([]);
    setFocus(null);
  }, [tree]);

  const current = trail.length ? trail[trail.length - 1] : tree;
  const kids = useMemo(() => [...(current?.children ?? [])].filter((c) => c.size > 0).sort(bySize), [current]);

  const bubbles = useMemo<BubbleDatum[]>(() => {
    const top = kids.slice(0, MAX_BUBBLES).map((c) => ({
      id: nodeId(c),
      name: c.name,
      size: c.size,
      icon: c.icon,
      badge: c.reclaimable >= HINT_MIN ? `−${formatBytes(c.reclaimable)}` : undefined,
    }));
    const rest = kids.slice(MAX_BUBBLES);
    if (rest.length) top.push({ id: REST_ID, name: `${rest.length} more`, size: rest.reduce((s, c) => s + c.size, 0), icon: 'more', badge: undefined });
    return top;
  }, [kids]);

  const open = (node: SpaceNode) => {
    if (node.children?.length) {
      setTrail((t) => [...t, node]);
      setFocus(null);
    } else {
      setFocus(nodeId(node));
    }
  };

  const onBubble = (id: string) => {
    if (id === REST_ID) {
      const next = kids[MAX_BUBBLES];
      setFocus(next ? nodeId(next) : null);
      return;
    }
    const node = kids.find((c) => nodeId(c) === id);
    if (node) open(node);
  };

  const rescan = () => scanSpaces();

  const reveal = (path: string) => {
    api.revealPath(path).catch((e: unknown) => toast(e instanceof Error ? e.message : 'Could not open that folder', 'err'));
  };

  useEffect(() => {
    if (!focus) return;
    document.getElementById(`fx-node-${focus}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [focus]);

  const loading = busy || scanning || !!prog;
  const total = splitBytes(current?.size ?? 0);

  return (
    <div className="screen">
      <ScreenHead title="Space Map" sub="See what fills your disk. Bigger bubble, more space. Tap one to look inside.">
        {current && (
          <div className="fx-stat">
            <span>{trail.length ? 'This folder' : 'Mapped'}</span>
            <div className="fx-big">
              {total.value}
              <small>{total.unit}</small>
            </div>
          </div>
        )}
        <button type="button" className="btn small" onClick={() => void rescan()} disabled={busy}>
          {busy ? <span className="spinner" /> : <Icon name="scan" />}
          {busy ? 'Mapping' : 'Rescan'}
        </button>
      </ScreenHead>

      {!tree && (
        <section className="card-w rise">
          {loading ? (
            <div className="fx-wait">
              <span className="orb">
                <Icon name="bubbles" />
              </span>
              <h3>Measuring your folders</h3>
              <p>{prog?.phase ?? 'Walking through your home folder. Big drives take a minute.'}</p>
              <Progress value={prog && prog.total > 0 ? prog.done / prog.total : undefined} />
              {prog?.current && <div className="cur">{shortPath(prog.current, home)}</div>}
            </div>
          ) : (
            <Empty icon="bubbles" title="No map yet" text="Measure your home folder to see where the space goes.">
              <button type="button" className="btn primary" onClick={() => void rescan()}>
                <Icon name="scan" /> Map my disk
              </button>
            </Empty>
          )}
        </section>
      )}

      {tree && current && (
        <div className="fx-map">
          <section className="card-w fx-stage rise" style={{ animationDelay: '0.06s' }} aria-label="Space map">
            <div className="fx-stage-head">
              <nav className="fx-crumbs" aria-label="Folder path">
                {[tree, ...trail].map((n, i, all) => (
                  <span key={i} style={{ display: 'contents' }}>
                    {i > 0 && <span className="sep">/</span>}
                    <button
                      type="button"
                      aria-current={i === all.length - 1}
                      onClick={() => {
                        setTrail(trail.slice(0, i));
                        setFocus(null);
                      }}
                    >
                      {i === 0 ? n.name || 'Home' : n.name}
                    </button>
                  </span>
                ))}
              </nav>
              <span className="grow" />
              {trail.length > 0 && (
                <button type="button" className="btn small ghost" onClick={() => setTrail(trail.slice(0, -1))}>
                  <Icon name="arrow" style={{ transform: 'rotate(180deg)' }} /> Up
                </button>
              )}
            </div>
            {bubbles.length ? (
              <Bubbles items={bubbles} onSelect={onBubble} selectedId={focus ?? undefined} />
            ) : (
              <Empty icon="folder" title="Nothing big in here" text="This folder is empty or only holds tiny files." />
            )}
            <div className="fx-stage-foot">
              <i />
              <span>Badge: something here can be cleaned</span>
              <span className="grow" />
              {busy && (
                <>
                  <span className="spinner" style={{ width: 14, height: 14 }} />
                  <span>Updating</span>
                </>
              )}
            </div>
          </section>

          <aside className="card-w fx-side rise" style={{ animationDelay: '0.12s' }} aria-label="Folder contents">
            <div className="fx-side-head">
              <div className="grow">
                <h2>{current === tree ? current.name || 'Home' : current.name}</h2>
                <p title={current.path}>{shortPath(current.path, home)}</p>
              </div>
              <button type="button" className="icon-btn" title="Show in folder" aria-label="Show in folder" onClick={() => reveal(current.path)}>
                <Icon name="reveal" />
              </button>
            </div>
            {current.reclaimable >= HINT_MIN && (
              <div className="fx-hint">
                <Icon name="spark" />
                <span className="grow">
                  About <b>{formatBytes(current.reclaimable)}</b> here looks reclaimable: caches and old downloads.
                </span>
                <button type="button" className="btn small" onClick={() => go('cleanup')}>
                  Review
                </button>
              </div>
            )}
            {kids.length === 0 ? (
              <Empty icon="folder" title="Empty folder" />
            ) : (
              <div className="list fx-list">
                {kids.slice(0, 80).map((c) => {
                  const drill = !!c.children?.length;
                  const share = current.size > 0 ? Math.max(1, Math.round((c.size / current.size) * 100)) : 0;
                  return (
                    <div
                      key={nodeId(c)}
                      id={`fx-node-${nodeId(c)}`}
                      className={`row${drill ? ' drill' : ''}${focus === nodeId(c) ? ' sel' : ''}`}
                      onClick={() => open(c)}
                      role={drill ? 'button' : undefined}
                      tabIndex={drill ? 0 : undefined}
                      onKeyDown={(e) => {
                        if (drill && (e.key === 'Enter' || e.key === ' ')) {
                          e.preventDefault();
                          open(c);
                        }
                      }}
                    >
                      <span className={`chip-ico${c.reclaimable >= HINT_MIN ? ' warm' : ''}`}>
                        <Icon name={c.icon} />
                      </span>
                      <div className="grow">
                        <div className="title">{c.name}</div>
                        {c.reclaimable >= HINT_MIN ? (
                          <div className="sub">{formatBytes(c.reclaimable)} can go</div>
                        ) : (
                          <div className="fx-share">
                            <i style={{ width: `${share}%` }} />
                          </div>
                        )}
                      </div>
                      <span className="size">{formatBytes(c.size)}</span>
                      <button
                        type="button"
                        className="icon-btn"
                        title="Show in folder"
                        aria-label={`Show ${c.name} in folder`}
                        onClick={(e) => {
                          e.stopPropagation();
                          reveal(c.path);
                        }}
                      >
                        <Icon name="reveal" />
                      </button>
                    </div>
                  );
                })}
                {kids.length > 80 && <div className="row sub muted">and {kids.length - 80} smaller items</div>}
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
