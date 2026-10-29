import { useCallback, useEffect, useMemo, useState } from 'react';
import type { InstalledApp } from '../../shared/types';
import { api } from '../api';
import { Icon } from '../components/Icon';
import { Empty, ScreenHead, Segmented } from '../components/ui';
import { formatBytes, sum, timeAgo } from '../lib/format';
import { useFileIcons } from '../lib/useFileIcons';
import { useStore } from '../state';
import './system.css';

type Sort = 'name' | 'size' | 'used';

const GRADIENTS: [string, string][] = [
  ['#6d7bff', '#a77bff'],
  ['#ff8fc8', '#ff5d8f'],
  ['#3fd6a0', '#5fc6ff'],
  ['#ffb547', '#ff7aa8'],
  ['#1a86c4', '#6d7bff'],
  ['#8a5cff', '#ff8fc8'],
  ['#4f6a14', '#a6c94a'],
  ['#c4253a', '#ff8f5a'],
];

function avatarStyle(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const [a, b] = GRADIENTS[h % GRADIENTS.length];
  return { background: `linear-gradient(135deg, ${a}, ${b})` };
}

function initial(name: string) {
  const ch = name.trim().match(/[\p{L}\p{N}]/u);
  return ch ? ch[0].toUpperCase() : '?';
}

function AppIcon({ app, src }: { app: InstalledApp; src?: string }) {
  const [broken, setBroken] = useState(false);
  if (src && !broken) {
    return (
      <span className="sy-av sy-av-img" aria-hidden="true">
        <img src={src} alt="" draggable={false} decoding="async" onError={() => setBroken(true)} />
      </span>
    );
  }
  return (
    <span className="sy-av" style={avatarStyle(app.name)} aria-hidden="true">
      {initial(app.name)}
    </span>
  );
}

export default function Apps() {
  const { toast, refreshDisk } = useStore();
  const [apps, setApps] = useState<InstalledApp[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('size');
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      setFailed(false);
      try {
        setApps(await api.installedApps());
      } catch (e) {
        if (!quiet) {
          setFailed(true);
          toast(e instanceof Error ? e.message : 'Could not list your apps', 'err');
        }
      } finally {
        setLoading(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (apps ?? []).filter(
      (a) => !q || a.name.toLowerCase().includes(q) || (a.publisher ?? '').toLowerCase().includes(q),
    );
    const byName = (a: InstalledApp, b: InstalledApp) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    return [...list].sort((a, b) => {
      if (sort === 'size') return (b.size ?? -1) - (a.size ?? -1) || byName(a, b);
      if (sort === 'used') return (b.lastUsed ?? -1) - (a.lastUsed ?? -1) || byName(a, b);
      return byName(a, b);
    });
  }, [apps, query, sort]);

  const uninstall = async (app: InstalledApp) => {
    setConfirming(null);
    setBusy(app.id);
    try {
      const res = await api.uninstallApp(app.id);
      toast(res.message || (res.ok ? `${app.name} removed` : `Could not uninstall ${app.name}`), res.ok ? 'ok' : 'err');
      if (res.ok) {
        void load(true);
        void refreshDisk();
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : `Could not uninstall ${app.name}`, 'err');
    } finally {
      setBusy(null);
    }
  };

  // Stable list (biggest apps first, like the default view) so searching or re-sorting never restarts icon loading.
  const iconPaths = useMemo(() => [...(apps ?? [])].sort((a, b) => (b.size ?? -1) - (a.size ?? -1)).map((a) => a.iconPath), [apps]);
  const icons = useFileIcons(iconPaths);

  const total = sum((apps ?? []).map((a) => a.size ?? 0));

  return (
    <div className="screen sy-screen">
      <ScreenHead title="Applications" sub="Everything installed on this computer. Remove what you no longer use with the app's own uninstaller.">
        {apps && (
          <div className="sy-head-meta">
            <b>{apps.length}</b> apps
            {total > 0 && (
              <>
                <span>·</span>
                <b>{formatBytes(total)}</b> in total
              </>
            )}
          </div>
        )}
      </ScreenHead>

      <div className="sy-toolbar rise" style={{ animationDelay: '0.06s' }}>
        <label className="sy-search">
          <Icon name="search" />
          <input
            className="input"
            type="search"
            placeholder="Search by name or publisher"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search apps"
          />
        </label>
        <Segmented<Sort>
          label="Sort apps"
          value={sort}
          onChange={setSort}
          options={[
            { value: 'name', label: 'Name' },
            { value: 'size', label: 'Size' },
            { value: 'used', label: 'Last used' },
          ]}
        />
      </div>

      <section className="card-w panel rise" style={{ animationDelay: '0.12s' }}>
        {loading && !apps ? (
          <div className="sy-center">
            <span className="spinner" />
            Gathering your apps
          </div>
        ) : failed && !apps ? (
          <Empty icon="warning" title="Could not list your apps" text="Something blocked the check. Try again in a moment.">
            <button type="button" className="btn" onClick={() => void load()}>
              Try again
            </button>
          </Empty>
        ) : shown.length === 0 ? (
          <Empty
            icon={query ? 'search' : 'apps'}
            title={query ? 'No matches' : 'No apps found'}
            text={query ? `Nothing matches "${query.trim()}".` : 'We could not find installed apps on this computer.'}
          />
        ) : (
          <>
            {query.trim() && (
              <div className="sy-sec-head">
                <span className="sy-count">
                  {shown.length} of {apps?.length ?? 0} apps
                </span>
              </div>
            )}
            <div className="list">
              {shown.map((app) => (
                <div key={app.id} className="row">
                  <AppIcon app={app} src={app.iconPath ? icons[app.iconPath] : undefined} />
                  <div className="grow">
                    <div className="title">{app.name}</div>
                    <div className="sub">
                      {[app.publisher, app.version && `v${app.version}`].filter(Boolean).join(' · ') || 'Unknown publisher'}
                    </div>
                  </div>
                  <div className="sy-meta">
                    <span className="size">{app.size ? formatBytes(app.size) : '—'}</span>
                    {app.lastUsed ? <small>Used {timeAgo(app.lastUsed)}</small> : null}
                  </div>
                  <div className="sy-act">
                    {busy === app.id ? (
                      <span className="sy-lock">
                        <span className="spinner" />
                        Starting uninstaller
                      </span>
                    ) : confirming === app.id ? (
                      <div className="sy-confirm">
                        <span>Uninstall?</span>
                        <button type="button" className="btn small ghost" onClick={() => setConfirming(null)}>
                          Cancel
                        </button>
                        <button type="button" className="btn small danger" onClick={() => void uninstall(app)}>
                          Uninstall
                        </button>
                      </div>
                    ) : app.canUninstall ? (
                      <button
                        type="button"
                        className="btn small"
                        disabled={busy !== null}
                        onClick={() => setConfirming(app.id)}
                      >
                        <Icon name="trash" />
                        Uninstall
                      </button>
                    ) : (
                      <span className="sy-lock" title="This app is part of the system or managed elsewhere">
                        <Icon name="lock" />
                        Built in
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
