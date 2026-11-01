import type { AiEffort, AiProvider } from './types';

export const AI_MODELS: Record<AiProvider, readonly { id: string; name: string }[]> = {
  claude: [
    { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' },
    { id: 'claude-opus-5-5', name: 'Opus 5.5' },
    { id: 'claude-haiku-5-5', name: 'Haiku 5.5' },
    { id: 'claude-fable-5-1', name: 'Fable 5.1' },
    { id: 'claude-sonnet-4-6', name: 'Sonnet 4.6' },
  ],
  chatgpt: [
    { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' },
    { id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra' },
    { id: 'gpt-6-astra', name: 'GPT-6 Astra' },
    { id: 'gpt-6-luna', name: 'GPT-6 Luna' },
  ],
};

export const validModelId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/@()-]{0,127}$/.test(value);

export const modelName = (provider: AiProvider, model: string): string =>
  AI_MODELS[provider].find((entry) => entry.id === model)?.name ?? model;

const EFFORTS: readonly AiEffort[] = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];
const SONNET_46_EFFORTS: readonly AiEffort[] = ['default', 'low', 'medium', 'high', 'max'];
const EFFORT_NAMES: Record<AiEffort, string> = { default: 'Model default', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };

export const allowedEfforts = (provider: AiProvider, model: string): readonly AiEffort[] =>
  provider === 'claude' && model === 'claude-sonnet-4-6' ? SONNET_46_EFFORTS : EFFORTS;

export const validEffort = (provider: AiProvider, model: string, value: unknown): value is AiEffort =>
  allowedEfforts(provider, model).some((effort) => effort === value);

export const effortName = (effort: AiEffort): string => EFFORT_NAMES[effort];
