import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const root = fileURLToPath(new URL('../../', import.meta.url));
for (const [, key] of readFileSync(`${root}/env/server.ts`, 'utf8').matchAll(/(\w+): z\.string\(\)\.min\(1\)/g)) {
  process.env[key] = 'unused-test-fixture';
}
for (const key of ['EXA_API_KEY', 'FIRECRAWL_API_KEY', 'PARALLEL_API_KEY']) delete process.env[key];
const provider = process.argv[2];
const selection = process.argv[3] === 'explicit' ? provider : 'auto';
if (selection === provider) {
  // Saved provider choices still win when all provider keys are set.
  process.env.EXA_API_KEY = 'test-exa';
  process.env.FIRECRAWL_API_KEY = 'test-firecrawl';
  process.env.PARALLEL_API_KEY = 'test-parallel';
} else {
  process.env[`${provider.toUpperCase()}_API_KEY`] = 'test-configured';
}
process.env.NODE_ENV = 'test';
const jiti = createJiti(import.meta.url, {
  alias: { '@': root, 'server-only': fileURLToPath(import.meta.resolve('server-only')) },
});
const calls = [];
const webCalls = [];
const fail = process.argv[4] === 'error';
const { default: FirecrawlApp } = await jiti.import('@mendable/firecrawl-js');
const { default: Exa } = await jiti.import('exa-js');
const { default: Parallel } = await jiti.import('parallel-web');
// Incumbent SDK fixtures prove selection without making requests with fake keys.
FirecrawlApp.prototype.search = async (_query, options = {}) => {
  if (options.sources?.some((source) => source === 'web' || source === 'news')) webCalls.push('firecrawl');
  calls.push('firecrawl');
  if (fail) throw new Error('Configured provider fixture failure');
  return {
    web: [{ url: 'https://example.com/firecrawl', title: 'Configured Firecrawl', description: 'source' }],
    images: [],
  };
};
Exa.prototype.search = async () => {
  calls.push('exa');
  webCalls.push('exa');
  if (fail) throw new Error('Configured provider fixture failure');
  return { results: [{ url: 'https://example.com/exa', title: 'Configured Exa', highlights: ['source'] }] };
};
Parallel.prototype.post = async () => {
  calls.push('parallel');
  webCalls.push('parallel');
  if (fail) throw new Error('Configured provider fixture failure');
  return { results: [{ url: 'https://example.com/parallel', title: 'Configured Parallel', excerpts: ['source'] }] };
};
globalThis.fetch = async () => {
  throw new Error('Unexpected MCP/network request for configured provider');
};
const { loadConfiguredTools } = await jiti.import(`${root}/lib/search/tool-loader.ts`);
const tools = await loadConfiguredTools({
  activeToolNames: ['web_search'],
  searchProvider: selection,
  contextFiles: [],
  includeMcpTools: false,
  mcpDynamicTools: {},
  lightweightUser: null,
});
const result = await tools.web_search.execute(
  { queries: ['one', 'two', 'three'] },
  { toolCallId: 'configured-test', messages: [] },
);
assert.ok(calls.includes(provider), `${selection} selected ${provider}`);
if (fail) assert.ok(result.searches.every((search) => search.results.length === 0));
else assert.equal(result.searches[0].results[0].url, `https://example.com/${provider}`);

assert.deepEqual([...new Set(webCalls)], [provider], 'an explicit provider must not silently fall back');
