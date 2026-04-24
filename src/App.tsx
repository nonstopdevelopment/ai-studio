import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { clusterPolicy, formatPolicyWindow } from './lib/cluster-policy';
import {
  modeOptions,
  workflowCards,
  type ArtifactPreview,
  type ComposerMode,
  type WorkflowCard,
} from './mock-data';

type Message = {
  id: string;
  role: 'assistant' | 'user';
  content: string;
  state: 'done' | 'streaming';
};

type ButtonVariant = 'primary' | 'secondary';

type StudioButtonProps = {
  children: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  variant?: ButtonVariant;
};

type GatewayStatus = {
  modelName: string;
  serviceName: string;
  mode: string;
  activeRequests: number;
  queueDepth: number;
  completedRequests: number;
  failedRequests: number;
  estimatedWaitMs: number;
  policy: {
    maxConcurrentClusterRequests: number;
    maxQueueDepth: number;
    perUserConcurrentRequests: number;
    perUserRequestsPerMinute: number;
    minIntervalMs: number;
    requestTimeoutMs: number;
    maxOutputTokens: number;
    maxPromptChars: number;
  };
};

type GeneratedArtifact = {
  id: string;
  title: string;
  filename: string;
  mimeType: string;
  bytes: number;
  url: string;
};

type OutputFormat = 'markdown' | 'text' | 'json';

const artifactDemoPrompt =
  'Create a deployment readiness brief for moving Tampa Devs AI Studio from local port-forward testing into OKD. Include sections for user experience, gateway/session memory, generated artifacts, object storage, rate limiting for one loaded vLLM model, observability, rollback, and a short operator checklist. Format it as Markdown that could be saved as a project file.';

const welcomeMessage: Message = {
  id: 'welcome',
  role: 'assistant',
  content: 'Ask a question to chat with the private-cloud model, or switch to Draft Files when you want a generated Markdown, text, or JSON artifact.',
  state: 'done',
};

function StudioButton({ children, disabled = false, onClick, variant = 'primary' }: StudioButtonProps) {
  return (
    <button
      className={`studio-button studio-button--${variant}`}
      type="button"
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function StatTile({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="stat-tile">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function createTabSessionId() {
  return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function formatClientError(error: unknown) {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return 'Generation failed before the gateway returned a response.';
}

function renderInlineMarkdown(text: string) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g);

  return parts.map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={index}>{part.slice(1, -1)}</code>;
    }

    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }

    const linkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (linkMatch) {
      return (
        <a key={index} href={linkMatch[2]} target="_blank" rel="noreferrer">
          {linkMatch[1]}
        </a>
      );
    }

    return part;
  });
}

function MarkdownRenderer({ content }: { content: string }) {
  const blocks = content.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);

  if (blocks.length === 0) {
    return <p />;
  }

  return (
    <div className="markdown-output">
      {blocks.map((block, index) => {
        if (block.startsWith('```')) {
          const code = block.replace(/^```[a-zA-Z0-9_-]*\n?/, '').replace(/```$/, '').trim();
          return <pre key={index}><code>{code}</code></pre>;
        }

        const heading = block.match(/^(#{1,3})\s+(.+)$/);
        if (heading) {
          const HeadingTag = (`h${heading[1].length + 1}` as 'h2' | 'h3' | 'h4');
          return <HeadingTag key={index}>{renderInlineMarkdown(heading[2])}</HeadingTag>;
        }

        const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
        const isUnorderedList = lines.every((line) => /^[-*]\s+/.test(line));
        if (isUnorderedList) {
          return (
            <ul key={index}>
              {lines.map((line) => (
                <li key={line}>{renderInlineMarkdown(line.replace(/^[-*]\s+/, ''))}</li>
              ))}
            </ul>
          );
        }

        const isOrderedList = lines.every((line) => /^\d+\.\s+/.test(line));
        if (isOrderedList) {
          return (
            <ol key={index}>
              {lines.map((line) => (
                <li key={line}>{renderInlineMarkdown(line.replace(/^\d+\.\s+/, ''))}</li>
              ))}
            </ol>
          );
        }

        return <p key={index}>{renderInlineMarkdown(block)}</p>;
      })}
    </div>
  );
}

export function App() {
  const [activeMode, setActiveMode] = useState<ComposerMode>('ask');
  const [activeWorkflowId, setActiveWorkflowId] = useState(workflowCards[0].id);
  const [prompt, setPrompt] = useState(workflowCards[0].samplePrompt);
  const [messages, setMessages] = useState<Message[]>([welcomeMessage]);
  const [artifact, setArtifact] = useState<ArtifactPreview>(workflowCards[0].artifact);
  const [statusText, setStatusText] = useState('Gateway status has not loaded yet.');
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');
  const [sessionId, setSessionId] = useState(createTabSessionId);
  const [createArtifact, setCreateArtifact] = useState(false);
  const [outputFormat, setOutputFormat] = useState<OutputFormat>('markdown');
  const [generatedArtifact, setGeneratedArtifact] = useState<GeneratedArtifact | null>(null);

  const activeWorkflow = useMemo(
    () => workflowCards.find((workflow) => workflow.id === activeWorkflowId) ?? workflowCards[0],
    [activeWorkflowId]
  );

  const filteredWorkflows = useMemo(
    () => workflowCards.filter((workflow) => workflow.mode === activeMode),
    [activeMode]
  );

  useEffect(() => {
    let canceled = false;

    async function refreshStatus() {
      try {
        const response = await fetch('/api/status');
        if (!response.ok) {
          throw new Error(`Gateway status failed with ${response.status}`);
        }

        const nextStatus = (await response.json()) as GatewayStatus;
        if (!canceled) {
          applyGatewayStatus(nextStatus);
          setStatusText(
            nextStatus.mode === 'live'
              ? `Live gateway ready for ${nextStatus.modelName}.`
              : 'Mock gateway ready.'
          );
        }
      } catch {
        if (!canceled) {
          setStatusText('Gateway offline. Start pnpm dev:api before running prompts.');
        }
      }
    }

    void refreshStatus();
    const interval = window.setInterval(refreshStatus, 2500);
    return () => {
      canceled = true;
      window.clearInterval(interval);
    };
  }, []);

  function applyGatewayStatus(nextStatus: GatewayStatus) {
    setGatewayStatus(nextStatus);
  }

  function loadWorkflow(workflow: WorkflowCard) {
    setActiveMode(workflow.mode);
    setActiveWorkflowId(workflow.id);
    setPrompt(workflow.samplePrompt);
    setCreateArtifact(workflow.mode === 'draft');
    setArtifact(workflow.artifact);
    setStatusText(`${workflow.title} loaded.`);
  }

  function activateMode(mode: ComposerMode) {
    const workflowForMode =
      workflowCards.find((workflow) => workflow.mode === mode) ?? workflowCards[0];
    loadWorkflow(workflowForMode);
  }

  function loadArtifactDemo() {
    setActiveMode('draft');
    setActiveWorkflowId('deployment-brief');
    setPrompt(artifactDemoPrompt);
    setCreateArtifact(true);
    setStatusText('Artifact demo prompt loaded.');
  }

  function startNewChat() {
    setSessionId(createTabSessionId());
    setMessages([{ ...welcomeMessage, id: `welcome-${Date.now()}` }]);
    setGeneratedArtifact(null);
    setCopyState('idle');
    setStatusText('Started a new chat with fresh context.');
  }

  async function submitPrompt() {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      setStatusText('Add a prompt before starting a generation.');
      return;
    }

    if (isGenerating) {
      setStatusText('This browser already has a request in progress.');
      return;
    }

    const stamp = Date.now();
    const userMessageId = `user-${stamp}`;
    const assistantMessageId = `assistant-${stamp}`;
    setIsGenerating(true);
    setCopyState('idle');
    setStatusText('Submitted to gateway.');
    setMessages((current) => [
      ...current,
      {
        id: userMessageId,
        role: 'user',
        content: trimmedPrompt,
        state: 'done',
      },
      {
        id: assistantMessageId,
        role: 'assistant',
        content: 'Waiting for gateway response...',
        state: 'streaming',
      },
    ]);

    try {
      const response = await fetch('/api/generate', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-user-id': sessionId,
        },
        body: JSON.stringify({
          prompt: trimmedPrompt,
          sessionId,
          workflowId: activeWorkflow.id,
          workflowTitle: activeWorkflow.title,
          sampleResponse: activeWorkflow.sampleResponse,
          createArtifact,
          outputFormat,
        }),
      });

      const responseText = await response.text();
      let body;
      try {
        body = responseText ? JSON.parse(responseText) : {};
      } catch {
        throw new Error(
          responseText
            ? `Gateway returned a non-JSON response: ${responseText.slice(0, 160)}`
            : 'Gateway returned an empty response. The route or model request may have timed out.'
        );
      }
      if (!response.ok) {
        const retryAfter =
          typeof body.retryAfterMs === 'number'
            ? ` Retry in about ${formatPolicyWindow(body.retryAfterMs)}.`
            : '';
        const gatewayMessage = body.message ? ` ${body.message}` : '';
        throw new Error(`${body.error ?? 'generation_failed'}.${gatewayMessage}${retryAfter}`);
      }

      if (body.status) {
        applyGatewayStatus(body.status);
      }

      setGeneratedArtifact(body.artifact ?? null);
      setArtifact(activeWorkflow.artifact);
      setStatusText(
        `${activeWorkflow.title} completed in ${formatPolicyWindow(body.latencyMs ?? 0)}. Session memory has ${body.memory?.messageCount ?? messages.length} messages.`
      );
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantMessageId
            ? {
                ...message,
                content: String(body.text ?? ''),
                state: 'done',
              }
            : message
        )
      );
    } catch (error) {
      const message = formatClientError(error);
      setStatusText(message);
      setMessages((current) =>
        current.map((item) =>
          item.id === assistantMessageId
            ? {
                ...item,
                content: `Gateway error: ${message}`,
                state: 'done',
              }
            : item
        )
      );
    } finally {
      setIsGenerating(false);
    }
  }

  const policy = gatewayStatus?.policy ?? clusterPolicy;
  const latestAssistantMessage =
    [...messages].reverse().find((message) => message.role === 'assistant') ?? messages[0];
  const latestUserMessage = [...messages].reverse().find((message) => message.role === 'user');
  const isThinking = latestAssistantMessage?.state === 'streaming';

  async function copyResponse() {
    if (!latestAssistantMessage?.content) {
      return;
    }

    try {
      await navigator.clipboard.writeText(latestAssistantMessage.content);
      setCopyState('copied');
      window.setTimeout(() => setCopyState('idle'), 1400);
    } catch {
      setStatusText('Copy failed. Select the response text manually.');
    }
  }

  return (
    <div className="studio-app">
      <header className="studio-topbar">
        <div className="project-mark" aria-label="OnTampa community AI lab">
          <span className="pirate-mark" aria-hidden="true">
            <img src="/ontampa-pirate.png" alt="" />
          </span>
          <span className="project-mark__text">
            <strong>OnTampa Lab</strong>
            <small>Private cloud demo</small>
          </span>
        </div>
        <div className="studio-topbar__center">
          <h1>Private Cloud AI Studio</h1>
          <p>{statusText}</p>
        </div>
        <div className="studio-topbar__status">
          <span className={`status-dot status-dot--${gatewayStatus ? 'online' : 'offline'}`} />
          <span>{gatewayStatus?.mode === 'live' ? 'private cloud live' : gatewayStatus?.mode ?? 'offline'}</span>
        </div>
      </header>

      <main className="studio-workspace">
        <aside className="workflow-panel">
          <div className="mode-tabs" aria-label="Workflow mode">
            {modeOptions.map((mode) => (
              <button
                key={mode.id}
                className={activeMode === mode.id ? 'is-active' : undefined}
                type="button"
                onClick={() => activateMode(mode.id)}
              >
                {mode.label}
              </button>
            ))}
          </div>

          <div className="workflow-list">
            {filteredWorkflows.map((workflow) => (
              <button
                key={workflow.id}
                className={activeWorkflowId === workflow.id ? 'workflow-card is-active' : 'workflow-card'}
                type="button"
                onClick={() => loadWorkflow(workflow)}
              >
                <span>{workflow.eyebrow}</span>
                <strong>{workflow.title}</strong>
                <small>{workflow.outputType}</small>
              </button>
            ))}
          </div>
        </aside>

        <section className="prompt-panel">
          <div className="panel-heading">
            <div>
              <span>Workspace</span>
              <h2>{activeWorkflow.title}</h2>
            </div>
            <span className="session-pill">Session memory on</span>
            <StudioButton variant="secondary" disabled={isGenerating} onClick={startNewChat}>
              New chat
            </StudioButton>
          </div>

          <label className="prompt-label" htmlFor="studio-prompt">
            Prompt
          </label>
          <textarea
            id="studio-prompt"
            className="prompt-input"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={9}
          />

          <div className="composer-actions">
            {activeMode === 'draft' ? (
              <label className="artifact-toggle">
                <input
                  type="checkbox"
                  checked={createArtifact}
                  onChange={(event) => setCreateArtifact(event.target.checked)}
                />
                <span>Create Markdown artifact</span>
              </label>
            ) : null}
            {activeMode === 'draft' ? (
              <StudioButton variant="secondary" onClick={loadArtifactDemo}>
              Load artifact demo
              </StudioButton>
            ) : null}
            <label className="format-select">
              <span>Format</span>
              <select
                value={outputFormat}
                onChange={(event) => setOutputFormat(event.target.value as OutputFormat)}
              >
                <option value="markdown">Markdown</option>
                <option value="text">Text</option>
                <option value="json">JSON</option>
              </select>
            </label>
            <StudioButton disabled={isGenerating} onClick={submitPrompt}>
              {isGenerating ? 'Running' : activeMode === 'draft' ? 'Draft File' : 'Ask'}
            </StudioButton>
          </div>

          <div className="prompt-context">
            <span>Current workflow</span>
            <p>{activeWorkflow.teaser}</p>
            {latestUserMessage ? <small>Last submitted prompt is shown in the review panel.</small> : null}
          </div>

          <section className="chat-thread" aria-label="Conversation thread">
            <div className="thread-heading">
              <span>Conversation</span>
              <strong>{messages.length} messages</strong>
            </div>
            <div className="thread-list">
              {messages.map((message) => (
                <article key={message.id} className={`thread-message thread-message--${message.role}`}>
                  <div>
                    <span>{message.role === 'assistant' ? 'AI Studio' : 'User'}</span>
                    <span>{message.state}</span>
                  </div>
                  <p>{message.content}</p>
                </article>
              ))}
            </div>
          </section>
        </section>

        <section className="review-panel">
          <article className="response-panel">
            <div className="panel-heading response-heading">
              <div>
                <span>Response review</span>
                <h2>{activeWorkflow.title}</h2>
              </div>
              <StudioButton variant="secondary" disabled={!latestAssistantMessage?.content} onClick={copyResponse}>
                {copyState === 'copied' ? 'Copied' : 'Copy'}
              </StudioButton>
            </div>

            <div className="response-meta">
              <span>{latestAssistantMessage.state}</span>
              <span>{gatewayStatus?.modelName ?? clusterPolicy.modelName}</span>
              <span>Community private cloud</span>
              <span>{sessionId.slice(0, 8)} session</span>
              <span>{outputFormat}</span>
              <span>{activeWorkflow.outputType}</span>
            </div>

            {latestUserMessage ? (
              <div className="submitted-prompt">
                <span>Prompt sent</span>
                <p>{latestUserMessage.content}</p>
              </div>
            ) : null}

            <div className={`response-body response-body--${latestAssistantMessage.state}`}>
              {isThinking ? (
                <div className="thinking-card" role="status" aria-live="polite">
                  <div className="thinking-orbit">
                    <span />
                    <span />
                    <span />
                  </div>
                  <div>
                    <strong>Thinking through the local model</strong>
                    <p>
                      The request is queued safely through the gateway while Gemma prepares a response.
                    </p>
                  </div>
                </div>
              ) : (
                outputFormat === 'markdown' ? (
                  <MarkdownRenderer content={latestAssistantMessage.content} />
                ) : (
                  <pre className={`raw-output raw-output--${outputFormat}`}>
                    <code>{latestAssistantMessage.content}</code>
                  </pre>
                )
              )}
            </div>

            {generatedArtifact ? (
              <a className="artifact-link" href={generatedArtifact.url} target="_blank" rel="noreferrer">
                <span>Generated file</span>
                <strong>{generatedArtifact.filename}</strong>
                <small>{Math.ceil(generatedArtifact.bytes / 1024)} KB Markdown artifact</small>
              </a>
            ) : null}
          </article>
        </section>
      </main>

      <details className="studio-details">
        <summary>
          <span>Studio details</span>
          <strong>{gatewayStatus?.modelName ?? clusterPolicy.modelName}</strong>
        </summary>
        <div className="details-grid">
          <section className="artifact-panel">
            <div className="panel-heading panel-heading--compact">
              <div>
                <span>Structured output</span>
                <h2>{artifact.title}</h2>
              </div>
            </div>
            <p>{artifact.summary}</p>
            <ul>
              {artifact.bullets.map((bullet) => (
                <li key={bullet}>{bullet}</li>
              ))}
            </ul>
            <div className="tag-row">
              {artifact.tags.map((tag) => (
                <span key={tag}>{tag}</span>
              ))}
            </div>
            {generatedArtifact ? (
              <a className="details-artifact-link" href={generatedArtifact.url} target="_blank" rel="noreferrer">
                Open generated temp artifact: {generatedArtifact.filename}
              </a>
            ) : null}
          </section>

          <section className="gateway-panel">
            <div className="panel-heading panel-heading--compact">
              <div>
                <span>Private cloud gateway</span>
                <h2>{gatewayStatus?.mode === 'live' ? 'Live model route' : 'Mock route'}</h2>
              </div>
            </div>
            <div className="stat-grid">
              <StatTile label="Active" value={gatewayStatus?.activeRequests ?? 0} />
              <StatTile label="Queue" value={gatewayStatus?.queueDepth ?? 0} />
              <StatTile label="Done" value={gatewayStatus?.completedRequests ?? 0} />
              <StatTile label="Failed" value={gatewayStatus?.failedRequests ?? 0} />
            </div>
            <dl className="service-list">
              <div>
                <dt>Endpoint</dt>
                <dd>{gatewayStatus?.serviceName ?? clusterPolicy.serviceName}</dd>
              </div>
              <div>
                <dt>Per-user</dt>
                <dd>
                  {policy.perUserConcurrentRequests} inflight / {policy.perUserRequestsPerMinute} rpm
                </dd>
              </div>
              <div>
                <dt>Timeout</dt>
                <dd>{formatPolicyWindow(policy.requestTimeoutMs)}</dd>
              </div>
              <div>
                <dt>Max output</dt>
                <dd>{policy.maxOutputTokens} tokens</dd>
              </div>
            </dl>
          </section>
        </div>
      </details>
    </div>
  );
}
