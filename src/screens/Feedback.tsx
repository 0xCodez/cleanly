import { useRef, useState, type KeyboardEvent } from 'react';
import type { FeedbackPayload, FeedbackResult } from '../../shared/types';
import { api } from '../api';
import { Flow } from '../components/Flow';
import { Icon } from '../components/Icon';
import { CleanButton, ScreenHead, Segmented, Toggle } from '../components/ui';
import { useStore } from '../state';
import './support.css';

type Kind = FeedbackPayload['kind'];

const MIN_LEN = 3;
const MAX_LEN = 2000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RATING_LABELS = ['不太好', '还有改进空间', '还可以', '相当不错', '非常喜欢'];
const PLACEHOLDERS: Record<Kind, string> = {
  idea: '什么能让 Cleanly 对你更好用？',
  bug: '发生了什么？你原本期望的是什么？',
  love: '你喜欢 Cleanly 的哪些方面？',
};
const DONE_TITLES: Record<FeedbackResult['via'], string> = {
  endpoint: '已发送 — 谢谢！',
  email: '你的邮件应用已打开，消息已准备好',
  saved: '已保存在这台电脑上 — 谢谢！',
};

function Star() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 2.8l2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 16.6l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function StarRating({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const shown = hover ?? value ?? 0;

  const pick = (n: number) => {
    onChange(n);
    refs.current[n - 1]?.focus();
  };

  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const cur = value ?? 0;
    const next: Record<string, number> = {
      ArrowRight: Math.min(5, cur + 1),
      ArrowUp: Math.min(5, cur + 1),
      ArrowLeft: Math.max(1, cur - 1),
      ArrowDown: Math.max(1, cur - 1),
      Home: 1,
      End: 5,
    };
    if (e.key in next) {
      e.preventDefault();
      pick(next[e.key]);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      onChange(null);
    }
  };

  return (
    <div className="fb-rate">
      <div className="fb-stars" role="radiogroup" aria-label="评分" onMouseLeave={() => setHover(null)}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            ref={(el) => {
              refs.current[n - 1] = el;
            }}
            type="button"
            role="radio"
            aria-checked={value === n}
            aria-label={`${n} 星，${RATING_LABELS[n - 1]}`}
            tabIndex={(value ?? 1) === n ? 0 : -1}
            className={`fb-star${shown >= n ? ' lit' : ''}`}
            onMouseEnter={() => setHover(n)}
            onClick={() => onChange(value === n ? null : n)}
            onKeyDown={onKey}
          >
            <Star />
          </button>
        ))}
      </div>
      <span className="fb-rate-label" aria-hidden="true">
        {shown ? RATING_LABELS[shown - 1] : '可选'}
      </span>
    </div>
  );
}

export default function Feedback() {
  const { system, toast } = useStore();
  const [kind, setKind] = useState<Kind>('idea');
  const [rating, setRating] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [includeSys, setIncludeSys] = useState(false);
  const [sysTouched, setSysTouched] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<FeedbackResult | null>(null);

  const trimmed = message.trim();
  const tooShort = trimmed.length < MIN_LEN;
  const emailBad = email.trim() !== '' && !EMAIL_RE.test(email.trim());
  const canSend = !tooShort && !emailBad && !sending;

  const changeKind = (k: Kind) => {
    setKind(k);
    // bug reports are far more useful with the OS version, but only if the user has not decided yet
    if (k === 'bug' && !sysTouched) setIncludeSys(true);
  };

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    try {
      const res = await api.sendFeedback({
        kind,
        message: trimmed,
        rating,
        email: email.trim() || undefined,
        includeSystemInfo: includeSys,
      });
      if (res.ok) setResult(res);
      else toast(res.message || '无法发送你的反馈', 'err');
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : '无法发送你的反馈', 'err');
    } finally {
      setSending(false);
    }
  };

  const reset = () => {
    setResult(null);
    setKind('idea');
    setRating(null);
    setMessage('');
    setIncludeSys(false);
    setSysTouched(false);
  };

  const sysLines: [string, string][] = system
    ? [
        ['应用', `Cleanly ${system.appVersion}`],
        ['系统', system.osVersion],
        ['平台', `${system.platform} / ${system.arch}`],
      ]
    : [];

  return (
    <div className="screen">
      <ScreenHead title="告诉我们任何想法" sub="想法、问题反馈，或一句鼓励。每条消息都会被阅读，并影响后续的改进方向。" />

      <div className="fb-grid">
        {result ? (
          <section className="card-w fb-done rise" aria-label="反馈已发送">
            <div className="sp-state" role="status">
              <span className={`sp-badge${result.via === 'email' ? '' : ' mint'}`}>
                <Icon name={result.via === 'email' ? 'mail' : 'check'} />
              </span>
              <h3>{DONE_TITLES[result.via]}</h3>
              {result.message && <p>{result.message}</p>}
              <div className="row-btns">
                <button type="button" className="btn" onClick={reset}>
                  <Icon name="plus" />
                  再发送一条
                </button>
              </div>
            </div>
          </section>
        ) : (
          <section className="card-w fb-form rise" style={{ animationDelay: '0.06s' }} aria-label="反馈表单">
            <div className="sp-section">
              <div className="sp-section-head">
                <b>这是关于什么的？</b>
                <Segmented
                  label="反馈类型"
                  value={kind}
                  onChange={changeKind}
                  options={[
                    { value: 'idea', label: '想法' },
                    { value: 'bug', label: '问题' },
                    { value: 'love', label: '好评' },
                  ]}
                />
              </div>
            </div>

            <div className="sp-section">
              <b style={{ fontSize: 14, fontWeight: 600 }}>Cleanly 用起来怎么样？</b>
              <StarRating value={rating} onChange={setRating} />
            </div>

            <label className="field">
              <span className="sp-section-head">
                <span>消息</span>
                <span className={`sp-count${message.length > MAX_LEN - 100 ? ' near' : ''}`}>{`${message.length}/${MAX_LEN}`}</span>
              </span>
              <textarea
                className="textarea"
                value={message}
                maxLength={MAX_LEN}
                rows={5}
                placeholder={PLACEHOLDERS[kind]}
                aria-describedby="fb-msg-hint"
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send();
                }}
              />
              <span id="fb-msg-hint" className="sp-hint">
                {tooShort && message.length > 0 ? `请再多写几个字（至少 ${MIN_LEN} 个字符）` : '按 Ctrl + Enter 发送'}
              </span>
            </label>

            <label className="field">
              <span>邮箱（可选，仅当你希望收到回复时填写）</span>
              <input
                className="input"
                type="email"
                value={email}
                maxLength={120}
                placeholder="you@example.com"
                aria-invalid={emailBad}
                aria-describedby={emailBad ? 'fb-email-hint' : undefined}
                onChange={(e) => setEmail(e.target.value)}
              />
              {emailBad && (
                <span id="fb-email-hint" className="sp-hint err">
                  该邮箱地址似乎不正确
                </span>
              )}
            </label>

            <div className="sp-section">
              <div className="fb-switch">
                <div className="grow">
                  <b>包含系统信息</b>
                  <span>有助于我们重现问题。不会发送你电脑上的其他任何内容。</span>
                </div>
                <Toggle
                  label="包含系统信息"
                  checked={includeSys}
                  onChange={(v) => {
                    setIncludeSys(v);
                    setSysTouched(true);
                  }}
                />
              </div>
              {includeSys && (
                <pre className="fb-sys" aria-label="将包含的系统信息">
                  {sysLines.length
                    ? sysLines.map(([k, v]) => (
                        <span key={k}>
                          <span className="k">{k.padEnd(10)}</span>
                          {v}
                          {'\n'}
                        </span>
                      ))
                    : '系统详情仍在加载中。'}
                </pre>
              )}
            </div>

            <div className="sp-actions">
              <CleanButton icon="chat" label="发送" sub={kind === 'bug' ? '问题报告' : kind === 'love' ? '好评' : '想法'} busy={sending} disabled={!canSend} onClick={() => void send()} />
              {tooShort && <span className="sp-hint">请至少写 {MIN_LEN} 个字符后再发送。</span>}
            </div>
          </section>
        )}

        <aside className="card-w fb-aside rise" style={{ animationDelay: '0.12s' }} aria-label="反馈如何处理">
          <div className="sp-plume">
            <Flow mode="plume" calm={!!result} pulse={result ? 1 : 0} />
          </div>
          <span className="eyebrow">
            <span className="dot" />
            由真人阅读
          </span>
          <h3>你的意见将塑造下一次更新</h3>
          <p>Cleanly 由独立开发者打造。欢迎简短留言，附带复现步骤的问题报告更是非常宝贵。</p>
          <ul>
            <li>
              <Icon name="lock" />
              只会发送你在此页面看到的内容。
            </li>
            <li>
              <Icon name="shield" />
              不会附带任何文件、文件夹名称或扫描结果。
            </li>
            <li>
              <Icon name="mail" />
              如果你希望收到回复，请留下邮箱。
            </li>
          </ul>
        </aside>
      </div>
    </div>
  );
}
