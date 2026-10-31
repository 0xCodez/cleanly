import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { StartupItem } from '../../shared/types';
import { api } from '../api';
import { Icon } from '../components/Icon';
import { Empty, ScreenHead, Toggle } from '../components/ui';
import { useFileIcons } from '../lib/useFileIcons';
import { useStore } from '../state';
import './system.css';

const GROUPS: { impact: StartupItem['impact']; title: string; hint: string }[] = [
  { impact: 'high', title: '高影响', hint: '这些最拖慢开机速度' },
  { impact: 'medium', title: '中影响', hint: '有一定影响，但较轻' },
  { impact: 'low', title: '低影响', hint: '登录时几乎感觉不到' },
];

const ABSOLUTE = /^(?:[a-z]:[\\/]|\\\\|\/)/i;
const APP_PATH = /^(.+?\.(?:exe|app))(?=$|[\s"/\\,])/i;

/** The program a startup command launches: first quoted or unquoted token ending in .exe or .app. */
function programPath(command: string): string | undefined {
  const s = command.trim();
  if (!s) return undefined;
  const quoted = s.match(/^"([^"]+)"/);
  const m = (quoted ? quoted[1] : s).match(APP_PATH);
  const p = m?.[1].trim();
  return p && ABSOLUTE.test(p) ? p : undefined;
}

export default function Speed() {
  const { toast, system } = useStore();
  const [items, setItems] = useState<StartupItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      setItems(await api.startupItems());
    } catch (e) {
      setFailed(true);
      toast(e instanceof Error ? e.message : '无法读取开机启动项', 'err');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (item: StartupItem, enabled: boolean) => {
    if (pending) return;
    setPending(item.id);
    try {
      setItems(await api.setStartupItem(item.id, enabled));
      toast(`已${enabled ? '开启' : '关闭'} ${item.name} — 下次开机时生效`);
    } catch (e) {
      toast(e instanceof Error ? e.message : `无法更改 ${item.name}`, 'err');
    } finally {
      setPending(null);
    }
  };

  const list = useMemo(() => items ?? [], [items]);
  const programs = useMemo(() => {
    const out: Record<string, string | undefined> = {};
    // %windir%\… style commands go as-is; the main process expands and validates them
    for (const i of list) out[i.id] = programPath(i.command) ?? (/^"?%\w+%[\\/]/.test(i.command.trim()) ? i.command.trim() : undefined);
    return out;
  }, [list]);
  const icons = useFileIcons(Object.values(programs));

  const enabled = list.filter((i) => i.enabled);
  const share = list.length ? enabled.length / list.length : 0;
  const heavyOn = enabled.filter((i) => i.impact === 'high').length;
  const locked = list.filter((i) => !i.canToggle).length;
  const admin = list.filter((i) => i.canToggle && i.needsAdmin).length;
  const off = list.length - enabled.length;
  const askHint = system?.platform === 'darwin' ? 'macOS 会要求输入密码' : 'Windows 会请求权限';

  return (
    <div className="screen sy-screen">
      <ScreenHead title="开机启动项" sub="选择哪些应用随电脑开机启动。登录时启动的应用越少，开机越快、越流畅。">
        <button type="button" className="btn small" onClick={() => void load()} disabled={loading}>
          {loading ? <span className="spinner" /> : <Icon name="history" />}
          刷新
        </button>
      </ScreenHead>

      {loading && !items ? (
        <div className="card-w sy-center">
          <span className="spinner" />
          正在查看随电脑启动的项目
        </div>
      ) : failed && !items ? (
        <div className="card-w">
          <Empty icon="warning" title="无法读取开机启动项" text="检查时遇到了阻碍。请稍后重试。">
            <button type="button" className="btn" onClick={() => void load()}>
              重试
            </button>
          </Empty>
        </div>
      ) : (
        <>
          <div className="sy-top sy-stagger">
            <article className={`lc c-speed${heavyOn ? '' : ' calm'}`}>
              <span className="glow" style={{ left: 20, top: 70, '--bd': '6s' } as CSSProperties} />
              <span className="glow" style={{ left: 200, top: -90, '--bd': '8s' } as CSSProperties} />
              <div className="lc-top">
                <span className="glass-ico">
                  <Icon name="gauge" />
                </span>
                <b>开机启动项</b>
              </div>
              <div className="lc-num">
                <strong>{enabled.length}</strong>
                <em>/ {list.length} 已开启</em>
              </div>
              <div className="lc-sub">
                电脑启动时打开 {enabled.length} 个应用
              </div>
              <div className="lc-foot">
                <div className="slider on sy-slider" role="img" aria-label={`${Math.round(share * 100)}% 的开机启动项已开启`}>
                  <span className="fill" style={{ width: `calc((100% - 10px) * ${Math.max(share, 0.04)})` }} />
                  <span className="knob" style={{ left: `calc((100% - 36px) * ${share} + 2px)` }} />
                </div>
              </div>
            </article>

            <section className="card-w panel">
              <div className="sy-sec-head">
                <h2>概览</h2>
              </div>
              <p className="sy-note" style={{ margin: 0 }}>
                关闭应用只是阻止它在登录时启动。不会卸载任何内容，你可以随时重新开启。
                {admin > 0 && ' 标记为管理员的项目是系统级的，因此会先向你请求权限。'}
              </p>
              <div className="sy-stats">
                <div className={`sy-stat${heavyOn ? ' hot' : ''}`}>
                  <strong>{heavyOn}</strong>
                  <span>高影响应用已开启</span>
                </div>
                <div className="sy-stat">
                  <strong>{off}</strong>
                  <span>已关闭</span>
                </div>
                {locked > 0 || admin === 0 ? (
                  <div className="sy-stat">
                    <strong>{locked}</strong>
                    <span>被系统锁定</span>
                  </div>
                ) : (
                  <div className="sy-stat">
                    <strong>{admin}</strong>
                    <span>需要管理员权限</span>
                  </div>
                )}
              </div>
            </section>
          </div>

          {list.length === 0 ? (
            <div className="card-w">
              <Empty icon="power" title="没有随电脑启动的项目" text="你的登录已经尽可能轻量了。" />
            </div>
          ) : (
            <div className="sy-stagger sy-groups">
              {GROUPS.map((g) => {
                const rows = list.filter((i) => i.impact === g.impact);
                if (!rows.length) return null;
                return (
                  <section key={g.impact} className="card-w panel">
                    <div className="sy-sec-head">
                      <h2>{g.title}</h2>
                      <span className={`tag ${g.impact}`}>{g.impact === 'high' ? '高' : g.impact === 'medium' ? '中' : '低'}</span>
                      <span className="grow" />
                      <span className="sy-count">
                        {rows.filter((r) => r.enabled).length} / {rows.length} 已开启 · {g.hint}
                      </span>
                    </div>
                    <div className="list">
                      {rows.map((item) => {
                        const prog = programs[item.id];
                        const icon = prog ? icons[prog] : undefined;
                        const asks = item.canToggle && item.needsAdmin;
                        const busy = pending === item.id;
                        return (
                          <div key={item.id} className={`row${item.enabled ? '' : ' sy-off'}${busy ? ' sy-busy' : ''}`}>
                            {icon ? (
                              <span className={`sy-appico sy-imp-${item.impact}`} aria-hidden="true">
                                <img src={icon} alt="" draggable={false} decoding="async" />
                              </span>
                            ) : (
                              <span className={`chip-ico sy-chip-${item.impact}`}>
                                <Icon name="power" />
                              </span>
                            )}
                            <div className="grow">
                              <div className="sy-title-line">
                                <span className="title">{item.name}</span>
                                {asks && (
                                  <span className="sy-admin" title={askHint}>
                                    <Icon name="shield" />
                                    管理员
                                  </span>
                                )}
                              </div>
                              <div className="sub sy-cmd" title={item.command}>
                                {item.command || '未记录命令'}
                              </div>
                              {asks && <div className={`sub sy-ask${busy ? ' on' : ''}`}>{busy ? '正在等待你授权…' : askHint}</div>}
                            </div>
                            <span className="sy-loc">{item.location}</span>
                            {item.canToggle ? (
                              busy ? (
                                <span className="sy-pending" role="status" aria-label={`正在更改 ${item.name}`}>
                                  <span className="spinner" />
                                </span>
                              ) : (
                                <span title={asks ? askHint : undefined} className="sy-switch">
                                  <Toggle
                                    checked={item.enabled}
                                    label={`登录时启动 ${item.name}${asks ? `（${askHint}）` : ''}`}
                                    onChange={(v) => void toggle(item, v)}
                                  />
                                </span>
                              )
                            ) : (
                              <span className="sy-lock" title="此项目由系统或管理员策略控制，无法在此处更改">
                                <Icon name="lock" />
                                由系统管理
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
