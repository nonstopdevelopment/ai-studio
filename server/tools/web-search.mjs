import { toolPolicy } from './policy.mjs';

export async function webSearch({ query, signal }) {
  const normalizedQuery = String(query ?? '').trim();
  if (!normalizedQuery) {
    return { query: normalizedQuery, results: [] };
  }

  if (toolPolicy.searxngBaseUrl) {
    return searchSearxng(normalizedQuery, signal);
  }

  return {
    query: normalizedQuery,
    results: [],
    note: 'No local SearXNG search service is configured for general web search.',
  };
}

async function searchSearxng(query, signal) {
  const url = new URL('/search', toolPolicy.searxngBaseUrl);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');

  const response = await fetch(url, {
    signal,
    headers: {
      accept: 'application/json',
      'user-agent': 'TampaDevsAIStudio/0.1 (+https://tampa.dev)',
    },
  });

  if (!response.ok) {
    return {
      query,
      source: 'SearXNG',
      sourceUrl: url.toString(),
      results: [],
      note: `SearXNG returned HTTP ${response.status}.`,
    };
  }

  const body = await response.json();
  return {
    query,
    source: 'SearXNG',
    sourceUrl: url.toString(),
    results: (body.results ?? []).slice(0, toolPolicy.maxSearchResults).map((result) => ({
      title: String(result.title ?? result.url ?? 'Untitled result'),
      url: String(result.url ?? ''),
      snippet: String(result.content ?? result.snippet ?? ''),
      publishedAt: result.publishedDate ?? result.published_at ?? null,
    })),
  };
}
