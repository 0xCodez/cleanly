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

const SUGGESTIONS = ['哪些文件可以安全删除？', '为什么我的磁盘这么满？', '哪些大文件已经一年没用过了？'];
const PRIVACY = '只会共享文件名、路径和大小 — 绝不会共享文件内容。';
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
      toast(`${info.name} 已就绪`);
    } catch (e) {
      toast(e instanceof Error ? e.message : '无法保存密钥', 'err');
    } finally {
      setSaving(false);
    }
  };

  const openKeys = () => {
    api.openExternal(info.keyUrl).catch(() => toast('无法打开浏览器', 'err'));
  };

  return (
    <section className="card-w panel sy-setup rise">
      <span className="sy-orb" style={{ width: 52, height: 52, borderRadius: 18 }}>
        <Icon name="lock" />
      </span>
      <h3>连接 {info.name}</h3>
      <p>
        AI助手使用你自己的 {info.name} API 密钥。密钥会安全地存储在这台电脑上，并且只会发送给 {info.name}。
      </p>
      <div className="sy-keyrow">
        <input
          className="input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={`粘贴你的密钥（${info.placeholder}）`}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
          }}
          aria-label={`${info.name} API 密钥`}
        />
        <button type="button" className="btn primary" onClick={() => void save()} disabled={saving || !key.trim()}>
          {saving ? <span className="spinner" style={{ borderColor: 'rgba(255,255,255,0.35)', borderTopColor: '#fff' }} /> : <Icon name="check" />}
          保存密钥
        </button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <button type="button" className="sy-link" onClick={openKeys}>
          获取密钥
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
      toast(e instanceof Error ? e.message : '无法切换AI助手', 'err');
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
      toast(`请先添加你的 ${PROVIDERS[provider].name} 密钥`, 'err');
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
      const msg = e instanceof Error ? e.message : 'AI助手无法回答';
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
    api.revealPath(p).catch(() => toast('无法显示该项目', 'err'));
  };

  const moveToTrash = async (key: string, p: string) => {
    setConfirm(null);
    setTrashing(key);
    try {
      const res = await api.trashPaths([p]);
      if (res.removed > 0) {
        setTrashed((s) => new Set(s).add(norm(p)));
        setLargeFiles((fs) => (fs ? fs.filter((f) => norm(f.path) !== norm(p)) : fs));
        toast(`已将 ${baseName(p)} 移到回收站 — 你可以从那里恢复它`);
        void refreshDisk();
      } else {
        toast(res.skipped[0] ?? `无法将 ${baseName(p)} 移到回收站`, 'err');
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : `无法将 ${baseName(p)} 移到回收站`, 'err');
    } finally {
      setTrashing(null);
    }
  };

  return (
    <div className="screen">
      <ScreenHead title="AI助手" sub="用日常语言询问你的磁盘情况。你会得到清晰的建议，未经你同意不会删除任何内容。">
        {settings && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {switching && <span className="spinner" />}
            <Segmented<AiProvider>
              label="AI助手服务商"
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
            正在准备AI助手
          </div>
        ) : !hasKey ? (
          <KeySetup provider={provider} />
        ) : messages.length === 0 && !asking ? (
          <div className="sy-intro rise">
            <span className="sy-orb">
              <Icon name="assist" />
            </span>
            <h2>你想了解什么？</h2>
            <p>
              我可以查看你的扫描结果、最大的文件夹和大文件，然后建议哪些可以安全删除、哪些值得保留。
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
                <span className="sy-by">{PROVIDERS[advice.provider]?.name ?? 'AI助手'}</span>
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
                                {s.verdict === 'safe' ? '可安全删除' : s.verdict === 'review' ? '请先确认' : '保留'}
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
                                  已移到回收站
                                </span>
                              ) : (
                                <>
                                  <button type="button" className="btn small" onClick={() => reveal(full)}>
                                    <Icon name="reveal" />
                                    显示位置
                                  </button>
                                  {canTrash &&
                                    (trashing === key ? (
                                      <span className="sy-lock">
                                        <span className="spinner" />
                                        正在移到回收站
                                      </span>
                                    ) : confirm === key ? (
                                      <div className="sy-confirm">
                                        <span>移到回收站？你可以恢复它。</span>
                                        <button type="button" className="btn small ghost" onClick={() => setConfirm(null)}>
                                          取消
                                        </button>
                                        <button type="button" className="btn small danger" onClick={() => void moveToTrash(key, full)}>
                                          移动
                                        </button>
                                      </div>
                                    ) : (
                                      <button type="button" className="btn small" disabled={trashing !== null} onClick={() => setConfirm(key)}>
                                        <Icon name="trash" />
                                        移到回收站
                                      </button>
                                    ))}
                                  {junkish && s.verdict !== 'keep' && (
                                    <button type="button" className="btn small ghost" onClick={() => go('cleanup')}>
                                      在清理中处理
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
            <div className="sy-bubble" style={{ padding: 0 }} role="status" aria-label="思考中">
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
            placeholder={ready ? '询问任何关于磁盘的问题' : `添加你的 ${PROVIDERS[provider].name} 密钥以开始`}
            value={text}
            disabled={!ready}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            aria-label="消息"
          />
          <button type="button" className="sy-send" disabled={!ready || asking || !text.trim()} onClick={() => void send(text)} aria-label="发送">
            {asking ? <span className="spinner" style={{ borderColor: 'rgba(255,255,255,0.35)', borderTopColor: '#fff' }} /> : <Icon name="arrow" />}
          </button>
        </div>
        <div className="sy-hint">按 Enter 发送 · Shift+Enter 换行</div>
      </div>
    </div>
  );
}
