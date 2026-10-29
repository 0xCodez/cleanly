import type { TipRequest, TipsProfile } from '../../shared/types';
import { TIPS_API, TIPS_CREATOR, TIPS_RETURN_URL } from '../config';

const TIMEOUT_MS = 15_000;
const PROFILE_TTL_MS = 10 * 60_000;
const MAX_NAME = 60;
const MAX_MESSAGE = 280;

let cached: { profile: TipsProfile; at: number } | null = null;
let inflight: Promise<TipsProfile> | null = null;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const str = (v: unknown, fallback: string) => (typeof v === 'string' ? v : fallback);

function serverMessage(body: unknown): string | null {
  if (!isRecord(body)) return null;
  for (const k of ['error', 'message', 'detail']) {
    const v = body[k];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 200);
    if (isRecord(v) && typeof v.message === 'string') return v.message.trim().slice(0, 200);
  }
  return null;
}

async function request(url: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') throw new Error('The tips service took too long to answer. Please try again.');
    throw new Error('Could not reach the tips service. Check your internet connection.');
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new Error(serverMessage(body) ?? `The tips service returned an error (${res.status}).`);
  return body;
}

function toProfile(body: unknown): TipsProfile {
  if (!isRecord(body) || !isRecord(body.creator)) throw new Error('The tips service sent an unexpected answer.');
  const c = body.creator;
  const min = Math.max(0, num(c.min, 1));
  const max = Math.max(min, num(c.max, 500));
  const presets = Array.isArray(c.presets)
    ? c.presets.filter((p): p is number => typeof p === 'number' && Number.isFinite(p) && p >= min && p <= max).slice(0, 8)
    : [];
  return {
    name: str(c.name, 'Beyond Apps'),
    tagline: str(c.tagline, ''),
    currency: str(c.currency, 'usd').toLowerCase(),
    presets,
    min,
    max,
    supporterCount: Math.max(0, Math.round(num(body.supporterCount, 0))),
  };
}

export async function getTipsProfile(): Promise<TipsProfile> {
  if (cached && Date.now() - cached.at < PROFILE_TTL_MS) return cached.profile;
  inflight ??= request(`${TIPS_API}?creator=${encodeURIComponent(TIPS_CREATOR)}`, { headers: { accept: 'application/json' } })
    .then(toProfile)
    .then((profile) => {
      cached = { profile, at: Date.now() };
      return profile;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

function cleanText(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  // strip control characters, collapse whitespace runs
  return v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export async function createTipCheckout(req: TipRequest): Promise<{ url: string }> {
  if (!isRecord(req)) throw new Error('Invalid tip.');
  const amount = req.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount)) throw new Error('Please choose an amount.');

  const profile = cached?.profile ?? (await getTipsProfile());
  if (amount < profile.min || amount > profile.max) {
    const cur = profile.currency.toUpperCase();
    throw new Error(`Please choose an amount between ${profile.min} and ${profile.max} ${cur}.`);
  }

  const body = await request(TIPS_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      creator: TIPS_CREATOR,
      amount,
      name: cleanText(req.name, MAX_NAME),
      message: cleanText(req.message, MAX_MESSAGE),
      monthly: req.monthly === true,
      returnUrl: TIPS_RETURN_URL,
    }),
  });

  const url = isRecord(body) ? body.url : null;
  if (typeof url !== 'string') throw new Error('The tips service did not return a checkout link.');
  try {
    if (new URL(url).protocol !== 'https:') throw new Error();
  } catch {
    throw new Error('The tips service returned an invalid checkout link.');
  }
  return { url };
}
