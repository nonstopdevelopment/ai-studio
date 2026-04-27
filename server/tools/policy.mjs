import { lookup } from 'node:dns/promises';
import net from 'node:net';

const privateCidrs = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const blockedHostnames = new Set([
  'localhost',
  'metadata.google.internal',
  'kubernetes.default.svc',
]);

export const toolPolicy = {
  enabled: process.env.AI_TOOLS_ENABLED === 'true',
  webFetchEnabled: process.env.AI_TOOL_WEB_FETCH_ENABLED === 'true',
  maxFetchBytes: readInt('AI_TOOL_MAX_FETCH_BYTES', 250_000),
  fetchTimeoutMs: readInt('AI_TOOL_FETCH_TIMEOUT_MS', 8000),
  maxRedirects: readInt('AI_TOOL_MAX_REDIRECTS', 2),
  maxUrlsPerRequest: readInt('AI_TOOL_MAX_URLS_PER_REQUEST', 2),
  allowedDomains: parseCsv(process.env.AI_TOOL_ALLOWED_DOMAINS || '*'),
  blockedDomains: parseCsv(process.env.AI_TOOL_BLOCKED_DOMAINS || ''),
};

export async function assertSafeFetchUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw publicToolError('invalid_url', 'The web fetch tool only accepts valid URLs.');
  }

  if (url.protocol !== 'https:') {
    throw publicToolError('blocked_protocol', 'The web fetch tool only allows HTTPS URLs.');
  }

  if (url.username || url.password) {
    throw publicToolError('blocked_credentials', 'URLs with embedded credentials are not allowed.');
  }

  if (!isAllowedDomain(url.hostname)) {
    throw publicToolError('blocked_domain', 'That domain is not allowed for this workspace.');
  }

  if (isBlockedHostname(url.hostname)) {
    throw publicToolError('blocked_hostname', 'Internal or local hostnames are not allowed.');
  }

  const addresses = await lookup(url.hostname, { all: true, verbatim: false });
  if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw publicToolError('blocked_address', 'Internal or private network addresses are not allowed.');
  }

  return url;
}

export function publicToolError(code, message) {
  const error = new Error(message);
  error.publicCode = code;
  error.publicMessage = message;
  return error;
}

function isAllowedDomain(hostname) {
  const host = hostname.toLowerCase();
  if (toolPolicy.blockedDomains.some((domain) => domainMatches(host, domain))) {
    return false;
  }

  if (toolPolicy.allowedDomains.includes('*')) {
    return true;
  }

  return toolPolicy.allowedDomains.some((domain) => domainMatches(host, domain));
}

function domainMatches(host, domain) {
  const normalized = domain.toLowerCase().replace(/^\*\./, '');
  return host === normalized || host.endsWith(`.${normalized}`);
}

function isBlockedHostname(hostname) {
  const host = hostname.toLowerCase();
  return blockedHostnames.has(host) || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.svc');
}

function isPrivateAddress(address) {
  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    return (
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe80:') ||
      normalized.startsWith('::ffff:127.') ||
      normalized.startsWith('::ffff:10.') ||
      normalized.startsWith('::ffff:192.168.')
    );
  }

  if (!net.isIPv4(address)) {
    return true;
  }

  const ipNumber = ipv4ToNumber(address);
  return privateCidrs.some(([range, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ipNumber & mask) === (ipv4ToNumber(range) & mask);
  });
}

function ipv4ToNumber(address) {
  return address
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .reduce((sum, value) => ((sum << 8) + value) >>> 0, 0);
}

function parseCsv(value) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function readInt(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
}
