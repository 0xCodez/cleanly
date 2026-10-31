import { OPENAI_MODEL } from '../../config';
import type { ProviderRequest } from '../ai';

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const TIMEOUT_MS = 60_000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function statusError(status: number): Error {
  if (status === 401) return new Error('你的 OpenAI API 密钥被拒绝。请在设置中检查。');
  if (status === 403) return new Error('你的 OpenAI API 密钥没有访问此模型的权限。');
  if (status === 429) return new Error('ChatGPT 繁忙或你的 OpenAI 额度已用完。请稍后重试。');
  if (status === 400) return new Error('ChatGPT 无法处理此请求。请试着缩短问题。');
  if (status >= 500) return new Error('ChatGPT 当前出现故障。请稍后重试。');
  return new Error(`ChatGPT 返回了错误（${status}）。请重试。`);
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
    if (name === 'TimeoutError' || name === 'AbortError') throw new Error('ChatGPT 响应超时。请重试。');
    throw new Error('无法连接 ChatGPT。请检查网络连接。');
  }

  if (!res.ok) throw statusError(res.status);

  const body: unknown = await res.json().catch(() => null);
  const choice = isRecord(body) && Array.isArray(body.choices) && isRecord(body.choices[0]) ? body.choices[0] : null;
  const message = choice && isRecord(choice.message) ? choice.message : null;

  if (message && typeof message.refusal === 'string' && message.refusal) {
    throw new Error('ChatGPT 无法处理该请求。请换一种问法。');
  }
  if (choice?.finish_reason === 'length') throw new Error('回答被截断了。请试着缩小问题范围。');
  if (choice?.finish_reason === 'content_filter') {
    throw new Error('ChatGPT 无法处理该请求。请换一种问法。');
  }

  const content = message && typeof message.content === 'string' ? message.content : '';
  try {
    return JSON.parse(content);
  } catch {
    throw new Error('ChatGPT 返回了 Cleanly 无法读取的回答。请重试。');
  }
}
