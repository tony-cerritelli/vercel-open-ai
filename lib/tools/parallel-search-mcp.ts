import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import { z } from 'zod';

const SEARCH_URL = 'https://search.parallel.ai/mcp';
const USER_AGENT = 'Scira/0.1.0 (+https://github.com/tony-cerritelli/vercel-open-ai)';
const SEARCH_TIMEOUT_MS = 20_000;

const mcpResponseSchema = z.object({
  isError: z.boolean().optional(),
  structuredContent: z.unknown().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});

const searchResponseSchema = z.object({
  results: z.array(
    z.object({
      url: z.url().refine((url) => ['http:', 'https:'].includes(new URL(url).protocol)),
      title: z.string().nullable().optional(),
      excerpts: z.array(z.string()),
      publish_date: z.string().nullable().optional(),
    }),
  ),
});

// Race initialization too: the SDK only accepts an AbortSignal after connecting.
// A client that finishes connecting after cancellation is closed by the caller below.
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export async function parallelMcpSearch({
  queries,
  maxResults,
  startDates,
  topics,
  abortSignal,
  sessionId,
}: {
  queries: string[];
  maxResults?: (number | undefined)[];
  startDates?: (string | null | undefined)[];
  topics?: ('general' | 'news' | undefined)[];
  abortSignal?: AbortSignal;
  sessionId?: string;
}) {
  const signal = AbortSignal.any([AbortSignal.timeout(SEARCH_TIMEOUT_MS), ...(abortSignal ? [abortSignal] : [])]);
  signal.throwIfAborted();
  let client: MCPClient | undefined;
  let closing: Promise<void> | undefined;
  const closeClient = () => (client ? (closing ??= client.close()) : Promise.resolve());
  const onAbort = () => void closeClient().catch(() => {});
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    const connectedClient = await abortable<MCPClient>(
      createMCPClient({
        name: 'scira',
        version: '0.1.0',
        transport: { type: 'http', url: SEARCH_URL, headers: { 'User-Agent': USER_AGENT } },
      }).then(async (connected) => {
        if (signal.aborted) {
          await connected.close();
          signal.throwIfAborted();
        }
        return connected;
      }),
      signal,
    );
    client = connectedClient;
    const definitions = await connectedClient.listTools({ options: { signal } });
    const tools = connectedClient.toolsFromDefinitions(definitions);
    if (!tools.web_search) throw new Error('Parallel Search MCP did not advertise web_search');

    const dateHints = startDates?.filter((date): date is string => Boolean(date)) ?? [];
    const objective = [
      queries.join('; '),
      ...(topics?.includes('news') ? ['Prefer news sources.'] : []),
      ...(dateHints.length ? [`Prefer sources published after: ${dateHints.join(', ')}.`] : []),
    ].join(' ');
    const response = mcpResponseSchema.parse(
      await tools.web_search.execute(
        {
          objective,
          search_queries: queries,
          ...(sessionId ? { session_id: sessionId.slice(0, 100) } : {}),
        },
        { toolCallId: 'scira-web-search', messages: [], abortSignal: signal },
      ),
    );
    if (response.isError) {
      const message = response.content
        .flatMap((part) => (part.type === 'text' && part.text ? [part.text] : []))
        .join('\n');
      throw new Error(`Parallel Search MCP search failed: ${message.slice(0, 500) || 'Please retry later.'}`);
    }
    const payload =
      response.structuredContent ??
      JSON.parse(response.content.flatMap((part) => (part.type === 'text' && part.text ? [part.text] : [])).join('\n'));
    const parsed = searchResponseSchema.parse(payload);
    const limit = Math.min(20, Math.max(1, ...(maxResults ?? [10]).map((value) => value ?? 10)));
    const seen = new Set<string>();
    const results = parsed.results
      .filter(({ url }) => {
        if (seen.has(url)) return false;
        seen.add(url);
        return true;
      })
      .slice(0, limit)
      .map((result) => ({
        url: result.url,
        title: result.title || new URL(result.url).hostname,
        content: result.excerpts.join('\n').slice(0, 5000),
        published_date: result.publish_date || undefined,
        author: undefined,
      }));

    // Parallel batches related queries into one result set; the UI accepts grouped searches.
    return { searches: [{ query: queries.join('; '), results, images: [] }] };
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
    await abortable(closeClient(), signal);
  }
}
