# Tampa Devs AI Studio

This app is the initial mock-first shell for a Tampa Devs AI workspace. It is designed as a calm testing console first: choose a workflow, adjust the prompt, run it through the gateway, and review the structured output.

## What This Scaffold Does

- Provides an app-first interface for testing prompt workflows instead of a showcase landing page.
- Uses canned generations in mock mode so we can evaluate UX before binding to the live Gemma lane.
- Routes all generations through the gateway so queue depth, active job count, and inference guardrails stay visible.
- Keeps the architecture honest: browser -> web app/gateway -> internal vLLM service.

## Run Locally

Run these commands from this `ai-studio` folder.

```bash
pnpm install
pnpm dev:api
pnpm dev
```

Use two terminals while developing locally. `pnpm dev:api` starts the protected gateway on `http://127.0.0.1:8787`, and `pnpm dev` starts Vite with `/api` proxied to that gateway.

For a production-style local run:

```bash
pnpm build
pnpm start
```

Then open `http://127.0.0.1:8787`.

## Testing Phase

Start in mock mode and verify the interface behavior before touching the model:

```bash
pnpm dev:api
pnpm dev
```

Open `http://localhost:5173`, run each workflow, and confirm the studio can reach the live or mock gateway through `/api`.

When the UI is ready to talk to the OKD-hosted vLLM service from your laptop, port-forward the service in a separate terminal:

```bash
oc project <namespace>
oc port-forward svc/<vllm-service-name> 8000:8000
```

Then start the gateway in live mode:

```bash
GATEWAY_MODE=live \
VLLM_BASE_URL=http://127.0.0.1:8000/v1 \
VLLM_MODEL=<loaded-model-name> \
pnpm dev:api
```

Keep Vite running with:

```bash
pnpm dev
```

Use the exact model id returned by the vLLM OpenAI-compatible API:

```bash
curl http://127.0.0.1:8000/v1/models
```

For the final OKD deployment, point the gateway at the internal service DNS instead of the port-forward:

```bash
GATEWAY_MODE=live
VLLM_BASE_URL=http://<vllm-service>.<namespace>.svc.cluster.local:<port>/v1
VLLM_MODEL=<loaded-model-name>
```

## Session Memory And Artifacts

The local gateway now accepts a `sessionId` on `POST /api/generate`. It keeps the last few messages in process memory and sends them back to vLLM on the next request, which lets the UI continue a thread during a demo.

The gateway can also create a temporary Markdown artifact when `createArtifact=true`. Local artifacts are written to:

```bash
/tmp/tampadevs-ai-artifacts
```

They are served through:

```bash
GET /api/artifacts/:artifactId
```

Supported output formats are:

- `markdown`: rendered in the app and saved as `.md`.
- `text`: shown as plain text and saved as `.txt`.
- `json`: requested as valid JSON, shown as raw JSON, and saved as `.json`.

For OKD with more than one gateway replica, replace these local-only stores:

- Session memory: use Redis, Postgres, or another shared session store keyed by `sessionId`.
- Artifacts: use an object bucket or PVC-backed artifact service instead of local `/tmp`.
- Gateway policy: keep rate limits and queue state centralized if requests can land on multiple pods.

## User Workspace Plan

The current workspace shell keeps threads in the browser and sends a generated `sessionId` to the gateway. When Tampa.dev authentication is connected, use the authenticated Tampa.dev user as the durable workspace owner:

- Browser obtains a Tampa.dev access token through OAuth 2.1 with PKCE.
- Browser sends `Authorization: Bearer <access_token>` to the AI Studio gateway.
- Gateway validates the token, derives a stable `userId`, and uses that for rate limits, thread ownership, and artifact access.
- Threads should move from browser-only state into shared storage keyed by `{userId, threadId}`.
- Anonymous sessions can remain as a fallback for public demos.

## Gateway Environment

The gateway defaults to canned mock generations. To point it at the in-cluster vLLM service, set:

```bash
GATEWAY_MODE=live
VLLM_BASE_URL=http://vllm-gateway.ai-studio.svc.cluster.local/v1
VLLM_MODEL=gemma-4
pnpm dev:api
```

Useful safety knobs:

- `GATEWAY_MAX_CONCURRENT=1`
- `GATEWAY_MAX_QUEUE_DEPTH=6`
- `GATEWAY_PER_USER_CONCURRENT=1`
- `GATEWAY_PER_USER_RPM=6`
- `GATEWAY_REQUEST_TIMEOUT_MS=120000`
- `GATEWAY_MAX_OUTPUT_TOKENS=768`

## Cluster Integration Shape

The browser should not call vLLM directly. The web app gateway owns the model-facing API:

1. `POST /api/generate`
2. `GET /api/status`
3. Future: `POST /api/cancel/:requestId`

The gateway should:

- Authenticate the user and stamp a request ID.
- Serialize access to the model deployment.
- Enforce queue depth and per-user limits.
- Cap prompt and output size.
- Cancel generation if the client disconnects.
- Forward to the internal vLLM service URL.

## Safe Defaults For One Loaded Model

- `maxConcurrentClusterRequests = 1`
- `maxQueueDepth = 6`
- `perUserConcurrentRequests = 1`
- `perUserRequestsPerMinute = 6`
- `requestTimeoutMs = 120000`
- `maxOutputTokens = 768`

For a single active model, this is the safest place to start if two people might use the app at once. The second user should be queued, not allowed to open a second live generation lane directly against vLLM.

## Suggested Gateway Behavior

- If one request is active and a second arrives, enqueue it.
- If the queue is full, return `429 Too Many Requests` with a short retry hint.
- Expose current `activeRequests`, `queueDepth`, `estimatedWaitMs`, and `modelName` from `/api/status`.
- Log `requestId`, `userId`, `workflowId`, latency, token counts, cancel reason, and final status.

## Next Step

Move from mock testing to port-forwarded live testing, then add OKD manifests once the local gateway can reliably reach the vLLM service.
