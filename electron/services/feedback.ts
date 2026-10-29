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
  if (typeof payload !== 'object' || payload === null) throw new Error('Invalid feedback.');
  if (!KINDS.includes(payload.kind)) throw new Error('Please pick what kind of feedback this is.');

  const message = typeof payload.message === 'string' ? payload.message.replace(/\r\n/g, '\n').trim() : '';
  if (message.length < 3) throw new Error('Please write a little more so we know what you mean.');
  if (message.length > 4000) throw new Error('That message is a bit long. Please keep it under 4000 characters.');

  let rating: number | null = null;
  if (payload.rating !== null && payload.rating !== undefined) {
    if (!Number.isInteger(payload.rating) || payload.rating < 1 || payload.rating > 5) throw new Error('Rating must be from 1 to 5.');
    rating = payload.rating;
  }

  let email: string | undefined;
  if (typeof payload.email === 'string' && payload.email.trim()) {
    email = payload.email.trim();
    if (email.length > 254 || !EMAIL_RE.test(email)) throw new Error('That email address does not look right.');
  }

  return { kind: payload.kind, message, rating, email, includeSystemInfo: payload.includeSystemInfo === true };
}

function systemLines(sys: SystemInfo): string {
  return [`App: Cleanly ${sys.appVersion}`, `OS: ${sys.platform} ${sys.osVersion}`, `Arch: ${sys.arch}`].join('\n');
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
    throw new Error('Could not send feedback. Check your internet connection and try again.');
  }
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    const msg = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' ? body.error : null;
    throw new Error(msg ?? `Could not send feedback (${res.status}). Please try again later.`);
  }
  return { ok: true, via: 'endpoint', message: 'Sent. Thanks for helping make Cleanly better!' };
}

async function viaEmail(fb: CleanFeedback, sys: SystemInfo): Promise<FeedbackResult> {
  const parts = [fb.message];
  if (fb.rating) parts.push(`Rating: ${fb.rating}/5`);
  if (fb.includeSystemInfo) parts.push(systemLines(sys));
  let body = parts.join('\n\n');
  if (body.length > MAILTO_BODY_MAX) body = `${body.slice(0, MAILTO_BODY_MAX)}...`;
  const subject = `Cleanly feedback: ${fb.kind}`;
  const url = `mailto:${encodeURIComponent(FEEDBACK_EMAIL)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  try {
    await shell.openExternal(url);
  } catch {
    throw new Error(`Could not open your mail app. You can write to ${FEEDBACK_EMAIL} directly.`);
  }
  return { ok: true, via: 'email', message: 'Your mail app is open with the message ready to send.' };
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
    throw new Error('Could not save your feedback on this computer.');
  }
  return { ok: true, via: 'saved', message: 'Saved on this computer. Thanks!' };
}

export async function sendFeedback(payload: FeedbackPayload, sys: SystemInfo): Promise<FeedbackResult> {
  const fb = validate(payload);
  if (FEEDBACK_ENDPOINT) return viaEndpoint(fb, sys);
  if (FEEDBACK_EMAIL) return viaEmail(fb, sys);
  return saveLocally(fb, sys);
}
