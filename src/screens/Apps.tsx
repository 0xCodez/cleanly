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
          toast(e instanceof Error ? e.message : '无法列出你的应用程序', 'err');
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
      toast(res.message || (res.ok ? `已移除 ${app.name}` : `无法卸载 ${app.name}`), res.ok ? 'ok' : 'err');
      if (res.ok) {
        void load(true);
        void refreshDisk();
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : `无法卸载 ${app.name}`, 'err');
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
      <ScreenHead title="应用程序" sub="这台电脑上安装的全部应用。使用应用自带的卸载程序移除不再需要的应用。">
        {apps && (
          <div className="sy-head-meta">
            <b>{apps.length}</b> 个应用
            {total > 0 && (
              <>
                <span>·</span>
                <b>{formatBytes(total)}</b> 总计
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
            placeholder="按名称或发行商搜索"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="搜索应用"
          />
        </label>
        <Segmented<Sort>
          label="排序应用"
          value={sort}
          onChange={setSort}
          options={[
            { value: 'name', label: '名称' },
            { value: 'size', label: '大小' },
            { value: 'used', label: '最近使用' },
          ]}
        />
      </div>

      <section className="card-w panel rise" style={{ animationDelay: '0.12s' }}>
        {loading && !apps ? (
          <div className="sy-center">
            <span className="spinner" />
            正在收集你的应用
          </div>
        ) : failed && !apps ? (
          <Empty icon="warning" title="无法列出你的应用程序" text="检查时遇到了阻碍。请稍后重试。">
            <button type="button" className="btn" onClick={() => void load()}>
              重试
            </button>
          </Empty>
        ) : shown.length === 0 ? (
          <Empty
            icon={query ? 'search' : 'apps'}
            title={query ? '无匹配结果' : '未找到应用'}
            text={query ? `没有与“${query.trim()}”匹配的内容。` : '未在这台电脑上找到已安装的应用。'}
          />
        ) : (
          <>
            {query.trim() && (
              <div className="sy-sec-head">
                <span className="sy-count">
                  {shown.length} / {apps?.length ?? 0} 个应用
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
                      {[app.publisher, app.version && `v${app.version}`].filter(Boolean).join(' · ') || '未知发行商'}
                    </div>
                  </div>
                  <div className="sy-meta">
                    <span className="size">{app.size ? formatBytes(app.size) : '—'}</span>
                    {app.lastUsed ? <small>{timeAgo(app.lastUsed)}使用过</small> : null}
                  </div>
                  <div className="sy-act">
                    {busy === app.id ? (
                      <span className="sy-lock">
                        <span className="spinner" />
                        正在启动卸载程序
                      </span>
                    ) : confirming === app.id ? (
                      <div className="sy-confirm">
                        <span>确定卸载？</span>
                        <button type="button" className="btn small ghost" onClick={() => setConfirming(null)}>
                          取消
                        </button>
                        <button type="button" className="btn small danger" onClick={() => void uninstall(app)}>
                          卸载
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
                        卸载
                      </button>
                    ) : (
                      <span className="sy-lock" title="此应用是系统的一部分，或在其他位置管理">
                        <Icon name="lock" />
                        系统内置
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
