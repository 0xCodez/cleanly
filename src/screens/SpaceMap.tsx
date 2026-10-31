import { useEffect, useMemo, useState } from 'react';
import type { DiskInfo, SpaceNode } from '../../shared/types';
import { api } from '../api';
import { Bubbles, type BubbleDatum } from '../components/Bubbles';
import { Icon } from '../components/Icon';
import { Empty, Progress, ScreenHead, Segmented } from '../components/ui';
import { formatBytes, shortPath, splitBytes } from '../lib/format';
import { useFileIcons } from '../lib/useFileIcons';
import { driveName, useStore } from '../state';
import './files.css';

const MAX_BUBBLES = 12;
const HINT_MIN = 50 * 1024 * 1024;
const REST_ID = '__rest';

const bySize = (a: SpaceNode, b: SpaceNode) => b.size - a.size;
// "Loose files" and "N more items" reuse their parent's path, so the path alone is not unique
const nodeId = (n: SpaceNode) => `${n.path}|${n.name}`;

// '' is the home folder in the store; the switch needs a non-empty value
const HOME_SRC = '~';
interface Source {
  key: string;
  label: string;
  disk?: DiskInfo;
}
// the picked source survives leaving the screen
let lastSource = HOME_SRC;

export default function SpaceMap() {
  const { spaceMaps, spacesBusy, spacesFailed, scanSpaces, scanning, progress, system, disks, toast, go } = useStore();
  const [picked, setPicked] = useState(lastSource);
  const [trail, setTrail] = useState<SpaceNode[]>([]);
  const [focus, setFocus] = useState<string | null>(null);

  const sources = useMemo<Source[]>(
    () => [{ key: HOME_SRC, label: '主文件夹' }, ...(disks ?? []).map((d) => ({ key: d.mount, label: driveName(d), disk: d }))],
    [disks],
  );
  // a drive that went away falls back to home
  const source = sources.find((s) => s.key === picked) ?? sources[0];
  const root = source.disk?.mount;
  const storeKey = root ?? '';

  const tree = spaceMaps[storeKey] ?? null;
  const busy = spacesBusy.includes(storeKey);
  const failed = spacesFailed.includes(storeKey);
  const home = system?.homeDir;
  // walks share one progress channel; only trust it while this is the only walk running
  const prog = busy && spacesBusy.length === 1 && progress?.task === 'spaces' ? progress : null;

  useEffect(() => {
    setTrail([]);
    setFocus(null);
  }, [tree]);

  const current = trail.length ? trail[trail.length - 1] : tree;
  const kids = useMemo(() => [...(current?.children ?? [])].filter((c) => c.size > 0).sort(bySize), [current]);

  const fileIcons = useFileIcons(kids.slice(0, 80).map((c) => (c.kind === 'file' ? c.path : null)));
  // only rebuild the bubbles when an icon actually arrives, not on every render
  const bubbleIcons = kids.slice(0, MAX_BUBBLES).map((c) => (c.kind === 'file' ? fileIcons[c.path] : undefined));
  const iconSig = bubbleIcons.map((s) => (s ? 1 : 0)).join('');

  const bubbles = useMemo<BubbleDatum[]>(() => {
    const top: BubbleDatum[] = kids.slice(0, MAX_BUBBLES).map((c, i) => ({
      id: nodeId(c),
      name: c.name,
      size: c.size,
      icon: c.icon,
      img: bubbleIcons[i],
      badge: c.reclaimable >= HINT_MIN ? `−${formatBytes(c.reclaimable)}` : undefined,
    }));
    const rest = kids.slice(MAX_BUBBLES);
    if (rest.length) top.push({ id: REST_ID, name: `${rest.length} 更多`, size: rest.reduce((s, c) => s + c.size, 0), icon: 'more' });
    return top;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kids, iconSig]);

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

  const rescan = () => scanSpaces(root);

  const pick = (key: string) => {
    const next = sources.find((s) => s.key === key);
    if (!next || next.key === source.key) return;
    lastSource = key;
    setPicked(key);
    setTrail([]);
    setFocus(null);
    const k = next.disk?.mount ?? '';
    if (!spaceMaps[k] && !spacesBusy.includes(k)) void scanSpaces(next.disk?.mount);
  };

  const reveal = (path: string) => {
    api.revealPath(path).catch((e: unknown) => toast(e instanceof Error ? e.message : '无法打开该文件夹', 'err'));
  };

  useEffect(() => {
    if (!focus) return;
    document.getElementById(`fx-node-${focus}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [focus]);

  const loading = busy || (!root && scanning);
  const total = splitBytes(current?.size ?? 0);
  const rootLabel = source.disk ? source.label : tree?.name || '主文件夹';
  const where = source.disk ? `驱动器 ${source.label}` : '你的主文件夹';

  return (
    <div className="screen">
      <ScreenHead title="空间地图" sub="查看磁盘空间占用。气泡越大，占用越多。点按可查看内部，或推它一下。">
        {current && (
          <div className="fx-stat">
            <span>{trail.length ? '当前文件夹' : `已映射 · ${source.label}`}</span>
            <div className="fx-big">
              {total.value}
              <small>{total.unit}</small>
            </div>
          </div>
        )}
        <button type="button" className="btn small" onClick={() => void rescan()} disabled={busy}>
          {busy ? <span className="spinner" /> : <Icon name="scan" />}
          {busy ? '正在映射' : '重新扫描'}
        </button>
      </ScreenHead>

      {sources.length > 1 && (
        <div className="fx-source rise" style={{ animationDelay: '0.03s' }}>
          <Segmented<string> label="要映射的内容" value={source.key} onChange={pick} options={sources.map((s) => ({ value: s.key, label: s.label }))} />
          <SourceNote source={source} home={home} />
        </div>
      )}

      {!tree && (
        <section className="card-w rise">
          {loading ? (
            <div className="fx-wait">
              <span className="orb">
                <Icon name="bubbles" />
              </span>
              <h3>{source.disk ? `正在测量 ${source.label}` : '正在测量你的文件夹'}</h3>
              <p>{prog?.phase ?? (source.disk ? `正在遍历${where}上的每个文件夹。完整驱动器可能需要几分钟。` : '正在遍历你的主文件夹。大容量驱动器需要一分钟左右。')}</p>
              <Progress value={prog && prog.total > 0 ? prog.done / prog.total : undefined} />
              {prog?.current && <div className="cur">{shortPath(prog.current, home)}</div>}
            </div>
          ) : failed ? (
            <Empty icon="warning" title={`无法映射${source.disk ? source.label : '你的文件夹'}`} text="遇到了一些问题，请再试一次。">
              <button type="button" className="btn primary" onClick={() => void rescan()}>
                再试一次
              </button>
            </Empty>
          ) : (
            <Empty icon="bubbles" title="尚未生成地图" text={`测量${where}，查看空间占用情况。`}>
              <button type="button" className="btn primary" onClick={() => void rescan()}>
                <Icon name="scan" /> {source.disk ? `映射 ${source.label}` : '映射我的磁盘'}
              </button>
            </Empty>
          )}
        </section>
      )}

      {tree && current && (
        <div className="fx-map">
          <section className="card-w fx-stage rise" style={{ animationDelay: '0.06s' }} aria-label="空间地图">
            <div className="fx-stage-head">
              <nav className="fx-crumbs" aria-label="文件夹路径">
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
                      {i === 0 ? rootLabel : n.name}
                    </button>
                  </span>
                ))}
              </nav>
              <span className="grow" />
              {trail.length > 0 && (
                <button type="button" className="btn small ghost" onClick={() => setTrail(trail.slice(0, -1))}>
                  <Icon name="arrow" style={{ transform: 'rotate(180deg)' }} /> 上一级
                </button>
              )}
            </div>
            {bubbles.length ? (
              <Bubbles items={bubbles} onSelect={onBubble} selectedId={focus ?? undefined} />
            ) : (
              <Empty icon="folder" title="这里没有大文件" text="此文件夹为空，或仅包含小文件。" />
            )}
            <div className="fx-stage-foot">
              <i />
              <span>角标：此处有可清理内容</span>
              <span className="grow" />
              {busy && (
                <>
                  <span className="spinner" style={{ width: 14, height: 14 }} />
                  <span>正在更新</span>
                </>
              )}
            </div>
          </section>

          <aside className="card-w fx-side rise" style={{ animationDelay: '0.12s' }} aria-label="文件夹内容">
            <div className="fx-side-head">
              <div className="grow">
                <h2>{current === tree ? rootLabel : current.name}</h2>
                <p title={current.path}>{shortPath(current.path, home)}</p>
              </div>
              <button type="button" className="icon-btn" title="在文件夹中显示" aria-label="在文件夹中显示" onClick={() => reveal(current.path)}>
                <Icon name="reveal" />
              </button>
            </div>
            {current.reclaimable >= HINT_MIN && (
              <div className="fx-hint">
                <Icon name="spark" />
                <span className="grow">
                  此处约有 <b>{formatBytes(current.reclaimable)}</b> 可释放：缓存和旧下载文件。
                </span>
                <button type="button" className="btn small" onClick={() => go('cleanup')}>
                  查看
                </button>
              </div>
            )}
            {kids.length === 0 ? (
              <Empty icon="folder" title="空文件夹" />
            ) : (
              <div className="list fx-list">
                {kids.slice(0, 80).map((c) => {
                  const drill = !!c.children?.length;
                  const share = current.size > 0 ? Math.max(1, Math.round((c.size / current.size) * 100)) : 0;
                  const img = fileIcons[c.path];
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
                      {img ? (
                        <span className="chip-ico real">
                          <img src={img} alt="" draggable={false} />
                        </span>
                      ) : (
                        <span className={`chip-ico${c.reclaimable >= HINT_MIN ? ' warm' : ''}`}>
                          <Icon name={c.icon} />
                        </span>
                      )}
                      <div className="grow">
                        <div className="title">{c.name}</div>
                        {c.reclaimable >= HINT_MIN ? (
                          <div className="sub">{formatBytes(c.reclaimable)} 可清理</div>
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
                        title="在文件夹中显示"
                        aria-label={`在文件夹中显示 ${c.name}`}
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
                {kids.length > 80 && <div className="row sub muted">还有 {kids.length - 80} 个更小的项目</div>}
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

function SourceNote({ source, home }: { source: Source; home?: string }) {
  const d = source.disk;
  if (!d) return <span className="fx-source-note">{home ? `你的主文件夹 · ${shortPath(home)}` : '你的主文件夹'}</span>;
  const pct = d.total > 0 ? Math.min(100, (d.used / d.total) * 100) : 0;
  return (
    <span className="fx-source-note" title={`${d.label}：剩余 ${formatBytes(d.free)}`}>
      <span className="bar" aria-hidden="true">
        <span className="used" style={{ width: `${pct}%` }} />
      </span>
      已用 {formatBytes(d.used)}，共 {formatBytes(d.total)}{d.system ? ' · 系统驱动器' : ''}
    </span>
  );
}
