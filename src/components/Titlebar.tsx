import { isDemo } from '../api';
import { useStore } from '../state';

/** Draggable window strip. Leaves room for macOS traffic lights or the Windows / Linux caption buttons. */
export function Titlebar() {
  const { system, scanning, cleaning, progress } = useStore();
  // Linux draws the same title bar overlay as Windows, so it needs the same room on the right.
  const platform = system?.platform === 'darwin' ? 'mac' : system ? 'win' : '';
  const busy = scanning || cleaning;

  return (
    <div className={`titlebar ${platform}`}>
      {isDemo && <span className="tag">Demo data</span>}
      <div className="grow" />
      {busy && (
        <span className="hint">
          <span className="spinner" />
          {progress?.phase ?? (cleaning ? 'Cleaning…' : 'Scanning…')}
        </span>
      )}
    </div>
  );
}
