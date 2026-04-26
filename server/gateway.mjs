import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from 'redis';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const distDir = join(rootDir, 'dist');
const artifactDir = process.env.ARTIFACT_DIR || join('/tmp', 'tampadevs-ai-artifacts');
const redisUrl = process.env.REDIS_URL || '';
const keyPrefix = process.env.REDIS_KEY_PREFIX || 'ai-studio';
const sessionTtlSeconds = readInt('SESSION_TTL_SECONDS', 24 * 60 * 60);
const artifactTtlSeconds = readInt('ARTIFACT_TTL_SECONDS', 24 * 60 * 60);
const threadTtlSeconds = readInt('THREAD_TTL_SECONDS', 30 * 24 * 60 * 60);
const adminToken = process.env.ADMIN_TOKEN || '';

const authConfig = {
  mode: process.env.AUTH_MODE || 'optional',
  issuer: process.env.TAMPADEV_AUTH_ISSUER || '',
  authorizeUrl: process.env.TAMPADEV_AUTH_AUTHORIZE_URL || 'https://tampa.dev/oauth/authorize',
  tokenUrl: process.env.TAMPADEV_AUTH_TOKEN_URL || 'https://tampa.dev/oauth/token',
  redirectUri: process.env.TAMPADEV_AUTH_REDIRECT_URI || '',
  userInfoUrl: process.env.TAMPADEV_AUTH_USERINFO_URL || '',
  introspectionUrl: process.env.TAMPADEV_AUTH_INTROSPECTION_URL || '',
  clientId: process.env.TAMPADEV_AUTH_CLIENT_ID || '',
  scopes: process.env.TAMPADEV_AUTH_SCOPES || 'read:user user:email',
};

const policy = {
  modelName: process.env.VLLM_MODEL || 'gemma-4',
  serviceName: process.env.VLLM_BASE_URL || 'mock://canned-generations',
  mode: process.env.GATEWAY_MODE || 'mock',
  maxConcurrentClusterRequests: readInt('GATEWAY_MAX_CONCURRENT', 1),
  maxQueueDepth: readInt('GATEWAY_MAX_QUEUE_DEPTH', 6),
  perUserConcurrentRequests: readInt('GATEWAY_PER_USER_CONCURRENT', 1),
  perUserRequestsPerMinute: readInt('GATEWAY_PER_USER_RPM', 6),
  minIntervalMs: readInt('GATEWAY_MIN_INTERVAL_MS', 2500),
  requestTimeoutMs: readInt('GATEWAY_REQUEST_TIMEOUT_MS', 120000),
  maxOutputTokens: readInt('GATEWAY_MAX_OUTPUT_TOKENS', 768),
  maxPromptChars: readInt('GATEWAY_MAX_PROMPT_CHARS', 8000),
};

const state = {
  activeRequests: 0,
  lastStartAt: 0,
  completedRequests: 0,
  failedRequests: 0,
  queue: [],
  perUserInflight: new Map(),
  perUserWindows: new Map(),
  sessions: new Map(),
  artifacts: new Map(),
  activeJobs: new Map(),
  recentRequests: [],
};

let sharedStore = createMemorySharedStore();

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

    if (request.method === 'GET' && url.pathname === '/api/status') {
      return sendJson(response, 200, getStatus());
    }

    if (request.method === 'GET' && url.pathname === '/api/auth/config') {
      return sendJson(response, 200, getPublicAuthConfig());
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/token') {
      return handleTokenExchange(request, response);
    }

    if (request.method === 'GET' && url.pathname === '/api/me') {
      return handleMe(request, response);
    }

    if (request.method === 'GET' && url.pathname === '/api/threads') {
      return handleListThreads(request, response);
    }

    if (request.method === 'POST' && url.pathname === '/api/threads') {
      return handleCreateThread(request, response);
    }

    if (request.method === 'GET' && url.pathname.startsWith('/api/threads/')) {
      return handleGetThread(request, response, url.pathname);
    }

    if (request.method === 'POST' && url.pathname === '/api/generate') {
      return handleGenerate(request, response);
    }

    if (request.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(response, 200, { ok: true, status: getStatus() });
    }

    if (request.method === 'GET' && url.pathname === '/api/admin/metrics') {
      return handleAdminMetrics(request, response);
    }

    if (request.method === 'GET' && url.pathname.startsWith('/api/artifacts/')) {
      return await serveArtifact(url.pathname, response);
    }

    if (url.pathname.startsWith('/api/')) {
      return sendJson(response, 404, { error: 'not_found' });
    }

    return serveStatic(url.pathname, response);
  } catch (error) {
    console.error('[gateway] unhandled request error', error);
    return sendJson(response, error.statusCode || 500, {
      error: error.publicCode || 'internal_error',
      message: error.publicMessage || 'The gateway could not complete the request.',
    });
  }
});

await initSharedStore();

server.listen(readInt('PORT', 8787), '0.0.0.0', () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 8787;
  console.log(`[gateway] listening on http://127.0.0.1:${port}`);
  console.log(`[gateway] mode=${policy.mode} model=${policy.modelName} base=${policy.serviceName}`);
  console.log(`[gateway] sharedStore=${sharedStore.name}`);
});

async function handleGenerate(request, response) {
  const identity = await resolveIdentity(request);
  if (!identity.ok) {
    return sendJson(response, identity.statusCode, identity.body);
  }

  const userId = identity.user.id;
  const body = await readJsonBody(request);
  const prompt = String(body.prompt ?? '').trim();

  if (!prompt) {
    return sendJson(response, 400, { error: 'prompt_required' });
  }

  if (prompt.length > policy.maxPromptChars) {
    return sendJson(response, 413, {
      error: 'prompt_too_large',
      maxPromptChars: policy.maxPromptChars,
    });
  }

  const limitCheck = await checkUserLimits(userId);
  if (!limitCheck.ok) {
    return sendJson(response, 429, limitCheck.body);
  }

  if (state.queue.length >= policy.maxQueueDepth) {
    return sendJson(response, 429, {
      error: 'queue_full',
      retryAfterMs: estimateWaitMs(),
      status: getStatus(),
    });
  }

  const requestId = randomUUID();
  const sessionId = sanitizeId(body.sessionId) || randomUUID();
  const threadId = sanitizeId(body.threadId) || '';
  const queuedAt = Date.now();

  return new Promise((resolve) => {
    const job = {
      request,
      response,
      resolve,
      requestId,
      userId,
      queuedAt,
      body: {
        prompt,
        sessionId,
        workflowId: String(body.workflowId ?? 'unknown'),
        workflowTitle: String(body.workflowTitle ?? 'Untitled workflow'),
        sampleResponse: String(body.sampleResponse ?? ''),
        createArtifact: Boolean(body.createArtifact),
        outputFormat: normalizeOutputFormat(body.outputFormat),
        threadId,
      },
    };

    state.queue.push(job);
    processQueue();
  });
}

function processQueue() {
  if (state.activeRequests >= policy.maxConcurrentClusterRequests || state.queue.length === 0) {
    return;
  }

  const cooldownRemaining = Math.max(0, policy.minIntervalMs - (Date.now() - state.lastStartAt));
  if (cooldownRemaining > 0) {
    setTimeout(processQueue, cooldownRemaining);
    return;
  }

  const job = state.queue.shift();
  if (!job) {
    return;
  }

  state.activeRequests += 1;
  state.lastStartAt = Date.now();
  job.startedAt = state.lastStartAt;
  state.activeJobs.set(job.requestId, job);
  incrementInflight(job.userId);

  runJob(job)
    .catch((error) => {
      state.failedRequests += 1;
      recordRequest(job, {
        status: 'failed',
        statusCode: error.statusCode || 500,
        error: error.publicCode || error.name || 'generation_failed',
      });
      console.error(`[gateway] request ${job.requestId} failed`, error);
      if (!job.response.headersSent) {
        const publicError = normalizePublicError(error);
        sendJson(job.response, error.statusCode || 500, {
          error: publicError.code,
          requestId: job.requestId,
          message: publicError.message,
          status: getStatus(),
        });
      }
    })
    .finally(() => {
      state.activeRequests = Math.max(0, state.activeRequests - 1);
      state.activeJobs.delete(job.requestId);
      decrementInflight(job.userId);
      job.resolve();
      processQueue();
    });

  processQueue();
}

async function runJob(job) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), policy.requestTimeoutMs);
  let releaseClusterSlot = null;

  let responseFinished = false;
  job.response.on('finish', () => {
    responseFinished = true;
  });
  job.response.on('close', () => {
    if (!responseFinished) {
      controller.abort();
    }
  });

  try {
    releaseClusterSlot = await waitForClusterSlot(job, controller.signal);
    const result =
      policy.mode === 'live'
        ? await generateWithVllm(job, controller.signal)
        : await generateWithMock(job, controller.signal);

    state.completedRequests += 1;
    const artifact = job.body.createArtifact ? await createArtifact(job, result.text) : null;
    await sharedStore.appendSessionMessage(job.body.sessionId, { role: 'user', content: job.body.prompt });
    await sharedStore.appendSessionMessage(job.body.sessionId, { role: 'assistant', content: result.text });
    if (job.body.threadId) {
      await sharedStore.saveThreadMessage(job.userId, job.body.threadId, {
        id: `user-${job.requestId}`,
        role: 'user',
        content: job.body.prompt,
      });
      await sharedStore.saveThreadMessage(job.userId, job.body.threadId, {
        id: `assistant-${job.requestId}`,
        role: 'assistant',
        content: result.text,
      });
      await sharedStore.touchThread(job.userId, {
        id: job.body.threadId,
        title: job.body.prompt.slice(0, 52) || job.body.workflowTitle,
        subtitle: job.body.workflowTitle,
        sessionId: job.body.sessionId,
      });
    }
    const completedAt = Date.now();
    recordRequest(job, {
      status: 'completed',
      statusCode: 200,
      completedAt,
      outputChars: result.text.length,
      totalTokens: result.usage?.total_tokens ?? result.usage?.totalTokens ?? null,
    });

    return sendJson(job.response, 200, {
      requestId: job.requestId,
      sessionId: job.body.sessionId,
      mode: policy.mode,
      model: policy.modelName,
      workflowId: job.body.workflowId,
      queuedMs: startedAt - job.queuedAt,
      latencyMs: completedAt - startedAt,
      text: result.text,
      artifact,
      memory: await sharedStore.getSessionSummary(job.body.sessionId),
      usage: result.usage,
      status: getProjectedCompletionStatus(),
    });
  } finally {
    if (releaseClusterSlot) {
      await releaseClusterSlot();
    }
    clearTimeout(timeout);
  }
}

async function handleTokenExchange(request, response) {
  if (!isAuthConfigured()) {
    return sendJson(response, 404, {
      error: 'auth_not_configured',
      message: 'Tampa.dev OAuth is not configured for this environment.',
    });
  }

  const body = await readJsonBody(request);
  const code = String(body.code ?? '').trim();
  const codeVerifier = String(body.codeVerifier ?? '').trim();
  const redirectUri = String(body.redirectUri ?? '').trim();

  if (!code || !codeVerifier || !redirectUri) {
    return sendJson(response, 400, { error: 'invalid_auth_callback' });
  }

  const tokenResponse = await fetch(authConfig.tokenUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: authConfig.clientId,
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    }),
  });

  const tokenText = await tokenResponse.text();
  let tokenBody = safeJsonParse(tokenText) ?? {};

  if (!tokenResponse.ok) {
    return sendJson(response, 502, {
      error: 'token_exchange_failed',
      message: tokenBody.error_description || tokenBody.error || 'The Tampa.dev token endpoint rejected the callback.',
    });
  }

  return sendJson(response, 200, {
    accessToken: tokenBody.access_token,
    tokenType: tokenBody.token_type || 'Bearer',
    expiresIn: tokenBody.expires_in ?? null,
    scope: tokenBody.scope ?? authConfig.scopes,
  });
}

async function handleMe(request, response) {
  const identity = await resolveIdentity(request);
  if (!identity.ok) {
    return sendJson(response, identity.statusCode, identity.body);
  }

  return sendJson(response, 200, {
    authenticated: identity.user.authenticated,
    id: identity.user.id,
    name: identity.user.name,
    email: identity.user.email,
    avatarUrl: identity.user.avatarUrl,
    authMode: authConfig.mode,
  });
}

async function handleListThreads(request, response) {
  const identity = await resolveIdentity(request);
  if (!identity.ok) {
    return sendJson(response, identity.statusCode, identity.body);
  }

  return sendJson(response, 200, {
    ownerId: identity.user.id,
    authenticated: identity.user.authenticated,
    threads: await sharedStore.listThreads(identity.user.id),
  });
}

async function handleCreateThread(request, response) {
  const identity = await resolveIdentity(request);
  if (!identity.ok) {
    return sendJson(response, identity.statusCode, identity.body);
  }

  const body = await readJsonBody(request);
  const thread = await sharedStore.createThread(identity.user.id, {
    title: String(body.title ?? 'New workspace chat').slice(0, 80),
    subtitle: String(body.subtitle ?? 'Just now').slice(0, 80),
    sessionId: sanitizeId(body.sessionId) || randomUUID(),
  });

  return sendJson(response, 201, { thread });
}

async function handleGetThread(request, response, pathname) {
  const identity = await resolveIdentity(request);
  if (!identity.ok) {
    return sendJson(response, identity.statusCode, identity.body);
  }

  const threadId = sanitizeId(pathname.split('/').pop() ?? '');
  const thread = await sharedStore.getThread(identity.user.id, threadId);
  if (!thread) {
    return sendJson(response, 404, { error: 'thread_not_found' });
  }

  return sendJson(response, 200, { thread });
}

function handleAdminMetrics(request, response) {
  if (!adminToken) {
    return sendJson(response, 404, { error: 'admin_disabled' });
  }

  if (!isAdminRequest(request)) {
    return sendJson(response, 401, { error: 'unauthorized' });
  }

  return sendJson(response, 200, getAdminMetrics());
}

function isAdminRequest(request) {
  const auth = request.headers.authorization;
  const bearerToken =
    typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  const headerToken = typeof request.headers['x-admin-token'] === 'string' ? request.headers['x-admin-token'] : '';
  return bearerToken === adminToken || headerToken === adminToken;
}

function getAdminMetrics() {
  const recent = state.recentRequests.slice(-80).reverse();
  const completed = state.recentRequests.filter((request) => request.status === 'completed');
  const failed = state.recentRequests.filter((request) => request.status === 'failed');
  const latencies = completed.map((request) => request.latencyMs).filter((value) => typeof value === 'number');

  return {
    generatedAt: new Date().toISOString(),
    status: getStatus(),
    throughput: {
      recentCompleted: completed.length,
      recentFailed: failed.length,
      avgLatencyMs: average(latencies),
      p95LatencyMs: percentile(latencies, 0.95),
      maxLatencyMs: latencies.length ? Math.max(...latencies) : 0,
    },
    activeJobs: [...state.activeJobs.values()].map((job) => summarizeJob(job, 'active')),
    queuedJobs: state.queue.map((job) => summarizeJob(job, 'queued')),
    recentRequests: recent,
  };
}

function summarizeJob(job, status) {
  const now = Date.now();
  return {
    requestId: job.requestId,
    userId: anonymizeId(job.userId),
    sessionId: anonymizeId(job.body.sessionId),
    workflowId: job.body.workflowId,
    outputFormat: job.body.outputFormat,
    createArtifact: job.body.createArtifact,
    status,
    queuedAt: new Date(job.queuedAt).toISOString(),
    startedAt: job.startedAt ? new Date(job.startedAt).toISOString() : null,
    queuedMs: (job.startedAt ?? now) - job.queuedAt,
    runningMs: job.startedAt ? now - job.startedAt : 0,
    promptChars: job.body.prompt.length,
  };
}

function recordRequest(job, details) {
  const completedAt = details.completedAt ?? Date.now();
  state.recentRequests.push({
    ...summarizeJob(job, details.status),
    completedAt: new Date(completedAt).toISOString(),
    latencyMs: job.startedAt ? completedAt - job.startedAt : 0,
    totalMs: completedAt - job.queuedAt,
    statusCode: details.statusCode,
    error: details.error ?? null,
    outputChars: details.outputChars ?? 0,
    totalTokens: details.totalTokens ?? null,
  });
  state.recentRequests = state.recentRequests.slice(-200);
}

function anonymizeId(value) {
  const text = String(value ?? 'unknown');
  if (text.length <= 12) {
    return text;
  }

  return `${text.slice(0, 6)}...${text.slice(-4)}`;
}

function average(values) {
  if (values.length === 0) {
    return 0;
  }

  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function percentile(values, pct) {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * pct))];
}

async function generateWithMock(job, signal) {
  await sleep(650, signal);
  return {
    text:
      job.body.sampleResponse ||
      `Mock gateway response for ${job.body.workflowTitle}. The queue protected this request before it reached the model lane.`,
    usage: {
      promptTokens: Math.ceil(job.body.prompt.length / 4),
      completionTokens: Math.ceil((job.body.sampleResponse || '').length / 4),
      totalTokens:
        Math.ceil(job.body.prompt.length / 4) + Math.ceil((job.body.sampleResponse || '').length / 4),
    },
  };
}

async function generateWithVllm(job, signal) {
  if (!process.env.VLLM_BASE_URL) {
    const error = new Error('VLLM_BASE_URL is required when GATEWAY_MODE=live.');
    error.statusCode = 500;
    error.publicCode = 'missing_vllm_base_url';
    error.publicMessage = 'The gateway is in live mode but no vLLM base URL is configured.';
    throw error;
  }

  const baseUrl = process.env.VLLM_BASE_URL.replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      ...(process.env.VLLM_API_KEY ? { authorization: `Bearer ${process.env.VLLM_API_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: policy.modelName,
      max_tokens: getMaxOutputTokens(job),
      temperature: 0.4,
      messages: [
        {
          role: 'system',
          content:
            'You are Tampa Devs AI Studio, running on a community private cloud. For normal chat, answer directly in 1-3 short paragraphs unless the user asks for depth. For generated artifacts, produce clean Markdown with headings, lists, and concrete next steps.',
        },
        ...(await getConversationHistory(job)),
        {
          role: 'user',
          content: `${job.body.prompt}\n\n${getFormatInstruction(job.body.outputFormat)}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    const error = new Error(`vLLM returned ${response.status}: ${body.slice(0, 500)}`);
    error.statusCode = response.status >= 500 ? 502 : response.status;
    error.publicCode = 'vllm_error';
    error.publicMessage = 'The model service returned an error.';
    throw error;
  }

  const payload = await response.json();
  return {
    text: payload?.choices?.[0]?.message?.content ?? '',
    usage: payload?.usage ?? null,
  };
}

async function getConversationHistory(job) {
  if (job.body.threadId) {
    const threadMessages = await sharedStore.getThreadMessages(job.userId, job.body.threadId);
    if (threadMessages.length > 0) {
      return threadMessages.slice(-8);
    }
  }

  return sharedStore.getSessionMessages(job.body.sessionId);
}

function getMaxOutputTokens(job) {
  if (job.body.createArtifact) {
    return policy.maxOutputTokens;
  }

  if (job.body.workflowId === 'general-chat') {
    return Math.min(policy.maxOutputTokens, 256);
  }

  return Math.min(policy.maxOutputTokens, 512);
}

async function createArtifact(job, text) {
  mkdirSync(artifactDir, { recursive: true });
  const artifactId = randomUUID();
  const format = job.body.outputFormat;
  const extension = getArtifactExtension(format);
  const mimeType = getArtifactMimeType(format);
  const filename = `${artifactId}.${extension}`;
  const title = `${job.body.workflowTitle} artifact`;
  const content = formatArtifactContent({
    format,
    text,
    title,
    requestId: job.requestId,
    sessionId: job.body.sessionId,
  });
  const filePath = join(artifactDir, filename);
  writeFileSync(filePath, content, 'utf8');

  const artifact = {
    id: artifactId,
    title,
    filename,
    mimeType,
    bytes: Buffer.byteLength(content),
    url: `/api/artifacts/${artifactId}`,
  };
  await sharedStore.saveArtifact({ ...artifact, filePath });
  return artifact;
}

function normalizeOutputFormat(value) {
  const format = String(value ?? 'markdown').toLowerCase();
  return ['markdown', 'text', 'json'].includes(format) ? format : 'markdown';
}

function getFormatInstruction(format) {
  if (format === 'json') {
    return 'Return only valid JSON. Do not wrap it in Markdown fences. Use double quotes and no trailing commas.';
  }

  if (format === 'text') {
    return 'Return plain text only. Do not use Markdown headings, tables, or code fences.';
  }

  return 'Return clean Markdown with useful headings, lists, and concise sections where appropriate.';
}

function getArtifactExtension(format) {
  if (format === 'json') {
    return 'json';
  }

  if (format === 'text') {
    return 'txt';
  }

  return 'md';
}

function getArtifactMimeType(format) {
  if (format === 'json') {
    return 'application/json';
  }

  if (format === 'text') {
    return 'text/plain';
  }

  return 'text/markdown';
}

function formatArtifactContent({ format, text, title, requestId, sessionId }) {
  const trimmed = text.trim();

  if (format === 'json') {
    try {
      return `${JSON.stringify(JSON.parse(trimmed), null, 2)}\n`;
    } catch {
      return `${JSON.stringify(
        {
          title,
          content: trimmed,
          generatedBy: 'Tampa Devs AI Studio',
          requestId,
          sessionId,
        },
        null,
        2
      )}\n`;
    }
  }

  if (format === 'text') {
    return `${title}\n\n${trimmed}\n\nGenerated by Tampa Devs AI Studio\nRequest: ${requestId}\nSession: ${sessionId}\n`;
  }

  return `# ${title}\n\n${trimmed}\n\n---\nGenerated by Tampa Devs AI Studio\nRequest: ${requestId}\nSession: ${sessionId}\n`;
}

async function serveArtifact(pathname, response) {
  const artifactId = sanitizeId(pathname.split('/').pop() ?? '');
  const artifact = await sharedStore.getArtifact(artifactId);

  if (!artifact || !existsSync(artifact.filePath)) {
    return sendJson(response, 404, { error: 'artifact_not_found' });
  }

  response.writeHead(200, {
    'content-type': `${artifact.mimeType}; charset=utf-8`,
    'content-disposition': `inline; filename="${artifact.filename}"`,
    'cache-control': 'no-store',
  });
  return createReadStream(artifact.filePath).pipe(response);
}

function sanitizeId(value) {
  return String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120);
}

async function checkUserLimits(userId) {
  const now = Date.now();
  const rateLimit = await sharedStore.checkRateLimit(userId, now);
  if (!rateLimit.ok) {
    return {
      ok: false,
      body: {
        error: 'rate_limited',
        retryAfterMs: rateLimit.retryAfterMs,
        status: getStatus(),
      },
    };
  }

  if ((state.perUserInflight.get(userId) ?? 0) >= policy.perUserConcurrentRequests) {
    return {
      ok: false,
      body: {
        error: 'user_request_inflight',
        retryAfterMs: estimateWaitMs(),
        status: getStatus(),
      },
    };
  }

  return { ok: true };
}

function getStatus() {
  return {
    modelName: policy.modelName,
    serviceName: policy.serviceName,
    mode: policy.mode,
    activeRequests: state.activeRequests,
    queueDepth: state.queue.length,
    completedRequests: state.completedRequests,
    failedRequests: state.failedRequests,
    estimatedWaitMs: estimateWaitMs(),
    sharedStorage: sharedStore.name,
    policy: {
      maxConcurrentClusterRequests: policy.maxConcurrentClusterRequests,
      maxQueueDepth: policy.maxQueueDepth,
      perUserConcurrentRequests: policy.perUserConcurrentRequests,
      perUserRequestsPerMinute: policy.perUserRequestsPerMinute,
      minIntervalMs: policy.minIntervalMs,
      requestTimeoutMs: policy.requestTimeoutMs,
      maxOutputTokens: policy.maxOutputTokens,
      maxPromptChars: policy.maxPromptChars,
    },
  };
}

function getPublicAuthConfig() {
  return {
    enabled: isAuthConfigured(),
    authMode: authConfig.mode,
    authorizeUrl: authConfig.authorizeUrl,
    clientId: authConfig.clientId,
    redirectUri: authConfig.redirectUri,
    scopes: authConfig.scopes,
  };
}

function isAuthConfigured() {
  return Boolean(authConfig.clientId && authConfig.authorizeUrl && authConfig.tokenUrl);
}

async function resolveIdentity(request) {
  const bearerToken = getBearerToken(request);

  if (bearerToken && isAuthConfigured()) {
    try {
      const profile = await validateBearerToken(bearerToken);
      return { ok: true, user: normalizeAuthProfile(profile) };
    } catch (error) {
      console.error('[gateway] auth validation failed', error);
      return {
        ok: false,
        statusCode: 401,
        body: {
          error: 'invalid_token',
          message: 'The Tampa.dev session could not be validated.',
        },
      };
    }
  }

  if (authConfig.mode === 'required') {
    return {
      ok: false,
      statusCode: 401,
      body: {
        error: 'auth_required',
        message: 'Sign in with Tampa.dev before using this workspace.',
      },
    };
  }

  return {
    ok: true,
    user: {
      id: getFallbackUserId(request),
      name: 'Guest workspace',
      email: '',
      avatarUrl: '',
      authenticated: false,
    },
  };
}

function getBearerToken(request) {
  const auth = request.headers.authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }

  return '';
}

async function validateBearerToken(token) {
  if (authConfig.userInfoUrl) {
    const response = await fetch(authConfig.userInfoUrl, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`userinfo_failed_${response.status}`);
    }
    return response.json();
  }

  if (authConfig.introspectionUrl) {
    const response = await fetch(authConfig.introspectionUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams({
        token,
        client_id: authConfig.clientId,
      }),
    });
    const body = await response.json();
    if (!response.ok || body.active === false) {
      throw new Error('token_inactive');
    }
    return body;
  }

  const claims = decodeJwtPayload(token);
  if (!claims) {
    throw new Error('token_claims_unreadable');
  }

  if (claims.exp && Date.now() / 1000 > Number(claims.exp)) {
    throw new Error('token_expired');
  }

  if (authConfig.issuer && claims.iss && claims.iss !== authConfig.issuer) {
    throw new Error('issuer_mismatch');
  }

  return claims;
}

function normalizeAuthProfile(profile) {
  const data = profile?.data && typeof profile.data === 'object' ? profile.data : profile;
  const id = sanitizeId(data.sub || data.id || data.user_id || data.username || data.email);
  if (!id) {
    throw new Error('missing_user_id');
  }

  return {
    id,
    name: String(data.name || data.preferred_username || data.username || data.email || 'Tampa.dev member'),
    email: String(data.email || ''),
    avatarUrl: String(data.picture || data.avatar_url || data.avatarUrl || ''),
    authenticated: true,
  };
}

function decodeJwtPayload(token) {
  const payload = token.split('.')[1];
  if (!payload) {
    return null;
  }

  const padded = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=');
  return safeJsonParse(Buffer.from(padded, 'base64').toString('utf8'));
}

async function waitForClusterSlot(job, signal) {
  while (!signal.aborted) {
    const release = await sharedStore.acquireClusterSlot(job.requestId, policy.maxConcurrentClusterRequests);
    if (release) {
      return release;
    }

    await sleep(750, signal);
  }

  throw abortError();
}

async function initSharedStore() {
  if (!redisUrl) {
    sharedStore = createMemorySharedStore();
    return;
  }

  try {
    const client = createClient({ url: redisUrl });
    client.on('error', (error) => {
      console.error('[gateway] redis error', error);
    });
    await client.connect();
    sharedStore = createRedisSharedStore(client);
  } catch (error) {
    if (process.env.REQUIRE_REDIS === 'true') {
      throw error;
    }

    console.error('[gateway] redis unavailable, falling back to process memory', error);
    sharedStore = createMemorySharedStore();
  }
}

function createMemorySharedStore() {
  return {
    name: 'memory',
    async appendSessionMessage(sessionId, message) {
      const current = state.sessions.get(sessionId) ?? [];
      current.push({
        ...message,
        at: new Date().toISOString(),
      });
      state.sessions.set(sessionId, current.slice(-16));
    },
    async getSessionMessages(sessionId) {
      return (state.sessions.get(sessionId) ?? []).slice(-8).map((message) => ({
        role: message.role,
        content: message.content,
      }));
    },
    async getSessionSummary(sessionId) {
      return {
        sessionId,
        messageCount: state.sessions.get(sessionId)?.length ?? 0,
        storage: 'memory',
      };
    },
    async listThreads(userId) {
      return getMemoryUserThreads(userId).map((thread) => ({
        ...thread,
        messages: undefined,
      }));
    },
    async createThread(userId, thread) {
      const now = new Date().toISOString();
      const nextThread = {
        id: sanitizeId(thread.id) || randomUUID(),
        title: thread.title || 'New workspace chat',
        subtitle: thread.subtitle || 'Just now',
        sessionId: sanitizeId(thread.sessionId) || randomUUID(),
        updatedAt: now,
        messages: [],
      };
      const threads = getMemoryUserThreads(userId);
      state.sessions.set(getThreadIndexKey(userId), [nextThread, ...threads].slice(0, 30));
      return nextThread;
    },
    async getThread(userId, threadId) {
      return getMemoryUserThreads(userId).find((thread) => thread.id === threadId) ?? null;
    },
    async getThreadMessages(userId, threadId) {
      const thread = getMemoryUserThreads(userId).find((item) => item.id === threadId);
      return (thread?.messages ?? []).slice(-8).map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: String(message.content ?? ''),
      }));
    },
    async touchThread(userId, thread) {
      const threads = getMemoryUserThreads(userId);
      const existing = threads.find((item) => item.id === thread.id);
      const now = new Date().toISOString();
      const nextThread = {
        ...(existing ?? {}),
        id: sanitizeId(thread.id) || randomUUID(),
        title: thread.title || existing?.title || 'New workspace chat',
        subtitle: thread.subtitle || existing?.subtitle || 'Chat',
        sessionId: sanitizeId(thread.sessionId) || existing?.sessionId || randomUUID(),
        updatedAt: now,
        messages: existing?.messages ?? [],
      };
      state.sessions.set(
        getThreadIndexKey(userId),
        [nextThread, ...threads.filter((item) => item.id !== nextThread.id)].slice(0, 30)
      );
      return nextThread;
    },
    async saveThreadMessage(userId, threadId, message) {
      const threads = getMemoryUserThreads(userId);
      const existing = threads.find((thread) => thread.id === threadId);
      const nextThread = existing ?? {
        id: threadId,
        title: 'New workspace chat',
        subtitle: 'Chat',
        sessionId: randomUUID(),
        updatedAt: new Date().toISOString(),
        messages: [],
      };
      nextThread.messages = [
        ...(nextThread.messages ?? []),
        {
          id: message.id || randomUUID(),
          role: message.role === 'assistant' ? 'assistant' : 'user',
          content: String(message.content ?? ''),
          state: 'done',
          at: new Date().toISOString(),
        },
      ].slice(-40);
      nextThread.updatedAt = new Date().toISOString();
      state.sessions.set(
        getThreadIndexKey(userId),
        [nextThread, ...threads.filter((thread) => thread.id !== threadId)].slice(0, 30)
      );
    },
    async checkRateLimit(userId, now) {
      const windowStart = now - 60_000;
      const recent = (state.perUserWindows.get(userId) ?? []).filter((timestamp) => timestamp > windowStart);

      if (recent.length >= policy.perUserRequestsPerMinute) {
        state.perUserWindows.set(userId, recent);
        return {
          ok: false,
          retryAfterMs: Math.max(1000, 60_000 - (now - recent[0])),
        };
      }

      recent.push(now);
      state.perUserWindows.set(userId, recent);
      return { ok: true };
    },
    async acquireClusterSlot() {
      return async () => {};
    },
    async saveArtifact(artifact) {
      state.artifacts.set(artifact.id, artifact);
    },
    async getArtifact(artifactId) {
      return state.artifacts.get(artifactId) ?? null;
    },
  };
}

function createRedisSharedStore(client) {
  const key = (...parts) => [keyPrefix, ...parts].join(':');

  return {
    name: 'redis',
    async appendSessionMessage(sessionId, message) {
      const sessionKey = key('session', sanitizeId(sessionId));
      await client
        .multi()
        .rPush(sessionKey, JSON.stringify({ ...message, at: new Date().toISOString() }))
        .lTrim(sessionKey, -16, -1)
        .expire(sessionKey, sessionTtlSeconds)
        .exec();
    },
    async getSessionMessages(sessionId) {
      const rows = await client.lRange(key('session', sanitizeId(sessionId)), -8, -1);
      return rows
        .map((row) => safeJsonParse(row))
        .filter(Boolean)
        .map((message) => ({
          role: message.role === 'assistant' ? 'assistant' : 'user',
          content: String(message.content ?? ''),
        }));
    },
    async getSessionSummary(sessionId) {
      const safeSessionId = sanitizeId(sessionId);
      return {
        sessionId: safeSessionId,
        messageCount: await client.lLen(key('session', safeSessionId)),
        storage: 'redis',
      };
    },
    async listThreads(userId) {
      const threadIds = await client.zRange(key('user', sanitizeId(userId), 'threads'), 0, 29, { REV: true });
      const rows = await Promise.all(threadIds.map((threadId) => client.get(key('thread', sanitizeId(userId), threadId))));
      return rows
        .map((row) => safeJsonParse(row))
        .filter(Boolean)
        .map((thread) => ({ ...thread, messages: undefined }));
    },
    async createThread(userId, thread) {
      const threadId = sanitizeId(thread.id) || randomUUID();
      const nextThread = {
        id: threadId,
        title: thread.title || 'New workspace chat',
        subtitle: thread.subtitle || 'Just now',
        sessionId: sanitizeId(thread.sessionId) || randomUUID(),
        updatedAt: new Date().toISOString(),
        messages: [],
      };
      await saveRedisThread(client, key, userId, nextThread);
      return nextThread;
    },
    async getThread(userId, threadId) {
      return safeJsonParse(await client.get(key('thread', sanitizeId(userId), sanitizeId(threadId))));
    },
    async getThreadMessages(userId, threadId) {
      const thread = safeJsonParse(await client.get(key('thread', sanitizeId(userId), sanitizeId(threadId))));
      return (thread?.messages ?? []).slice(-8).map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: String(message.content ?? ''),
      }));
    },
    async touchThread(userId, thread) {
      const safeUserId = sanitizeId(userId);
      const threadId = sanitizeId(thread.id) || randomUUID();
      const current = safeJsonParse(await client.get(key('thread', safeUserId, threadId))) ?? {};
      const nextThread = {
        ...current,
        id: threadId,
        title: thread.title || current.title || 'New workspace chat',
        subtitle: thread.subtitle || current.subtitle || 'Chat',
        sessionId: sanitizeId(thread.sessionId) || current.sessionId || randomUUID(),
        updatedAt: new Date().toISOString(),
        messages: current.messages ?? [],
      };
      await saveRedisThread(client, key, safeUserId, nextThread);
      return nextThread;
    },
    async saveThreadMessage(userId, threadId, message) {
      const safeUserId = sanitizeId(userId);
      const safeThreadId = sanitizeId(threadId);
      const current = safeJsonParse(await client.get(key('thread', safeUserId, safeThreadId))) ?? {
        id: safeThreadId,
        title: 'New workspace chat',
        subtitle: 'Chat',
        sessionId: randomUUID(),
        updatedAt: new Date().toISOString(),
        messages: [],
      };
      const nextThread = {
        ...current,
        updatedAt: new Date().toISOString(),
        messages: [
          ...(current.messages ?? []),
          {
            id: message.id || randomUUID(),
            role: message.role === 'assistant' ? 'assistant' : 'user',
            content: String(message.content ?? ''),
            state: 'done',
            at: new Date().toISOString(),
          },
        ].slice(-40),
      };
      await saveRedisThread(client, key, safeUserId, nextThread);
    },
    async checkRateLimit(userId, now) {
      const bucket = Math.floor(now / 60_000);
      const rateKey = key('rate', sanitizeId(userId), String(bucket));
      const count = await client.incr(rateKey);
      if (count === 1) {
        await client.expire(rateKey, 90);
      }

      if (count > policy.perUserRequestsPerMinute) {
        return {
          ok: false,
          retryAfterMs: Math.max(1000, 60_000 - (now % 60_000)),
        };
      }

      return { ok: true };
    },
    async acquireClusterSlot(requestId, limit) {
      const slotKey = key('cluster', 'active');
      const holderKey = key('cluster', 'holder', sanitizeId(requestId));
      const acquired = await client.eval(
        `
        local slotKey = KEYS[1]
        local holderKey = KEYS[2]
        local limit = tonumber(ARGV[1])
        local ttl = tonumber(ARGV[2])
        local current = tonumber(redis.call('get', slotKey) or '0')
        if current < limit then
          redis.call('incr', slotKey)
          redis.call('pexpire', slotKey, ttl)
          redis.call('set', holderKey, '1', 'PX', ttl)
          return 1
        end
        return 0
        `,
        {
          keys: [slotKey, holderKey],
          arguments: [String(limit), String(policy.requestTimeoutMs + 15_000)],
        }
      );

      if (Number(acquired) !== 1) {
        return null;
      }

      return async () => {
        await client.eval(
          `
          local slotKey = KEYS[1]
          local holderKey = KEYS[2]
          if redis.call('del', holderKey) == 1 then
            local current = tonumber(redis.call('get', slotKey) or '0')
            if current <= 1 then
              redis.call('del', slotKey)
            else
              redis.call('decr', slotKey)
            end
          end
          return 1
          `,
          {
            keys: [slotKey, holderKey],
            arguments: [],
          }
        );
      };
    },
    async saveArtifact(artifact) {
      await client.set(key('artifact', sanitizeId(artifact.id)), JSON.stringify(artifact), {
        EX: artifactTtlSeconds,
      });
    },
    async getArtifact(artifactId) {
      return safeJsonParse(await client.get(key('artifact', sanitizeId(artifactId))));
    },
  };
}

function getThreadIndexKey(userId) {
  return `threads:${sanitizeId(userId)}`;
}

function getMemoryUserThreads(userId) {
  return state.sessions.get(getThreadIndexKey(userId)) ?? [];
}

async function saveRedisThread(client, key, userId, thread) {
  const safeUserId = sanitizeId(userId);
  const safeThreadId = sanitizeId(thread.id);
  const serialized = JSON.stringify({ ...thread, id: safeThreadId });
  const threadKey = key('thread', safeUserId, safeThreadId);
  const indexKey = key('user', safeUserId, 'threads');

  await client
    .multi()
    .set(threadKey, serialized, { EX: threadTtlSeconds })
    .zAdd(indexKey, [{ score: Date.now(), value: safeThreadId }])
    .expire(indexKey, threadTtlSeconds)
    .exec();
}

function safeJsonParse(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function getProjectedCompletionStatus() {
  return {
    ...getStatus(),
    activeRequests: Math.max(0, state.activeRequests - 1),
    estimatedWaitMs: state.queue.length * Math.max(policy.minIntervalMs, 1000),
  };
}

function estimateWaitMs() {
  const activeDelay = state.activeRequests > 0 ? policy.requestTimeoutMs / 2 : 0;
  return Math.ceil(activeDelay + state.queue.length * Math.max(policy.minIntervalMs, 1000));
}

function incrementInflight(userId) {
  state.perUserInflight.set(userId, (state.perUserInflight.get(userId) ?? 0) + 1);
}

function decrementInflight(userId) {
  const nextValue = Math.max(0, (state.perUserInflight.get(userId) ?? 0) - 1);
  if (nextValue === 0) {
    state.perUserInflight.delete(userId);
  } else {
    state.perUserInflight.set(userId, nextValue);
  }
}

function getFallbackUserId(request) {
  const forwardedUser = request.headers['x-user-id'];
  if (typeof forwardedUser === 'string' && forwardedUser.trim()) {
    return forwardedUser.trim().slice(0, 120);
  }

  return request.socket.remoteAddress || 'anonymous';
}

async function readJsonBody(request) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > 128_000) {
      const error = new Error('Request body too large.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function serveStatic(pathname, response) {
  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const normalizedPath = normalize(requestedPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(distDir, normalizedPath);

  if (!filePath.startsWith(distDir) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    const fallbackPath = join(distDir, 'index.html');
    if (!existsSync(fallbackPath)) {
      return sendJson(response, 404, {
        error: 'frontend_not_built',
        message: 'Run pnpm build before using the gateway as the static app server.',
      });
    }
    response.writeHead(200, { 'content-type': contentTypes['.html'] });
    return createReadStream(fallbackPath).pipe(response);
  }

  response.writeHead(200, {
    'content-type': contentTypes[extname(filePath)] || 'application/octet-stream',
  });
  return createReadStream(filePath).pipe(response);
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function readInt(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }

    const timeout = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        reject(abortError());
      },
      { once: true }
    );
  });
}

function abortError() {
  const error = new Error('Request aborted.');
  error.statusCode = 499;
  error.publicCode = 'request_aborted';
  error.publicMessage = 'The request was canceled before generation completed.';
  return error;
}

function normalizePublicError(error) {
  if (error?.publicCode || error?.publicMessage) {
    return {
      code: error.publicCode || 'generation_failed',
      message: error.publicMessage || 'Generation failed before the model returned a response.',
    };
  }

  if (error?.name === 'AbortError') {
    return {
      code: 'model_request_timeout',
      message:
        'The model request was aborted before vLLM returned a response. Try a shorter prompt or increase GATEWAY_REQUEST_TIMEOUT_MS for longer artifact generations.',
    };
  }

  return {
    code: 'generation_failed',
    message: 'Generation failed before the model returned a response.',
  };
}
