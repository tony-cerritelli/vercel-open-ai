import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createJiti } from 'jiti';

const root = fileURLToPath(new URL('../', import.meta.url));
// Isolate real credentials. Unused application services get local fixture values.
for (const [, key] of readFileSync(`${root}/env/server.ts`, 'utf8').matchAll(/(\w+): z\.string\(\)\.min\(1\)/g)) {
  process.env[key] = 'unused-test-fixture';
}
const searchKeys = ['EXA_API_KEY', 'FIRECRAWL_API_KEY', 'PARALLEL_API_KEY'];
for (const key of searchKeys) delete process.env[key];
process.env.NODE_ENV = 'test';
const jiti = createJiti(import.meta.url, {
  alias: { '@': root, 'server-only': fileURLToPath(import.meta.resolve('server-only')) },
  moduleCache: false,
});
const { resolveWebSearchProvider } = await jiti.import(`${root}/lib/search/web-search-provider.ts`);
const { loadConfiguredTools } = await jiti.import(`${root}/lib/search/tool-loader.ts`);
const queries = ['Node.js release schedule', 'Node.js supported releases', 'Node.js LTS versions'];
const args = { queries, maxResults: [5], topics: ['news'], startDates: ['2026-01-01'] };
const executeOptions = { toolCallId: 'test-web-search', messages: [] };

async function load(searchProvider, activeToolNames = ['web_search'], events = []) {
  return loadConfiguredTools({
    activeToolNames,
    dataStream: { write: (event) => events.push(event) },
    searchProvider,
    searchSessionId: '0c843488-faf3-4057-ad38-9c94b95495b1',
    contextFiles: [],
    includeMcpTools: false,
    mcpDynamicTools: {},
    lightweightUser: null,
  });
}

function installMcp(t, { payload, isError = false, textOnly = false, hang, status = 200 } = {}) {
  const requests = [];
  const pending = [];
  const responsePayload = payload ?? {
    results: [
      {
        url: 'https://nodejs.org/en/about/previous-releases',
        title: 'Node.js releases',
        excerpts: ['LTS schedule'],
        publish_date: '2026-01-02',
      },
      { url: 'https://nodejs.org/en/about/previous-releases', title: 'Duplicate', excerpts: ['duplicate'] },
      { url: 'http://example.org/source', title: null, excerpts: ['Second source'] },
    ],
  };
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const headers = new Headers(init.headers);
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ url: String(url), method: init.method, headers, body });
    assert.equal(String(url), 'https://search.parallel.ai/mcp');
    assert.match(headers.get('user-agent'), /Scira\/0\.1\.0/);
    assert.equal(headers.get('authorization'), null);
    if (init.method === 'GET') return new Response(null, { status: 405 });
    if (init.method === 'DELETE' || (!body?.id && body?.id !== 0)) return new Response(null, { status: 202 });
    if (body.method === hang) {
      return new Promise((resolve, reject) => {
        pending.push({ resolve, body });
        init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      });
    }
    if (body.method === 'tools/call' && status !== 200) return new Response('Search unavailable', { status });
    let result;
    switch (body.method) {
      case 'initialize':
        result = {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'test-parallel', version: '1' },
        };
        break;
      case 'tools/list':
        result = { tools: [{ name: 'web_search', inputSchema: { type: 'object', properties: {}, required: [] } }] };
        break;
      case 'tools/call':
        assert.equal(body.params.name, 'web_search');
        result = {
          content: [{ type: 'text', text: JSON.stringify(responsePayload) }],
          isError,
          ...(!textOnly ? { structuredContent: responsePayload } : {}),
        };
        break;
      default:
        throw new Error(`Unexpected RPC method: ${body.method}`);
    }
    return Response.json({ jsonrpc: '2.0', id: body.id, result });
  });
  return { requests, pending };
}

await test('provider selection preserves explicit choices and configured keys', () => {
  assert.equal(resolveWebSearchProvider(undefined, {}), 'parallel-mcp');
  assert.equal(resolveWebSearchProvider(undefined, { EXA_API_KEY: 'exa', FIRECRAWL_API_KEY: 'firecrawl' }), 'exa');
  assert.equal(resolveWebSearchProvider('auto', { FIRECRAWL_API_KEY: '' }), 'parallel-mcp');
  assert.equal(resolveWebSearchProvider('auto', { EXA_API_KEY: 'exa' }), 'exa');
  assert.equal(resolveWebSearchProvider('auto', { PARALLEL_API_KEY: 'parallel' }), 'parallel');
  assert.equal(resolveWebSearchProvider('auto', { EXA_API_KEY: 'exa', FIRECRAWL_API_KEY: 'firecrawl' }), 'firecrawl');
  for (const provider of ['exa', 'parallel', 'firecrawl', 'parallel-mcp']) {
    assert.equal(resolveWebSearchProvider(provider, { FIRECRAWL_API_KEY: 'configured' }), provider);
  }
  assert.throws(() => resolveWebSearchProvider('unknown', {}), /Unknown/);
});

await test('fresh no-key dispatcher executes MCP and returns UI/model source data', async (t) => {
  const { requests } = installMcp(t);
  const events = [];
  const { web_search } = await load(undefined, undefined, events);
  const result = await web_search.execute(args, executeOptions);
  assert.deepEqual(result.searches[0].images, []);
  assert.equal(result.searches[0].results.length, 2);
  assert.equal(result.searches[0].results[0].content, 'LTS schedule');
  assert.equal(result.searches[0].results[0].published_date, '2026-01-02');
  assert.equal(result.searches[0].results[1].title, 'example.org');
  // MultiSearch consumes searches[].results[].url/title/content and grouped query labels.
  assert.equal(result.searches[0].query, queries.join('; '));
  for (const source of result.searches[0].results) assert.match(source.url, /^https?:\/\//);
  assert.deepEqual(
    events.map((event) => event.data.status),
    ['started', 'completed'],
  );
  const call = requests.find((request) => request.body?.method === 'tools/call');
  assert.deepEqual(call.body.params.arguments.search_queries, queries);
  assert.match(call.body.params.arguments.objective, /2026-01-01/);
  assert.match(call.body.params.arguments.objective, /Prefer news/);
  assert.equal(call.body.params.arguments.session_id, '0c843488-faf3-4057-ad38-9c94b95495b1');
  assert.ok(requests.some((request) => request.body?.method === 'tools/list'));
});

await test('explicit MCP selection supports JSON text responses', async (t) => {
  installMcp(t, { textOnly: true });
  const { web_search } = await load('parallel-mcp');
  assert.equal((await web_search.execute(args, executeOptions)).searches[0].results.length, 2);
});

await test('disabled web search and chat tool set make no MCP requests', async (t) => {
  const { requests } = installMcp(t);
  assert.deepEqual(await load('parallel-mcp', []), {});
  assert.deepEqual(await load('parallel-mcp', ['not_an_allowed_tool']), {});
  assert.equal(requests.length, 0);
});

await test('saved API choices without credentials fail instead of using MCP', async (t) => {
  const { requests } = installMcp(t);
  for (const provider of ['exa', 'firecrawl', 'parallel']) {
    const { web_search } = await load(provider);
    await assert.rejects(() => web_search.execute(args, executeOptions), /requires .*API_KEY/);
  }
  assert.equal(requests.length, 0);
});

for (const [name, options] of [
  ['unsafe source URLs', { payload: { results: [{ url: 'javascript:alert(1)', excerpts: ['unsafe'] }] } }],
  ['malformed results', { payload: { results: [{ url: 'https://example.org', excerpts: 'invalid' }] } }],
  ['MCP tool errors', { isError: true }],
  ['transport failures', { status: 503 }],
]) {
  await test(`${name} propagate and mark search as failed`, async (t) => {
    installMcp(t, options);
    const events = [];
    const { web_search } = await load('parallel-mcp', undefined, events);
    await assert.rejects(() => web_search.execute(args, executeOptions));
    assert.equal(events.at(-1).data.status, 'error');
  });
}

await test('empty MCP results stay empty without a paid fallback', async (t) => {
  installMcp(t, { payload: { results: [] } });
  const { web_search } = await load('parallel-mcp');
  assert.deepEqual((await web_search.execute(args, executeOptions)).searches[0].results, []);
});

await test('cancellation propagates through the dispatcher', async (t) => {
  const { pending } = installMcp(t, { hang: 'tools/call' });
  const controller = new AbortController();
  const { web_search } = await load('parallel-mcp');
  const operation = web_search.execute(args, { ...executeOptions, abortSignal: controller.signal });
  while (!pending.length) await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error('user cancelled'));
  await assert.rejects(() => operation, /cancel|closed|abort/i);
});

await test('a pre-aborted call makes no requests', async (t) => {
  const { requests } = installMcp(t);
  const { web_search } = await load('parallel-mcp');
  await assert.rejects(
    () => web_search.execute(args, { ...executeOptions, abortSignal: AbortSignal.abort(new Error('cancelled')) }),
    /cancelled/,
  );
  assert.equal(requests.length, 0);
});

await test('the deadline covers initialization and closes a late connection', async (t) => {
  const { pending, requests } = installMcp(t, { hang: 'initialize' });
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', (ms) => {
    assert.equal(ms, 20_000);
    return originalTimeout(15);
  });
  const { web_search } = await load('parallel-mcp');
  // Keep a referenced handle while the unref'ed AbortSignal timeout is pending.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(() => web_search.execute(args, executeOptions), /timeout/i);
    const init = pending[0];
    init.resolve(
      Response.json({
        jsonrpc: '2.0',
        id: init.body.id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'late', version: '1' },
        },
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.filter((request) => request.body?.method === 'tools/call').length, 0);
  } finally {
    clearTimeout(keepAlive);
  }
});

await test('scripted AI SDK agent consumes search results on its next step', async (t) => {
  installMcp(t);
  const { generateText, stepCountIs } = await import('ai');
  const { MockLanguageModelV3 } = await import('ai/test');
  const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };
  let calls = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async ({ prompt }) => {
      if (calls++ === 0) {
        return {
          content: [
            { type: 'tool-call', toolCallId: 'agent-search', toolName: 'web_search', input: JSON.stringify(args) },
          ],
          finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
          usage,
          warnings: [],
        };
      }
      const toolMessage = prompt.find((message) => message.role === 'tool');
      assert.ok(toolMessage, 'agent loop received a tool-result message');
      const source = toolMessage.content[0].output.value.searches[0].results[0];
      assert.equal(source.content, 'LTS schedule');
      return {
        content: [{ type: 'text', text: `Release schedule: ${source.url}` }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage,
        warnings: [],
      };
    },
  });
  const result = await generateText({
    model,
    tools: await load(undefined),
    prompt: 'Find the Node.js release schedule.',
    stopWhen: stepCountIs(2),
  });
  assert.equal(result.steps.length, 2);
  assert.match(result.text, /https:\/\/nodejs.org\/en\/about\/previous-releases/);
});

for (const phase of ['tools/list', 'tools/call']) {
  await test(`deadline aborts a stalled ${phase}`, async (t) => {
    installMcp(t, { hang: phase });
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    t.mock.method(AbortSignal, 'timeout', () => originalTimeout(15));
    const { web_search } = await load('parallel-mcp');
    const keepAlive = setTimeout(() => {}, 1000);
    try {
      await assert.rejects(() => web_search.execute(args, executeOptions), /timeout/i);
    } finally {
      clearTimeout(keepAlive);
    }
  });
}

await test('configured keys and saved API selections use the incumbent SDKs', async () => {
  const { execFileSync } = await import('node:child_process');
  for (const provider of ['exa', 'firecrawl', 'parallel']) {
    for (const selection of ['auto', 'explicit']) {
      execFileSync(
        process.execPath,
        ['--conditions=react-server', `${root}/tests/fixtures/configured-web-search.mjs`, provider, selection],
        { stdio: 'pipe' },
      );
    }
  }
});

await test('configured provider errors preserve explicit choices and never use anonymous MCP', async () => {
  const { execFileSync } = await import('node:child_process');
  for (const provider of ['exa', 'firecrawl', 'parallel']) {
    for (const selection of ['auto', 'explicit']) {
      execFileSync(
        process.execPath,
        ['--conditions=react-server', `${root}/tests/fixtures/configured-web-search.mjs`, provider, selection, 'error'],
        { stdio: 'pipe' },
      );
    }
  }
});

await test('the complete Web-mode tool set loads without Web-provider credentials', async (t) => {
  installMcp(t);
  // Read the maintained mode's actual tool names without importing its database-backed config helper.
  const groupConfig = readFileSync(`${root}/lib/search/group-config.ts`, 'utf8');
  const webList = groupConfig.match(/\bweb: \[([\s\S]*?)\] as const/)[1];
  const webToolNames = [...webList.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.ok(webToolNames.includes('retrieve'));
  const tools = await load(undefined, webToolNames);
  assert.ok(tools.retrieve);
  const result = await tools.web_search.execute(args, executeOptions);
  assert.equal(result.searches[0].results[0].content, 'LTS schedule');
});

await test('code context without Exa credentials fails before requesting its API', async (t) => {
  const { requests } = installMcp(t);
  const tools = await load(undefined, ['code_context']);
  await assert.rejects(() => tools.code_context.execute({ query: 'Node.js' }, executeOptions), /requires EXA_API_KEY/);
  assert.equal(requests.length, 0);
});
