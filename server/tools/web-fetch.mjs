import { assertSafeFetchUrl, publicToolError, toolPolicy } from './policy.mjs';

const textContentTypes = [
  'application/json',
  'application/rss+xml',
  'application/xml',
  'text/html',
  'text/markdown',
  'text/plain',
  'text/xml',
];

export async function webFetch({ url, signal }) {
  let currentUrl = await assertSafeFetchUrl(url);
  const visited = [];

  for (let redirectCount = 0; redirectCount <= toolPolicy.maxRedirects; redirectCount += 1) {
    visited.push(currentUrl.toString());
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), toolPolicy.fetchTimeoutMs);
    const abortListener = () => controller.abort();
    signal?.addEventListener('abort', abortListener, { once: true });

    try {
      const response = await fetch(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          accept: 'text/html, text/plain, application/json, application/xml;q=0.8, */*;q=0.1',
          'user-agent': 'TampaDevsAIStudio/0.1 (+https://tampa.dev)',
        },
      });

      if (isRedirect(response.status)) {
        const location = response.headers.get('location');
        if (!location) {
          throw publicToolError('redirect_without_location', 'The page redirected without a target URL.');
        }
        currentUrl = await assertSafeFetchUrl(new URL(location, currentUrl).toString());
        continue;
      }

      const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || '';
      if (!textContentTypes.includes(contentType)) {
        throw publicToolError('blocked_content_type', `The page returned unsupported content type: ${contentType || 'unknown'}.`);
      }

      const rawText = await readLimitedText(response, toolPolicy.maxFetchBytes);
      return {
        url: currentUrl.toString(),
        finalUrl: response.url || currentUrl.toString(),
        status: response.status,
        ok: response.ok,
        contentType,
        redirects: visited.slice(0, -1),
        title: extractTitle(rawText),
        text: cleanFetchedText(rawText, contentType).slice(0, 12_000),
      };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortListener);
    }
  }

  throw publicToolError('too_many_redirects', 'The page redirected too many times.');
}

function isRedirect(status) {
  return [301, 302, 303, 307, 308].includes(status);
}

async function readLimitedText(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) {
    return '';
  }

  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      throw publicToolError('response_too_large', 'The page was larger than the workspace fetch limit.');
    }
    chunks.push(value);
  }

  return new TextDecoder().decode(Buffer.concat(chunks));
}

function extractTitle(text) {
  const match = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeHtml(match[1]).replace(/\s+/g, ' ').trim().slice(0, 160) : '';
}

function cleanFetchedText(text, contentType) {
  if (contentType === 'application/json') {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  }

  if (!contentType.includes('html')) {
    return text.replace(/\s+\n/g, '\n').trim();
  }

  return decodeHtml(
    text
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|section|article|h[1-6]|li)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeHtml(value) {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}
