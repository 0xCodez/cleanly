import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TipsProfile } from '../../shared/types';
import { api } from '../api';
import { Flow } from '../components/Flow';
import { Icon } from '../components/Icon';
import { CleanButton, Empty, ScreenHead, Segmented } from '../components/ui';
import { useStore } from '../state';
import './support.css';

const NAME_MAX = 60;
const MESSAGE_MAX = 280;

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency.toUpperCase(),
      minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount} ${currency.toUpperCase()}`;
  }
}

function currencySymbol(currency: string): string {
  try {
    const parts = new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).formatToParts(0);
    return parts.find((p) => p.type === 'currency')?.value ?? currency.toUpperCase();
  } catch {
    return currency.toUpperCase();
  }
}

/** Returns the amount, or an error message for the custom field. */
function parseCustom(raw: string, profile: TipsProfile): number | string {
  const text = raw.trim().replace(',', '.');
  if (!/^\d+(\.\d{0,2})?$/.test(text)) return 'Use a number like 15 or 7.50';
  const n = Number(text);
  if (n < profile.min) return `The minimum is ${formatMoney(profile.min, profile.currency)}`;
  if (n > profile.max) return `The maximum is ${formatMoney(profile.max, profile.currency)}`;
  return Math.round(n * 100) / 100;
}

type Load = { state: 'loading' } | { state: 'error'; offline: boolean } | { state: 'ready'; profile: TipsProfile };

export default function Support() {
  const { toast } = useStore();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [preset, setPreset] = useState<number | null>(null);
  const [custom, setCustom] = useState('');
  const [monthly, setMonthly] = useState(false);
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [reopening, setReopening] = useState(false);
  const [pulse, setPulse] = useState(0);

  const fetchProfile = useCallback(async () => {
    setLoad({ state: 'loading' });
    try {
      const profile = await api.tipsProfile();
      setLoad({ state: 'ready', profile });
      setPreset((p) => p ?? (profile.presets.includes(10) ? 10 : (profile.presets[1] ?? profile.presets[0] ?? null)));
    } catch {
      setLoad({ state: 'error', offline: typeof navigator !== 'undefined' && !navigator.onLine });
    }
  }, []);

  useEffect(() => {
    void fetchProfile();
  }, [fetchProfile]);

  const profile = load.state === 'ready' ? load.profile : null;
  const usingCustom = custom.trim() !== '';
  const parsed = profile && usingCustom ? parseCustom(custom, profile) : null;
  const customError = typeof parsed === 'string' ? parsed : null;
  const amount = typeof parsed === 'number' ? parsed : !usingCustom ? preset : null;
  const valid = !!profile && amount !== null && amount >= profile.min && amount <= profile.max;
  const money = profile && amount !== null ? formatMoney(amount, profile.currency) : null;
  const symbol = useMemo(() => (profile ? currencySymbol(profile.currency) : '$'), [profile]);

  const startTip = async () => {
    if (!valid || amount === null || busy) return;
    setBusy(true);
    try {
      const res = await api.startTip({
        amount,
        monthly,
        name: name.trim() || undefined,
        message: message.trim() || undefined,
      });
      setCheckoutUrl(res.url);
      setPulse((n) => n + 1);
    } catch (e) {
      const offline = typeof navigator !== 'undefined' && !navigator.onLine;
      toast(offline ? 'You seem to be offline. Connect and try again.' : e instanceof Error && e.message ? e.message : 'Could not open checkout', 'err');
    } finally {
      setBusy(false);
    }
  };

  const openAgain = async () => {
    if (!checkoutUrl) return;
    setReopening(true);
    try {
      await api.openExternal(checkoutUrl);
    } catch {
      toast('Could not open your browser', 'err');
    } finally {
      setReopening(false);
    }
  };

  const supporters = profile?.supporterCount ?? 0;

  return (
    <div className="screen">
      <ScreenHead title="Support Cleanly" sub="Cleanly is free, with no ads and no upsells. If it helped, a small tip keeps it that way." />

      <div className="sp-grid">
        <section className="sp-hero card-w rise" style={{ animationDelay: '0.06s' }} aria-label="About tips">
          <div className="sp-plume">
            <Flow mode="plume" calm={!!checkoutUrl} pulse={pulse} />
          </div>
          <div className="sp-hero-in">
            <span className="eyebrow">
              <span className="dot" />
              INDEPENDENT · AD-FREE
            </span>
            <h2>Keep Cleanly free</h2>
            <p>Cleanly costs nothing and never will. Tips keep it free of ads and pay for the time that goes into new features and fixes.</p>
            <ul className="sp-perks">
              <li>
                <Icon name="shield" />
                No ads, no tracking, no paywalls
              </li>
              <li>
                <Icon name="spark" />
                New features, shaped by your feedback
              </li>
              <li>
                <Icon name="heart" />
                Built independently, with care
              </li>
            </ul>
            {profile && (
              <div className="sp-amount" aria-live="polite">
                <div className="label">{checkoutUrl ? 'Thank you' : 'Your tip'}</div>
                <div className="sp-big">
                  {money ?? '—'}
                  {monthly && <small> / month</small>}
                </div>
                {supporters > 0 && (
                  <span className="sp-supporters">
                    <span className="dots" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                    {supporters.toLocaleString('en-US')} {supporters === 1 ? 'person has' : 'people have'} chipped in
                  </span>
                )}
              </div>
            )}
          </div>
        </section>

        <section className="card-w sp-form rise" style={{ animationDelay: '0.12s' }} aria-label="Choose a tip" aria-busy={load.state === 'loading'}>
          {load.state === 'loading' && (
            <div className="sp-skel" aria-label="Loading">
              <i className="short" />
              <i />
              <i />
              <i className="short" />
              <i />
              <i style={{ height: 84 }} />
            </div>
          )}

          {load.state === 'error' && (
            <Empty
              icon="cloud"
              title="Can't reach the tip jar"
              text={load.offline ? 'You seem to be offline. Connect to the internet and try again.' : 'Something went wrong while loading. Please try again in a moment.'}
            >
              <button type="button" className="btn" onClick={() => void fetchProfile()}>
                <Icon name="arrow" />
                Try again
              </button>
            </Empty>
          )}

          {profile && checkoutUrl && (
            <div className="sp-state" role="status">
              <span className="sp-badge mint">
                <Icon name="heart" />
              </span>
              <h3>Checkout opened in your browser</h3>
              <p>
                Finish your {money}
                {monthly ? ' monthly' : ''} tip on the secure Stripe page. Thank you for keeping Cleanly free.
              </p>
              <div className="row-btns">
                <button type="button" className="btn" onClick={() => void openAgain()} disabled={reopening}>
                  {reopening ? <span className="spinner" style={{ width: 14, height: 14 }} /> : <Icon name="globe" />}
                  Open again
                </button>
                <button type="button" className="btn ghost" onClick={() => setCheckoutUrl(null)}>
                  Change amount
                </button>
              </div>
            </div>
          )}

          {profile && !checkoutUrl && (
            <>
              <div className="sp-section">
                <div className="sp-section-head">
                  <b id="sp-amount-label">Amount</b>
                  <Segmented
                    label="Tip frequency"
                    value={monthly ? 'monthly' : 'once'}
                    onChange={(v) => setMonthly(v === 'monthly')}
                    options={[
                      { value: 'once', label: 'One-time' },
                      { value: 'monthly', label: 'Monthly' },
                    ]}
                  />
                </div>
                <div className="sp-presets" role="group" aria-labelledby="sp-amount-label">
                  {profile.presets.map((p) => (
                    <button
                      key={p}
                      type="button"
                      className="sp-chip"
                      aria-pressed={!usingCustom && preset === p}
                      onClick={() => {
                        setPreset(p);
                        setCustom('');
                      }}
                    >
                      {formatMoney(p, profile.currency)}
                    </button>
                  ))}
                </div>
                <label className="field">
                  <span>Or your own amount</span>
                  <span className="sp-custom">
                    <span className="cur" aria-hidden="true">
                      {symbol}
                    </span>
                    <input
                      className="input"
                      inputMode="decimal"
                      placeholder={`${profile.min} – ${profile.max.toLocaleString('en-US')}`}
                      value={custom}
                      maxLength={8}
                      aria-invalid={!!customError}
                      aria-describedby="sp-custom-hint"
                      onChange={(e) => setCustom(e.target.value.replace(/[^\d.,]/g, ''))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void startTip();
                      }}
                    />
                  </span>
                  <span id="sp-custom-hint" className={`sp-hint${customError ? ' err' : ''}`}>
                    {customError ?? `Anything from ${formatMoney(profile.min, profile.currency)} to ${formatMoney(profile.max, profile.currency)}`}
                  </span>
                </label>
              </div>

              <div className="sp-two">
                <label className="field">
                  <span className="sp-section-head">
                    <span>Your name (optional)</span>
                    {name.length > NAME_MAX - 15 && <span className="sp-count">{`${name.length}/${NAME_MAX}`}</span>}
                  </span>
                  <input className="input" value={name} maxLength={NAME_MAX} placeholder="How we can thank you" onChange={(e) => setName(e.target.value)} />
                </label>
                <label className="field">
                  <span className="sp-section-head">
                    <span>A note (optional)</span>
                    <span className={`sp-count${message.length > MESSAGE_MAX - 30 ? ' near' : ''}`}>{`${message.length}/${MESSAGE_MAX}`}</span>
                  </span>
                  <textarea
                    className="textarea"
                    value={message}
                    maxLength={MESSAGE_MAX}
                    rows={3}
                    placeholder="Say hi, or tell us what to build next"
                    onChange={(e) => setMessage(e.target.value)}
                  />
                </label>
              </div>

              <div className="sp-actions">
                <CleanButton
                  icon="heart"
                  label={valid && money ? `Tip ${money}${monthly ? ' / month' : ''}` : 'Tip'}
                  sub={monthly ? 'Cancel anytime' : 'Secure checkout'}
                  busy={busy}
                  disabled={!valid}
                  onClick={() => void startTip()}
                />
                <span className="sp-hint">{monthly ? 'Billed monthly until you cancel.' : 'Opens Stripe Checkout in your browser.'}</span>
              </div>

              <div className="sp-foot">
                <Icon name="lock" />
                <span>Payments are handled by Stripe via beyond-media.ai. Cleanly never sees your card.</span>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
