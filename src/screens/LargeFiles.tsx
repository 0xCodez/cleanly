import { useCallback, useEffect, useMemo, useState } from 'react';
import type { IconName, LargeFile } from '../../shared/types';
import { api } from '../api';
import { Icon } from '../components/Icon';
import { Empty, Progress, ScreenHead, Segmented } from '../components/ui';
import { formatBytes, shortPath, splitBytes, sum, timeAgo } from '../lib/format';
import { useFileIcons } from '../lib/useFileIcons';
import { driveOf, useStore } from '../state';
import './files.css';

type Filter = 'all' | 'video' | 'archive' | 'disk-image' | 'installer' | 'other';
type Sort = 'size' | 'oldest';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'video', label: 'Videos' },
  { id: 'archive', label: 'Archives' },
  { id: 'disk-image', label: 'Disk images' },
  { id: 'installer', label: 'Installers' },
  { id: 'other', label: 'Other' },
];

const KIND_ICON: Record<LargeFile['kind'], IconName> = {
  video: 'video',
  archive: 'layers',
  'disk-image': 'chip',
  installer: 'down',
  audio: 'music',
  photo: 'photo',
  document: 'doc',
  other: 'file',
};

const MAIN_KINDS = new Set<LargeFile['kind']>(['video', 'archive', 'disk-image', 'installer']);
const MB = 1024 * 1024;

const filterOf = (f: LargeFile): Filter => (MAIN_KINDS.has(f.kind) ? (f.kind as Filter) : 'other');
const lastUsed = (f: LargeFile) => Math.max(f.accessed || 0, f.modified || 0);
const parentDir = (p: string) => p.replace(/[\\/][^\\/]*$/, '');

// results survive leaving the screen; the walk is not cheap
let cache: { min: number; files: LargeFile[] } | null = null;
let pending: { min: number; promise: Promise<LargeFile[]> } | null = null;

function scan(min: number): Promise<LargeFile[]> {
  if (pending && pending.min === min) return pending.promise;
  const promise = api.scanLargeFiles(min).then(
    (files) => {
      cache = { min, files };
      pending = null;
      return files;
    },
    (e: unknown) => {
      pending = null;
      throw e;
    },
  );
  pending = { min, promise };
  return promise;
}

export default function LargeFiles() {
  const { settings, progress, system, disks, toast, refreshDisk } = useStore();
  const min = settings ? settings.largeFileMinMb * MB : null;
  const [files, setFiles] = useState<LargeFile[] | null>(cache && cache.min === min ? cache.files : null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('size');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [trashing, setTrashing] = useState(false);

  const home = system?.homeDir;
  const prog = progress?.task === 'large' ? progress : null;

  const load = useCallback(
    async (force = false) => {
      if (min === null) return;
      if (!force && cache && cache.min === min) {
        setFiles(cache.files);
        return;
      }
      if (force) cache = null;
      setLoading(true);
      setFailed(false);
      try {
        const next = await scan(min);
        setFiles(next);
        setSelected(new Set());
      } catch (e) {
        setFailed(true);
        toast(e instanceof Error ? e.message : 'Could not look for large files', 'err');
      } finally {
        setLoading(false);
      }
    },
    [min, toast],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: 0, video: 0, archive: 0, 'disk-image': 0, installer: 0, other: 0 };
    for (const f of files ?? []) {
      c.all++;
      c[filterOf(f)]++;
    }
    return c;
  }, [files]);

  const shown = useMemo(() => {
    const list = (files ?? []).filter((f) => filter === 'all' || filterOf(f) === filter);
    return list.sort(sort === 'size' ? (a, b) => b.size - a.size : (a, b) => lastUsed(a) - lastUsed(b));
  }, [files, filter, sort]);

  const icons = useFileIcons(shown.map((f) => f.path));
  const otherDrives = (disks?.length ?? 0) > 1;

  const chosen = (files ?? []).filter((f) => selected.has(f.path));
  const chosenSize = sum(chosen.map((f) => f.size));
  const totalSize = sum((files ?? []).map((f) => f.size));
  const shownAllOn = shown.length > 0 && shown.every((f) => selected.has(f.path));

  const toggle = (path: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      return n;
    });

  const toggleShown = () =>
    setSelected((s) => {
      const n = new Set(s);
      for (const f of shown) {
        if (shownAllOn) n.delete(f.path);
        else n.add(f.path);
      }
      return n;
    });

  const reveal = (path: string) => {
    api.revealPath(path).catch((e: unknown) => toast(e instanceof Error ? e.message : 'Could not show that file', 'err'));
  };

  const trash = async () => {
    setConfirming(false);
    setTrashing(true);
    const paths = chosen.map((f) => f.path);
    try {
      const result = await api.trashPaths(paths);
      const moved = result.removed;
      const note = result.failed > 0 ? ` · ${result.failed} could not be moved` : '';
      toast(`Moved ${moved} ${moved === 1 ? 'file' : 'files'} (${formatBytes(result.freed)}) to Trash${note}`, result.failed && !moved ? 'err' : 'ok');
      if (result.failed > 0) {
        await load(true);
      } else {
        const gone = new Set(paths);
        const next = (files ?? []).filter((f) => !gone.has(f.path));
        setFiles(next);
        if (min !== null) cache = { min, files: next };
        setSelected(new Set());
      }
      void refreshDisk();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not move files to Trash', 'err');
    } finally {
      setTrashing(false);
    }
  };

  const total = splitBytes(totalSize);

  return (
    <div className="screen">
      <ScreenHead
        title="Large Files"
        sub={`Files over ${settings ? formatBytes(settings.largeFileMinMb * MB) : '…'} that you may have forgotten${otherDrives ? ', on every drive' : ''}. Anything you remove goes to the Trash.`}
      >
        {files && files.length > 0 && (
          <div className="fx-stat">
            <span>{files.length} files</span>
            <div className="fx-big">
              {total.value}
              <small>{total.unit}</small>
            </div>
          </div>
        )}
        <button type="button" className="btn small" onClick={() => void load(true)} disabled={loading || trashing || min === null}>
          {loading ? <span className="spinner" /> : <Icon name="scan" />}
          {loading ? 'Searching' : 'Rescan'}
        </button>
      </ScreenHead>

      {!files && (
        <section className="card-w rise">
          {failed ? (
            <Empty icon="warning" title="Search didn't finish" text="Something got in the way. Give it another try.">
              <button type="button" className="btn primary" onClick={() => void load(true)}>
                Try again
              </button>
            </Empty>
          ) : (
            <div className="fx-wait">
              <span className="orb">
                <Icon name="file" />
              </span>
              <h3>Looking for big files</h3>
              <p>{prog?.phase ?? (otherDrives ? 'Checking your home folder and your other drives.' : 'Checking Downloads, Desktop, Documents, Movies and more.')}</p>
              <Progress value={prog && prog.total > 0 ? prog.done / prog.total : undefined} />
              {prog?.current && <div className="cur">{shortPath(prog.current, home)}</div>}
            </div>
          )}
        </section>
      )}

      {files && files.length === 0 && (
        <section className="card-w rise">
          <Empty icon="check" title="No large files" text="Nothing above your size limit. You can lower it in Settings." />
        </section>
      )}

      {files && files.length > 0 && (
        <>
          <div className="fx-filters rise" style={{ animationDelay: '0.04s' }}>
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                className="fx-chip"
                aria-pressed={filter === f.id}
                disabled={f.id !== 'all' && counts[f.id] === 0}
                onClick={() => setFilter(f.id)}
              >
                {f.label}
                <i>{counts[f.id]}</i>
              </button>
            ))}
            <span className="grow" />
            <Segmented<Sort>
              label="Sort files"
              value={sort}
              onChange={setSort}
              options={[
                { value: 'size', label: 'Size' },
                { value: 'oldest', label: 'Oldest' },
              ]}
            />
          </div>

          <section className="card-w fx-panel rise" style={{ animationDelay: '0.08s' }}>
            {loading && (
              <div className="fx-strip">
                <span className="spinner" />
                <span>{prog?.phase ?? 'Searching again'}</span>
                <Progress value={prog && prog.total > 0 ? prog.done / prog.total : undefined} />
              </div>
            )}
            <div className="fx-panel-head">
              <h2>{FILTERS.find((f) => f.id === filter)?.label}</h2>
              <span className="fx-count">
                {shown.length} · {formatBytes(sum(shown.map((f) => f.size)))}
              </span>
              <span className="grow" />
              <button type="button" className="fx-link" onClick={toggleShown} disabled={!shown.length || trashing}>
                {shownAllOn ? 'Select none' : 'Select all'}
              </button>
            </div>
            {shown.length === 0 ? (
              <Empty icon="search" title="Nothing in this group" />
            ) : (
              <div className="list fx-list">
                {shown.map((f) => {
                  const on = selected.has(f.path);
                  const opened = f.accessed > 0 && f.accessed >= f.modified;
                  const drive = driveOf(f.path, home, disks);
                  return (
                    <label key={f.path} className={`row${on ? ' on' : ''}`}>
                      <input type="checkbox" className="check" checked={on} disabled={trashing} onChange={() => toggle(f.path)} aria-label={f.name} />
                      {icons[f.path] ? (
                        <span className="chip-ico real">
                          <img src={icons[f.path]} alt="" draggable={false} />
                        </span>
                      ) : (
                        <span className={`chip-ico k-${f.kind}`}>
                          <Icon name={KIND_ICON[f.kind]} />
                        </span>
                      )}
                      <div className="grow">
                        <div className="title" title={f.name}>
                          {f.name}
                        </div>
                        <div className="sub mono" title={f.path}>
                          {drive ? (
                            <>
                              <span className="fx-drive">{drive.name}</span>
                              {drive.dir}
                            </>
                          ) : (
                            shortPath(parentDir(f.path), home)
                          )}
                        </div>
                      </div>
                      <span className="fx-meta">
                        {opened ? 'last opened' : 'changed'} {timeAgo(lastUsed(f))}
                      </span>
                      <span className="size">{formatBytes(f.size)}</span>
                      <button
                        type="button"
                        className="icon-btn"
                        title="Show in folder"
                        aria-label={`Show ${f.name} in folder`}
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
            )}
          </section>

          {chosen.length > 0 &&
            (confirming ? (
              <div className="fx-dock" role="alertdialog" aria-label="Confirm move to Trash">
                <span className="chip-ico">
                  <Icon name="trash" />
                </span>
                <div className="grow">
                  <div className="fx-dock-q">
                    Move {chosen.length} {chosen.length === 1 ? 'file' : 'files'} ({formatBytes(chosenSize)}) to Trash?
                  </div>
                  <div className="fx-dock-note">You can restore them from the Trash until you empty it.</div>
                </div>
                <button type="button" className="btn ghost" onClick={() => setConfirming(false)}>
                  Cancel
                </button>
                <button type="button" className="btn primary" onClick={() => void trash()} autoFocus>
                  Move to Trash
                </button>
              </div>
            ) : (
              <div className="fx-dock">
                <div className="grow">
                  <div className="fx-dock-num">
                    {splitBytes(chosenSize).value}
                    <small>{splitBytes(chosenSize).unit} selected</small>
                  </div>
                  <div className="fx-dock-sub">
                    {chosen.length} {chosen.length === 1 ? 'file' : 'files'} · goes to Trash, restorable
                  </div>
                </div>
                <button type="button" className="btn ghost" onClick={() => setSelected(new Set())} disabled={trashing}>
                  Clear
                </button>
                <button
                  type="button"
                  className="btn primary"
                  disabled={trashing || loading}
                  onClick={() => (settings?.confirmBeforeClean === false ? void trash() : setConfirming(true))}
                >
                  {trashing ? <span className="spinner" style={{ borderColor: 'rgba(255,255,255,0.35)', borderTopColor: '#fff' }} /> : <Icon name="trash" />}
                  {trashing ? 'Moving' : 'Move to Trash'}
                </button>
              </div>
            ))}
        </>
      )}
    </div>
  );
}
