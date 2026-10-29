import type { DiskInfo, IconName } from '../../shared/types';
import { formatBytes } from '../lib/format';
import { driveName, useStore, type Screen } from '../state';
import { BrandMark, Icon } from './Icon';
import '../screens/files.css';

const MAIN: { id: Screen; label: string; icon: IconName }[] = [
  { id: 'scan', label: 'Smart Scan', icon: 'scan' },
  { id: 'cleanup', label: 'Cleanup', icon: 'broom' },
  { id: 'protection', label: 'Protection', icon: 'shield' },
  { id: 'speed', label: 'Speed', icon: 'gauge' },
  { id: 'apps', label: 'Applications', icon: 'apps' },
];
const FILES: { id: Screen; label: string; icon: IconName }[] = [
  { id: 'spaces', label: 'Space Map', icon: 'bubbles' },
  { id: 'large', label: 'Large Files', icon: 'file' },
  { id: 'dupes', label: 'Duplicates', icon: 'dupes' },
  { id: 'assistant', label: 'Assistant', icon: 'assist' },
];

export function Sidebar() {
  const { screen, go, reclaimable, disk, disks } = useStore();

  const item = (it: { id: Screen; label: string; icon: IconName }) => (
    <button key={it.id} type="button" className={`nav-item${screen === it.id ? ' on' : ''}`} onClick={() => go(it.id)} aria-current={screen === it.id ? 'page' : undefined}>
      <Icon name={it.icon} />
      {it.label}
      {it.id === 'cleanup' && reclaimable > 0 && <span className="count">{formatBytes(reclaimable)}</span>}
    </button>
  );

  const drives: DiskInfo[] = disks?.length ? disks : disk ? [disk] : [];
  const sys = drives.find((d) => d.system) ?? disk ?? drives[0] ?? null;
  const many = drives.length > 1;

  const note = !sys
    ? 'Measuring…'
    : reclaimable > 0
      ? `${formatBytes(reclaimable)} can be reclaimed${many ? ` on ${driveName(sys)}` : ''}`
      : many
        ? `${formatBytes(drives.reduce((a, d) => a + d.free, 0))} free on ${drives.length} drives`
        : `${formatBytes(sys.free)} free`;

  return (
    <nav className="nav rise" aria-label="Sections">
      <div className="brand">
        <BrandMark />
        <span className="brand-name">cleanly</span>
      </div>
      {MAIN.map(item)}
      <div className="nav-label">FILES</div>
      {FILES.map(item)}

      <div className="nav-foot">
        <div className="disk">
          <div className={`disk-list${drives.length > 3 ? ' scroll' : ''}`}>
            {drives.length ? (
              drives.map((d) => {
                const usedPct = d.total > 0 ? Math.min(100, (d.used / d.total) * 100) : 0;
                const junkPct = d.mount === sys?.mount && d.total > 0 ? Math.min(usedPct, (reclaimable / d.total) * 100) : 0;
                return (
                  <div key={d.mount} className="drv" title={`${d.label}: ${formatBytes(d.free)} free of ${formatBytes(d.total)}`}>
                    <div className="disk-row">
                      <span>{d.label}</span>
                      <span>
                        {formatBytes(d.used)} / {formatBytes(d.total)}
                      </span>
                    </div>
                    <div className="bar">
                      <span className="used" style={{ width: `${Math.max(0, usedPct - junkPct)}%` }} />
                      <span className="junk" style={{ width: `${junkPct}%` }} />
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="drv">
                <div className="disk-row">
                  <span>Disk</span>
                  <span>…</span>
                </div>
                <div className="bar" />
              </div>
            )}
          </div>
          <div className="disk-note">{note}</div>
        </div>
        <div className="nav-mini">
          <button type="button" className={`nav-item${screen === 'support' ? ' on' : ''}`} onClick={() => go('support')} title="Support Cleanly">
            <Icon name="heart" />
            Tip
          </button>
          <button type="button" className={`nav-item${screen === 'feedback' ? ' on' : ''}`} onClick={() => go('feedback')} title="Send feedback">
            <Icon name="chat" />
            Feedback
          </button>
          <button type="button" className={`nav-item${screen === 'settings' ? ' on' : ''}`} onClick={() => go('settings')} aria-label="Settings" title="Settings" style={{ flex: '0 0 40px', padding: 0 }}>
            <Icon name="gear" />
          </button>
        </div>
      </div>
    </nav>
  );
}
