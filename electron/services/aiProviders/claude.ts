import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import type { ProviderRequest } from '../ai';
import { ADVICE_SCHEMA } from '../aiSchema';

function friendlyError(err: unknown): Error {
  if (err instanceof Anthropic.AuthenticationError) return new Error('Your Claude API key was rejected. Check it in Settings.');
  if (err instanceof Anthropic.PermissionDeniedError) return new Error('Your Claude API key does not have access to this model.');
  if (err instanceof Anthropic.RateLimitError) return new Error('Claude is getting too many requests right now. Wait a minute and try again.');
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new Error('Claude took too long to answer. Please try again.');
  if (err instanceof Anthropic.APIConnectionError) return new Error('Could not reach Claude. Check your internet connection.');
  if (err instanceof Anthropic.BadRequestError) return new Error('Claude could not process this request. Try a shorter question.');
  if (err instanceof Anthropic.InternalServerError) return new Error('Claude is having trouble right now. Please try again shortly.');
  if (err instanceof Anthropic.APIError) return new Error(`Claude returned an error${err.status ? ` (${err.status})` : ''}. Please try again.`);
  if (err instanceof Anthropic.AnthropicError) return new Error('Claude sent an answer Cleanly could not read. Please try again.');
  return err instanceof Error ? err : new Error('Something went wrong talking to Claude.');
}

export async function askClaude(req: ProviderRequest): Promise<unknown> {
  const client = new Anthropic({ apiKey: req.apiKey, baseURL: 'https://api.anthropic.com', timeout: 60_000, maxRetries: 1 });

  let response;
  try {
    req.progress('waiting');
    response = await client.messages.parse({
      model: req.model,
      max_tokens: 16000,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
      ...(req.effort !== 'default' ? { thinking: { type: 'adaptive' } } : {}),
      output_config: { format: jsonSchemaOutputFormat(ADVICE_SCHEMA), ...(req.effort !== 'default' ? { effort: req.effort } : {}) },
    }, { signal: req.signal });
  } catch (err) {
    throw friendlyError(err);
  }

  if (response.stop_reason === 'refusal') {
    throw new Error('Claude could not help with that request. Try asking in a different way.');
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error('The answer got cut off. Try a narrower question.');
  }
  if (!response.parsed_output) {
    throw new Error('Claude sent an answer Cleanly could not read. Please try again.');
  }
  return response.parsed_output;
}
