import { OPENAI_MODEL } from '../../config';
import type { ProviderRequest } from '../ai';

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const TIMEOUT_MS = 60_000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function statusError(status: number): Error {
  if (status === 401) return new Error('Your OpenAI API key was rejected. Check it in Settings.');
  if (status === 403) return new Error('Your OpenAI API key does not have access to this model.');
  if (status === 429) return new Error('ChatGPT is busy or your OpenAI quota is used up. Try again later.');
  if (status === 400) return new Error('ChatGPT could not process this request. Try a shorter question.');
  if (status >= 500) return new Error('ChatGPT is having trouble right now. Please try again shortly.');
  return new Error(`ChatGPT returned an error (${status}). Please try again.`);
}

export async function askOpenAi(req: ProviderRequest): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${req.apiKey}` },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        response_format: { type: 'json_object' },
        max_completion_tokens: 16000,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') throw new Error('ChatGPT took too long to answer. Please try again.');
    throw new Error('Could not reach ChatGPT. Check your internet connection.');
  }

  if (!res.ok) throw statusError(res.status);

  const body: unknown = await res.json().catch(() => null);
  const choice = isRecord(body) && Array.isArray(body.choices) && isRecord(body.choices[0]) ? body.choices[0] : null;
  const message = choice && isRecord(choice.message) ? choice.message : null;

  if (message && typeof message.refusal === 'string' && message.refusal) {
    throw new Error('ChatGPT could not help with that request. Try asking in a different way.');
  }
  if (choice?.finish_reason === 'length') throw new Error('The answer got cut off. Try a narrower question.');
  if (choice?.finish_reason === 'content_filter') {
    throw new Error('ChatGPT could not help with that request. Try asking in a different way.');
  }

  const content = message && typeof message.content === 'string' ? message.content : '';
  try {
    return JSON.parse(content);
  } catch {
    throw new Error('ChatGPT sent an answer Cleanly could not read. Please try again.');
  }
}
