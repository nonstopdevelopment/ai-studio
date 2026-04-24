# OKD Deploy

These manifests run the AI Studio gateway/UI as one deployable app and keep vLLM private inside the cluster.

## Assumptions

- The AI Studio app deploys into the `nonstopdev-ai` namespace.
- The vLLM OpenAI-compatible service is reachable from `nonstopdev-ai`, but it may live in a different namespace.
- `VLLM_BASE_URL` is set to `http://gemma4-27b-vllm.kuberay-system.svc.cluster.local:8000/v1`.
- The loaded model is `gemma-4-26B-A4B-it`.
- Valkey is used for demo shared state: session memory, per-user rate windows, artifact metadata, and the shared single-model slot.
- Generated artifact files are written to a PVC at `/data/artifacts`.

## Cluster Build From GitHub

Use this path when you do not want to build locally or push image layers over your home connection.

1. Push this `ai-studio` folder to `https://github.com/nonstopdevelopment/ai-studio`.
2. Apply the build/deploy manifests:

```bash
oc project nonstopdev-ai
oc apply -k deploy/okd
oc start-build ai-studio --follow
oc rollout status deploy/ai-studio
oc get route ai-studio
```

The `BuildConfig` builds the local `Dockerfile` inside OKD and writes the result to the internal `ai-studio:latest` ImageStreamTag.

## Optional Local Build And Push

Only use this if Docker is available locally and you want to push manually:

```bash
oc project nonstopdev-ai
docker build -t image-registry.openshift-image-registry.svc:5000/nonstopdev-ai/ai-studio:latest .
docker login image-registry.openshift-image-registry.svc:5000 -u $(oc whoami) -p $(oc whoami -t)
docker push image-registry.openshift-image-registry.svc:5000/nonstopdev-ai/ai-studio:latest
oc apply -k deploy/okd
oc rollout status deploy/ai-studio
oc get route ai-studio
```

## Smoke Test

```bash
ROUTE_HOST=$(oc get route ai-studio -o jsonpath='{.spec.host}')
curl -s https://$ROUTE_HOST/api/health
curl -s -X POST https://$ROUTE_HOST/api/generate \
  -H 'content-type: application/json' \
  -H 'x-user-id: smoke-user' \
  --data '{"sessionId":"smoke-user","workflowId":"general-chat","workflowTitle":"General Chat","outputFormat":"text","prompt":"Reply with one short sentence confirming the private cloud gateway is live."}'
```

## Scaling Note

The default deployment uses `replicas: 1`, which is enough for multiple testers because the gateway queues access to the single loaded model. If you scale above one gateway pod, use shared object storage or an RWX PVC for artifacts. Redis/Valkey already protects session/rate-limit state and the shared model slot.
