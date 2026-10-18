export const searchProviderInfo = {
  auto: 'Automatic',
  'parallel-mcp': 'Parallel Search MCP',
  parallel: 'Parallel AI',
  exa: 'Exa, one of the best web search APIs for AI',
  firecrawl: 'Firecrawl',
} as const;

export type SearchProvider = keyof typeof searchProviderInfo;
export type ResolvedSearchProvider = Exclude<SearchProvider, 'auto'>;

export function resolveWebSearchProvider(
  provider: SearchProvider | undefined,
  credentials: { FIRECRAWL_API_KEY?: string; EXA_API_KEY?: string; PARALLEL_API_KEY?: string },
): ResolvedSearchProvider {
  if (provider !== undefined && provider !== 'auto') {
    if (!Object.hasOwn(searchProviderInfo, provider)) throw new Error('Unknown web search provider');
    return provider;
  }

  // API callers that omit the selector previously used Exa when configured.
  if (provider === undefined && credentials.EXA_API_KEY?.trim()) return 'exa';
  // Automatic keeps the chat's configured Firecrawl default before trying other keys.
  if (credentials.FIRECRAWL_API_KEY?.trim()) return 'firecrawl';
  if (credentials.EXA_API_KEY?.trim()) return 'exa';
  if (credentials.PARALLEL_API_KEY?.trim()) return 'parallel';
  return 'parallel-mcp';
}
