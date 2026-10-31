import type { DiskInfo, IconName } from '../../shared/types';
import { formatBytes } from '../lib/format';
import { driveName, useStore, type Screen } from '../state';
import { BrandMark, Icon } from './Icon';
import '../screens/files.css';

const MAIN: { id: Screen; label: string; icon: IconName }[] = [
  { id: 'scan', label: '智能扫描', icon: 'scan' },
  { id: 'cleanup', label: '清理', icon: 'broom' },
  { id: 'protection', label: '安全防护', icon: 'shield' },
  { id: 'speed', label: '启动加速', icon: 'gauge' },
  { id: 'apps', label: '应用程序', icon: 'apps' },
];
const FILES: { id: Screen; label: string; icon: IconName }[] = [
  { id: 'spaces', label: '空间地图', icon: 'bubbles' },
  { id: 'large', label: '大文件', icon: 'file' },
  { id: 'dupes', label: '重复文件', icon: 'dupes' },
  { id: 'assistant', label: 'AI助手', icon: 'assist' },
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
    ? '正在测量…'
    : reclaimable > 0
      ? `可释放 ${formatBytes(reclaimable)}${many ? `（位于 ${driveName(sys)}）` : ''}`
      : many
        ? `${drives.length} 个驱动器共剩余 ${formatBytes(drives.reduce((a, d) => a + d.free, 0))}`
        : `剩余 ${formatBytes(sys.free)}`;

  return (
    <nav className="nav rise" aria-label="栏目导航">
      <div className="brand">
        <BrandMark />
        <span className="brand-name">cleanly</span>
      </div>
      {MAIN.map(item)}
      <div className="nav-label">文件</div>
      {FILES.map(item)}

      <div className="nav-foot">
        <div className="disk">
          <div className={`disk-list${drives.length > 3 ? ' scroll' : ''}`}>
            {drives.length ? (
              drives.map((d) => {
                const usedPct = d.total > 0 ? Math.min(100, (d.used / d.total) * 100) : 0;
                const junkPct = d.mount === sys?.mount && d.total > 0 ? Math.min(usedPct, (reclaimable / d.total) * 100) : 0;
                return (
                  <div key={d.mount} className="drv" title={`${d.label}：共 ${formatBytes(d.total)}，剩余 ${formatBytes(d.free)}`}>
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
                  <span>磁盘</span>
                  <span>…</span>
                </div>
                <div className="bar" />
              </div>
            )}
          </div>
          <div className="disk-note">{note}</div>
        </div>
        <div className="nav-mini">
          <button type="button" className={`nav-item${screen === 'support' ? ' on' : ''}`} onClick={() => go('support')} title="支持 Cleanly">
            <Icon name="heart" />
            打赏作者
          </button>
          <button type="button" className={`nav-item${screen === 'feedback' ? ' on' : ''}`} onClick={() => go('feedback')} title="发送反馈">
            <Icon name="chat" />
            反馈
          </button>
          <button type="button" className={`nav-item${screen === 'settings' ? ' on' : ''}`} onClick={() => go('settings')} aria-label="设置" title="设置" style={{ flex: '0 0 40px', padding: 0 }}>
            <Icon name="gear" />
          </button>
        </div>
      </div>
    </nav>
  );
}
