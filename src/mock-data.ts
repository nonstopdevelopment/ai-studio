export type ComposerMode = 'ask' | 'draft';

export interface ArtifactPreview {
  kind: string;
  title: string;
  summary: string;
  bullets: string[];
  tags: string[];
}

export interface WorkflowCard {
  id: string;
  mode: ComposerMode;
  eyebrow: string;
  title: string;
  teaser: string;
  outputType: string;
  latencyBudget: string;
  samplePrompt: string;
  sampleResponse: string;
  artifact: ArtifactPreview;
}

export interface ModeOption {
  id: ComposerMode;
  label: string;
  description: string;
}

export const modeOptions: ModeOption[] = [
  {
    id: 'ask',
    label: 'Ask',
    description: 'Standard chat with the local private-cloud model.',
  },
  {
    id: 'draft',
    label: 'Draft Files',
    description: 'Generate Markdown artifacts and project-ready files.',
  },
];

export const workflowCards: WorkflowCard[] = [
  {
    id: 'general-chat',
    mode: 'ask',
    eyebrow: 'Chat',
    title: 'General Chat',
    teaser: 'Ask a question and keep a running thread with the Tampa Devs private-cloud model.',
    outputType: 'Chat response',
    latencyBudget: 'Low',
    samplePrompt: '',
    sampleResponse: 'Ask me about Tampa, local AI infrastructure, OKD deployment, developer workflows, or community ideas.',
    artifact: {
      kind: 'Chat',
      title: 'Open Chat',
      summary: 'A standard chat lane for quick questions and follow-up context.',
      bullets: [
        'Ask natural questions.',
        'Continue the same thread in this browser tab.',
        'Use Draft Files when you want a generated Markdown artifact.',
      ],
      tags: ['Chat', 'Private Cloud', 'Tampa Devs'],
    },
  },
  {
    id: 'live-cutover-checklist',
    mode: 'ask',
    eyebrow: 'Operators',
    title: 'Live Cutover Q&A',
    teaser: 'Ask operational questions about moving from local testing to the live model path.',
    outputType: 'Answer + checklist',
    latencyBudget: 'Low',
    samplePrompt: 'What should we validate before switching this app from canned generations to the live Gemma model in our OKD namespace?',
    sampleResponse: 'Before cutting over to the live model, validate the whole request path rather than the model alone. Confirm the internal service DNS and TLS expectations, prove the gateway queue policy with two simultaneous users, cap output tokens, and capture request IDs in both the web app and inference logs. Then run a small prompt suite across your canned workflows so you can compare quality and latency against the mock shell you are building now.',
    artifact: {
      kind: 'Readiness Checklist',
      title: 'Live Model Cutover',
      summary: 'A short validation list for moving from mock outputs to the in-cluster Gemma deployment.',
      bullets: [
        'Prove internal service reachability and auth from the web app gateway.',
        'Load test queueing with two or more simultaneous users.',
        'Track request IDs, token counts, timeouts, and cancellation behavior.',
      ],
      tags: ['OKD', 'vLLM', 'Readiness'],
    },
  },
  {
    id: 'meetup-brief',
    mode: 'draft',
    eyebrow: 'Community Ops',
    title: 'Meetup Brief',
    teaser: 'Turn a rough meetup concept into a clean title, agenda, speaker ask, and promo copy.',
    outputType: 'Agenda + promo card',
    latencyBudget: 'Low',
    samplePrompt: 'Draft a Tampa Devs meetup brief for a 45-minute session on local-first AI tooling for teams. Keep it practical, welcoming, and sponsor friendly.',
    sampleResponse: 'Here is a meetup brief built for a fast internal review. Lead with a clear promise: local-first AI tooling that real teams can ship this quarter. Open with a five minute framing on why teams want private inference, move into a fifteen minute demo section, reserve ten minutes for architecture and deployment tradeoffs, and finish with sponsor thank-yous plus a concise call to action. The promo angle should emphasize practical workflows, Tampa builder energy, and a strong operator mindset rather than broad AI hype.',
    artifact: {
      kind: 'Event Brief',
      title: 'Local-First AI Tooling for Teams',
      summary: 'A practical Tampa Devs session focused on private inference, deployment tradeoffs, and fast wins for product teams.',
      bullets: [
        'Open with why teams want private inference and predictable cost.',
        'Demo a simple internal AI workflow and show operator guardrails.',
        'Close with sponsor mention, Q&A, and a clean community CTA.',
      ],
      tags: ['Meetups', 'Community', 'AI Infrastructure'],
    },
  },
  {
    id: 'sponsor-follow-up',
    mode: 'draft',
    eyebrow: 'Partnerships',
    title: 'Sponsor Follow-Up',
    teaser: 'Generate a short, brand-safe follow-up email after an event or intro call.',
    outputType: 'Email draft',
    latencyBudget: 'Low',
    samplePrompt: 'Write a sponsor follow-up email after a Tampa Devs intro call. The sponsor is interested in AI infrastructure builders and wants community visibility without sounding salesy.',
    sampleResponse: 'Subject line direction: thanks for the conversation and a few clean next steps. Keep the email warm and direct. Reference their interest in AI infrastructure builders, note that our audience values practical operator content, and suggest one lightweight next move such as a demo-backed meetup slot, a sponsor-supported workshop, or a shared landing page with a signup goal. The tone should feel grounded, local, and useful rather than like generic sponsorship outreach.',
    artifact: {
      kind: 'Email Draft',
      title: 'Sponsor Follow-Up',
      summary: 'A concise post-call email that keeps momentum without drifting into generic sponsor language.',
      bullets: [
        'Thank them for the call and restate the audience fit.',
        'Offer one to two next-step options with light operational lift.',
        'Anchor everything in useful programming, not ad inventory.',
      ],
      tags: ['Sponsors', 'Email', 'Community'],
    },
  },
  {
    id: 'deployment-brief',
    mode: 'draft',
    eyebrow: 'Engineering',
    title: 'Deployment Brief',
    teaser: 'Generate a Markdown readiness brief for OKD, session memory, object storage, and model routing.',
    outputType: 'Markdown file',
    latencyBudget: 'Medium',
    samplePrompt: 'Create a deployment readiness brief for moving Tampa Devs AI Studio from local port-forward testing into OKD. Include sections for user experience, gateway/session memory, generated artifacts, object storage, rate limiting for one loaded vLLM model, observability, rollback, and a short operator checklist. Format it as Markdown that could be saved as a project file.',
    sampleResponse: 'This deployment brief should separate user experience, gateway safety, shared session memory, artifact storage, and OKD rollout checks. Keep the document practical: what must be true before demo, what changes when more than one gateway pod exists, and what operators should watch during the first live test.',
    artifact: {
      kind: 'Markdown Brief',
      title: 'OKD Readiness Brief',
      summary: 'A generated project file for moving the AI Studio from local port-forward testing into OKD.',
      bullets: [
        'Define the live user flow and private-cloud story.',
        'Move session memory and artifacts into shared services before scaling pods.',
        'Validate rate limits, observability, rollback, and object storage.',
      ],
      tags: ['OKD', 'Artifact', 'Deployment'],
    },
  },
];
