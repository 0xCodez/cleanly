import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import { CLAUDE_MODEL } from '../../config';
import type { ProviderRequest } from '../ai';

const ADVICE_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          verdict: { type: 'string', enum: ['safe', 'review', 'keep'] },
          reason: { type: 'string' },
        },
        required: ['path', 'verdict', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['answer', 'suggestions'],
  additionalProperties: false,
} as const;

function friendlyError(err: unknown): Error {
  if (err instanceof Anthropic.AuthenticationError) return new Error('你的 Claude API 密钥被拒绝。请在设置中检查。');
  if (err instanceof Anthropic.PermissionDeniedError) return new Error('你的 Claude API 密钥没有访问此模型的权限。');
  if (err instanceof Anthropic.RateLimitError) return new Error('Claude 当前请求过多。请等一分钟后重试。');
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new Error('Claude 响应超时。请重试。');
  if (err instanceof Anthropic.APIConnectionError) return new Error('无法连接 Claude。请检查网络连接。');
  if (err instanceof Anthropic.BadRequestError) return new Error('Claude 无法处理此请求。请试着缩短问题。');
  if (err instanceof Anthropic.InternalServerError) return new Error('Claude 当前出现故障。请稍后重试。');
  if (err instanceof Anthropic.APIError) return new Error(`Claude 返回了错误${err.status ? `（${err.status}）` : ''}。请重试。`);
  if (err instanceof Anthropic.AnthropicError) return new Error('Claude 返回了 Cleanly 无法读取的回答。请重试。');
  return err instanceof Error ? err : new Error('与 Claude 通信时出现问题。');
}

export async function askClaude(req: ProviderRequest): Promise<unknown> {
  const client = new Anthropic({ apiKey: req.apiKey, timeout: 60_000, maxRetries: 1 });

  let response;
  try {
    // Claude Opus 5.5 always thinks; no thinking parameter is sent.
    response = await client.messages.parse({
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
      output_config: { format: jsonSchemaOutputFormat(ADVICE_SCHEMA) },
    });
  } catch (err) {
    throw friendlyError(err);
  }

  if (response.stop_reason === 'refusal') {
    throw new Error('Claude 无法处理该请求。请换一种问法。');
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error('回答被截断了。请试着缩小问题范围。');
  }
  if (!response.parsed_output) {
    throw new Error('Claude 返回了 Cleanly 无法读取的回答。请重试。');
  }
  return response.parsed_output;
}
