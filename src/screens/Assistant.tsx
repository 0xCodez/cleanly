import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { AiAdvice, AiConnections, AiConnectionMode, AiContext, AiEffort, AiProvider, AiProgress } from '../../shared/types';
import { api } from '../api';
import { Icon } from '../components/Icon';
import { ScreenHead } from '../components/ui';
import { shortPath } from '../lib/format';
import { useStore } from '../state';
import { cachedLargeFiles } from '../lib/largeFileCache';
import { effortName, modelName, validEffort, validModelId } from '../../shared/aiModels';
import AssistantSetup, { PROVIDERS, LOCAL_APPS, PRIVACY, ModelControls } from './AssistantSetup';
import './system.css';

type NewMsg = { role: 'user'; text: string } | { role: 'ai'; advice: AiAdvice } | { role: 'err'; text: string };
type Msg = NewMsg & { id: number };

type LargeCtx = NonNullable<AiContext['largeFiles']>;

const SUGGESTIONS = ['What can I safely delete?', 'Why is my disk so full?', "Which large files haven't I used in a year?"];

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

export default function Assistant() {
  const { settings, junk, spaces, disk, system, toast, go, refreshDisk } = useStore();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [provider, setProvider] = useState<AiProvider | null>(null);
  const [mode, setMode] = useState<AiConnectionMode | null>(null);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<AiEffort | null>(null);
  const [chatReady, setChatReady] = useState(false);
  const [pending, setPending] = useState<{ id: string; provider: AiProvider; model: string; effort: AiEffort; stage: AiProgress['stage']; startedAt: number } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const pendingRef = useRef<string | null>(null);
  const cancelledRef = useRef<string | null>(null);
  const asking = pending !== null;
  const [connections, setConnections] = useState<AiConnections | null>(null);
  const [checking, setChecking] = useState(false);
  const [largeFiles, setLargeFiles] = useState<LargeCtx | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [trashing, setTrashing] = useState<string | null>(null);
  const [trashed, setTrashed] = useState<Set<string>>(() => new Set());
  const endRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const nextId = useRef(1);

  const hasKey = !!settings && (provider === 'claude' ? settings.hasClaudeKey : settings.hasOpenAiKey);
  const ready = chatReady && provider !== null && mode !== null && validModelId(model)
    && validEffort(provider, model, effort)
    && (mode === 'api' ? hasKey : connections?.[provider].kind === 'ready');
  const activity = pending ? pending.stage === 'thinking' ? PROVIDERS[pending.provider].name + ' is thinking…'
    : pending.stage === 'responding' ? 'Receiving the answer…'
    : pending.stage === 'connecting' ? 'Connecting to ' + PROVIDERS[pending.provider].name + '…' : 'Waiting for ' + PROVIDERS[pending.provider].name + '…' : '';
  const refreshConnections = async () => {
    setChecking(true);
    try { setConnections(await api.aiConnections()); }
    catch { toast('Could not check installed apps. Try again or use an API key.', 'err'); }
    finally { setChecking(false); }
  };

  useEffect(() => { void refreshConnections(); }, []);
  useEffect(() => api.onAiProgress((progress) => {
    setPending((current) => current?.id === progress.requestId ? { ...current, stage: progress.stage } : current);
  }), []);
  useEffect(() => () => {
    if (pendingRef.current) void api.cancelAi(pendingRef.current).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!pending) return;
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - pending.startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [pending?.id]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [messages, asking]);

  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el || !chatReady) return;
    const resize = () => {
      if (!el.clientWidth) return;
      el.style.height = 'auto';
      const contentHeight = el.scrollHeight;
      el.style.height = `${Math.max(40, Math.min(contentHeight, 160))}px`;
      el.style.overflowY = contentHeight > 160 ? 'auto' : 'hidden';
      if (!text) el.scrollTop = 0;
    };
    resize();
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      resize();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, chatReady]);

  const switchProvider = (value: AiProvider) => {
    setProvider(value); setMode(null); setModel(''); setEffort(null); setChatReady(false);
  };
  const changeModel = (value: string) => {
    setModel(value);
    if (!provider || !validEffort(provider, value, effort)) setEffort(null);
  };
  const cancel = async () => {
    if (!pending) return;
    cancelledRef.current = pending.id;
    setCancelling(true);
    try { await api.cancelAi(pending.id); }
    catch (error) { cancelledRef.current = null; setCancelling(false); toast(error instanceof Error ? error.message : 'Could not cancel the request', 'err'); }
  };

  const push = (m: NewMsg) => {
    const id = nextId.current++;
    setMessages((prev) => [...prev, { ...m, id }]);
  };

  const send = async (raw: string) => {
    const q = raw.trim();
    if (!q || asking || pendingRef.current) return;
    if (!ready || !provider || !mode || !effort) {
      toast('Choose an assistant, connection, model, and thinking level first', 'err');
      return;
    }
    setText('');
    push({ role: 'user', text: q });
    const id = crypto.randomUUID();
    cancelledRef.current = null;
    pendingRef.current = id;
    setPending({ id, provider, model, effort, stage: 'connecting', startedAt: Date.now() });
    try {
      const files = cachedLargeFiles().map((file) => ({ path: file.path, size: file.size, modified: file.modified }));
      setLargeFiles(files);
      const context: AiContext = {
        junk: (junk ?? []).filter((j) => j.size > 0).map((j) => ({ name: j.name, size: j.size, locations: j.locations })),
        spaces: (spaces?.children ?? []).slice(0, 40).map((c) => ({ name: c.name, size: c.size })),
        disk: disk ? { total: disk.total, free: disk.free } : undefined,
        largeFiles: files,
      };
      const advice = await api.askAi(q, context, { id, provider, connection: mode, model, effort });
      if (cancelledRef.current === id) push({ role: 'err', text: 'Request cancelled.' });
      else push({ role: 'ai', advice });
    } catch (e) {
      const msg = cancelledRef.current === id ? 'Request cancelled.' : e instanceof Error ? e.message : 'The assistant could not answer';
      if (/sign in/i.test(msg)) {
        setChatReady(false);
        setConnections((current) => current ? { ...current, [provider]: { kind: 'signed-out', appName: LOCAL_APPS[provider].name } } : current);
      }
      push({ role: 'err', text: msg });
      if (msg !== 'Request cancelled.') toast(msg, 'err');
    } finally {
      pendingRef.current = null; cancelledRef.current = null; setPending(null); setCancelling(false);
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
      <ScreenHead title="Assistant" sub="Ask about your completed scans. You choose the assistant, connection, and model." />
      {chatReady && provider && mode && (
        <div className="sy-connection-bar">
          <span>{PROVIDERS[provider].name} · {mode === 'local' ? LOCAL_APPS[provider].name : 'API key'}</span>
          <ModelControls key={provider} provider={provider} model={model} effort={effort} onModel={changeModel} onEffort={setEffort} disabled={asking} />
          <button type="button" className="sy-link" disabled={asking} onClick={() => setChatReady(false)}>Change setup</button>
        </div>
      )}

      <div className="sy-chat">
        {!settings ? (
          <div className="sy-center">
            <span className="spinner" />
            Getting the assistant ready
          </div>
        ) : !chatReady ? (
          <AssistantSetup key={provider ?? 'choose'} provider={provider} mode={mode} model={model} effort={effort} connections={connections} checking={checking}
            onProvider={switchProvider} onMode={(value) => { setMode(value); setModel(''); setEffort(null); }} onModel={changeModel} onEffort={setEffort}
            refresh={refreshConnections} onConnected={setConnections} onStart={() => setChatReady(true)} />
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
                <span className="sy-by">{PROVIDERS[advice.provider].name} · {modelName(advice.provider, advice.model)} · {effortName(advice.effort)} thinking</span>
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
            <div className="sy-bubble" style={{ padding: 0 }} role="status" aria-label={activity}>
              <span className="sy-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="sy-composer" hidden={!chatReady}>
        <div className="sy-chips">
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" disabled={!ready || asking} onClick={() => void send(s)}>
              <Icon name="spark" />
              {s}
            </button>
          ))}
        </div>
        {pending && <div className="sy-request-status" role="status" aria-live="polite">
          <span>{cancelling ? 'Cancelling…' : activity} · {modelName(pending.provider, pending.model)} · {effortName(pending.effort)} thinking · {elapsed}s</span>
          <button type="button" className="sy-link" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? 'Cancelling…' : 'Cancel'}</button>
        </div>}
        <div className="sy-box">
          <textarea
            ref={taRef}
            className="sy-ta"
            rows={1}
            placeholder={ready ? 'Ask anything about your disk' : 'Choose a connection above to start'}
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
