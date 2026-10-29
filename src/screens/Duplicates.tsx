import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DuplicateGroup, IconName } from '../../shared/types';
import { api } from '../api';
import { Icon } from '../components/Icon';
import { Empty, Progress, ScreenHead } from '../components/ui';
import { formatBytes, formatDate, shortPath, splitBytes, sum } from '../lib/format';
import { useStore } from '../state';
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
  const { progress, system, settings, toast, refreshDisk } = useStore();
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
        toast(e instanceof Error ? e.message : 'Could not compare files', 'err');
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
    api.revealPath(path).catch((e: unknown) => toast(e instanceof Error ? e.message : 'Could not show that file', 'err'));
  };

  const trash = async () => {
    setConfirming(false);
    setTrashing(true);
    const paths = toTrash.map((f) => f.path);
    try {
      const result = await api.trashPaths(paths);
      const moved = result.removed;
      const note = result.failed > 0 ? ` · ${result.failed} could not be moved` : '';
      toast(`Moved ${moved} ${moved === 1 ? 'copy' : 'copies'} (${formatBytes(result.freed)}) to Trash${note}`, result.failed && !moved ? 'err' : 'ok');
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
      toast(e instanceof Error ? e.message : 'Could not move copies to Trash', 'err');
    } finally {
      setTrashing(false);
    }
  };

  const total = splitBytes(totalWasted);
  const sel = splitBytes(trashSize);
  const n = toTrash.length;

  return (
    <div className="screen">
      <ScreenHead title="Duplicates" sub="Identical files, matched by content, not by name. We keep the newest copy and move the rest to the Trash.">
        {groups && groups.length > 0 && (
          <div className="fx-stat">
            <span>Wasted</span>
            <div className="fx-big">
              {total.value}
              <small>{total.unit}</small>
            </div>
          </div>
        )}
        <button type="button" className="btn small" onClick={() => void load(true)} disabled={loading || trashing}>
          {loading ? <span className="spinner" /> : <Icon name="scan" />}
          {loading ? 'Comparing' : 'Rescan'}
        </button>
      </ScreenHead>

      {!groups && (
        <section className="card-w rise">
          {failed ? (
            <Empty icon="warning" title="Comparison didn't finish" text="Something got in the way. Give it another try.">
              <button type="button" className="btn primary" onClick={() => void load(true)}>
                Try again
              </button>
            </Empty>
          ) : (
            <div className="fx-wait">
              <span className="orb">
                <Icon name="dupes" />
              </span>
              <h3>Comparing your files</h3>
              <p>{prog?.phase ? `${prog.phase}. ` : ''}We check contents byte by byte, so this can take a minute or two. Feel free to look around meanwhile.</p>
              <Progress value={prog && prog.total > 0 ? prog.done / prog.total : undefined} />
              {prog?.current && <div className="cur">{shortPath(prog.current, home)}</div>}
            </div>
          )}
        </section>
      )}

      {groups && groups.length === 0 && (
        <section className="card-w rise">
          <Empty icon="check" title="No duplicates" text="Every file here is one of a kind. Nice and tidy." />
        </section>
      )}

      {groups && groups.length > 0 && (
        <>
          {loading && (
            <section className="card-w">
              <div className="fx-strip">
                <span className="spinner" />
                <span>{prog?.phase ?? 'Comparing again'}</span>
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
                      aria-label={`Include ${name}`}
                    />
                    <span className="chip-ico">
                      <Icon name={iconFor(name)} />
                    </span>
                    <div className="grow">
                      <div className="title" title={name}>
                        {name}
                      </div>
                      <div className="sub">
                        {g.files.length} copies · {formatBytes(g.size)} each
                      </div>
                    </div>
                    <div className="fx-wasted">
                      <b>{formatBytes(wasted(g))}</b>
                      <span>wasted</span>
                    </div>
                  </div>
                  <div className="list fx-copies" role="radiogroup" aria-label={`Copy of ${name} to keep`}>
                    {g.files.map((f) => {
                      const kept = f.path === keeper;
                      return (
                        <label key={f.path} className={`row${kept ? ' keep' : ''}`}>
                          <input
                            type="radio"
                            className="fx-radio"
                            name={`keep-${g.hash}`}
                            checked={kept}
                            disabled={trashing}
                            onChange={() => setKeep((k) => ({ ...k, [g.hash]: f.path }))}
                            aria-label="Keep this one"
                          />
                          <div className="grow">
                            <div className="title" title={f.path}>
                              {shortPath(parentDir(f.path), home)}
                            </div>
                            <div className="sub">
                              Modified {formatDate(f.modified)}
                              {f.path === newest && ' · newest'}
                            </div>
                          </div>
                          <span className={`fx-fate ${kept ? 'keep' : 'trash'}`}>{kept ? 'Keep' : off ? 'Leave' : 'To Trash'}</span>
                          <button
                            type="button"
                            className="icon-btn"
                            title="Show in folder"
                            aria-label="Show in folder"
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
                Show {Math.min(PAGE, groups.length - limit)} more of {groups.length - limit}
              </button>
            )}
          </div>

          {n > 0 &&
            (confirming ? (
              <div className="fx-dock" role="alertdialog" aria-label="Confirm move to Trash">
                <span className="chip-ico">
                  <Icon name="trash" />
                </span>
                <div className="grow">
                  <div className="fx-dock-q">
                    Move {n} {n === 1 ? 'copy' : 'copies'} ({formatBytes(trashSize)}) to Trash?
                  </div>
                  <div className="fx-dock-note">One copy of each file stays where it is. You can restore the rest from the Trash.</div>
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
                    {sel.value}
                    <small>{sel.unit} selected</small>
                  </div>
                  <div className="fx-dock-sub">
                    {groups.length - skip.size} of {groups.length} groups · keeping one copy of each
                  </div>
                </div>
                <button
                  type="button"
                  className="btn primary"
                  disabled={trashing || loading}
                  onClick={() => (settings?.confirmBeforeClean === false ? void trash() : setConfirming(true))}
                >
                  {trashing ? <span className="spinner" style={{ borderColor: 'rgba(255,255,255,0.35)', borderTopColor: '#fff' }} /> : <Icon name="trash" />}
                  {trashing ? 'Moving' : `Move ${n} ${n === 1 ? 'copy' : 'copies'} to Trash`}
                </button>
              </div>
            ))}
        </>
      )}
    </div>
  );
}
