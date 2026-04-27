import { toolPolicy } from './policy.mjs';

export async function webSearch({ query, signal }) {
  const normalizedQuery = String(query ?? '').trim();
  if (!normalizedQuery) {
    return { query: normalizedQuery, results: [] };
  }

  const mlbSchedule = await maybeSearchMlbSchedule(normalizedQuery, signal);
  if (mlbSchedule) {
    return mlbSchedule;
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

async function maybeSearchMlbSchedule(query, signal) {
  if (!/\b(mlb|baseball)\b/i.test(query) || !/\b(today|tonight|games?|schedule|play)\b/i.test(query)) {
    return null;
  }

  const date = getEasternDate();
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}`;
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
      source: 'MLB Stats API',
      sourceUrl: url,
      results: [],
      note: `MLB schedule lookup returned HTTP ${response.status}.`,
    };
  }

  const body = await response.json();
  const games = (body.dates?.[0]?.games ?? []).map((game) => ({
    title: `${game.teams?.away?.team?.name ?? 'Away'} at ${game.teams?.home?.team?.name ?? 'Home'}`,
    url: `https://www.mlb.com/gameday/${game.gamePk}`,
    publishedAt: game.gameDate,
    snippet: [
      `Status: ${game.status?.detailedState ?? 'Scheduled'}`,
      game.venue?.name ? `Venue: ${game.venue.name}` : '',
    ]
      .filter(Boolean)
      .join('. '),
  }));

  return {
    query,
    source: 'MLB Stats API',
    sourceUrl: url,
    date,
    results: games,
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

function getEasternDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
