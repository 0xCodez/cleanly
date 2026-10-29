import { app, safeStorage } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AiProvider, Background, Settings } from '../../shared/types';

type StoredSettings = Omit<Settings, 'hasClaudeKey' | 'hasOpenAiKey'>;
type StoredKeys = Partial<Record<AiProvider, string>>;

const DEFAULTS: StoredSettings = {
  aiProvider: 'claude',
  background: 'mist',
  largeFileMinMb: 500,
  confirmBeforeClean: true,
};

const PROVIDERS: readonly AiProvider[] = ['claude', 'chatgpt'];
const BACKGROUNDS: readonly Background[] = ['mist', 'grid', 'dots', 'grain'];
const MIN_LARGE_MB = 10;
const MAX_LARGE_MB = 100_000;

let cachedSettings: StoredSettings | null = null;
let cachedKeys: StoredKeys | null = null;
let writeChain: Promise<unknown> = Promise.resolve();

const dataDir = () => app.getPath('userData');
const settingsFile = () => path.join(dataDir(), 'settings.json');
const keysFile = () => path.join(dataDir(), 'keys.json');

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Write to a temp file and rename, so a crash never leaves a half-written file behind. Writes are serialized. */
function writeJson(file: string, value: unknown): Promise<void> {
  const run = async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmp, file);
  };
  const next = writeChain.then(run, run);
  writeChain = next.catch(() => undefined);
  return next;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Returns only the valid fields of an untrusted patch. Throws on a field that is present but invalid. */
function validatePatch(patch: unknown): Partial<StoredSettings> {
  if (!isRecord(patch)) throw new Error('Settings update must be an object.');
  const out: Partial<StoredSettings> = {};
  for (const [key, value] of Object.entries(patch)) {
    switch (key) {
      case 'aiProvider':
        if (!PROVIDERS.includes(value as AiProvider)) throw new Error('Unknown assistant provider.');
        out.aiProvider = value as AiProvider;
        break;
      case 'background':
        if (!BACKGROUNDS.includes(value as Background)) throw new Error('Unknown background style.');
        out.background = value as Background;
        break;
      case 'largeFileMinMb':
        if (typeof value !== 'number' || !Number.isFinite(value) || value < MIN_LARGE_MB || value > MAX_LARGE_MB) {
          throw new Error(`Large file size must be between ${MIN_LARGE_MB} MB and ${MAX_LARGE_MB} MB.`);
        }
        out.largeFileMinMb = Math.round(value);
        break;
      case 'confirmBeforeClean':
        if (typeof value !== 'boolean') throw new Error('Confirm before clean must be on or off.');
        out.confirmBeforeClean = value;
        break;
      default:
        // hasClaudeKey / hasOpenAiKey and anything else are not writable here.
        break;
    }
  }
  return out;
}

/** Lenient version for data read from disk: bad fields fall back to defaults instead of throwing. */
function sanitizeStored(raw: unknown): StoredSettings {
  const result: StoredSettings = { ...DEFAULTS };
  if (!isRecord(raw)) return result;
  for (const [key, value] of Object.entries(raw)) {
    try {
      Object.assign(result, validatePatch({ [key]: value }));
    } catch {
      // keep the default
    }
  }
  return result;
}

async function loadSettings(): Promise<StoredSettings> {
  if (!cachedSettings) cachedSettings = sanitizeStored(await readJson(settingsFile()));
  return cachedSettings;
}

async function loadKeys(): Promise<StoredKeys> {
  if (cachedKeys) return cachedKeys;
  const raw = await readJson(keysFile());
  const keys: StoredKeys = {};
  if (isRecord(raw)) {
    for (const p of PROVIDERS) {
      const v = raw[p];
      if (typeof v === 'string' && v.length > 0) keys[p] = v;
    }
  }
  cachedKeys = keys;
  return keys;
}

function encryptionReady(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  // On Linux without a keyring Electron falls back to a hardcoded password, which is not real protection.
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') return false;
  return true;
}

async function toPublic(): Promise<Settings> {
  const [s, keys] = await Promise.all([loadSettings(), loadKeys()]);
  return { ...s, hasClaudeKey: Boolean(keys.claude), hasOpenAiKey: Boolean(keys.chatgpt) };
}

export async function getSettings(): Promise<Settings> {
  return toPublic();
}

export async function setSettings(patch: Partial<StoredSettings>): Promise<Settings> {
  const valid = validatePatch(patch);
  const next = { ...(await loadSettings()), ...valid };
  await writeJson(settingsFile(), next);
  cachedSettings = next;
  return toPublic();
}

function checkKey(provider: AiProvider, key: string): string {
  const trimmed = key.trim();
  if (trimmed.length < 20 || trimmed.length > 512 || /\s/.test(trimmed)) {
    throw new Error(`That does not look like a valid ${provider === 'claude' ? 'Claude' : 'OpenAI'} API key.`);
  }
  return trimmed;
}

export async function setApiKey(provider: AiProvider, key: string | null): Promise<Settings> {
  if (!PROVIDERS.includes(provider)) throw new Error('Unknown assistant provider.');
  if (key !== null && typeof key !== 'string') throw new Error('API key must be text.');
  const keys = { ...(await loadKeys()) };

  if (key === null || key.trim() === '') {
    delete keys[provider];
  } else {
    const clean = checkKey(provider, key);
    if (!encryptionReady()) {
      throw new Error('Secure storage is not available on this system, so the key was not saved.');
    }
    keys[provider] = safeStorage.encryptString(clean).toString('base64');
  }

  await writeJson(keysFile(), keys);
  cachedKeys = keys;
  return toPublic();
}

/** Main-process only. Never send the result to the renderer or write it to a log. */
export async function getApiKey(provider: AiProvider): Promise<string | null> {
  const stored = (await loadKeys())[provider];
  if (!stored) return null;
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure storage is not available right now, so the saved API key cannot be read.');
  }
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'));
  } catch {
    throw new Error('The saved API key could not be unlocked. Please add it again in Settings.');
  }
}
