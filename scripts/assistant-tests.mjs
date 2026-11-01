import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';

const compiled = await build({
  stdin: { contents: `export * from './electron/services/localAi.ts';
    export * from './electron/services/settings.ts';
    export { askAi, cancelAi } from './electron/services/ai.ts';`, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{ name: 'isolated-assistant', setup(builder) {
    const sources = {
      electron: `export const app = { getPath: () => globalThis.aiFixture.data, getAppPath: () => globalThis.aiFixture.base };
        export const safeStorage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'test',
          encryptString: s => Buffer.from('encrypted:' + s), decryptString: b => b.toString().slice(10) };`,
      os: `export default { homedir: () => globalThis.aiFixture.home, tmpdir: () => globalThis.aiFixture.base };`,
      child: `export function execFile(file, args, options, callback) {
        const f = globalThis.aiFixture;
        f.processes.push({ file, args, options });
        const claude = /claude(?:\\.exe)?$/.test(file);
        if (!claude && args[0] === 'exec') {
          f.codex = { file, args, options };
          return { stdin: { on() {}, end(prompt) {
            f.prompt = prompt;
            callback(null, JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(f.advice) } }), '');
          } } };
        }
        if ((claude && args[1] === 'login') || (!claude && args.length === 1)) f.signedIn = true;
        if (f.brokenStatus) callback(new Error('status unavailable'), 'invalid output', '');
        else if (claude) callback(null, JSON.stringify({ loggedIn: f.signedIn, email: 'private@example.test', accessToken: 'do-not-return' }), '');
        else callback(f.signedIn ? null : new Error('signed out'), f.signedIn ? 'Logged in using ChatGPT' : 'Not logged in', '');
      }`,
      claude: `export function query(options) {
        const f = globalThis.aiFixture; f.claude = options;
        const generator = (async function* () {
          if (f.block) {
            f.started?.();
            await new Promise((resolve, reject) => {
              const signal = options.options.abortController.signal;
              if (signal.aborted) reject(new Error('aborted'));
              else signal.addEventListener('abort', () => f.ignoreAbort ? resolve() : reject(new Error('aborted')), { once: true });
            });
          }
          yield { type: 'system', subtype: 'init' };
          yield { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'thinking' } } };
          yield { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } };
          yield f.expired ? { type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate: OAuth session expired' }
            : { type: 'result', subtype: 'success', is_error: false, structured_output: f.advice, result: '' };
        })();
        generator.close = () => { f.closed = true; };
        return generator;
      }`,
      api: `export const askClaude = async req => { globalThis.aiFixture.apiRequest = req; return globalThis.aiFixture.advice; };
        export const askOpenAi = askClaude;`,
    };
    for (const [filter, key] of [
      [/^electron$/, 'electron'], [/^node:os$/, 'os'], [/^node:child_process$/, 'child'],
      [/^@anthropic-ai\/claude-agent-sdk\/core$/, 'claude'],
      [/\.\/aiProviders\/(claude|openai)$/, 'api'],
    ]) builder.onResolve({ filter }, () => ({ path: key, namespace: 'test' }));
    builder.onLoad({ filter: /.*/, namespace: 'test' }, ({ path: key }) => ({ contents: sources[key], loader: 'js' }));
  } }],
});
let sequence = 0;
const request = (patch = {}) => ({ id: `request-${sequence++}`, provider: 'claude', connection: 'local', model: 'claude-sonnet-5-5', effort: 'medium', ...patch });

async function fixture(t, installed = true) {
  const parent = await fs.realpath(os.tmpdir());
  const base = await fs.mkdtemp(path.join(parent, 'cleanly-assistant-'));
  const previous = { PATH: process.env.PATH, LOCALAPPDATA: process.env.LOCALAPPDATA };
  const bin = path.join(base, 'bin');
  await fs.mkdir(bin);
  process.env.PATH = bin;
  process.env.LOCALAPPDATA = path.join(base, 'local');
  const f = globalThis.aiFixture = { base, home: path.join(base, 'home'), data: path.join(base, 'data'),
    signedIn: true, processes: [], advice: { answer: 'Connected', suggestions: [] } };
  if (installed) for (const name of ['claude', 'codex']) {
    const file = path.join(bin, name + (process.platform === 'win32' ? '.exe' : ''));
    await fs.writeFile(file, 'fixture executable, never launched');
    await fs.chmod(file, 0o755);
  }
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    delete globalThis.aiFixture;
    assert.equal(path.dirname(base).toLowerCase(), parent.toLowerCase());
    assert.ok(path.basename(base).startsWith('cleanly-assistant-'));
    await fs.rm(base, { recursive: true, force: true });
  });
  const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}#${sequence++}`);
  return { f, api };
}

test('old automatic assistant preferences are discarded while other preferences remain', async (t) => {
  const { f, api } = await fixture(t);
  await fs.mkdir(f.data);
  await fs.writeFile(path.join(f.data, 'settings.json'), JSON.stringify({ aiProvider: 'chatgpt', background: 'grid' }));
  const settings = await api.getSettings();
  assert.equal(settings.background, 'grid');
  assert.equal(settings.aiProvider, undefined);
  assert.equal(settings.aiConnections, undefined);
});

test('each request requires an explicit provider, connection, and model', async (t) => {
  const { api, f } = await fixture(t);
  await assert.rejects(api.askAi('Explain the scan', {}), /Choose an assistant/);
  await assert.rejects(api.askAi('Explain the scan', {}, request({ connection: 'auto' })), /Choose an assistant/);
  await assert.rejects(api.askAi('Explain the scan', {}, request({ provider: 'unknown' })), /Choose an assistant/);
  await assert.rejects(api.askAi('Explain the scan', {}, request({ model: '' })), /Choose a model/);
  await assert.rejects(api.askAi('Explain the scan', {}, request({ model: '--help' })), /Choose a model/);
  await assert.rejects(api.askAi('Explain the scan', {}, request({ effort: undefined })), /thinking level/);
  await assert.rejects(api.askAi('Explain the scan', {}, request({ effort: 'unlimited' })), /thinking level/);
  await assert.rejects(api.askAi('Explain the scan', {}, request({ model: 'claude-sonnet-4-6', effort: 'xhigh' })), /thinking level/);
  assert.equal(f.claude, undefined);
});

test('local status reveals readiness without returning account credentials', async (t) => {
  const { api, f } = await fixture(t);
  assert.deepEqual(await api.getAiConnections(), {
    claude: { kind: 'ready', appName: 'Claude Code' }, chatgpt: { kind: 'ready', appName: 'Codex' },
  });
  assert.ok(f.processes.every((p) => p.options.windowsHide && !p.options.shell));
});

test('local requests omit API keys and Node injection options from their environment', async (t) => {
  const { api } = await fixture(t);
  const names = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE'];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  for (const name of names) process.env[name] = 'test-value';
  const env = api.localAiEnvironment();
  for (const name of names) assert.equal(env[name], undefined);
});

test('missing apps, signed-out sessions and unreadable status are distinct', async (t) => {
  const { api, f } = await fixture(t, false);
  assert.equal((await api.getAiConnections()).claude.kind, 'not-installed');
  const bin = process.env.PATH;
  for (const name of ['claude', 'codex']) {
    const file = path.join(bin, name + (process.platform === 'win32' ? '.exe' : ''));
    await fs.writeFile(file, 'fixture'); await fs.chmod(file, 0o755);
  }
  f.signedIn = false;
  assert.equal((await api.getAiConnections()).claude.kind, 'signed-out');
  assert.equal((await api.getAiConnections()).chatgpt.kind, 'signed-out');
  f.brokenStatus = true;
  assert.equal((await api.getAiConnections()).claude.kind, 'unavailable');
});

test('sign-in only invokes a known provider and rechecks its status', async (t) => {
  const { api, f } = await fixture(t);
  f.signedIn = false;
  await assert.rejects(api.signInAi('arbitrary command'), /Unknown assistant/);
  assert.equal((await api.signInAi('claude')).claude.kind, 'ready');
  assert.ok(f.processes.some((p) => p.args.join(' ') === 'auth login'));
});

test('Claude uses the chosen model and supplied metadata with tools disabled', async (t) => {
  const { api, f } = await fixture(t);
  const answer = await api.askAi('What can I remove?', { largeFiles: [{ path: path.join(f.home, 'movie.mp4'), size: 100, modified: 0 }], fileContents: 'never forward this' }, request());
  assert.equal(answer.answer, 'Connected');
  assert.equal(answer.model, 'claude-sonnet-5-5');
  assert.equal(f.claude.options.model, 'claude-sonnet-5-5');
  assert.equal(f.claude.options.effort, 'medium');
  assert.equal(f.claude.options.env.CLAUDE_CODE_EFFORT_LEVEL, 'medium');
  assert.equal(answer.effort, 'medium');
  assert.ok(f.claude.prompt.includes('movie.mp4'));
  assert.ok(!f.claude.prompt.includes('never forward this'));
  assert.ok(!f.claude.prompt.includes(f.home));
  assert.deepEqual(f.claude.options.tools, []);
  assert.deepEqual(f.claude.options.settingSources, []);
  assert.deepEqual(f.claude.options.mcpServers, {});
  assert.equal(f.claude.options.settings.disableAllHooks, true);
  assert.equal(f.claude.options.persistSession, false);
  assert.equal((await f.claude.options.canUseTool()).behavior, 'deny');
  assert.equal(f.closed, true);
});

test('Codex local mode disables command tools, web search, and inherited integrations', async (t) => {
  const { api, f } = await fixture(t);
  await api.askAi('Explain the scan', {}, request({ provider: 'chatgpt', model: 'gpt-6.1-sol' }));
  assert.equal(f.codex.args[f.codex.args.indexOf('--model') + 1], 'gpt-6.1-sol');
  assert.ok(f.codex.args.includes('model_reasoning_effort="medium"'));
  assert.ok(f.codex.args.includes('--ignore-user-config'));
  assert.ok(f.codex.args.includes('--ignore-rules'));
  assert.ok(f.codex.args.includes('--ephemeral'));
  assert.ok(f.codex.args.includes('features.shell_tool=false'));
  assert.ok(f.codex.args.includes('features.view_image=false'));
  assert.ok(f.codex.args.includes('features.image_generation=false'));
  assert.ok(f.codex.args.includes('features.hooks=false'));
  assert.ok(f.codex.args.includes('read-only'));
  assert.ok(f.codex.args.includes('web_search="disabled"'));
  assert.ok(f.codex.options.signal instanceof AbortSignal);
  assert.equal(f.codex.args.includes(f.prompt), false, 'The question is passed on stdin, not the command line');
});

test('the pinned Codex runtime ignores user configuration without moving the auth home', async (t) => {
  const { f } = await fixture(t);
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const target = process.platform === 'win32' ? (arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc')
    : process.platform === 'darwin' ? (arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin')
    : (arch === 'arm64' ? 'aarch64-unknown-linux-musl' : 'x86_64-unknown-linux-musl');
  const cli = path.resolve('node_modules', '@openai', `codex-${process.platform}-${arch}`, 'vendor', target, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
  const configHome = path.join(f.base, 'codex-home');
  await fs.mkdir(configHome);
  await fs.writeFile(path.join(configHome, 'config.toml'), '[mcp_servers.invalid\n');
  const args = ['exec', '--skip-git-repo-check', '--json', '-c', 'model_provider="cleanly-isolation-fixture"', 'Fixture question'];
  const run = promisify(execFile);
  const output = async (flags) => {
    try { return (await run(cli, flags, { env: { ...process.env, CODEX_HOME: configHome }, windowsHide: true, timeout: 15000 })).stdout; }
    catch (error) { return String(error.stderr || error.stdout || error.message); }
  };
  assert.match(await output(args), /Error loading config.toml/);
  assert.match(await output([...args, '--ignore-user-config', '--ignore-rules', '--ephemeral']), /cleanly-isolation-fixture.*not found/i);
});

test('a saved key never selects a connection or overrides a local choice', async (t) => {
  const { api, f } = await fixture(t);
  await api.setApiKey('claude', 'sk-test-not-a-real-api-key-1234567890');
  await assert.rejects(api.askAi('Explain the scan', {}), /Choose an assistant/);
  await api.askAi('Explain the scan', {}, request({ connection: 'api' }));
  assert.equal(f.apiRequest.apiKey, 'sk-test-not-a-real-api-key-1234567890');
  assert.equal(f.apiRequest.model, 'claude-sonnet-5-5');
  assert.equal(f.apiRequest.effort, 'medium');
  assert.equal(f.claude, undefined);
  await api.askAi('Explain the scan', {}, request());
  assert.ok(f.claude);
});

test('expired local sessions show a sign-in instruction without falling back to API billing', async (t) => {
  const { api, f } = await fixture(t);
  f.expired = true;
  await assert.rejects(api.askAi('Explain the scan', {}, request()), /Sign in to Claude Code again/);
  assert.equal(f.apiRequest, undefined);
});

test('an API selection without a key asks for a connection instead of using local login', async (t) => {
  const { api, f } = await fixture(t);
  await assert.rejects(api.askAi('Explain the scan', {}, request({ connection: 'api' })), /Add an API key/);
  assert.equal(f.claude, undefined);
});

test('unknown paths suggested as safe are downgraded to review in both transports', async (t) => {
  const { api, f } = await fixture(t);
  f.advice.suggestions = [{ path: 'C:\\unknown\\important.txt', verdict: 'safe', reason: 'Unverified' }];
  const advice = await api.askAi('Explain the scan', {}, request());
  assert.equal(advice.suggestions[0].verdict, 'review');
  await api.setApiKey('claude', 'sk-test-not-a-real-api-key-1234567890');
  const apiAdvice = await api.askAi('Explain the scan', {}, request({ connection: 'api' }));
  assert.equal(apiAdvice.suggestions[0].verdict, 'review');
});

test('Claude reuses only the configured connection values without loading user instructions or hooks', async (t) => {
  const { api, f } = await fixture(t);
  await fs.mkdir(path.join(f.home, '.claude'), { recursive: true });
  await fs.writeFile(path.join(f.home, '.claude', 'settings.json'), JSON.stringify({
    env: { ANTHROPIC_BASE_URL: 'https://claude.example.test', ANTHROPIC_AUTH_TOKEN: 'fixture-auth-token', NODE_OPTIONS: 'do-not-forward', UNRELATED_SECRET: 'do-not-forward' },
    hooks: { SessionStart: ['do-not-run'] }, enabledPlugins: { 'do-not-load': true },
  }));
  await api.askAi('Explain the scan', {}, request());
  assert.equal(f.claude.options.env.ANTHROPIC_BASE_URL, 'https://claude.example.test');
  assert.equal(f.claude.options.env.ANTHROPIC_AUTH_TOKEN, 'fixture-auth-token');
  assert.equal(f.claude.options.env.NODE_OPTIONS, undefined);
  assert.equal(f.claude.options.env.UNRELATED_SECRET, undefined);
  assert.equal(f.claude.options.env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
  assert.deepEqual(f.claude.options.settingSources, []);
  assert.equal(f.claude.options.settings.disableAllHooks, true);
});

test('progress reports only stages for the matching request', async (t) => {
  const { api } = await fixture(t);
  const selected = request();
  const events = [];
  await api.askAi('Explain the scan', {}, selected, (event) => events.push(event));
  assert.deepEqual(events.map((event) => event.stage), ['connecting', 'waiting', 'thinking', 'responding']);
  assert.ok(events.every((event) => event.requestId === selected.id && Object.keys(event).length === 2));
});

test('a configured Claude service does not require a separate subscription login', async (t) => {
  const { api, f } = await fixture(t);
  f.signedIn = false;
  await fs.mkdir(path.join(f.home, '.claude'), { recursive: true });
  await fs.writeFile(path.join(f.home, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'fixture-auth-token' } }));
  assert.equal((await api.getAiConnections()).claude.kind, 'ready');
  assert.equal((await api.askAi('Explain the scan', {}, request())).answer, 'Connected');
});

test('cancelling a pending request stops the provider and releases the request ID', async (t) => {
  const { api, f } = await fixture(t);
  f.block = true;
  const selected = request();
  const started = new Promise((resolve) => { f.started = resolve; });
  const pending = api.askAi('Explain the scan', {}, selected);
  await started;
  await assert.rejects(api.askAi('Explain the scan', {}, selected), /duplicate assistant request/);
  await api.cancelAi(selected.id);
  await assert.rejects(pending, /Request cancelled/);
  assert.equal(f.closed, true);
  f.block = false;
  assert.equal((await api.askAi('Explain the scan', {}, selected)).answer, 'Connected');
});

test('a provider reply arriving after cancellation is discarded', async (t) => {
  const { api, f } = await fixture(t);
  f.block = true; f.ignoreAbort = true;
  const selected = request();
  const started = new Promise(resolve => { f.started = resolve; });
  const pending = api.askAi('Explain the scan', {}, selected);
  await started;
  await api.cancelAi(selected.id);
  await assert.rejects(pending, /Request cancelled/);
});

test('thinking level changes reach each installed provider and appear in the returned advice', async (t) => {
  const { api, f } = await fixture(t);
  const advice = await api.askAi('Explain the scan', {}, request({ effort: 'high' }));
  assert.equal(advice.effort, 'high');
  assert.equal(f.claude.options.effort, 'high');
  assert.equal(f.claude.options.thinking.type, 'adaptive');
  await api.askAi('Explain the scan', {}, request({ provider: 'chatgpt', model: 'gpt-6.1-sol', effort: 'xhigh' }));
  assert.ok(f.codex.args.includes('model_reasoning_effort="xhigh"'));
});

test('choosing the model default does not force a thinking level', async (t) => {
  const { api, f } = await fixture(t);
  await api.askAi('Explain the scan', {}, request({ effort: 'default' }));
  assert.equal(f.claude.options.effort, undefined);
  assert.equal(f.claude.options.thinking, undefined);
  await api.askAi('Explain the scan', {}, request({ provider: 'chatgpt', model: 'gpt-6.1-sol', effort: 'default' }));
  assert.equal(f.codex.args.some(arg => arg.startsWith('model_reasoning_effort=')), false);
});
