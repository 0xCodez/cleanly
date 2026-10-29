import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import type { StartupItem } from '../../shared/types';
import { api } from '../api';
import { Icon } from '../components/Icon';
import { Empty, ScreenHead, Toggle } from '../components/ui';
import { useStore } from '../state';
import './system.css';

const GROUPS: { impact: StartupItem['impact']; title: string; hint: string }[] = [
  { impact: 'high', title: 'High impact', hint: 'These slow your start the most' },
  { impact: 'medium', title: 'Medium impact', hint: 'Noticeable, but lighter' },
  { impact: 'low', title: 'Low impact', hint: 'Barely felt at login' },
];

export default function Speed() {
  const { toast } = useStore();
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

  const list = items ?? [];
  const enabled = list.filter((i) => i.enabled);
  const share = list.length ? enabled.length / list.length : 0;
  const heavyOn = enabled.filter((i) => i.impact === 'high').length;
  const managed = list.filter((i) => !i.canToggle).length;
  const off = list.length - enabled.length;

  return (
    <div className="screen">
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
                <div className="sy-stat">
                  <strong>{managed}</strong>
                  <span>managed by the system</span>
                </div>
              </div>
            </section>
          </div>

          {list.length === 0 ? (
            <div className="card-w">
              <Empty icon="power" title="Nothing starts with your computer" text="Your login is already as light as it gets." />
            </div>
          ) : (
            <div className="sy-stagger" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
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
                      {rows.map((item) => (
                        <div key={item.id} className={`row${item.enabled ? '' : ' sy-off'}`}>
                          <span className={`chip-ico sy-chip-${item.impact}`}>
                            <Icon name="power" />
                          </span>
                          <div className="grow">
                            <div className="title">{item.name}</div>
                            <div className="sub sy-cmd" title={item.command}>
                              {item.command || 'No command recorded'}
                            </div>
                          </div>
                          <span className="sy-loc">{item.location}</span>
                          {item.canToggle ? (
                            pending === item.id ? (
                              <span className="spinner" style={{ margin: '0 13px' }} />
                            ) : (
                              <Toggle
                                checked={item.enabled}
                                label={`Start ${item.name} at login`}
                                onChange={(v) => void toggle(item, v)}
                              />
                            )
                          ) : (
                            <span className="sy-lock" title="This item is controlled by your system or an administrator">
                              <Icon name="lock" />
                              Managed by the system
                            </span>
                          )}
                        </div>
                      ))}
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
