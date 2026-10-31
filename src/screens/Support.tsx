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
    return new Intl.NumberFormat('zh-CN', {
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
    const parts = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: currency.toUpperCase() }).formatToParts(0);
    return parts.find((p) => p.type === 'currency')?.value ?? currency.toUpperCase();
  } catch {
    return currency.toUpperCase();
  }
}

/** Returns the amount, or an error message for the custom field. */
function parseCustom(raw: string, profile: TipsProfile): number | string {
  const text = raw.trim().replace(',', '.');
  if (!/^\d+(\.\d{0,2})?$/.test(text)) return '请使用类似 15 或 7.50 的数字';
  const n = Number(text);
  if (n < profile.min) return `最低金额为 ${formatMoney(profile.min, profile.currency)}`;
  if (n > profile.max) return `最高金额为 ${formatMoney(profile.max, profile.currency)}`;
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
      toast(offline ? '你似乎已离线。请连接网络后重试。' : e instanceof Error && e.message ? e.message : '无法打开结账页面', 'err');
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
      toast('无法打开你的浏览器', 'err');
    } finally {
      setReopening(false);
    }
  };

  const supporters = profile?.supporterCount ?? 0;

  return (
    <div className="screen">
      <ScreenHead title="支持作者" sub="Cleanly 免费使用，没有广告，也没有推销。如果它帮到了你，一笔小额打赏能让它保持这样。" />

      <div className="sp-grid">
        <section className="sp-hero card-w rise" style={{ animationDelay: '0.06s' }} aria-label="关于打赏">
          <div className="sp-plume">
            <Flow mode="plume" calm={!!checkoutUrl} pulse={pulse} />
          </div>
          <div className="sp-hero-in">
            <span className="eyebrow">
              <span className="dot" />
              独立开发 · 无广告
            </span>
            <h2>让 Cleanly 保持免费</h2>
            <p>Cleanly 免费使用，并将一直免费。打赏能让它保持无广告，并支持新功能开发和问题修复所投入的时间。</p>
            <ul className="sp-perks">
              <li>
                <Icon name="shield" />
                无广告、无追踪、无付费墙
              </li>
              <li>
                <Icon name="spark" />
                新功能，由你的反馈塑造
              </li>
              <li>
                <Icon name="heart" />
                独立开发，用心制作
              </li>
            </ul>
            {profile && (
              <div className="sp-amount" aria-live="polite">
                <div className="label">{checkoutUrl ? '谢谢你' : '你的打赏'}</div>
                <div className="sp-big">
                  {money ?? '—'}
                  {monthly && <small> / 月</small>}
                </div>
                {supporters > 0 && (
                  <span className="sp-supporters">
                    <span className="dots" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                    {supporters.toLocaleString('zh-CN')} 人已参与支持
                  </span>
                )}
              </div>
            )}
          </div>
        </section>

        <section className="card-w sp-form rise" style={{ animationDelay: '0.12s' }} aria-label="选择打赏" aria-busy={load.state === 'loading'}>
          {load.state === 'loading' && (
            <div className="sp-skel" aria-label="加载中">
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
              title="无法连接打赏服务"
              text={load.offline ? '你似乎已离线。请连接互联网后重试。' : '加载时出了点问题。请稍后重试。'}
            >
              <button type="button" className="btn" onClick={() => void fetchProfile()}>
                <Icon name="arrow" />
                重试
              </button>
            </Empty>
          )}

          {profile && checkoutUrl && (
            <div className="sp-state" role="status">
              <span className="sp-badge mint">
                <Icon name="heart" />
              </span>
              <h3>已在浏览器中打开结账页面</h3>
              <p>
                请在安全的 Stripe 页面完成你的 {money}
                {monthly ? ' 每月' : ''}打赏。感谢你让 Cleanly 保持免费。
              </p>
              <div className="row-btns">
                <button type="button" className="btn" onClick={() => void openAgain()} disabled={reopening}>
                  {reopening ? <span className="spinner" style={{ width: 14, height: 14 }} /> : <Icon name="globe" />}
                  再次打开
                </button>
                <button type="button" className="btn ghost" onClick={() => setCheckoutUrl(null)}>
                  更改金额
                </button>
              </div>
            </div>
          )}

          {profile && !checkoutUrl && (
            <>
              <div className="sp-section">
                <div className="sp-section-head">
                  <b id="sp-amount-label">金额</b>
                  <Segmented
                    label="打赏频率"
                    value={monthly ? 'monthly' : 'once'}
                    onChange={(v) => setMonthly(v === 'monthly')}
                    options={[
                      { value: 'once', label: '一次性' },
                      { value: 'monthly', label: '每月' },
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
                  <span>或输入自定义金额</span>
                  <span className="sp-custom">
                    <span className="cur" aria-hidden="true">
                      {symbol}
                    </span>
                    <input
                      className="input"
                      inputMode="decimal"
                      placeholder={`${profile.min} – ${profile.max.toLocaleString('zh-CN')}`}
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
                    {customError ?? `金额范围：${formatMoney(profile.min, profile.currency)} 至 ${formatMoney(profile.max, profile.currency)}`}
                  </span>
                </label>
              </div>

              <div className="sp-two">
                <label className="field">
                  <span className="sp-section-head">
                    <span>你的名字（可选）</span>
                    {name.length > NAME_MAX - 15 && <span className="sp-count">{`${name.length}/${NAME_MAX}`}</span>}
                  </span>
                  <input className="input" value={name} maxLength={NAME_MAX} placeholder="我们该如何称呼你以表示感谢" onChange={(e) => setName(e.target.value)} />
                </label>
                <label className="field">
                  <span className="sp-section-head">
                    <span>留言（可选）</span>
                    <span className={`sp-count${message.length > MESSAGE_MAX - 30 ? ' near' : ''}`}>{`${message.length}/${MESSAGE_MAX}`}</span>
                  </span>
                  <textarea
                    className="textarea"
                    value={message}
                    maxLength={MESSAGE_MAX}
                    rows={3}
                    placeholder="打个招呼，或告诉我们接下来该做什么"
                    onChange={(e) => setMessage(e.target.value)}
                  />
                </label>
              </div>

              <div className="sp-actions">
                <CleanButton
                  icon="heart"
                  label={valid && money ? `打赏 ${money}${monthly ? ' / 月' : ''}` : '打赏'}
                  sub={monthly ? '随时取消' : '安全结账'}
                  busy={busy}
                  disabled={!valid}
                  onClick={() => void startTip()}
                />
                <span className="sp-hint">{monthly ? '每月扣款，直到你取消为止。' : '将在浏览器中打开 Stripe 结账页面。'}</span>
              </div>

              <div className="sp-foot">
                <Icon name="lock" />
                <span>付款由 Stripe 通过 beyond-media.ai 处理。Cleanly 绝不会看到你的银行卡信息。</span>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
