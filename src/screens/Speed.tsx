import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { StartupItem } from '../../shared/types';
import { api } from '../api';
import { Icon } from '../components/Icon';
import { Empty, ScreenHead, Toggle } from '../components/ui';
import { useFileIcons } from '../lib/useFileIcons';
import { useStore } from '../state';
import './system.css';

const GROUPS: { impact: StartupItem['impact']; title: string; hint: string }[] = [
  { impact: 'high', title: 'High impact', hint: 'These slow your start the most' },
  { impact: 'medium', title: 'Medium impact', hint: 'Noticeable, but lighter' },
  { impact: 'low', title: 'Low impact', hint: 'Barely felt at login' },
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
      toast(e instanceof Error ? e.message : 'Could not read startup apps', 'err');
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
      toast(`${enabled ? 'Turned on' : 'Turned off'} ${item.name} — takes effect next start`);
    } catch (e) {
      toast(e instanceof Error ? e.message : `Could not change ${item.name}`, 'err');
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
  const askHint =
    system?.platform === 'darwin' ? 'macOS will ask for your password' : system?.platform === 'linux' ? 'Your system will ask for your password' : 'Windows will ask for permission';

  return (
    <div className="screen sy-screen">
      <ScreenHead title="Speed" sub="Pick which apps launch with your computer. Fewer at login means a quicker, calmer start.">
        <button type="button" className="btn small" onClick={() => void load()} disabled={loading}>
          {loading ? <span className="spinner" /> : <Icon name="history" />}
          Refresh
        </button>
      </ScreenHead>

      {loading && !items ? (
        <div className="card-w sy-center">
          <span className="spinner" />
          Looking at what starts with your computer
        </div>
      ) : failed && !items ? (
        <div className="card-w">
          <Empty icon="warning" title="Could not read startup apps" text="Something blocked the check. Try again in a moment.">
            <button type="button" className="btn" onClick={() => void load()}>
              Try again
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
                <b>Startup</b>
              </div>
              <div className="lc-num">
                <strong>{enabled.length}</strong>
                <em>of {list.length} on</em>
              </div>
              <div className="lc-sub">
                {enabled.length === 1 ? '1 app opens' : `${enabled.length} apps open`} when your computer starts
              </div>
              <div className="lc-foot">
                <div className="slider on sy-slider" role="img" aria-label={`${Math.round(share * 100)}% of startup apps are on`}>
                  <span className="fill" style={{ width: `calc((100% - 10px) * ${Math.max(share, 0.04)})` }} />
                  <span className="knob" style={{ left: `calc((100% - 36px) * ${share} + 2px)` }} />
                </div>
              </div>
            </article>

            <section className="card-w panel">
              <div className="sy-sec-head">
                <h2>At a glance</h2>
              </div>
              <p className="sy-note" style={{ margin: 0 }}>
                Turning an app off only stops it from launching at login. Nothing is uninstalled, and you can switch it back on any time.
                {admin > 0 && ' Items marked Admin are system-wide, so you will be asked for permission first.'}
              </p>
              <div className="sy-stats">
                <div className={`sy-stat${heavyOn ? ' hot' : ''}`}>
                  <strong>{heavyOn}</strong>
                  <span>heavy apps on</span>
                </div>
                <div className="sy-stat">
                  <strong>{off}</strong>
                  <span>turned off</span>
                </div>
                {locked > 0 || admin === 0 ? (
                  <div className="sy-stat">
                    <strong>{locked}</strong>
                    <span>locked by the system</span>
                  </div>
                ) : (
                  <div className="sy-stat">
                    <strong>{admin}</strong>
                    <span>need admin rights</span>
                  </div>
                )}
              </div>
            </section>
          </div>

          {list.length === 0 ? (
            <div className="card-w">
              <Empty icon="power" title="Nothing starts with your computer" text="Your login is already as light as it gets." />
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
                      <span className={`tag ${g.impact}`}>{g.impact[0].toUpperCase() + g.impact.slice(1)}</span>
                      <span className="grow" />
                      <span className="sy-count">
                        {rows.filter((r) => r.enabled).length} of {rows.length} on · {g.hint}
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
                                    Admin
                                  </span>
                                )}
                              </div>
                              <div className="sub sy-cmd" title={item.command}>
                                {item.command || 'No command recorded'}
                              </div>
                              {asks && <div className={`sub sy-ask${busy ? ' on' : ''}`}>{busy ? 'Waiting for your permission…' : askHint}</div>}
                            </div>
                            <span className="sy-loc">{item.location}</span>
                            {item.canToggle ? (
                              busy ? (
                                <span className="sy-pending" role="status" aria-label={`Changing ${item.name}`}>
                                  <span className="spinner" />
                                </span>
                              ) : (
                                <span title={asks ? askHint : undefined} className="sy-switch">
                                  <Toggle
                                    checked={item.enabled}
                                    label={`Start ${item.name} at login${asks ? ` (${askHint.toLowerCase()})` : ''}`}
                                    onChange={(v) => void toggle(item, v)}
                                  />
                                </span>
                              )
                            ) : (
                              <span className="sy-lock" title="This item is controlled by your system or an administrator policy and cannot be changed here">
                                <Icon name="lock" />
                                Managed by the system
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
