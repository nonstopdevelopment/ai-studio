export const clusterPolicy = {
  modelName: 'Gemma 4 via internal vLLM service',
  serviceName: 'http://vllm-gateway.ai-studio.svc.cluster.local/v1',
  maxConcurrentClusterRequests: 1,
  maxQueueDepth: 6,
  perUserConcurrentRequests: 1,
  perUserRequestsPerMinute: 6,
  minIntervalMs: 2500,
  requestTimeoutMs: 45000,
  maxOutputTokens: 768,
} as const;

export const clusterPolicyBullets = [
  'Route browser traffic through a server-side gateway, not directly to vLLM.',
  'Allow only one active inference at a time for this single-model deployment.',
  'Queue up to six waiting jobs, then return HTTP 429 with retry guidance.',
  'Keep each signed-in user to one inflight request and six requests per minute.',
  'Cancel work on client disconnect and cap generation length to protect memory.',
];

export function formatPolicyWindow(ms: number): string {
  if (ms < 1000) {
    return `${ms} ms`;
  }

  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(seconds % 1 === 0 ? 0 : 1)}s`;
  }

  return `${(seconds / 60).toFixed(1)}m`;
}
