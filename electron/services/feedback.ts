import { app, shell } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FeedbackPayload, FeedbackResult, SystemInfo } from '../../shared/types';
import { FEEDBACK_EMAIL, FEEDBACK_ENDPOINT } from '../config';

const KINDS: readonly FeedbackPayload['kind'][] = ['idea', 'bug', 'love'];
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i;
const MAILTO_BODY_MAX = 1800;

interface CleanFeedback {
  kind: FeedbackPayload['kind'];
  message: string;
  rating: number | null;
  email?: string;
  includeSystemInfo: boolean;
}

function validate(payload: FeedbackPayload): CleanFeedback {
  if (typeof payload !== 'object' || payload === null) throw new Error('反馈内容无效。');
  if (!KINDS.includes(payload.kind)) throw new Error('请选择反馈类型。');

  const message = typeof payload.message === 'string' ? payload.message.replace(/\r\n/g, '\n').trim() : '';
  if (message.length < 3) throw new Error('请再多写一点，以便我们理解你的意思。');
  if (message.length > 4000) throw new Error('内容有点长。请控制在 4000 个字符以内。');

  let rating: number | null = null;
  if (payload.rating !== null && payload.rating !== undefined) {
    if (!Number.isInteger(payload.rating) || payload.rating < 1 || payload.rating > 5) throw new Error('评分必须在 1 到 5 之间。');
    rating = payload.rating;
  }

  let email: string | undefined;
  if (typeof payload.email === 'string' && payload.email.trim()) {
    email = payload.email.trim();
    if (email.length > 254 || !EMAIL_RE.test(email)) throw new Error('该电子邮件地址格式不正确。');
  }

  return { kind: payload.kind, message, rating, email, includeSystemInfo: payload.includeSystemInfo === true };
}

function systemLines(sys: SystemInfo): string {
  return [`应用：Cleanly ${sys.appVersion}`, `系统：${sys.platform} ${sys.osVersion}`, `架构：${sys.arch}`].join('\n');
}

/** The home directory reveals the user's account name, so it never leaves the machine. */
function publicSystem(sys: SystemInfo) {
  return { platform: sys.platform, arch: sys.arch, osVersion: sys.osVersion, appVersion: sys.appVersion };
}

async function viaEndpoint(fb: CleanFeedback, sys: SystemInfo): Promise<FeedbackResult> {
  let res: Response;
  try {
    res = await fetch(FEEDBACK_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        kind: fb.kind,
        message: fb.message,
        rating: fb.rating,
        email: fb.email ?? null,
        system: fb.includeSystemInfo ? publicSystem(sys) : null,
        app: 'cleanly',
        version: app.getVersion(),
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error('无法发送反馈。请检查网络连接后重试。');
  }
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    const msg = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' ? body.error : null;
    throw new Error(msg ?? `无法发送反馈（${res.status}）。请稍后重试。`);
  }
  return { ok: true, via: 'endpoint', message: '已发送。感谢你帮助 Cleanly 变得更好！' };
}

async function viaEmail(fb: CleanFeedback, sys: SystemInfo): Promise<FeedbackResult> {
  const parts = [fb.message];
  if (fb.rating) parts.push(`评分：${fb.rating}/5`);
  if (fb.includeSystemInfo) parts.push(systemLines(sys));
  let body = parts.join('\n\n');
  if (body.length > MAILTO_BODY_MAX) body = `${body.slice(0, MAILTO_BODY_MAX)}...`;
  const subject = `Cleanly 反馈：${fb.kind}`;
  const url = `mailto:${encodeURIComponent(FEEDBACK_EMAIL)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  try {
    await shell.openExternal(url);
  } catch {
    throw new Error(`无法打开邮件应用。你可以直接写信至 ${FEEDBACK_EMAIL}。`);
  }
  return { ok: true, via: 'email', message: '你的邮件应用已打开，反馈内容已准备好发送。' };
}

async function saveLocally(fb: CleanFeedback, sys: SystemInfo): Promise<FeedbackResult> {
  const dir = path.join(app.getPath('userData'), 'feedback');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const record = {
    ...fb,
    system: fb.includeSystemInfo ? publicSystem(sys) : null,
    app: 'cleanly',
    version: app.getVersion(),
    createdAt: Date.now(),
  };
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${stamp}.json`), JSON.stringify(record, null, 2), { encoding: 'utf8', flag: 'wx' });
  } catch {
    throw new Error('无法将反馈保存在这台电脑上。');
  }
  return { ok: true, via: 'saved', message: '已保存在这台电脑上。谢谢！' };
}

export async function sendFeedback(payload: FeedbackPayload, sys: SystemInfo): Promise<FeedbackResult> {
  const fb = validate(payload);
  if (FEEDBACK_ENDPOINT) return viaEndpoint(fb, sys);
  if (FEEDBACK_EMAIL) return viaEmail(fb, sys);
  return saveLocally(fb, sys);
}
