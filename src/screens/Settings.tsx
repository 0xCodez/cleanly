import { useState } from 'react';
import type { AiProvider, Background, Settings as SettingsData } from '../../shared/types';
import { api } from '../api';
import { BrandMark, Icon } from '../components/Icon';
import { ScreenHead, Segmented, Toggle } from '../components/ui';
import { useStore } from '../state';
import './system.css';

type Patch = Partial<Omit<SettingsData, 'hasClaudeKey' | 'hasOpenAiKey'>>;

const BACKGROUNDS: { value: Background; label: string }[] = [
  { value: 'mist', label: 'Mist' },
  { value: 'grid', label: 'Grid' },
  { value: 'dots', label: 'Dots' },
  { value: 'grain', label: 'Grain' },
];

const SIZES = ['100', '250', '500', '1000'] as const;
type SizeOpt = (typeof SIZES)[number];

const PROVIDERS: { id: AiProvider; name: string; keyUrl: string }[] = [
  { id: 'claude', name: 'Claude', keyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'chatgpt', name: 'ChatGPT', keyUrl: 'https://platform.openai.com/api-keys' },
];

const PLATFORM: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

function osLabel(platform: string, version: string) {
  const name = PLATFORM[platform] ?? platform;
  return version.toLowerCase().includes(name.toLowerCase()) ? version : `${name} ${version}`.trim();
}

function KeyRow({ id, name, keyUrl, has }: { id: AiProvider; name: string; keyUrl: string; has: boolean }) {
  const { setApiKey, toast } = useStore();
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);

  const apply = async (value: string | null) => {
    setBusy(true);
    try {
      await setApiKey(id, value);
      toast(value ? `${name} key saved` : `${name} key removed`);
      setEditing(false);
      setKey('');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not update the key', 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sy-opt col">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span className="chip-ico">
          <Icon name={has ? 'lock' : 'assist'} />
        </span>
        <div className="grow">
          <b>{name}</b>
          <small>{has ? 'Key saved on this computer' : 'No key yet'}</small>
        </div>
        <span className={`tag${has ? ' safe' : ''}`}>{has ? 'Connected' : 'Not set'}</span>
        {busy && !editing ? (
          <span className="spinner" />
        ) : (
          !editing && (
            <>
              <button type="button" className="btn small" onClick={() => setEditing(true)}>
                {has ? 'Replace' : 'Add key'}
              </button>
              {has && (
                <button type="button" className="btn small ghost danger" onClick={() => void apply(null)}>
                  Remove
                </button>
              )}
            </>
          )
        )}
      </div>
      {editing && (
        <div className="sy-keyrow rise">
          <input
            className="input"
            type="password"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            placeholder={`Paste your ${name} key`}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && key.trim()) void apply(key.trim());
              if (e.key === 'Escape') setEditing(false);
            }}
            aria-label={`${name} API key`}
          />
          <button type="button" className="btn small primary" disabled={busy || !key.trim()} onClick={() => void apply(key.trim())}>
            {busy ? <span className="spinner" style={{ width: 14, height: 14, borderColor: 'rgba(255,255,255,0.35)', borderTopColor: '#fff' }} /> : 'Save'}
          </button>
          <button type="button" className="btn small ghost" onClick={() => setEditing(false)} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="sy-link"
            onClick={() => api.openExternal(keyUrl).catch(() => toast('Could not open the browser', 'err'))}
          >
            Get a key
            <Icon name="arrow" />
          </button>
        </div>
      )}
    </div>
  );
}

export default function Settings() {
  const { settings, updateSettings, system, go, toast } = useStore();
  const [saving, setSaving] = useState<string | null>(null);

  const save = async (field: string, patch: Patch) => {
    setSaving(field);
    try {
      await updateSettings(patch);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save the setting', 'err');
    } finally {
      setSaving(null);
    }
  };

  const spin = (field: string) => (saving === field ? <span className="spinner" style={{ width: 16, height: 16 }} /> : null);

  if (!settings) {
    return (
      <div className="screen">
        <ScreenHead title="Settings" />
        <div className="card-w sy-center">
          <span className="spinner" />
          Loading your settings
        </div>
      </div>
    );
  }

  const sizeValue = String(settings.largeFileMinMb) as SizeOpt;

  return (
    <div className="screen">
      <ScreenHead title="Settings" sub="Make Cleanly feel like yours. Changes save right away." />

      <div className="sy-settings sy-stagger">
        <section className="card-w panel">
          <div className="sy-set-head">
            <span className="chip-ico">
              <Icon name="layers" />
            </span>
            <h2>Appearance</h2>
          </div>
          <div className="sy-opt col">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div className="grow">
                <b>Background</b>
                <small>The canvas behind every screen</small>
              </div>
              {spin('background')}
              <Segmented<Background>
                label="Background"
                value={settings.background}
                options={BACKGROUNDS}
                onChange={(v) => void save('background', { background: v })}
              />
            </div>
            <div className="sy-swatches" aria-hidden="true">
              {BACKGROUNDS.map((b) => (
                <button
                  key={b.value}
                  type="button"
                  tabIndex={-1}
                  className={`sy-swatch ${b.value}`}
                  aria-pressed={settings.background === b.value}
                  onClick={() => void save('background', { background: b.value })}
                >
                  <span>{b.label}</span>
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="card-w panel">
          <div className="sy-set-head">
            <span className="chip-ico">
              <Icon name="broom" />
            </span>
            <h2>Cleaning</h2>
          </div>
          <div className="sy-opt">
            <div className="grow">
              <b>Ask before cleaning</b>
              <small>Show what will be removed and wait for your OK</small>
            </div>
            {spin('confirm')}
            <Toggle
              checked={settings.confirmBeforeClean}
              label="Ask before cleaning"
              onChange={(v) => void save('confirm', { confirmBeforeClean: v })}
            />
          </div>
          <div className="sy-opt col">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div className="grow">
                <b>Large file size</b>
                <small>Files bigger than this show up in Large Files</small>
              </div>
              {spin('large')}
            </div>
            <Segmented<SizeOpt>
              label="Large file size"
              value={sizeValue}
              options={SIZES.map((s) => ({ value: s, label: s === '1000' ? '1 GB' : `${s} MB` }))}
              onChange={(v) => void save('large', { largeFileMinMb: Number(v) })}
            />
          </div>
          <p className="sy-note" style={{ margin: '6px 0 0' }}>
            Caches and temporary files are deleted for good. Your own files always go to the Trash, so you can restore them.
          </p>
        </section>

        <section className="card-w panel sy-wide">
          <div className="sy-set-head">
            <span className="chip-ico">
              <Icon name="assist" />
            </span>
            <h2>Assistant</h2>
            <span style={{ flex: 1 }} />
            {spin('provider')}
            <Segmented<AiProvider>
              label="Assistant provider"
              value={settings.aiProvider}
              options={PROVIDERS.map((p) => ({ value: p.id, label: p.name }))}
              onChange={(v) => void save('provider', { aiProvider: v })}
            />
          </div>
          {PROVIDERS.map((p) => (
            <KeyRow key={p.id} id={p.id} name={p.name} keyUrl={p.keyUrl} has={p.id === 'claude' ? settings.hasClaudeKey : settings.hasOpenAiKey} />
          ))}
          <p className="sy-privacy" style={{ margin: '8px 0 0' }}>
            <Icon name="shield" />
            Only file names, paths and sizes are shared — never file contents.
          </p>
        </section>

        <section className="card-w panel sy-wide">
          <div className="sy-about">
            <BrandMark size={44} />
            <div className="grow">
              <h3>cleanly</h3>
              <p className="mono">
                {system ? `Version ${system.appVersion} · ${osLabel(system.platform, system.osVersion)} · ${system.arch}` : 'Reading version'}
              </p>
              <span className="sy-love">
                <Icon name="heart" />
                Made with care, so your computer stays light.
              </span>
            </div>
            <button type="button" className="btn" onClick={() => go('feedback')}>
              <Icon name="chat" />
              Send feedback
            </button>
            <button type="button" className="btn primary" onClick={() => go('support')}>
              <Icon name="heart" style={{ color: '#ff8fc8' }} />
              Leave a tip
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
