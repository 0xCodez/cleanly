import type { IconName } from '../../shared/types';
import { formatBytes } from '../lib/format';
import { useStore, type Screen } from '../state';
import { BrandMark, Icon } from './Icon';

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
  const { screen, go, reclaimable, disk } = useStore();

  const item = (it: { id: Screen; label: string; icon: IconName }) => (
    <button key={it.id} type="button" className={`nav-item${screen === it.id ? ' on' : ''}`} onClick={() => go(it.id)} aria-current={screen === it.id ? 'page' : undefined}>
      <Icon name={it.icon} />
      {it.label}
      {it.id === 'cleanup' && reclaimable > 0 && <span className="count">{formatBytes(reclaimable)}</span>}
    </button>
  );

  const usedPct = disk ? (disk.used / disk.total) * 100 : 0;
  const junkPct = disk ? Math.min(100 - usedPct, (reclaimable / disk.total) * 100) : 0;

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
          <div className="disk-row">
            <span>{disk?.label ?? 'Disk'}</span>
            <span>{disk ? `${formatBytes(disk.used)} / ${formatBytes(disk.total)}` : '…'}</span>
          </div>
          <div className="bar">
            <span className="used" style={{ width: `${Math.max(0, usedPct - junkPct)}%` }} />
            <span className="junk" style={{ width: `${junkPct}%` }} />
          </div>
          <div className="disk-note">{reclaimable > 0 ? `${formatBytes(reclaimable)} can be reclaimed` : disk ? `${formatBytes(disk.free)} free` : 'Measuring…'}</div>
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
