import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { AiAdvice, AiContext, AiProvider } from '../../shared/types';
import { api } from '../api';
import { Icon } from '../components/Icon';
import { ScreenHead, Segmented } from '../components/ui';
import { shortPath } from '../lib/format';
import { useStore } from '../state';
import './system.css';

type NewMsg = { role: 'user'; text: string } | { role: 'ai'; advice: AiAdvice } | { role: 'err'; text: string };
type Msg = NewMsg & { id: number };

type LargeCtx = NonNullable<AiContext['largeFiles']>;

const PROVIDERS: Record<AiProvider, { name: string; keyUrl: string; placeholder: string }> = {
  claude: { name: 'Claude', keyUrl: 'https://console.anthropic.com/settings/keys', placeholder: 'sk-ant-...' },
  chatgpt: { name: 'ChatGPT', keyUrl: 'https://platform.openai.com/api-keys', placeholder: 'sk-...' },
};

const SUGGESTIONS = ['What can I safely delete?', 'Why is my disk so full?', "Which large files haven't I used in a year?"];
const PRIVACY = 'Only file names, paths and sizes are shared — never file contents.';
const LARGE_MIN = 500 * 1024 * 1024;

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

function KeySetup({ provider }: { provider: AiProvider }) {
  const { setApiKey, toast } = useStore();
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const info = PROVIDERS[provider];

  const save = async () => {
    const k = key.trim();
    if (!k) return;
    setSaving(true);
    try {
      await setApiKey(provider, k);
      setKey('');
      toast(`${info.name} is ready`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save the key', 'err');
    } finally {
      setSaving(false);
    }
  };

  const openKeys = () => {
    api.openExternal(info.keyUrl).catch(() => toast('Could not open the browser', 'err'));
  };

  return (
    <section className="card-w panel sy-setup rise">
      <span className="sy-orb" style={{ width: 52, height: 52, borderRadius: 18 }}>
        <Icon name="lock" />
      </span>
      <h3>Connect {info.name}</h3>
      <p>
        The assistant uses your own {info.name} API key. It is stored securely on this computer and only sent to {info.name}.
      </p>
      <div className="sy-keyrow">
        <input
          className="input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={`Paste your key (${info.placeholder})`}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
          }}
          aria-label={`${info.name} API key`}
        />
        <button type="button" className="btn primary" onClick={() => void save()} disabled={saving || !key.trim()}>
          {saving ? <span className="spinner" style={{ borderColor: 'rgba(255,255,255,0.35)', borderTopColor: '#fff' }} /> : <Icon name="check" />}
          Save key
        </button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <button type="button" className="sy-link" onClick={openKeys}>
          Get a key
          <Icon name="arrow" />
        </button>
        <span className="sy-privacy">
          <Icon name="shield" />
          {PRIVACY}
        </span>
      </div>
    </section>
  );
}

export default function Assistant() {
  const { settings, updateSettings, junk, spaces, disk, system, toast, go, refreshDisk } = useStore();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [asking, setAsking] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [largeFiles, setLargeFiles] = useState<LargeCtx | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [trashing, setTrashing] = useState<string | null>(null);
  const [trashed, setTrashed] = useState<Set<string>>(() => new Set());
  const endRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const nextId = useRef(1);

  const provider = settings?.aiProvider ?? 'claude';
  const hasKey = settings ? (provider === 'claude' ? settings.hasClaudeKey : settings.hasOpenAiKey) : false;
  const ready = !!settings && hasKey;

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [messages, asking]);

  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const switchProvider = async (p: AiProvider) => {
    if (p === provider) return;
    setSwitching(true);
    try {
      await updateSettings({ aiProvider: p });
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not switch the assistant', 'err');
    } finally {
      setSwitching(false);
    }
  };

  const getLargeFiles = async (): Promise<LargeCtx> => {
    if (largeFiles) return largeFiles;
    try {
      const found = await api.scanLargeFiles(LARGE_MIN);
      const ctx = [...found]
        .sort((a, b) => b.size - a.size)
        .slice(0, 60)
        .map((f) => ({ path: f.path, size: f.size, modified: f.modified }));
      setLargeFiles(ctx);
      return ctx;
    } catch {
      return [];
    }
  };

  const push = (m: NewMsg) => {
    const id = nextId.current++;
    setMessages((prev) => [...prev, { ...m, id }]);
  };

  const send = async (raw: string) => {
    const q = raw.trim();
    if (!q || asking) return;
    if (!ready) {
      toast(`Add your ${PROVIDERS[provider].name} key first`, 'err');
      return;
    }
    setText('');
    push({ role: 'user', text: q });
    setAsking(true);
    try {
      const context: AiContext = {
        junk: (junk ?? []).filter((j) => j.size > 0).map((j) => ({ name: j.name, size: j.size, locations: j.locations })),
        spaces: (spaces?.children ?? []).slice(0, 40).map((c) => ({ name: c.name, size: c.size })),
        disk: disk ? { total: disk.total, free: disk.free } : undefined,
        largeFiles: await getLargeFiles(),
      };
      const advice = await api.askAi(q, context);
      push({ role: 'ai', advice });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'The assistant could not answer';
      push({ role: 'err', text: msg });
      toast(msg, 'err');
    } finally {
      setAsking(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(text);
    }
  };

  const known = new Set((largeFiles ?? []).map((f) => norm(f.path)));
  const home = system?.homeDir ?? '';
  // the assistant sees display paths with ~, so it may answer with them too
  const expand = (p: string) => (/^~([\\/]|$)/.test(p) && home ? home + p.slice(1) : p);
  const junkRoots = (junk ?? []).flatMap((j) => j.locations.map((l) => norm(expand(l))));
  const isJunkPath = (p: string) => {
    const n = norm(p);
    return junkRoots.some((r) => r && (n === r || n.startsWith(r + '/')));
  };

  const reveal = (p: string) => {
    api.revealPath(p).catch(() => toast('Could not show that item', 'err'));
  };

  const moveToTrash = async (key: string, p: string) => {
    setConfirm(null);
    setTrashing(key);
    try {
      const res = await api.trashPaths([p]);
      if (res.removed > 0) {
        setTrashed((s) => new Set(s).add(norm(p)));
        setLargeFiles((fs) => (fs ? fs.filter((f) => norm(f.path) !== norm(p)) : fs));
        toast(`Moved ${baseName(p)} to Trash — you can restore it from there`);
        void refreshDisk();
      } else {
        toast(res.skipped[0] ?? `Could not move ${baseName(p)} to Trash`, 'err');
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : `Could not move ${baseName(p)} to Trash`, 'err');
    } finally {
      setTrashing(null);
    }
  };

  return (
    <div className="screen">
      <ScreenHead title="Assistant" sub="Ask about your disk in plain words. You get clear advice, and nothing is removed without your say.">
        {settings && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {switching && <span className="spinner" />}
            <Segmented<AiProvider>
              label="Assistant provider"
              value={provider}
              onChange={(p) => void switchProvider(p)}
              options={[
                { value: 'claude', label: 'Claude' },
                { value: 'chatgpt', label: 'ChatGPT' },
              ]}
            />
          </div>
        )}
      </ScreenHead>

      <div className="sy-chat">
        {!settings ? (
          <div className="sy-center">
            <span className="spinner" />
            Getting the assistant ready
          </div>
        ) : !hasKey ? (
          <KeySetup provider={provider} />
        ) : messages.length === 0 && !asking ? (
          <div className="sy-intro rise">
            <span className="sy-orb">
              <Icon name="assist" />
            </span>
            <h2>What would you like to know?</h2>
            <p>
              I can look at your scan results, the biggest folders and large files, then suggest what is safe to remove and what is worth keeping.
            </p>
            <span className="sy-privacy">
              <Icon name="shield" />
              {PRIVACY}
            </span>
          </div>
        ) : null}

        {messages.map((m) => {
          if (m.role === 'user') {
            return (
              <div key={m.id} className="sy-msg user">
                <div className="sy-bubble">{m.text}</div>
              </div>
            );
          }
          if (m.role === 'err') {
            return (
              <div key={m.id} className="sy-msg err">
                <span className="sy-ai-ico">
                  <Icon name="warning" />
                </span>
                <div className="sy-ai-body">
                  <div className="sy-bubble">{m.text}</div>
                </div>
              </div>
            );
          }
          const { advice } = m;
          return (
            <div key={m.id} className="sy-msg">
              <span className="sy-ai-ico">
                <Icon name="assist" />
              </span>
              <div className="sy-ai-body">
                <span className="sy-by">{PROVIDERS[advice.provider]?.name ?? 'Assistant'}</span>
                <div className="sy-bubble">{advice.answer}</div>
                {advice.suggestions.length > 0 && (
                  <div className="sy-sugs">
                    {advice.suggestions.map((s, i) => {
                      const key = `${m.id}:${i}`;
                      const full = expand(s.path);
                      const n = norm(full);
                      const gone = trashed.has(n);
                      const canTrash = s.verdict === 'safe' && known.has(n) && !gone;
                      const junkish = !known.has(n) && isJunkPath(full);
                      return (
                        <div key={key} className={`sy-sug${gone ? ' sy-gone' : ''}`}>
                          <span className="chip-ico">
                            <Icon name={junkish ? 'folder' : 'file'} />
                          </span>
                          <div className="sy-sug-main">
                            <div className="sy-sug-top">
                              <b>{baseName(s.path)}</b>
                              <span className={`tag ${s.verdict}`}>
                                {s.verdict === 'safe' ? 'Safe to remove' : s.verdict === 'review' ? 'Review first' : 'Keep'}
                              </span>
                            </div>
                            <div className="sy-sug-path" title={s.path}>
                              {shortPath(full, home)}
                            </div>
                            <div className="sy-sug-why">{s.reason}</div>
                            <div className="sy-sug-act">
                              {gone ? (
                                <span className="sy-lock">
                                  <Icon name="check" />
                                  Moved to Trash
                                </span>
                              ) : (
                                <>
                                  <button type="button" className="btn small" onClick={() => reveal(full)}>
                                    <Icon name="reveal" />
                                    Reveal
                                  </button>
                                  {canTrash &&
                                    (trashing === key ? (
                                      <span className="sy-lock">
                                        <span className="spinner" />
                                        Moving to Trash
                                      </span>
                                    ) : confirm === key ? (
                                      <div className="sy-confirm">
                                        <span>Move to Trash? You can restore it.</span>
                                        <button type="button" className="btn small ghost" onClick={() => setConfirm(null)}>
                                          Cancel
                                        </button>
                                        <button type="button" className="btn small danger" onClick={() => void moveToTrash(key, full)}>
                                          Move
                                        </button>
                                      </div>
                                    ) : (
                                      <button type="button" className="btn small" disabled={trashing !== null} onClick={() => setConfirm(key)}>
                                        <Icon name="trash" />
                                        Move to Trash
                                      </button>
                                    ))}
                                  {junkish && s.verdict !== 'keep' && (
                                    <button type="button" className="btn small ghost" onClick={() => go('cleanup')}>
                                      Clean in Cleanup
                                      <Icon name="arrow" />
                                    </button>
                                  )}
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {asking && (
          <div className="sy-msg">
            <span className="sy-ai-ico">
              <Icon name="assist" />
            </span>
            <div className="sy-bubble" style={{ padding: 0 }} role="status" aria-label="Thinking">
              <span className="sy-dots">
                <i />
                <i />
                <i />
              </span>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="sy-composer">
        <div className="sy-chips">
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" disabled={!ready || asking} onClick={() => void send(s)}>
              <Icon name="spark" />
              {s}
            </button>
          ))}
        </div>
        <div className="sy-box">
          <textarea
            ref={taRef}
            className="sy-ta"
            rows={1}
            placeholder={ready ? 'Ask anything about your disk' : `Add your ${PROVIDERS[provider].name} key to start`}
            value={text}
            disabled={!ready}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            aria-label="Message"
          />
          <button type="button" className="sy-send" disabled={!ready || asking || !text.trim()} onClick={() => void send(text)} aria-label="Send">
            {asking ? <span className="spinner" style={{ borderColor: 'rgba(255,255,255,0.35)', borderTopColor: '#fff' }} /> : <Icon name="arrow" />}
          </button>
        </div>
        <div className="sy-hint">Enter to send · Shift+Enter for a new line</div>
      </div>
    </div>
  );
}
