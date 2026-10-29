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
const RATING_LABELS = ['Not great', 'Could be better', 'It is okay', 'Pretty good', 'Love it'];
const PLACEHOLDERS: Record<Kind, string> = {
  idea: 'What would make Cleanly better for you?',
  bug: 'What happened, and what did you expect instead?',
  love: 'What do you like about Cleanly?',
};
const DONE_TITLES: Record<FeedbackResult['via'], string> = {
  endpoint: 'Sent — thank you!',
  email: 'Your email app is open with the message ready',
  saved: 'Saved on this computer — thank you!',
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
      <div className="fb-stars" role="radiogroup" aria-label="Rating" onMouseLeave={() => setHover(null)}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            ref={(el) => {
              refs.current[n - 1] = el;
            }}
            type="button"
            role="radio"
            aria-checked={value === n}
            aria-label={`${n} ${n === 1 ? 'star' : 'stars'}, ${RATING_LABELS[n - 1]}`}
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
        {shown ? RATING_LABELS[shown - 1] : 'Optional'}
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
      else toast(res.message || 'Could not send your feedback', 'err');
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : 'Could not send your feedback', 'err');
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
        ['app', `Cleanly ${system.appVersion}`],
        ['os', system.osVersion],
        ['platform', `${system.platform} / ${system.arch}`],
      ]
    : [];

  return (
    <div className="screen">
      <ScreenHead title="Tell us anything" sub="Ideas, bugs, or a kind word. Every message is read, and it shapes what comes next." />

      <div className="fb-grid">
        {result ? (
          <section className="card-w fb-done rise" aria-label="Feedback sent">
            <div className="sp-state" role="status">
              <span className={`sp-badge${result.via === 'email' ? '' : ' mint'}`}>
                <Icon name={result.via === 'email' ? 'mail' : 'check'} />
              </span>
              <h3>{DONE_TITLES[result.via]}</h3>
              {result.message && <p>{result.message}</p>}
              <div className="row-btns">
                <button type="button" className="btn" onClick={reset}>
                  <Icon name="plus" />
                  Send another
                </button>
              </div>
            </div>
          </section>
        ) : (
          <section className="card-w fb-form rise" style={{ animationDelay: '0.06s' }} aria-label="Feedback form">
            <div className="sp-section">
              <div className="sp-section-head">
                <b>What is it about?</b>
                <Segmented
                  label="Feedback type"
                  value={kind}
                  onChange={changeKind}
                  options={[
                    { value: 'idea', label: 'Idea' },
                    { value: 'bug', label: 'Bug' },
                    { value: 'love', label: 'Love' },
                  ]}
                />
              </div>
            </div>

            <div className="sp-section">
              <b style={{ fontSize: 14, fontWeight: 600 }}>How is Cleanly working for you?</b>
              <StarRating value={rating} onChange={setRating} />
            </div>

            <label className="field">
              <span className="sp-section-head">
                <span>Message</span>
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
                {tooShort && message.length > 0 ? `A few more characters, please (at least ${MIN_LEN})` : 'Ctrl + Enter to send'}
              </span>
            </label>

            <label className="field">
              <span>Email (optional, only if you want a reply)</span>
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
                  That email does not look right
                </span>
              )}
            </label>

            <div className="sp-section">
              <div className="fb-switch">
                <div className="grow">
                  <b>Include system info</b>
                  <span>Helps us reproduce bugs. Nothing else from your computer is sent.</span>
                </div>
                <Toggle
                  label="Include system info"
                  checked={includeSys}
                  onChange={(v) => {
                    setIncludeSys(v);
                    setSysTouched(true);
                  }}
                />
              </div>
              {includeSys && (
                <pre className="fb-sys" aria-label="System info that will be included">
                  {sysLines.length
                    ? sysLines.map(([k, v]) => (
                        <span key={k}>
                          <span className="k">{k.padEnd(10)}</span>
                          {v}
                          {'\n'}
                        </span>
                      ))
                    : 'System details are still loading.'}
                </pre>
              )}
            </div>

            <div className="sp-actions">
              <CleanButton icon="chat" label="Send" sub={kind === 'bug' ? 'Bug report' : kind === 'love' ? 'Kind words' : 'Idea'} busy={sending} disabled={!canSend} onClick={() => void send()} />
              {tooShort && <span className="sp-hint">Write at least {MIN_LEN} characters to send.</span>}
            </div>
          </section>
        )}

        <aside className="card-w fb-aside rise" style={{ animationDelay: '0.12s' }} aria-label="How feedback is handled">
          <div className="sp-plume">
            <Flow mode="plume" calm={!!result} pulse={result ? 1 : 0} />
          </div>
          <span className="eyebrow">
            <span className="dot" />
            READ BY A HUMAN
          </span>
          <h3>Your words shape the next update</h3>
          <p>Cleanly is built independently. Short notes are welcome, and bug reports with steps are gold.</p>
          <ul>
            <li>
              <Icon name="lock" />
              Only what you see on this page is sent.
            </li>
            <li>
              <Icon name="shield" />
              No files, folder names or scan results are attached.
            </li>
            <li>
              <Icon name="mail" />
              Leave an email if you would like a reply.
            </li>
          </ul>
        </aside>
      </div>
    </div>
  );
}
