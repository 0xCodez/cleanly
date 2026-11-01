import { useState } from 'react';
import { AI_MODELS, allowedEfforts, effortName, validEffort, validModelId } from '../../shared/aiModels';
import type { AiConnections, AiConnectionMode, AiEffort, AiProvider } from '../../shared/types';
import { api } from '../api';
import { Icon } from '../components/Icon';
import { Segmented } from '../components/ui';
import { useStore } from '../state';

export const PROVIDERS: Record<AiProvider, { name: string; keyUrl: string; placeholder: string }> = {
  claude: { name: 'Claude', keyUrl: 'https://console.anthropic.com/settings/keys', placeholder: 'sk-ant-...' },
  chatgpt: { name: 'ChatGPT', keyUrl: 'https://platform.openai.com/api-keys', placeholder: 'sk-...' },
};
export const LOCAL_APPS: Record<AiProvider, { name: string; installUrl: string }> = {
  claude: { name: 'Claude Code', installUrl: 'https://code.claude.com/docs/en/setup' },
  chatgpt: { name: 'Codex', installUrl: 'https://learn.chatgpt.com/docs/cli' },
};
export const PRIVACY = 'Only your question and completed scan details are shared. Files are never uploaded.';

export function ModelPicker({ provider, value, onChange, disabled = false }: {
  provider: AiProvider; value: string; onChange: (value: string) => void; disabled?: boolean;
}) {
  const [custom, setCustom] = useState(false);
  const known = AI_MODELS[provider].some((model) => model.id === value);
  const isCustom = custom || (!!value && !known);
  return (
    <div className="sy-model">
      <label>
        <span>Model</span>
        <select className="input" aria-label="Model" value={isCustom ? 'custom' : value} disabled={disabled} onChange={(e) => {
          setCustom(e.target.value === 'custom');
          onChange(e.target.value === 'custom' ? '' : e.target.value);
        }}>
          <option value="" disabled>Choose a model</option>
          {AI_MODELS[provider].map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
          <option value="custom">Other model…</option>
        </select>
      </label>
      {isCustom && <input className="input" aria-label="Custom model ID" placeholder="Enter the model ID" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value.trim())} />}
      <small>{value || 'Availability depends on your account or configured service.'}</small>
    </div>
  );
}

export function ModelControls({ provider, model, effort, onModel, onEffort, disabled = false }: {
  provider: AiProvider; model: string; effort: AiEffort | null;
  onModel: (model: string) => void; onEffort: (effort: AiEffort) => void; disabled?: boolean;
}) {
  return (
    <div className="sy-model-controls">
      <ModelPicker provider={provider} value={model} onChange={onModel} disabled={disabled} />
      <div className="sy-model">
        <label>
          <span>Thinking level</span>
          <select className="input" aria-label="Thinking level" value={effort ?? ''} disabled={disabled || !validModelId(model)} onChange={(e) => {
            if (validEffort(provider, model, e.target.value)) onEffort(e.target.value);
          }}>
            <option value="" disabled>Choose a level</option>
            {allowedEfforts(provider, model).map((level) => <option key={level} value={level}>{effortName(level)}</option>)}
          </select>
        </label>
        <small>Higher levels can take longer.</small>
      </div>
    </div>
  );
}

export default function AssistantSetup({ provider, mode, model, effort, connections, checking, onProvider, onMode, onModel, onEffort, refresh, onConnected, onStart }: {
  provider: AiProvider | null; mode: AiConnectionMode | null; model: string; effort: AiEffort | null;
  connections: AiConnections | null; checking: boolean;
  onProvider: (provider: AiProvider) => void; onMode: (mode: AiConnectionMode) => void; onModel: (model: string) => void;
  onEffort: (effort: AiEffort) => void;
  refresh: () => Promise<void>; onConnected: (connections: AiConnections) => void; onStart: () => void;
}) {
  const { settings, setApiKey, toast } = useStore();
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const providerChoices = <Segmented<AiProvider> label="Assistant provider" value={provider} onChange={onProvider}
    disabled={saving || signingIn} options={[{ value: 'claude', label: 'Claude' }, { value: 'chatgpt', label: 'ChatGPT' }]} />;
  if (!provider) return (
    <section className="card-w panel sy-setup rise">
      <h3>Choose your assistant</h3>
      <p>Pick an assistant, its connection, model, and thinking level.</p>
      {providerChoices}
      <span className="sy-privacy"><Icon name="shield" />{PRIVACY}</span>
    </section>
  );
  const info = PROVIDERS[provider];
  const local = LOCAL_APPS[provider];
  const status = connections?.[provider];
  const hasKey = !!settings && (provider === 'claude' ? settings.hasClaudeKey : settings.hasOpenAiKey);
  const canStart = validModelId(model) && validEffort(provider, model, effort) && (mode === 'api' ? hasKey : mode === 'local' && status?.kind === 'ready');
  const save = async () => {
    if (!key.trim()) return;
    setSaving(true);
    try { await setApiKey(provider, key.trim()); setKey(''); toast(`${info.name} API key saved`); }
    catch (error) { toast(error instanceof Error ? error.message : 'Could not save the key', 'err'); }
    finally { setSaving(false); }
  };
  const signIn = async () => {
    setSigningIn(true);
    try { onConnected(await api.signInAi(provider)); }
    catch (error) { toast(error instanceof Error ? error.message : 'Sign-in did not finish', 'err'); }
    finally { setSigningIn(false); }
  };
  return (
    <section className="card-w panel sy-setup rise">
      <h3>Set up {info.name}</h3>
      {providerChoices}
      <div className="sy-connection-choices" role="group" aria-label="Connection method">
        <button type="button" aria-pressed={mode === 'local'} disabled={saving || signingIn} onClick={() => onMode('local')}>
          <Icon name="apps" /><span><b>Use {local.name}</b><small>Use its configured connection</small></span>
        </button>
        <button type="button" aria-pressed={mode === 'api'} disabled={saving || signingIn} onClick={() => onMode('api')}>
          <Icon name="lock" /><span><b>Use an API key</b><small>Separate API billing</small></span>
        </button>
      </div>
      {mode === 'local' && (
        <div className="sy-local-connection" aria-live="polite">
          {checking && !status ? <b>Checking {local.name}…</b> : status?.kind === 'ready' ? (
            <><b className="sy-connected"><Icon name="check" /> {local.name} connection found</b><p>Uses its saved login or configured service. Its account limits and billing apply.</p></>
          ) : status?.kind === 'not-installed' ? (
            <><b>{local.name} is not installed</b><p>Install it and sign in, or choose an API key above.</p></>
          ) : status?.kind === 'signed-out' ? (
            <><b>Check your {local.name} connection</b><p>Open it in a terminal and confirm it can answer, then check again.</p></>
          ) : <b>Could not check {local.name}. Open it in a terminal, then check again.</b>}
          <div className="sy-connection-actions">
            {status?.kind === 'not-installed' ? <button type="button" className="btn small" onClick={() => void api.openExternal(local.installUrl).catch(() => toast('Could not open the install guide', 'err'))}>Install {local.name}</button>
              : <button type="button" className="btn small" disabled={signingIn || checking} onClick={() => void signIn()}>{signingIn ? 'Waiting for sign-in…' : 'Sign in again'}</button>}
            <button type="button" className="btn small ghost" disabled={checking || signingIn} onClick={() => void refresh()}>{checking ? 'Checking…' : 'Check again'}</button>
          </div>
          {signingIn && <p>Finish signing in in your browser.</p>}
        </div>
      )}
      {mode === 'api' && (
        <>
          <p>{hasKey ? 'API key saved. You can use it or replace it below.' : `Paste your ${info.name} API key. It is encrypted on this computer.`}</p>
          <div className="sy-keyrow">
            <input className="input" type="password" autoComplete="off" spellCheck={false} aria-label={`${info.name} API key`}
              placeholder={`Paste your key (${info.placeholder})`} value={key} disabled={saving} onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void save(); }} />
            <button type="button" className="btn primary" disabled={saving || !key.trim()} onClick={() => void save()}>{saving ? 'Saving…' : hasKey ? 'Replace key' : 'Save key'}</button>
          </div>
          <button type="button" className="sy-link" onClick={() => void api.openExternal(info.keyUrl).catch(() => toast('Could not open the browser', 'err'))}>Get a key <Icon name="arrow" /></button>
        </>
      )}
      {mode && <ModelControls key={provider} provider={provider} model={model} effort={effort} onModel={onModel} onEffort={onEffort} disabled={saving || signingIn} />}
      <button type="button" className="btn primary sy-start" disabled={!canStart || saving || signingIn} onClick={onStart}>Start chat <Icon name="arrow" /></button>
      <span className="sy-privacy"><Icon name="shield" />{PRIVACY}</span>
    </section>
  );
}
