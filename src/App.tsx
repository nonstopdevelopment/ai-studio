import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { clusterPolicy, formatPolicyWindow } from './lib/cluster-policy';
import {
  workflowCards,
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

type ChatThread = {
  id: string;
  title: string;
  subtitle: string;
  sessionId: string;
  messages?: Message[];
  updatedAt: string;
};

type AuthConfig = {
  enabled: boolean;
  authMode: 'optional' | 'required' | string;
  authorizeUrl: string;
  clientId: string;
  redirectUri: string;
  scopes: string;
};

type AuthProfile = {
  authenticated: boolean;
  id: string;
  name: string;
  email: string;
  avatarUrl: string;
  authMode: string;
};

type AdminJob = {
  requestId: string;
  userId: string;
  sessionId: string;
  workflowId: string;
  outputFormat: string;
  status: string;
  queuedAt: string;
  startedAt: string | null;
  completedAt?: string;
  queuedMs: number;
  runningMs: number;
  latencyMs?: number;
  totalMs?: number;
  promptChars: number;
  outputChars?: number;
  totalTokens?: number | null;
  error?: string | null;
};

type AdminMetrics = {
  generatedAt: string;
  status: GatewayStatus & { sharedStorage?: string };
  throughput: {
    recentCompleted: number;
    recentFailed: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
    maxLatencyMs: number;
  };
  activeJobs: AdminJob[];
  queuedJobs: AdminJob[];
  recentRequests: AdminJob[];
};

const examplePrompts = [
  {
    icon: '📅',
    title: 'What events are happening this week?',
    prompt: 'What Tampa Bay developer or startup events should I pay attention to this week?',
  },
  {
    icon: '👥',
    title: 'How do I join Tampa Devs?',
    prompt: 'How do I join Tampa Devs and start meeting people in the community?',
  },
  {
    icon: '🏆',
    title: 'Tell me about BayHacks',
    prompt: 'Tell me about BayHacks and what someone should know before registering.',
  },
  {
    icon: '🤝',
    title: 'How do I become a sponsor?',
    prompt: 'How should a company think about sponsoring Tampa Devs without sounding salesy?',
  },
  {
    icon: '💼',
    title: 'Tell me about the Talent Network',
    prompt: 'Explain the Tampa Devs Talent Network and who it helps.',
  },
  {
    icon: '🧑‍💻',
    title: 'How does mentorship work?',
    prompt: 'How could mentorship work for Tampa Bay developers who are early in their careers?',
  },
];

const authTokenStorageKey = 'ai-studio-auth-token';
const authVerifierStorageKey = 'ai-studio-auth-verifier';

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

function AdminDashboard() {
  const [token, setToken] = useState(() => window.localStorage.getItem('ai-studio-admin-token') ?? '');
  const [draftToken, setDraftToken] = useState(token);
  const [metrics, setMetrics] = useState<AdminMetrics | null>(null);
  const [error, setError] = useState('');
  const [isPaused, setIsPaused] = useState(false);

  useEffect(() => {
    let canceled = false;

    async function refreshMetrics() {
      if (!token || isPaused) {
        return;
      }

      try {
        const response = await fetch('/api/admin/metrics', {
          headers: {
            authorization: `Bearer ${token}`,
          },
        });
        const body = await response.json();
        if (!response.ok) {
          throw new Error(body.error ?? `Admin metrics failed with ${response.status}`);
        }

        if (!canceled) {
          setMetrics(body as AdminMetrics);
          setError('');
        }
      } catch (refreshError) {
        if (!canceled) {
          setError(formatClientError(refreshError));
        }
      }
    }

    void refreshMetrics();
    const interval = window.setInterval(refreshMetrics, 3000);
    return () => {
      canceled = true;
      window.clearInterval(interval);
    };
  }, [token, isPaused]);

  function saveToken() {
    const nextToken = draftToken.trim();
    setToken(nextToken);
    window.localStorage.setItem('ai-studio-admin-token', nextToken);
  }

  function clearToken() {
    setToken('');
    setDraftToken('');
    setMetrics(null);
    window.localStorage.removeItem('ai-studio-admin-token');
  }

  return (
    <div className="studio-app admin-app">
      <header className="studio-topbar">
        <div className="project-mark" aria-label="OnTampa private monitor">
          <span className="pirate-mark" aria-hidden="true">
            <img src="/ontampa-pirate.png" alt="" />
          </span>
          <span className="project-mark__text">
            <strong>Ops Monitor</strong>
            <small>Private queue view</small>
          </span>
        </div>
        <div className="studio-topbar__center">
          <h1>AI Studio Operations</h1>
          <p>
            {metrics
              ? `Updated ${new Date(metrics.generatedAt).toLocaleTimeString()} from ${metrics.status.sharedStorage ?? 'gateway'} storage.`
              : 'Enter the admin token to monitor queue and request timing.'}
          </p>
        </div>
        <a className="admin-return-link" href="/">
          Back to studio
        </a>
      </header>

      <main className="admin-shell">
        <section className="admin-auth-panel">
          <label className="prompt-label" htmlFor="admin-token">
            Admin token
          </label>
          <input
            id="admin-token"
            className="admin-token-input"
            type="password"
            value={draftToken}
            onChange={(event) => setDraftToken(event.target.value)}
            placeholder="Paste ADMIN_TOKEN"
          />
          <div className="composer-actions">
            <StudioButton variant="secondary" onClick={() => setIsPaused((current) => !current)}>
              {isPaused ? 'Resume' : 'Pause'}
            </StudioButton>
            <StudioButton variant="secondary" onClick={clearToken}>
              Clear
            </StudioButton>
            <StudioButton onClick={saveToken}>Connect</StudioButton>
          </div>
          {error ? <p className="admin-error">{error}</p> : null}
        </section>

        {metrics ? (
          <>
            <section className="admin-grid">
              <StatTile label="Active" value={metrics.status.activeRequests} />
              <StatTile label="Queued" value={metrics.status.queueDepth} />
              <StatTile label="Avg latency" value={formatPolicyWindow(metrics.throughput.avgLatencyMs)} />
              <StatTile label="P95 latency" value={formatPolicyWindow(metrics.throughput.p95LatencyMs)} />
              <StatTile label="Completed" value={metrics.status.completedRequests} />
              <StatTile label="Failed" value={metrics.status.failedRequests} />
              <StatTile label="Recent ok" value={metrics.throughput.recentCompleted} />
              <StatTile label="Recent failed" value={metrics.throughput.recentFailed} />
            </section>

            <section className="admin-panels">
              <AdminJobTable title="Active jobs" jobs={metrics.activeJobs} empty="No active model request." />
              <AdminJobTable title="Queued jobs" jobs={metrics.queuedJobs} empty="Queue is empty." />
              <AdminJobTable title="Recent requests" jobs={metrics.recentRequests} empty="No completed requests yet." />
            </section>
          </>
        ) : null}
      </main>
    </div>
  );
}

function AdminJobTable({ title, jobs, empty }: { title: string; jobs: AdminJob[]; empty: string }) {
  return (
    <section className="admin-table-panel">
      <div className="panel-heading panel-heading--compact">
        <div>
          <span>Queue monitor</span>
          <h2>{title}</h2>
        </div>
        <strong>{jobs.length}</strong>
      </div>
      {jobs.length === 0 ? (
        <p className="admin-empty">{empty}</p>
      ) : (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Workflow</th>
                <th>User</th>
                <th>Queued</th>
                <th>Run</th>
                <th>Total</th>
                <th>Tokens</th>
                <th>Request</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={`${title}-${job.requestId}`}>
                  <td>
                    <span className={`admin-status admin-status--${job.status}`}>{job.status}</span>
                  </td>
                  <td>{job.workflowId}</td>
                  <td>{job.userId}</td>
                  <td>{formatPolicyWindow(job.queuedMs)}</td>
                  <td>{formatPolicyWindow(job.latencyMs ?? job.runningMs)}</td>
                  <td>{formatPolicyWindow(job.totalMs ?? job.queuedMs + job.runningMs)}</td>
                  <td>{job.totalTokens ?? '-'}</td>
                  <td title={job.requestId}>{job.requestId.slice(0, 8)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function createTabSessionId() {
  return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function getAuthToken() {
  return window.sessionStorage.getItem(authTokenStorageKey) ?? '';
}

function getAuthHeaders(authToken: string, fallbackSessionId: string): Record<string, string> {
  if (authToken) {
    return { authorization: `Bearer ${authToken}` };
  }

  return { 'x-user-id': fallbackSessionId };
}

function mapServerThread(thread: ChatThread): ChatThread {
  return {
    id: thread.id,
    title: thread.title,
    subtitle: thread.subtitle || 'Saved chat',
    sessionId: thread.sessionId,
    messages: thread.messages ?? [],
    updatedAt: formatThreadTimestamp(thread.updatedAt),
  };
}

function formatThreadTimestamp(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return value || 'Just now';
  }

  const seconds = Math.max(1, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) {
    return 'Just now';
  }
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)} min ago`;
  }
  if (seconds < 86400) {
    return `${Math.round(seconds / 3600)} hr ago`;
  }

  return `${Math.round(seconds / 86400)} days ago`;
}

function createCodeVerifier() {
  const bytes = new Uint8Array(32);
  window.crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function createCodeChallenge(verifier: string) {
  const encoded = new TextEncoder().encode(verifier);
  const digest = await window.crypto.subtle.digest('SHA-256', encoded);
  return base64Url(new Uint8Array(digest));
}

function base64Url(bytes: Uint8Array) {
  return window.btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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
  if (window.location.pathname.startsWith('/admin')) {
    return <AdminDashboard />;
  }

  const [activeMode, setActiveMode] = useState<ComposerMode>('ask');
  const [activeWorkflowId, setActiveWorkflowId] = useState(workflowCards[0].id);
  const [prompt, setPrompt] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState('new-thread');
  const [, setStatusText] = useState('');
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [sessionId, setSessionId] = useState(createTabSessionId);
  const [createArtifact, setCreateArtifact] = useState(false);
  const [outputFormat, setOutputFormat] = useState<OutputFormat>('text');
  const [generatedArtifact, setGeneratedArtifact] = useState<GeneratedArtifact | null>(null);
  const [authConfig, setAuthConfig] = useState<AuthConfig | null>(null);
  const [authToken, setAuthToken] = useState(getAuthToken);
  const [authProfile, setAuthProfile] = useState<AuthProfile | null>(null);
  const [authStatus, setAuthStatus] = useState('Guest workspace');
  const [showComposerTools, setShowComposerTools] = useState(false);
  const threadEndRef = useRef<HTMLDivElement | null>(null);

  const activeWorkflow = useMemo(
    () => workflowCards.find((workflow) => workflow.id === activeWorkflowId) ?? workflowCards[0],
    [activeWorkflowId]
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

  useEffect(() => {
    let canceled = false;

    async function loadAuth() {
      try {
        const response = await fetch('/api/auth/config');
        const config = (await response.json()) as AuthConfig;
        if (canceled) {
          return;
        }

        setAuthConfig(config);

        const callbackUrl = new URL(window.location.href);
        const code = callbackUrl.searchParams.get('code');
        if (config.enabled && code) {
          const verifier = window.sessionStorage.getItem(authVerifierStorageKey) ?? '';
          const tokenResponse = await fetch('/api/auth/token', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              code,
              codeVerifier: verifier,
              redirectUri: config.redirectUri || window.location.origin,
            }),
          });
          const tokenBody = await tokenResponse.json();
          if (!tokenResponse.ok) {
            throw new Error(tokenBody.message ?? tokenBody.error ?? 'Tampa.dev sign-in failed.');
          }

          window.sessionStorage.setItem(authTokenStorageKey, tokenBody.accessToken);
          window.sessionStorage.removeItem(authVerifierStorageKey);
          setAuthToken(tokenBody.accessToken);
          window.history.replaceState({}, document.title, window.location.pathname);
          setAuthStatus('Signed in with Tampa.dev.');
          return;
        }

        if (!config.enabled) {
          setAuthStatus('Guest workspace. Tampa.dev auth is not configured yet.');
        }
      } catch (error) {
        if (!canceled) {
          setAuthStatus(formatClientError(error));
        }
      }
    }

    void loadAuth();
    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    let canceled = false;

    async function loadWorkspace() {
      try {
        const profileResponse = await fetch('/api/me', {
          headers: getAuthHeaders(authToken, sessionId),
        });
        const profile = (await profileResponse.json()) as AuthProfile;
        if (!profileResponse.ok) {
          throw new Error((profile as unknown as { message?: string }).message ?? 'Could not load workspace profile.');
        }

        if (canceled) {
          return;
        }

        setAuthProfile(profile);
        setAuthStatus(profile.authenticated ? `Signed in as ${profile.name}.` : 'Guest workspace.');

        const threadResponse = await fetch('/api/threads', {
          headers: getAuthHeaders(authToken, sessionId),
        });
        const threadBody = await threadResponse.json();
        if (threadResponse.ok && Array.isArray(threadBody.threads) && !canceled) {
          setThreads(profile.authenticated ? threadBody.threads.map(mapServerThread) : []);
        }
      } catch (error) {
        if (!canceled) {
          setAuthStatus(formatClientError(error));
        }
      }
    }

    void loadWorkspace();
    return () => {
      canceled = true;
    };
  }, [authToken]);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, isGenerating]);

  function applyGatewayStatus(nextStatus: GatewayStatus) {
    setGatewayStatus(nextStatus);
  }

  async function signIn() {
    if (!authConfig?.enabled) {
      setAuthStatus('Tampa.dev auth is waiting on OAuth client configuration.');
      return;
    }

    const verifier = createCodeVerifier();
    const challenge = await createCodeChallenge(verifier);
    window.sessionStorage.setItem(authVerifierStorageKey, verifier);

    const authorizeUrl = new URL(authConfig.authorizeUrl);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', authConfig.clientId);
    authorizeUrl.searchParams.set('redirect_uri', authConfig.redirectUri || window.location.origin);
    authorizeUrl.searchParams.set('scope', authConfig.scopes);
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    window.location.assign(authorizeUrl.toString());
  }

  function signOut() {
    window.sessionStorage.removeItem(authTokenStorageKey);
    window.sessionStorage.removeItem(authVerifierStorageKey);
    setAuthToken('');
    setAuthProfile(null);
    setThreads([]);
    setMessages([]);
    setPrompt('');
    setActiveThreadId('new-thread');
    setSessionId(createTabSessionId());
    setAuthStatus('Signed out. Using guest workspace.');
  }

  function loadWorkflow(workflow: WorkflowCard) {
    setActiveMode(workflow.mode);
    setActiveWorkflowId(workflow.id);
    setPrompt(workflow.mode === 'draft' ? workflow.samplePrompt : '');
    setCreateArtifact(workflow.mode === 'draft');
    setOutputFormat(workflow.mode === 'draft' ? 'markdown' : 'text');
    setStatusText(`${workflow.title} loaded.`);
  }

  function startNewChat() {
    if (!isSignedIn) {
      setAuthStatus('Sign in with Tampa.dev to start a private chat.');
      return;
    }

    const nextSessionId = createTabSessionId();
    const nextThreadId = `thread-${Date.now().toString(36)}`;
    setSessionId(nextSessionId);
    setActiveThreadId(nextThreadId);
    setMessages([]);
    setGeneratedArtifact(null);
    setPrompt('');
    setActiveMode('ask');
    setActiveWorkflowId('general-chat');
    setOutputFormat('text');
    setCreateArtifact(false);
    setShowComposerTools(false);
    setStatusText('Started a new chat with fresh context.');
  }

  async function loadThread(thread: ChatThread) {
    let nextThread = thread;
    if (authToken) {
      try {
        const response = await fetch(`/api/threads/${thread.id}`, {
          headers: getAuthHeaders(authToken, sessionId),
        });
        const body = await response.json();
        if (response.ok && body.thread) {
          nextThread = mapServerThread(body.thread);
        }
      } catch {
        nextThread = thread;
      }
    }

    setActiveThreadId(nextThread.id);
    setSessionId(nextThread.sessionId);
    setMessages(nextThread.messages ?? []);
    setGeneratedArtifact(null);
    setStatusText(`${nextThread.title} loaded.`);
  }

  function updateThread(nextMessages: Message[], nextTitle?: string, threadIdOverride?: string) {
    const requestedThreadId = threadIdOverride || activeThreadId;
    const existingThread = threads.find((thread) => thread.id === requestedThreadId);
    const resolvedThreadId =
      existingThread || requestedThreadId !== 'new-thread' ? requestedThreadId : `thread-${Date.now().toString(36)}`;
    const fallbackTitle =
      nextMessages.find((message) => message.role === 'user')?.content.slice(0, 44) || 'New workspace chat';

    if (!existingThread) {
      setActiveThreadId(resolvedThreadId);
    }

    setThreads((current) => {
      const nextThread: ChatThread = {
        id: resolvedThreadId,
        title: nextTitle || existingThread?.title || fallbackTitle,
        subtitle: activeWorkflow.title,
        sessionId,
        messages: nextMessages,
        updatedAt: 'Just now',
      };
      return [nextThread, ...current.filter((thread) => thread.id !== resolvedThreadId)].slice(0, 8);
    });
  }

  async function deleteThread(threadId: string) {
    const nextThreads = threads.filter((thread) => thread.id !== threadId);
    setThreads(nextThreads);

    if (authToken) {
      try {
        await fetch(`/api/threads/${threadId}`, {
          method: 'DELETE',
          headers: getAuthHeaders(authToken, sessionId),
        });
      } catch {
        setStatusText('Could not delete the saved thread from the gateway.');
      }
    }

    if (threadId === activeThreadId) {
      const nextThread = nextThreads[0];
      if (nextThread) {
        await loadThread(nextThread);
      } else {
        startNewChat();
      }
    }
  }

  async function submitPrompt() {
    if (!isSignedIn) {
      setAuthStatus('Sign in with Tampa.dev to continue.');
      return;
    }

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
    const requestThreadId = activeThreadId === 'new-thread' ? `thread-${stamp.toString(36)}` : activeThreadId;
    const userMessageId = `user-${stamp}`;
    const assistantMessageId = `assistant-${stamp}`;
    setIsGenerating(true);
    setPrompt('');
    setStatusText('Submitted to gateway.');
    setMessages((current) => {
      const nextMessages = [
        ...current,
        {
          id: userMessageId,
          role: 'user' as const,
          content: trimmedPrompt,
          state: 'done' as const,
        },
        {
          id: assistantMessageId,
          role: 'assistant' as const,
          content: 'Waiting for gateway response...',
          state: 'streaming' as const,
        },
      ];
      updateThread(nextMessages, trimmedPrompt.slice(0, 44), requestThreadId);
      return nextMessages;
    });

    try {
      const response = await fetch('/api/generate', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...getAuthHeaders(authToken, sessionId),
        },
        body: JSON.stringify({
          prompt: trimmedPrompt,
          sessionId,
          threadId: requestThreadId,
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
      setStatusText(
        `${activeWorkflow.title} completed in ${formatPolicyWindow(body.latencyMs ?? 0)}. Session memory has ${body.memory?.messageCount ?? messages.length} messages.`
      );
      setMessages((current) => {
        const nextMessages = current.map((message) =>
          message.id === assistantMessageId
            ? {
                ...message,
                content: String(body.text ?? ''),
                state: 'done' as const,
              }
            : message
        );
        updateThread(nextMessages);
        return nextMessages;
      });
    } catch (error) {
      const message = formatClientError(error);
      setStatusText(message);
      setMessages((current) => {
        const nextMessages = current.map((item) =>
          item.id === assistantMessageId
            ? {
                ...item,
                content: `Gateway error: ${message}`,
                state: 'done' as const,
              }
            : item
        );
        updateThread(nextMessages);
        return nextMessages;
      });
    } finally {
      setIsGenerating(false);
    }
  }

  const hasStartedChat = messages.some((message) => message.role === 'user');
  const isSignedIn = Boolean(authProfile?.authenticated && authToken);
  const askWorkflows = workflowCards.filter((workflow) => workflow.mode === 'ask');
  const draftWorkflow = workflowCards.find((workflow) => workflow.id === 'deployment-brief') ?? workflowCards[0];

  return (
    <div className="workspace-app">
      <aside className="workspace-sidebar">
        <div className="workspace-brand">
          <span className="workspace-logo">
            <img src="/ontampa-pirate.png" alt="" />
          </span>
          <strong>
            Tampa<span>.dev</span> AI
          </strong>
        </div>

        <button className="new-chat-button" type="button" onClick={startNewChat} disabled={isGenerating || !isSignedIn}>
          <span>+</span>
          New Chat
        </button>

        <section className="workspace-recent">
          <span>Your Chats</span>
          <div className="recent-thread-list">
            {isSignedIn && threads.length === 0 ? <p className="recent-empty">No saved chats yet.</p> : null}
            {!isSignedIn ? <p className="recent-empty">Sign in to see your private chat history.</p> : null}
            {isSignedIn
              ? threads.map((thread) => (
                  <div
                    key={thread.id}
                    className={thread.id === activeThreadId ? 'recent-thread is-active' : 'recent-thread'}
                  >
                    <button type="button" onClick={() => void loadThread(thread)}>
                      <span className="recent-thread__icon">●</span>
                      <span>
                        <strong>{thread.title}</strong>
                        <small>{thread.updatedAt}</small>
                      </span>
                    </button>
                    <button
                      className="recent-thread__delete"
                      type="button"
                      aria-label={`Delete ${thread.title}`}
                      onClick={() => void deleteThread(thread.id)}
                    >
                      ×
                    </button>
                  </div>
                ))
              : null}
          </div>
        </section>

        <section className="identity-card">
          <div className="identity-avatar">
            {authProfile?.name?.slice(0, 1).toUpperCase() || (authProfile?.authenticated ? 'T' : 'G')}
          </div>
          <div className="identity-copy">
            <strong>{authProfile?.authenticated ? authProfile.name : 'Private workspace'}</strong>
            <small>{authProfile?.authenticated ? 'Signed in with Tampa.dev' : 'Sign in to use the studio'}</small>
            {authProfile?.authenticated ? (
              <button type="button" onClick={signOut}>
                Sign out
              </button>
            ) : (
              <button type="button" onClick={() => void signIn()} disabled={!authConfig?.enabled}>
                Sign in with Tampa.dev
              </button>
            )}
          </div>
        </section>
      </aside>

      <section className="workspace-main">
        <header className="workspace-topbar">
          <div>
            <button className="menu-button" type="button" aria-label="Open workspace menu">☰</button>
            <strong>Tampa Devs AI</strong>
          </div>
          <div className="workspace-status">
            <span>{gatewayStatus?.modelName ?? clusterPolicy.modelName}</span>
            <span className="status-dot status-dot--online" />
            <strong>{gatewayStatus?.mode === 'live' ? 'Online' : gatewayStatus?.mode ?? 'Offline'}</strong>
          </div>
        </header>

        <main className="workspace-chat">
          <section className="workspace-thread" aria-label="Conversation thread">
            {!isSignedIn ? (
              <div className="signin-panel">
                <span className="hero-logo">
                  <img src="/ontampa-pirate.png" alt="" />
                </span>
                <h1>Private Tampa.dev AI</h1>
                <p>Sign in with Tampa.dev to use the community AI studio and keep your chats in your own workspace.</p>
                <StudioButton onClick={() => void signIn()} disabled={!authConfig?.enabled}>
                  Sign in with Tampa.dev
                </StudioButton>
              </div>
            ) : !hasStartedChat ? (
              <div className="thread-starter">
                <h1>How can I help?</h1>
                <p>Ask a question, pick an example, or start a new thread from the sidebar.</p>
                <div className="example-grid example-grid--compact">
                  {examplePrompts.slice(0, 4).map((example) => (
                    <button
                      key={example.title}
                      className="example-tile"
                      type="button"
                      onClick={() => {
                        setPrompt(example.prompt);
                        setActiveMode('ask');
                        setActiveWorkflowId(askWorkflows[0]?.id ?? 'general-chat');
                        setOutputFormat('text');
                        setCreateArtifact(false);
                      }}
                    >
                      <span>{example.icon}</span>
                      <strong>{example.title}</strong>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {messages.map((message) => (
              <article key={message.id} className={`workspace-message workspace-message--${message.role}`}>
                <div className="workspace-message__avatar">{message.role === 'assistant' ? 'AI' : 'You'}</div>
                <div className="workspace-message__body">
                  <span>{message.role === 'assistant' ? 'Tampa.dev AI' : 'You'}</span>
                  {message.state === 'streaming' ? (
                    <div className="thinking-card workspace-thinking" role="status" aria-live="polite">
                      <div className="thinking-orbit">
                        <span />
                        <span />
                        <span />
                      </div>
                      <p>Thinking through the local model...</p>
                    </div>
                  ) : outputFormat === 'markdown' && message.role === 'assistant' ? (
                    <MarkdownRenderer content={message.content} />
                  ) : (
                    <p>{message.content}</p>
                  )}
                </div>
              </article>
            ))}
            <div ref={threadEndRef} />
          </section>
        </main>

        <footer className="workspace-composer-shell">
          {authStatus && !isSignedIn ? <div className="workspace-notice">{authStatus}</div> : null}
          {showComposerTools ? (
            <div className="workspace-tools">
              <button
                className={activeMode === 'ask' ? 'tool-chip is-active' : 'tool-chip'}
                type="button"
                onClick={() => loadWorkflow(askWorkflows[0] ?? workflowCards[0])}
              >
                Chat
              </button>
              <button
                className={activeMode === 'draft' ? 'tool-chip is-active' : 'tool-chip'}
                type="button"
                onClick={() => loadWorkflow(draftWorkflow)}
              >
                Draft file
              </button>
              <label className="format-select workspace-format">
                <span>Format</span>
                <select value={outputFormat} onChange={(event) => setOutputFormat(event.target.value as OutputFormat)}>
                  <option value="text">Text</option>
                  <option value="markdown">Markdown</option>
                  <option value="json">JSON</option>
                </select>
              </label>
              {activeMode === 'draft' ? (
                <label className="artifact-toggle workspace-artifact">
                  <input
                    type="checkbox"
                    checked={createArtifact}
                    onChange={(event) => setCreateArtifact(event.target.checked)}
                  />
                  <span>Create file</span>
                </label>
              ) : null}
              {generatedArtifact ? (
                <a className="workspace-file-link" href={generatedArtifact.url} target="_blank" rel="noreferrer">
                  {generatedArtifact.filename}
                </a>
              ) : null}
            </div>
          ) : null}
          <div className="workspace-composer">
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void submitPrompt();
                }
              }}
              placeholder="Ask about events, groups, sponsorships, mentorship..."
              disabled={!isSignedIn || isGenerating}
              rows={3}
            />
            <div className="composer-buttons">
              <button
                className="composer-tool-button"
                type="button"
                onClick={() => setShowComposerTools((current) => !current)}
                aria-label="Show tools"
                disabled={!isSignedIn}
              >
                +
              </button>
              <button type="button" disabled={isGenerating || !isSignedIn} onClick={submitPrompt} aria-label="Send message">
              {isGenerating ? '…' : '➤'}
              </button>
            </div>
          </div>
        </footer>
      </section>
    </div>
  );
}
