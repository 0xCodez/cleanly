import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk/core';
import type { AiProvider } from '../../../shared/types';
import type { ProviderRequest } from '../ai';
import { ADVICE_SCHEMA } from '../aiSchema';
import { codexSdkRuntime, findLocalAi, localAiEnvironment, localClaudeEnvironment, localAiWorkingDirectory } from '../localAi';

/** The SDK's CLI supports isolation flags that its TypeScript client does not expose yet. */
async function askCodex(executable: string, cwd: string, req: Omit<ProviderRequest, 'apiKey'>, signal: AbortSignal): Promise<unknown> {
  const dir = await fs.mkdtemp(path.join(cwd, 'codex-'));
  const schema = path.join(dir, 'advice-schema.json');
  try {
    await fs.writeFile(schema, JSON.stringify(ADVICE_SCHEMA), { mode: 0o600 });
    const args = [
      'exec', '--json', '--ignore-user-config', '--ignore-rules', '--ephemeral',
      '--skip-git-repo-check', '--sandbox', 'read-only', '--cd', cwd, '--output-schema', schema,
      '--model', req.model,
      ...(req.effort !== 'default' ? ['-c', `model_reasoning_effort="${req.effort}"`] : []),
      '-c', 'approval_policy="never"', '-c', 'web_search="disabled"',
      '-c', 'model_provider="openai"', '-c', 'cli_auth_credentials_store="auto"',
      '-c', 'project_doc_max_bytes=0', '-c', `developer_instructions=${JSON.stringify(req.system)}`,
      ...['shell_tool', 'view_image', 'image_generation', 'hooks', 'apps', 'multi_agent',
        'multi_agent_v2', 'multi_agent_v2_dynamic_tools', 'remote_plugin', 'js_repl', 'memories', 'code_mode']
        .flatMap((feature) => ['-c', `features.${feature}=false`]),
      '-c', 'sandbox_workspace_write.network_access=false',
    ];
    const output = await new Promise<string>((resolve, reject) => {
      const child = execFile(executable, args, { env: localAiEnvironment(), windowsHide: true, signal, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr || stdout || error.message)));
        else resolve(stdout);
      });
      child.stdin?.on('error', reject);
      let buffer = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          try {
            const event: unknown = JSON.parse(line);
            if (typeof event !== 'object' || event === null) continue;
            if ('type' in event && event.type === 'turn.started') req.progress('waiting');
            if (!('item' in event)) continue;
            const item = event.item;
            if (typeof item !== 'object' || item === null || !('type' in item)) continue;
            if (item.type === 'reasoning') req.progress('thinking');
            if (item.type === 'agent_message') req.progress('responding');
          } catch {
            // The complete output is validated after the process exits.
          }
        }
      });
      child.stdin?.end(req.user);
    });
    let answer: string | undefined;
    for (const line of output.split(/\r?\n/).filter(Boolean)) {
      const event: unknown = JSON.parse(line);
      if (typeof event !== 'object' || event === null || !('type' in event)) continue;
      if (event.type === 'turn.failed' && 'error' in event) {
        throw new Error(JSON.stringify(event.error));
      }
      if (event.type !== 'item.completed' || !('item' in event)) continue;
      const item = event.item;
      if (typeof item === 'object' && item !== null && 'type' in item && item.type === 'agent_message' && 'text' in item && typeof item.text === 'string') answer = item.text;
    }
    if (!answer) throw new Error('No assistant response');
    return JSON.parse(answer);
  } finally {
    await fs.unlink(schema).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    await fs.rmdir(dir);
  }
}

export async function askLocalAi(provider: AiProvider, req: Omit<ProviderRequest, 'apiKey'>): Promise<unknown> {
  req.signal.throwIfAborted();
  const executable = await findLocalAi(provider);
  const name = provider === 'claude' ? 'Claude Code' : 'Codex';
  if (!executable) throw new Error(`Install ${name}, sign in, and choose Check again, or use an API key.`);
  const cwd = await localAiWorkingDirectory();
  req.signal.throwIfAborted();
  const abort = new AbortController();
  const forwardAbort = () => abort.abort(req.signal.reason);
  req.signal.addEventListener('abort', forwardAbort, { once: true });
  if (req.signal.aborted) forwardAbort();
  try {
    if (provider === 'claude') {
      const env = await localClaudeEnvironment();
      req.signal.throwIfAborted();
      const response = query({
        prompt: req.user,
        options: {
          pathToClaudeCodeExecutable: executable,
          cwd,
          env: { ...env, ...(req.effort !== 'default' ? { CLAUDE_CODE_EFFORT_LEVEL: req.effort } : {}), CLAUDE_AGENT_SDK_CLIENT_APP: 'cleanly/0.1.1' },
          abortController: abort,
          systemPrompt: req.system,
          model: req.model,
          ...(req.effort !== 'default' ? { effort: req.effort, thinking: { type: 'adaptive' } } : {}),
          includePartialMessages: true,
          tools: [],
          allowedTools: [],
          canUseTool: async () => ({ behavior: 'deny', message: 'Cleanly supplies scan metadata only. Tools are disabled.' }),
          permissionMode: 'dontAsk',
          settingSources: [],
          settings: { disableAllHooks: true },
          plugins: [],
          skills: [],
          mcpServers: {},
          extraArgs: { 'strict-mcp-config': null },
          persistSession: false,
          maxTurns: 2,
          outputFormat: { type: 'json_schema', schema: ADVICE_SCHEMA },
        },
      });
      const close = () => response.close();
      req.signal.addEventListener('abort', close, { once: true });
      if (req.signal.aborted) close();
      try {
        for await (const message of response) {
          req.signal.throwIfAborted();
          if (message.type === 'system' && message.subtype === 'init') req.progress('waiting');
          if (message.type === 'stream_event' && message.event.type === 'content_block_start') {
            if (message.event.content_block.type === 'thinking') req.progress('thinking');
            if (message.event.content_block.type === 'text') req.progress('responding');
          }
          if (message.type === 'result') {
            if (message.subtype !== 'success') throw new Error(message.subtype);
            if (message.is_error) throw new Error(message.result);
            return message.structured_output ?? JSON.parse(message.result);
          }
        }
      } finally {
        req.signal.removeEventListener('abort', close);
        response.close();
      }
      throw new Error('No assistant response');
    }
    return await askCodex((await codexSdkRuntime()) ?? executable, cwd, req, abort.signal);
  } catch (error) {
    if (abort.signal.aborted) throw error;
    const message = error instanceof Error ? error.message : '';
    if (/rate.?limit|quota|budget|limit.exceeded|usage.limit|too many requests/i.test(message)) throw new Error(`${name} has reached an account limit. Try again later or choose another connection.`);
    if (/model.*(not found|not supported|not available|invalid|access|does not exist)/i.test(message)) throw new Error(`That model is not available through ${name}. Choose another model.`);
    if (/auth|login|sign.in|401|credential/i.test(message)) throw new Error(`Sign in to ${name} again, then choose Check again.`);
    throw new Error(`${name} could not answer. Check that it is up to date and signed in, or use an API key.`, { cause: error });
  } finally {
    req.signal.removeEventListener('abort', forwardAbort);
  }
}
