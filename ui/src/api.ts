// Thin fetch wrapper around the APICover JSON API. Centralised so the base path can move.

export const apiBase = '/apicover/api';

export interface EndpointParameterInfo {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie' | 'form';
  required?: boolean;
  type?: string;
  defaultValue?: unknown;
  enumValues?: string[];
  description?: string;
}

export interface EndpointMediaType {
  contentType: string;
  schema?: unknown;
  example?: unknown;
  kind?: string;
}

export interface EndpointSample {
  name: string;
  jsonPayload: string;
  description?: string;
}

export interface EndpointDescriptor {
  id: string;
  method: string;
  path: string;
  displayName?: string;
  area?: string;
  purpose?: string;
  description?: string;
  source?: string;
  tags?: string[];
  isDeprecated?: boolean;
  parameters?: EndpointParameterInfo[];
  requestBody?: { content: EndpointMediaType[]; required?: boolean };
  responses?: { statusCode: number; content: EndpointMediaType[]; kind?: string }[];
  samples?: EndpointSample[];
}

export interface ApiNode {
  id: string;
  label?: string;
  method: string;
  path: string;
  pathParameters?: Record<string, unknown>;
  queryParameters?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  body?: unknown;
  contentType?: string;
  shouldRun?: unknown;
  position?: { x: number; y: number };
}

export interface Edge {
  from: string;
  to: string;
  mode?: 'sequential' | 'parallel';
}

export interface Breakpoint {
  nodeId: string;
  enabled?: boolean;
  label?: string;
}

export interface NodeMutation {
  nodeId: string;
  field: string;
  rule?: unknown;
}

export interface GroupBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ExecutionGroup {
  id: string;
  label?: string;
  nodeIds: string[];
  bounds?: GroupBounds;
  backgroundColor?: string;
  repeat?: { count?: number; delay?: string };
  mutations?: NodeMutation[];
}

export interface NodeFieldOverride {
  field: string;
  value?: unknown;
  isRule?: boolean;
}

export interface CaseVariant {
  id: string;
  label: string;
  overrides?: NodeFieldOverride[];
}

export interface CaseSet {
  id: string;
  label?: string;
  anchorNodeId: string;
  variants: CaseVariant[];
  backgroundColor?: string;
}

export interface Scenario {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  nodes: ApiNode[];
  edges: Edge[];
  startNodeIds?: string[];
  breakpoints?: Breakpoint[];
  groups?: ExecutionGroup[];
  caseSets?: CaseSet[];
}

export type NodeStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'paused' | 'cancelled';
export type RunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'paused' | 'cancelled';

export interface NodeIteration {
  index: number;
  status: NodeStatus;
  request?: { method: string; path: string; headers?: Record<string, string>; body?: unknown };
  response?: { status: number; headers?: Record<string, string>; body?: unknown };
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface NodeResult {
  nodeId: string;
  /** Branch path identifying the forked sub-tree this result belongs to. Empty ≡ root. */
  branchPath?: string[];
  status: NodeStatus;
  request?: { method: string; path: string; headers?: Record<string, string>; body?: unknown };
  response?: { status: number; headers?: Record<string, string>; body?: unknown };
  error?: string;
  startedAt?: string;
  completedAt?: string;
  iterations?: NodeIteration[];
}

export interface Run {
  id: string;
  scenarioId: string;
  status: RunStatus;
  /** Flat list of (node, branch) execution records. Use branchKey() helper to group. */
  nodeResults: NodeResult[];
  pausedAtNodeId?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

/** Wire-format branch key for a node result (empty string ≡ root). */
export function branchKey(r: NodeResult): string {
  return (r.branchPath ?? []).join('/');
}

/** Find a node result for a specific (nodeId, branchKey). branchKey="" for root. */
export function getNodeResult(run: Run | null | undefined, nodeId: string, branch: string = ''): NodeResult | undefined {
  if (!run) return undefined;
  return run.nodeResults.find((r) => r.nodeId === nodeId && branchKey(r) === branch);
}

/**
 * Aggregate canvas-level status for a node across all its branches.
 * Priority: running > paused > failed > succeeded > skipped > pending.
 * Returns the "most interesting" result (with its body/error) so the canvas surfaces a
 * useful glance even when the BranchTree picker hasn't been opened yet.
 */
export function aggregateNodeResult(run: Run | null | undefined, nodeId: string): NodeResult | undefined {
  if (!run) return undefined;
  const matches = run.nodeResults.filter((r) => r.nodeId === nodeId);
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return matches[0];
  const order: Record<NodeStatus, number> = {
    running: 0, paused: 1, failed: 2, succeeded: 3, skipped: 4, cancelled: 5, pending: 6,
  };
  return [...matches].sort((a, b) => order[a.status] - order[b.status])[0];
}

export async function listScenarios(): Promise<Scenario[]> {
  const r = await fetch(`${apiBase}/scenarios`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function getScenario(id: string): Promise<Scenario> {
  const r = await fetch(`${apiBase}/scenarios/${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function saveScenario(scenario: Scenario): Promise<void> {
  const r = await fetch(`${apiBase}/scenarios/${encodeURIComponent(scenario.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(scenario),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text().catch(() => '')}`);
}

export async function deleteScenario(id: string): Promise<void> {
  const r = await fetch(`${apiBase}/scenarios/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

export async function startRun(
  scenarioId: string,
  opts: {
    breakpointsEnabled?: boolean;
    headers?: Record<string, string>;
    queryParameters?: Record<string, string>;
  } = {}
): Promise<Run> {
  const body: Record<string, unknown> = {
    breakpointsEnabled: opts.breakpointsEnabled ?? true,
  };
  if (opts.headers && Object.keys(opts.headers).length > 0) body.headers = opts.headers;
  if (opts.queryParameters && Object.keys(opts.queryParameters).length > 0) body.queryParameters = opts.queryParameters;

  const r = await fetch(`${apiBase}/scenarios/${encodeURIComponent(scenarioId)}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function getRun(id: string): Promise<Run> {
  const r = await fetch(`${apiBase}/runs/${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function listRuns(scenarioId?: string): Promise<Run[]> {
  const url = scenarioId
    ? `${apiBase}/runs?scenarioId=${encodeURIComponent(scenarioId)}`
    : `${apiBase}/runs`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export interface QuickCallRequest {
  method: string;
  path: string;
  pathParameters?: Record<string, string>;
  queryParameters?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
  contentType?: string;
}

export interface QuickCallResponse {
  request?: QuickCallRequest & { headers?: Record<string, string> };
  response?: {
    status: number;
    headers?: Record<string, string>;
    body?: unknown;
    contentType?: string;
  };
  elapsedMs?: number;
  error?: string;
}

export async function quickCall(req: QuickCallRequest): Promise<QuickCallResponse> {
  const r = await fetch(`${apiBase}/quick-call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  // 502 means transport error captured by the server; still parse body for { error }.
  return r.json();
}

// ── Call-graph inspection (opt-in) ──────────────────────────────────────────────

export type CallNodeKind =
  | 'controllerMethod'
  | 'method'
  | 'interface'
  | 'externalHttp'
  | 'database'
  | 'framework'
  | 'cycle'
  | 'depthCap'
  | 'dynamic'
  | 'opaque';

export interface CallNodeDto {
  displayName: string;
  declaringType?: string;
  methodName?: string;
  parameterTypes?: string[];
  kind: CallNodeKind;
  resolvedImplType?: string;
  notes?: string;
  summary?: string;
  filePath?: string;
  lineNumber?: number;
  calls?: CallNodeDto[];
}

export interface CallGraphDto {
  endpointId: string;
  rootMethod: string;
  generatedAt: string;
  assemblyHash: string;
  rootCall: CallNodeDto;
  warnings?: string[];
}

export async function getInspectorOptions(): Promise<{ enableCallGraph: boolean }> {
  try {
    const r = await fetch(`${apiBase}/options`);
    if (!r.ok) return { enableCallGraph: false };
    return r.json();
  } catch {
    return { enableCallGraph: false };
  }
}

export async function getCallGraph(endpointId: string): Promise<CallGraphDto | null> {
  const r = await fetch(`${apiBase}/call-graphs/?id=${encodeURIComponent(endpointId)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function rebuildCallGraphs(): Promise<{ rebuilt: number }> {
  const r = await fetch(`${apiBase}/call-graphs/rebuild`, { method: 'POST' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ── Service catalog (cross-endpoint aggregation) ────────────────────────────────

export interface ServiceUsageEntry {
  declaringType: string;
  shortName: string;
  isInterface: boolean;
  resolvedImplType?: string;
  usedByEndpoints: string[];
  calledMethods: string[];
  totalCallSites: number;
}

export interface ExternalBoundary {
  label: string;
  kind: 'ExternalHttp' | 'Database';
  usedByEndpoints: string[];
  totalCallSites: number;
}

export interface ServiceCatalog {
  generatedAt: string;
  services: ServiceUsageEntry[];
  externalHttp: ExternalBoundary[];
  databases: ExternalBoundary[];
}

export async function getServiceCatalog(): Promise<ServiceCatalog | null> {
  const r = await fetch(`${apiBase}/services`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function listEndpoints(): Promise<EndpointDescriptor[]> {
  const r = await fetch(`${apiBase}/discovery`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ---------------------------------------------------------------------------
// Service map — topology view (Inspector)
// ---------------------------------------------------------------------------

export type ServiceMapNodeKind = 'endpoint' | 'service' | 'externalHttp' | 'database';
export type ServiceMapEdgeKind = 'invokes' | 'calls' | 'http' | 'database';

export interface ServiceMapMetrics {
  fanIn: number;
  fanOut: number;
  depth: number;
  externalReach: number;
  databaseReach: number;
  serviceReach: number;
  siblingEndpoints: number;
  instability: number | null;
  coupling: number;
}

export interface ServiceMapNode {
  id: string;
  kind: ServiceMapNodeKind;
  label: string;
  fullName?: string;
  resolvedImplType?: string;
  isInterface?: boolean;
  httpMethod?: string;
  area?: string;
  metrics: ServiceMapMetrics;
  islandIndex: number;
}

export interface ServiceMapEdge {
  from: string;
  to: string;
  kind: ServiceMapEdgeKind;
  callSites: number;
}

export interface ServiceMap {
  generatedAt: string;
  nodes: ServiceMapNode[];
  edges: ServiceMapEdge[];
  islands: string[][];
}

export async function getServiceMap(): Promise<ServiceMap | null> {
  const r = await fetch(`${apiBase}/service-map`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export interface RunEvent {
  type:
    | 'runStarted'
    | 'runStatusChanged'
    | 'nodeStarted'
    | 'nodeCompleted'
    | 'nodePaused'
    | 'nodeResumed'
    | 'runFinished'
    | 'branchSpawned'
    | 'branchCompleted'
    | 'snapshot';
  runId: string;
  nodeId?: string;
  branchPath?: string[];
  timestamp: string;
  payload?: NodeResult | Run | unknown;
}

/**
 * Subscribe to a run's SSE event stream. Returns a teardown function.
 * The server emits a synthetic "snapshot" event first carrying the current Run object so
 * late subscribers don't miss state.
 */
export function subscribeRunEvents(
  runId: string,
  onEvent: (evt: RunEvent) => void,
  onError?: (e: Event) => void
): () => void {
  const url = `${apiBase}/runs/${encodeURIComponent(runId)}/events`;
  const es = new EventSource(url);
  const eventNames: RunEvent['type'][] = [
    'snapshot',
    'runStarted',
    'runStatusChanged',
    'nodeStarted',
    'nodeCompleted',
    'nodePaused',
    'nodeResumed',
    'runFinished',
    'branchSpawned',
    'branchCompleted',
  ];
  for (const name of eventNames) {
    es.addEventListener(name, (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        if (name === 'snapshot') {
          onEvent({ type: 'snapshot', runId, timestamp: new Date().toISOString(), payload: data });
        } else {
          onEvent(data);
        }
      } catch (err) {
        console.error(`Failed to parse SSE ${name}:`, err);
      }
    });
  }
  if (onError) es.onerror = onError;
  return () => es.close();
}

// ---------------------------------------------------------------------------
// Embedded Claude agent (APICover.Agent package). Endpoints under /agent/*
// are only mounted when the agent package is present. The UI probes
// /agent/status on load: 404 → hide all agent UI; 200 → render.
// ---------------------------------------------------------------------------

export interface AgentStatus {
  available: true;
  model: string;
  allowApiKey: boolean;
  allowMaxSubscription: boolean;
  maxDetected: boolean;
  maxVersion?: string;
  mode: 'Disabled' | 'ApiKey' | 'Max';
  hasApiKey: boolean;
  dailyDollarCap?: number;
  globalDailyDollarCap?: number;
  maxTokensPerRun: number;
  maxToolCallsPerRun: number;
  memoryRoot: string;
  memoryFileCount: number;
  memoryEmpty: boolean;
}

export interface AgentCredentials {
  mode: 'Disabled' | 'ApiKey' | 'Max';
  hasApiKey: boolean;
  lastFourChars?: string;
  dailyDollarCap?: number;
  maxDetected: boolean;
  maxVersion?: string;
  maxError?: string;
}

export async function getAgentStatus(): Promise<AgentStatus | null> {
  try {
    const r = await fetch(`${apiBase}/agent/status`);
    if (r.status === 404) return null;
    if (!r.ok) return null;
    return r.json();
  } catch {
    return null;
  }
}

export async function getAgentCredentials(): Promise<AgentCredentials> {
  const r = await fetch(`${apiBase}/agent/credentials`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function saveAgentCredentials(payload: {
  mode: 'Disabled' | 'ApiKey' | 'Max';
  apiKey?: string;
  dailyDollarCap?: number;
}): Promise<{ ok: boolean; mode: string }> {
  const r = await fetch(`${apiBase}/agent/credentials`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body?.error || `HTTP ${r.status}`);
  }
  return r.json();
}

export async function deleteAgentCredentials(): Promise<void> {
  const r = await fetch(`${apiBase}/agent/credentials`, { method: 'DELETE' });
  if (!r.ok && r.status !== 204) throw new Error(`HTTP ${r.status}`);
}

export async function testAgentCredentials(): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${apiBase}/agent/credentials/test`, { method: 'POST' });
  return r.json();
}

export type AgentEventType =
  | 'RunStarted'
  | 'RunCompleted'
  | 'RunFailed'
  | 'BudgetExhausted'
  | 'Narration'
  | 'ReadingMemory'
  | 'WritingMemory'
  | 'DiscoveringEndpoints'
  | 'ExaminingEndpoint'
  | 'ToolError'
  | 'ComposingResponse'
  | 'AssistantMessage'
  | 'UsageUpdate'
  | 'TextDelta'
  | 'ToolCallStarted'
  | 'ToolCallCompleted';

export interface AgentEvent {
  type: AgentEventType;
  runId: string;
  timestamp: string;
  summary?: string;
  path?: string;
  endpointId?: string;
  count?: number;
  durationMs?: number;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  toolIsError?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  dollarsSpentInRun?: number;
  dollarsSpentToday?: number;
  dailyDollarCap?: number;
  error?: string;
  stopReason?: string;
}

export interface SessionTotals {
  inputTokens: number;
  outputTokens: number;
  dollars: number;
  toolCalls: number;
}

export interface SessionSummary {
  id: string;
  prompt: string;
  mode: string;
  startedAt: string;
  completedAt?: string;
  status: string;
  totals: SessionTotals;
}

export interface SessionDoc extends SessionSummary {
  model: string;
  events: AgentEvent[];
  error?: string;
}

export async function listAgentSessions(take = 50): Promise<{ root: string; count: number; sessions: SessionSummary[] }> {
  const r = await fetch(`${apiBase}/agent/sessions/?take=${take}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function getAgentSession(id: string): Promise<SessionDoc | null> {
  const r = await fetch(`${apiBase}/agent/sessions/${encodeURIComponent(id)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function deleteAgentSession(id: string): Promise<void> {
  const r = await fetch(`${apiBase}/agent/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!r.ok && r.status !== 204) throw new Error(`HTTP ${r.status}`);
}

export async function startAgentRun(prompt: string, mode: 'chat' | 'scan' = 'chat'): Promise<{ runId: string; mode: string }> {
  const r = await fetch(`${apiBase}/agent/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, mode }),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body?.error || `HTTP ${r.status}`);
  }
  return r.json();
}

export interface MemoryEntry {
  path: string;
  bytes: number;
  updatedAt: string;
}

export async function listMemory(): Promise<{ root: string; count: number; files: MemoryEntry[] }> {
  const r = await fetch(`${apiBase}/agent/memory/`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function readMemoryFile(path: string): Promise<{ path: string; content: string } | null> {
  const r = await fetch(`${apiBase}/agent/memory/file?path=${encodeURIComponent(path)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function writeMemoryFile(path: string, content: string): Promise<void> {
  const r = await fetch(`${apiBase}/agent/memory/file`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content }),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body?.error || `HTTP ${r.status}`);
  }
}

export async function deleteMemoryFile(path: string): Promise<void> {
  const r = await fetch(`${apiBase}/agent/memory/file?path=${encodeURIComponent(path)}`, {
    method: 'DELETE',
  });
  if (!r.ok && r.status !== 204) throw new Error(`HTTP ${r.status}`);
}

export function subscribeAgentEvents(
  runId: string,
  onEvent: (evt: AgentEvent) => void,
  onError?: (e: Event) => void
): () => void {
  const url = `${apiBase}/agent/runs/${encodeURIComponent(runId)}/events`;
  const es = new EventSource(url);
  const names: AgentEvent['type'][] = [
    'RunStarted',
    'RunCompleted',
    'RunFailed',
    'BudgetExhausted',
    'Narration',
    'ReadingMemory',
    'WritingMemory',
    'DiscoveringEndpoints',
    'ExaminingEndpoint',
    'ToolError',
    'ComposingResponse',
    'AssistantMessage',
    'UsageUpdate',
    'TextDelta',
    'ToolCallStarted',
    'ToolCallCompleted',
  ];
  for (const name of names) {
    es.addEventListener(name, (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        onEvent(data);
      } catch (err) {
        console.error(`Failed to parse agent SSE ${name}:`, err);
      }
    });
  }
  if (onError) es.onerror = onError;
  return () => es.close();
}
