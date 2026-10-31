import { useState } from 'react';
import type { AiProvider, Background, Settings as SettingsData } from '../../shared/types';
import { api } from '../api';
import { BrandMark, Icon } from '../components/Icon';
import { ScreenHead, Segmented, Toggle } from '../components/ui';
import { useStore } from '../state';
import './system.css';

type Patch = Partial<Omit<SettingsData, 'hasClaudeKey' | 'hasOpenAiKey'>>;

const BACKGROUNDS: { value: Background; label: string }[] = [
  { value: 'mist', label: '雾气' },
  { value: 'grid', label: '网格' },
  { value: 'dots', label: '圆点' },
  { value: 'grain', label: '颗粒' },
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
      toast(value ? `${name} 密钥已保存` : `${name} 密钥已移除`);
      setEditing(false);
      setKey('');
    } catch (e) {
      toast(e instanceof Error ? e.message : '无法更新密钥', 'err');
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
          <small>{has ? '密钥已保存在这台电脑上' : '尚未添加密钥'}</small>
        </div>
        <span className={`tag${has ? ' safe' : ''}`}>{has ? '已连接' : '未设置'}</span>
        {busy && !editing ? (
          <span className="spinner" />
        ) : (
          !editing && (
            <>
              <button type="button" className="btn small" onClick={() => setEditing(true)}>
                {has ? '替换' : '添加密钥'}
              </button>
              {has && (
                <button type="button" className="btn small ghost danger" onClick={() => void apply(null)}>
                  移除
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
            placeholder={`粘贴你的 ${name} 密钥`}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && key.trim()) void apply(key.trim());
              if (e.key === 'Escape') setEditing(false);
            }}
            aria-label={`${name} API 密钥`}
          />
          <button type="button" className="btn small primary" disabled={busy || !key.trim()} onClick={() => void apply(key.trim())}>
            {busy ? <span className="spinner" style={{ width: 14, height: 14, borderColor: 'rgba(255,255,255,0.35)', borderTopColor: '#fff' }} /> : '保存'}
          </button>
          <button type="button" className="btn small ghost" onClick={() => setEditing(false)} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="sy-link"
            onClick={() => api.openExternal(keyUrl).catch(() => toast('无法打开浏览器', 'err'))}
          >
            获取密钥
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
      toast(e instanceof Error ? e.message : '无法保存设置', 'err');
    } finally {
      setSaving(null);
    }
  };

  const spin = (field: string) => (saving === field ? <span className="spinner" style={{ width: 16, height: 16 }} /> : null);

  if (!settings) {
    return (
      <div className="screen">
        <ScreenHead title="设置" />
        <div className="card-w sy-center">
          <span className="spinner" />
          正在加载你的设置
        </div>
      </div>
    );
  }

  const sizeValue = String(settings.largeFileMinMb) as SizeOpt;

  return (
    <div className="screen">
      <ScreenHead title="设置" sub="让 Cleanly 更符合你的习惯。更改会立即保存。" />

      <div className="sy-settings sy-stagger">
        <section className="card-w panel">
          <div className="sy-set-head">
            <span className="chip-ico">
              <Icon name="layers" />
            </span>
            <h2>外观</h2>
          </div>
          <div className="sy-opt col">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div className="grow">
                <b>背景</b>
                <small>每个页面背后的画布背景</small>
              </div>
              {spin('background')}
              <Segmented<Background>
                label="背景"
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
            <h2>清理</h2>
          </div>
          <div className="sy-opt">
            <div className="grow">
              <b>清理前询问</b>
              <small>显示将要删除的内容，并等待你确认</small>
            </div>
            {spin('confirm')}
            <Toggle
              checked={settings.confirmBeforeClean}
              label="清理前询问"
              onChange={(v) => void save('confirm', { confirmBeforeClean: v })}
            />
          </div>
          <div className="sy-opt col">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div className="grow">
                <b>大文件大小</b>
                <small>大于此大小的文件会出现在大文件中</small>
              </div>
              {spin('large')}
            </div>
            <Segmented<SizeOpt>
              label="大文件大小"
              value={sizeValue}
              options={SIZES.map((s) => ({ value: s, label: s === '1000' ? '1 GB' : `${s} MB` }))}
              onChange={(v) => void save('large', { largeFileMinMb: Number(v) })}
            />
          </div>
          <p className="sy-note" style={{ margin: '6px 0 0' }}>
            缓存和临时文件会被永久删除。你自己的文件始终会进入回收站，因此可以恢复。
          </p>
        </section>

        <section className="card-w panel sy-wide">
          <div className="sy-set-head">
            <span className="chip-ico">
              <Icon name="assist" />
            </span>
            <h2>AI助手</h2>
            <span style={{ flex: 1 }} />
            {spin('provider')}
            <Segmented<AiProvider>
              label="AI助手服务商"
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
            只会共享文件名、路径和大小 — 绝不会共享文件内容。
          </p>
        </section>

        <section className="card-w panel sy-wide">
          <div className="sy-about">
            <BrandMark size={44} />
            <div className="grow">
              <h3>cleanly</h3>
              <p className="mono">
                {system ? `版本 ${system.appVersion} · ${osLabel(system.platform, system.osVersion)} · ${system.arch}` : '正在读取版本'}
              </p>
              <span className="sy-love">
                <Icon name="heart" />
                用心制作，让你的电脑保持轻快。
              </span>
            </div>
            <button type="button" className="btn" onClick={() => go('feedback')}>
              <Icon name="chat" />
              发送反馈
            </button>
            <button type="button" className="btn primary" onClick={() => go('support')}>
              <Icon name="heart" style={{ color: '#ff8fc8' }} />
              支持作者
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
