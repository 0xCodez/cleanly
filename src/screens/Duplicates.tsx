import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DuplicateGroup, IconName } from '../../shared/types';
import { api } from '../api';
import { Icon } from '../components/Icon';
import { Empty, Progress, ScreenHead } from '../components/ui';
import { formatBytes, formatDate, shortPath, splitBytes, sum } from '../lib/format';
import { useFileIcons } from '../lib/useFileIcons';
import { driveOf, useStore } from '../state';
import './files.css';

const PAGE = 30;

const EXT_ICON: [RegExp, IconName][] = [
  [/\.(mp4|mov|mkv|avi|webm|m4v|wmv)$/i, 'video'],
  [/\.(jpe?g|png|gif|heic|webp|tiff?|bmp|raw|cr2|nef|dng)$/i, 'photo'],
  [/\.(mp3|wav|flac|aac|m4a|ogg)$/i, 'music'],
  [/\.(zip|rar|7z|tar|gz|tgz|bz2|xz)$/i, 'layers'],
  [/\.(pdf|docx?|xlsx?|pptx?|txt|rtf|odt|pages|key|numbers|csv)$/i, 'doc'],
  [/\.(dmg|iso|img|exe|msi|pkg)$/i, 'down'],
  [/\.(js|ts|py|json|html|css|java|c|cpp|cs|go|rs)$/i, 'code'],
];

const baseName = (p: string) => p.split(/[\\/]/).pop() || p;
const parentDir = (p: string) => p.replace(/[\\/][^\\/]*$/, '');
const iconFor = (name: string): IconName => EXT_ICON.find(([re]) => re.test(name))?.[1] ?? 'file';
const newestPath = (g: DuplicateGroup) => g.files.reduce((a, b) => (b.modified > a.modified ? b : a)).path;
const wasted = (g: DuplicateGroup) => g.size * Math.max(0, g.files.length - 1);

// hashing is slow; keep the result while the app is open
let cache: DuplicateGroup[] | null = null;
let pending: Promise<DuplicateGroup[]> | null = null;

function scan(): Promise<DuplicateGroup[]> {
  pending ??= api.scanDuplicates().then(
    (groups) => {
      cache = groups.filter((g) => g.files.length > 1).sort((a, b) => wasted(b) - wasted(a));
      pending = null;
      return cache;
    },
    (e: unknown) => {
      pending = null;
      throw e;
    },
  );
  return pending;
}

export default function Duplicates() {
  const { progress, system, disks, settings, toast, refreshDisk } = useStore();
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(cache);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [keep, setKeep] = useState<Record<string, string>>({});
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(PAGE);
  const [confirming, setConfirming] = useState(false);
  const [trashing, setTrashing] = useState(false);

  const home = system?.homeDir;
  const prog = progress?.task === 'dupes' ? progress : null;

  const load = useCallback(
    async (force = false) => {
      if (!force && cache) {
        setGroups(cache);
        return;
      }
      if (force) cache = null;
      setLoading(true);
      setFailed(false);
      try {
        const next = await scan();
        setGroups(next);
        setKeep({});
        setSkip(new Set());
        setLimit(PAGE);
      } catch (e) {
        setFailed(true);
        toast(e instanceof Error ? e.message : '无法比较文件', 'err');
      } finally {
        setLoading(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const keeperOf = useCallback((g: DuplicateGroup) => keep[g.hash] ?? newestPath(g), [keep]);

  const toTrash = useMemo(
    () => (groups ?? []).filter((g) => !skip.has(g.hash)).flatMap((g) => g.files.filter((f) => f.path !== keeperOf(g)).map((f) => ({ path: f.path, size: g.size }))),
    [groups, skip, keeperOf],
  );
  const trashSize = sum(toTrash.map((f) => f.size));
  const totalWasted = sum((groups ?? []).map(wasted));

  const toggleGroup = (hash: string) =>
    setSkip((s) => {
      const n = new Set(s);
      if (n.has(hash)) n.delete(hash);
      else n.add(hash);
      return n;
    });

  const reveal = (path: string) => {
    api.revealPath(path).catch((e: unknown) => toast(e instanceof Error ? e.message : '无法显示该文件', 'err'));
  };

  const trash = async () => {
    setConfirming(false);
    setTrashing(true);
    const paths = toTrash.map((f) => f.path);
    try {
      const result = await api.trashPaths(paths);
      const moved = result.removed;
      const note = result.failed > 0 ? ` · ${result.failed} 个无法移动` : '';
      toast(`已将 ${moved} 个副本（${formatBytes(result.freed)}）移到回收站${note}`, result.failed && !moved ? 'err' : 'ok');
      if (result.failed > 0) {
        await load(true);
      } else {
        const gone = new Set(paths);
        const next = (groups ?? [])
          .map((g) => ({ ...g, files: g.files.filter((f) => !gone.has(f.path)) }))
          .filter((g) => g.files.length > 1);
        cache = next;
        setGroups(next);
      }
      void refreshDisk();
    } catch (e) {
      toast(e instanceof Error ? e.message : '无法将副本移到回收站', 'err');
    } finally {
      setTrashing(false);
    }
  };

  const icons = useFileIcons((groups ?? []).slice(0, limit).map((g) => g.files[0]?.path));

  const total = splitBytes(totalWasted);
  const sel = splitBytes(trashSize);
  const n = toTrash.length;

  return (
    <div className="screen">
      <ScreenHead title="重复文件" sub="按内容而非名称匹配的完全相同文件。我们保留最新的一份副本，其余移到回收站。">
        {groups && groups.length > 0 && (
          <div className="fx-stat">
            <span>浪费空间</span>
            <div className="fx-big">
              {total.value}
              <small>{total.unit}</small>
            </div>
          </div>
        )}
        <button type="button" className="btn small" onClick={() => void load(true)} disabled={loading || trashing}>
          {loading ? <span className="spinner" /> : <Icon name="scan" />}
          {loading ? '正在比较' : '重新扫描'}
        </button>
      </ScreenHead>

      {!groups && (
        <section className="card-w rise">
          {failed ? (
            <Empty icon="warning" title="比较未完成" text="遇到了一些阻碍。请再试一次。">
              <button type="button" className="btn primary" onClick={() => void load(true)}>
                重试
              </button>
            </Empty>
          ) : (
            <div className="fx-wait">
              <span className="orb">
                <Icon name="dupes" />
              </span>
              <h3>正在比较你的文件</h3>
              <p>{prog?.phase ? `${prog.phase}. ` : ''}我们会逐字节检查内容，因此可能需要一两分钟。期间你可以随意浏览其他页面。</p>
              <Progress value={prog && prog.total > 0 ? prog.done / prog.total : undefined} />
              {prog?.current && <div className="cur">{shortPath(prog.current, home)}</div>}
            </div>
          )}
        </section>
      )}

      {groups && groups.length === 0 && (
        <section className="card-w rise">
          <Empty icon="check" title="没有重复文件" text="这里的每个文件都是独一无二的。非常整洁。" />
        </section>
      )}

      {groups && groups.length > 0 && (
        <>
          {loading && (
            <section className="card-w">
              <div className="fx-strip">
                <span className="spinner" />
                <span>{prog?.phase ?? '正在再次比较'}</span>
                <Progress value={prog && prog.total > 0 ? prog.done / prog.total : undefined} />
              </div>
            </section>
          )}
          <div className="fx-groups">
            {groups.slice(0, limit).map((g, i) => {
              const name = baseName(g.files[0].path);
              const keeper = keeperOf(g);
              const newest = newestPath(g);
              const off = skip.has(g.hash);
              return (
                <section key={g.hash} className={`card-w fx-group rise${off ? ' skip' : ''}`} style={{ animationDelay: `${Math.min(i, 8) * 0.04}s` }}>
                  <div className="fx-group-head">
                    <input
                      type="checkbox"
                      className="check"
                      checked={!off}
                      disabled={trashing}
                      onChange={() => toggleGroup(g.hash)}
                      aria-label={`包含 ${name}`}
                    />
                    {icons[g.files[0].path] ? (
                      <span className="chip-ico real">
                        <img src={icons[g.files[0].path]} alt="" draggable={false} />
                      </span>
                    ) : (
                      <span className="chip-ico">
                        <Icon name={iconFor(name)} />
                      </span>
                    )}
                    <div className="grow">
                      <div className="title" title={name}>
                        {name}
                      </div>
                      <div className="sub">
                        {g.files.length} 个副本 · 每个 {formatBytes(g.size)}
                      </div>
                    </div>
                    <div className="fx-wasted">
                      <b>{formatBytes(wasted(g))}</b>
                      <span>浪费</span>
                    </div>
                  </div>
                  <div className="list fx-copies" role="radiogroup" aria-label={`要保留的 ${name} 副本`}>
                    {g.files.map((f) => {
                      const kept = f.path === keeper;
                      const drive = driveOf(f.path, home, disks);
                      return (
                        <label key={f.path} className={`row${kept ? ' keep' : ''}`}>
                          <input
                            type="radio"
                            className="fx-radio"
                            name={`keep-${g.hash}`}
                            checked={kept}
                            disabled={trashing}
                            onChange={() => setKeep((k) => ({ ...k, [g.hash]: f.path }))}
                            aria-label="保留这一份"
                          />
                          <div className="grow">
                            <div className="title" title={f.path}>
                              {drive ? (
                                <>
                                  <span className="fx-drive">{drive.name}</span>
                                  {drive.dir}
                                </>
                              ) : (
                                shortPath(parentDir(f.path), home)
                              )}
                            </div>
                            <div className="sub">
                              修改于 {formatDate(f.modified)}
                              {f.path === newest && ' · 最新'}
                            </div>
                          </div>
                          <span className={`fx-fate ${kept ? 'keep' : 'trash'}`}>{kept ? '保留' : off ? '跳过' : '移到回收站'}</span>
                          <button
                            type="button"
                            className="icon-btn"
                            title="在文件夹中显示"
                            aria-label="在文件夹中显示"
                            onClick={(e) => {
                              e.preventDefault();
                              reveal(f.path);
                            }}
                          >
                            <Icon name="reveal" />
                          </button>
                        </label>
                      );
                    })}
                  </div>
                </section>
              );
            })}
            {groups.length > limit && (
              <button type="button" className="btn fx-more" onClick={() => setLimit((l) => l + PAGE)}>
                再显示 {Math.min(PAGE, groups.length - limit)} 组，共剩余 {groups.length - limit} 组
              </button>
            )}
          </div>

          {n > 0 &&
            (confirming ? (
              <div className="fx-dock" role="alertdialog" aria-label="确认移到回收站">
                <span className="chip-ico">
                  <Icon name="trash" />
                </span>
                <div className="grow">
                  <div className="fx-dock-q">
                    将 {n} 个副本（{formatBytes(trashSize)}）移到回收站？
                  </div>
                  <div className="fx-dock-note">每个文件会保留一份副本在原处。其余副本可从回收站恢复。</div>
                </div>
                <button type="button" className="btn ghost" onClick={() => setConfirming(false)}>
                  取消
                </button>
                <button type="button" className="btn primary" onClick={() => void trash()} autoFocus>
                  移到回收站
                </button>
              </div>
            ) : (
              <div className="fx-dock">
                <div className="grow">
                  <div className="fx-dock-num">
                    {sel.value}
                    <small>{sel.unit} 已选</small>
                  </div>
                  <div className="fx-dock-sub">
                    {groups.length - skip.size} / {groups.length} 组 · 每组保留一份副本
                  </div>
                </div>
                <button
                  type="button"
                  className="btn primary"
                  disabled={trashing || loading}
                  onClick={() => (settings?.confirmBeforeClean === false ? void trash() : setConfirming(true))}
                >
                  {trashing ? <span className="spinner" style={{ borderColor: 'rgba(255,255,255,0.35)', borderTopColor: '#fff' }} /> : <Icon name="trash" />}
                  {trashing ? '正在移动' : `将 ${n} 个副本移到回收站`}
                </button>
              </div>
            ))}
        </>
      )}
    </div>
  );
}
