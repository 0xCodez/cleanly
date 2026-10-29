import type { ComponentType } from 'react';
import { Flow } from './components/Flow';
import { Icon, IconSprite } from './components/Icon';
import { Sidebar } from './components/Sidebar';
import { Titlebar } from './components/Titlebar';
import Apps from './screens/Apps';
import Assistant from './screens/Assistant';
import Cleanup from './screens/Cleanup';
import Duplicates from './screens/Duplicates';
import Feedback from './screens/Feedback';
import LargeFiles from './screens/LargeFiles';
import Protection from './screens/Protection';
import Settings from './screens/Settings';
import SmartScan from './screens/SmartScan';
import SpaceMap from './screens/SpaceMap';
import Speed from './screens/Speed';
import Support from './screens/Support';
import { StoreProvider, useStore, type Screen } from './state';

const SCREENS: Record<Screen, ComponentType> = {
  scan: SmartScan,
  cleanup: Cleanup,
  protection: Protection,
  speed: Speed,
  apps: Apps,
  spaces: SpaceMap,
  large: LargeFiles,
  dupes: Duplicates,
  assistant: Assistant,
  support: Support,
  feedback: Feedback,
  settings: Settings,
};

function Shell() {
  const { screen, settings, toasts } = useStore();
  const bg = settings?.background ?? 'mist';
  const Current = SCREENS[screen];

  return (
    <div className="app" data-bg={bg}>
      {bg === 'mist' && (
        <div className="bg-layer">
          <Flow mode="mist" />
        </div>
      )}
      {bg === 'dots' && (
        <div className="bg-layer bg-dots">
          <i />
          <i />
          <i />
        </div>
      )}
      {bg === 'grain' && <div className="bg-layer bg-grain" />}
      <Titlebar />
      <div className="body">
        <Sidebar />
        <main className="main" key={screen}>
          <Current />
        </main>
      </div>
      <div className="toast-wrap" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.kind === 'err' ? ' err' : ''}`}>
            <Icon name={t.kind === 'err' ? 'warning' : 'check'} />
            {t.text}
          </div>
        ))}
      </div>
      <IconSprite />
    </div>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}
