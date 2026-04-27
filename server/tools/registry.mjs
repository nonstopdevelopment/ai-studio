import { toolPolicy } from './policy.mjs';
import { webFetch } from './web-fetch.mjs';
import { webSearch } from './web-search.mjs';

const toolDefinitions = [
  {
    name: 'time_now',
    title: 'Current time',
    description: 'Adds the current server time to the model context.',
    enabled: () => toolPolicy.enabled,
  },
  {
    name: 'web_search',
    title: 'Web search',
    description: 'Looks up current information through approved server-side search sources.',
    enabled: () => toolPolicy.enabled && toolPolicy.webSearchEnabled,
  },
  {
    name: 'web_fetch',
    title: 'URL fetch',
    description: 'Fetches HTTPS URLs included in the prompt through the gateway safety policy.',
    enabled: () => toolPolicy.enabled && toolPolicy.webFetchEnabled,
  },
];

export function getPublicTools() {
  return toolDefinitions.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    source: 'system',
    available: tool.enabled(),
  }));
}

export function normalizeEnabledTools(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const available = new Set(getPublicTools().filter((tool) => tool.available).map((tool) => tool.name));
  return [...new Set(value.map((tool) => String(tool)).filter((tool) => available.has(tool)))];
}

export async function buildToolContext({ prompt, enabledTools, signal, sourceHints = [] }) {
  const requestedTools = normalizeEnabledTools(enabledTools);
  const shouldFetchSourceHints = sourceHints.length > 0 && toolPolicy.webFetchEnabled;
  const enabled = shouldFetchSourceHints ? uniqueValues([...requestedTools, 'web_fetch']) : requestedTools;
  if (!toolPolicy.enabled || enabled.length === 0) {
    return { enabledTools: enabled, results: [], contextText: '' };
  }

  const results = [];

  if (enabled.includes('time_now')) {
    results.push({
      tool: 'time_now',
      ok: true,
      content: {
        iso: new Date().toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    });
  }

  if (enabled.includes('web_fetch')) {
    const urls = uniqueUrls([
      ...extractUrls(prompt),
      ...sourceHints.map((hint) => hint?.url).filter(Boolean),
    ]).slice(0, toolPolicy.maxUrlsPerRequest);
    for (const url of urls) {
      try {
        const content = await webFetch({ url, signal });
        results.push({
          tool: 'web_fetch',
          ok: true,
          content,
        });
        const nextUrl = pickLinkedArticleUrl(prompt, content, url);
        if (
          nextUrl &&
          !urls.includes(nextUrl) &&
          results.filter((result) => result.tool === 'web_fetch').length < toolPolicy.maxUrlsPerRequest
        ) {
          try {
            results.push({
              tool: 'web_fetch',
              ok: true,
              content: await webFetch({ url: nextUrl, signal }),
            });
          } catch (error) {
            results.push({
              tool: 'web_fetch',
              ok: false,
              content: {
                url: nextUrl,
                error: error.publicCode || 'tool_failed',
                message: error.publicMessage || 'The linked page could not be fetched.',
              },
            });
          }
        }
      } catch (error) {
        results.push({
          tool: 'web_fetch',
          ok: false,
          content: {
            url,
            error: error.publicCode || 'tool_failed',
            message: error.publicMessage || 'The tool could not fetch this URL.',
          },
        });
      }
    }
  }

  if (enabled.includes('web_search') && sourceHints.length === 0) {
    try {
      results.push({
        tool: 'web_search',
        ok: true,
        content: await webSearch({ query: prompt, signal }),
      });
    } catch (error) {
      results.push({
        tool: 'web_search',
        ok: false,
        content: {
          query: prompt,
          error: error.publicCode || 'tool_failed',
          message: error.publicMessage || 'The search service could not complete this request.',
        },
      });
    }
  }

  return {
    enabledTools: enabled,
    results,
    contextText: formatToolContext(results),
  };
}

function extractUrls(text) {
  return [...String(text).matchAll(/https?:\/\/[^\s<>"')]+/g)].map((match) => match[0]);
}

function uniqueUrls(urls) {
  return [...new Set(urls.map((url) => String(url).trim()).filter(Boolean))];
}

function uniqueValues(values) {
  return [...new Set(values.map((value) => String(value)).filter(Boolean))];
}

function pickLinkedArticleUrl(prompt, fetchedContent, sourceUrl) {
  if (!/\b(summarize|summary|what.*about|post|article|story)\b/i.test(String(prompt))) {
    return null;
  }

  const sourceHost = getHost(sourceUrl);
  return (
    (fetchedContent.links ?? []).find((link) => {
      const host = getHost(link.url);
      return host && host !== sourceHost && !isUtilityLink(link);
    })?.url ?? null
  );
}

function getHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function isUtilityLink(link) {
  return /\b(login|sign in|comments|reply|hide|more|past|new|jobs|submit|guidelines|privacy|terms)\b/i.test(
    `${link.title} ${link.url}`
  );
}

function formatToolContext(results) {
  if (results.length === 0) {
    return '';
  }

  const blocks = results.map((result, index) => {
    if (result.tool === 'time_now') {
      return `[tool:${index + 1}] time_now\n${JSON.stringify(result.content, null, 2)}`;
    }

    if (result.tool === 'web_fetch' && result.ok) {
      return [
        `[tool:${index + 1}] web_fetch ${result.content.url}`,
        `status: ${result.content.status}`,
        result.content.title ? `title: ${result.content.title}` : '',
        result.content.text,
      ]
        .filter(Boolean)
        .join('\n');
    }

    if (result.tool === 'web_search' && result.ok) {
      return [
        `[tool:${index + 1}] web_search`,
        `query: ${result.content.query}`,
        result.content.source ? `source: ${result.content.source}` : '',
        result.content.sourceUrl ? `sourceUrl: ${result.content.sourceUrl}` : '',
        result.content.note ? `note: ${result.content.note}` : '',
        ...(result.content.results ?? []).map((item, itemIndex) =>
          [
            `${itemIndex + 1}. ${item.title}`,
            item.url ? `url: ${item.url}` : '',
            item.publishedAt ? `time: ${item.publishedAt}` : '',
            item.snippet ? `snippet: ${item.snippet}` : '',
          ]
            .filter(Boolean)
            .join('\n')
        ),
      ]
        .filter(Boolean)
        .join('\n');
    }

    return `[tool:${index + 1}] ${result.tool} failed\n${JSON.stringify(result.content, null, 2)}`;
  });

  return `Gateway tool context:\n\n${blocks.join('\n\n')}`;
}
