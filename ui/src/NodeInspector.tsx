import { useEffect, useMemo, useState } from 'react';
import type { ApiNode, CaseSet, EndpointDescriptor, ExecutionGroup, NodeIteration, NodeResult } from './api';
import { IdentityBlock } from './inspector/IdentityBlock';
import { TabBar, type InspectorTab } from './inspector/TabBar';
import { OverviewTab } from './inspector/OverviewTab';
import { RequestTab } from './inspector/RequestTab';
import { ResponseTab } from './inspector/ResponseTab';
import { WiringTab } from './inspector/WiringTab';
import { BranchingTab } from './inspector/BranchingTab';
import { CallGraphTab } from './inspector/CallGraphTab';
import { HistoryTab } from './inspector/HistoryTab';
import { parseMaybeJson, stringifyValue, type KV } from './inspector/KVEditor';
import { staggerChild, staggerParent } from './inspector/animations';
import { ErrorBoundary } from './components/ErrorBoundary';
import { usePrefs } from './stores/prefs';

const VALID_TABS = ['overview', 'request', 'response', 'wiring', 'branching', 'internals', 'history'] as const;
function asInspectorTab(v: string): InspectorTab {
  return (VALID_TABS as readonly string[]).includes(v) ? (v as InspectorTab) : 'overview';
}

interface Props {
  node: ApiNode;
  endpoint?: EndpointDescriptor;
  isStartNode: boolean;
  groupsForNode?: ExecutionGroup[];
  iterations?: NodeIteration[];
  /** Aggregate NodeResult for this node from the active run — feeds the Response tab. */
  latestResult?: NodeResult;
  /** Other nodes in the same scenario — surfaced in the wiring graph. */
  siblings?: ApiNode[];
  /** Direct upstream node ids (edges that point at this node). */
  upstreamIds?: string[];
  /** Direct downstream node ids (edges that originate from this node). */
  downstreamIds?: string[];
  /** Cross-scenario usage: scenarios that contain this endpoint along with their pass/fail counts. */
  scenariosUsing?: { id: string; name: string; passed: number; failed: number }[];
  endpointTotals?: { passed: number; failed: number };
  /** Display label for the current scenario in the History tab heading. */
  scenarioName?: string;
  onChange: (next: ApiNode) => void;
  onToggleStartNode: () => void;
  onClose: () => void;
  /** Optional inline width override (for user-resizable inspector). */
  width?: number;
  /** Click a node circle in the dependency mini-map to focus it on the canvas. */
  onFocusNode?: (id: string) => void;
  /** Open the GroupSettingsModal for a specific group (used by Branching tab). */
  onEditGroup?: (groupId: string) => void;
  /** All scenario groups — drives the "add to group" picker in BranchingTab. */
  allGroups?: ExecutionGroup[];
  /** Persist a single group mutation (add/remove membership from BranchingTab). */
  onUpdateGroup?: (next: ExecutionGroup) => void;
  /** Drop a group entirely when last member is removed. */
  onDeleteGroup?: (groupId: string) => void;
  /** CaseSet attached to this node, if any (the anchor). */
  caseSetForNode?: CaseSet;
  /** Persist a new/edited case set, or remove (null) it. */
  onCaseSetChange?: (next: CaseSet | null) => void;
  /** Whether the call-graph inspection feature is enabled by the host. When false, the
   * "internals" tab is hidden entirely. */
  enableCallGraph?: boolean;
}

/**
 * Right-side inspector for the currently selected canvas node. Pinned identity card +
 * 5-tab strip + tab content. Composes leaf components from `inspector/`.
 *
 * Wrapped in its own ErrorBoundary so a tab render exception (bad JSONLogic, malformed
 * iteration data) does not kill the parent canvas.
 */
export function NodeInspector(props: Props) {
  return (
    <ErrorBoundary name="NodeInspector">
      <NodeInspectorInner {...props} />
    </ErrorBoundary>
  );
}

function NodeInspectorInner({
  node,
  endpoint,
  isStartNode,
  groupsForNode,
  allGroups,
  onUpdateGroup,
  onDeleteGroup,
  iterations,
  latestResult,
  siblings,
  upstreamIds,
  downstreamIds,
  scenariosUsing,
  endpointTotals,
  scenarioName,
  onChange,
  onToggleStartNode,
  onClose,
  width,
  onFocusNode,
  onEditGroup,
  caseSetForNode,
  onCaseSetChange,
  enableCallGraph,
}: Props) {
  // Convert dictionary<string, JsonNode|string|...> ⇄ KV rows.
  const [pathRows, setPathRows] = useState<KV[]>(() => buildRows(node.pathParameters, endpoint, 'path'));
  const [queryRows, setQueryRows] = useState<KV[]>(() => buildRows(node.queryParameters, endpoint, 'query'));
  const [headerRows, setHeaderRows] = useState<KV[]>(() => buildRows(node.headers, endpoint, 'header'));
  const [bodyText, setBodyText] = useState<string>(() => initialBody(node, endpoint));
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [bodyMode, setBodyMode] = useState<'form' | 'raw'>('form');
  const [shouldRunText, setShouldRunText] = useState<string>(() => stringifyOrEmpty(node.shouldRun));
  const [shouldRunError, setShouldRunError] = useState<string | null>(null);
  // Persist last-used tab across scenarios + page reloads via the prefs store. Falls back
  // to 'overview' when the stored value is invalid (e.g. an old tab id that no longer exists).
  const storedTab = usePrefs((s) => s.inspectorTab);
  const setPrefsTab = usePrefs((s) => s.set);
  const [activeTab, setActiveTabLocal] = useState<InspectorTab>(() => asInspectorTab(storedTab));
  const setActiveTab = (t: InspectorTab) => {
    setActiveTabLocal(t);
    setPrefsTab('inspectorTab', t);
  };

  // Reset local state when a different node is selected.
  useEffect(() => {
    setPathRows(buildRows(node.pathParameters, endpoint, 'path'));
    setQueryRows(buildRows(node.queryParameters, endpoint, 'query'));
    setHeaderRows(buildRows(node.headers, endpoint, 'header'));
    setBodyText(initialBody(node, endpoint));
    setBodyError(null);
    setShouldRunText(stringifyOrEmpty(node.shouldRun));
    setShouldRunError(null);
    setActiveTab('overview');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]);

  // Resolve the request-body schema (first JSON content type) for the form generator.
  const bodySchema = useMemo(() => {
    const content = endpoint?.requestBody?.content ?? [];
    const json = content.find((c) => c.contentType.includes('json')) ?? content[0];
    return (json?.schema as Record<string, unknown> | undefined) ?? undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint?.id]);

  const declaredPath = useMemo(() => declaredNames(endpoint, 'path'), [endpoint]);
  const declaredQuery = useMemo(() => declaredNames(endpoint, 'query'), [endpoint]);
  const declaredHeader = useMemo(() => declaredNames(endpoint, 'header'), [endpoint]);

  const defaultRequestSample = useMemo(() => buildDefaultRequest(endpoint, bodySchema), [endpoint, bodySchema]);

  // Behavior mode: explicit user toggle wins; fall back to graph-derived.
  const isStartMode = isStartNode || (upstreamIds?.length ?? 0) === 0;

  function applyChanges(partial: Partial<ApiNode>) {
    onChange({ ...node, ...partial });
  }

  function commitRows(kind: 'path' | 'query' | 'header', rows: KV[]) {
    const dict: Record<string, unknown> = {};
    for (const r of rows) {
      if (!r.key) continue;
      dict[r.key] = parseMaybeJson(r.value);
    }
    if (kind === 'path') applyChanges({ pathParameters: dict });
    if (kind === 'query') applyChanges({ queryParameters: dict });
    if (kind === 'header') applyChanges({ headers: dict });
  }

  function commitBody(text: string) {
    setBodyText(text);
    if (text.trim().length === 0) {
      setBodyError(null);
      applyChanges({ body: undefined });
      return;
    }
    try {
      const parsed = JSON.parse(text);
      setBodyError(null);
      applyChanges({ body: parsed });
    } catch (e) {
      setBodyError((e as Error).message);
    }
  }

  function commitShouldRun(text: string) {
    setShouldRunText(text);
    if (text.trim().length === 0) {
      setShouldRunError(null);
      applyChanges({ shouldRun: undefined });
      return;
    }
    try {
      const parsed = JSON.parse(text);
      setShouldRunError(null);
      applyChanges({ shouldRun: parsed });
    } catch (e) {
      setShouldRunError((e as Error).message);
    }
  }

  function loadSample(jsonPayload: string) {
    try {
      const parsed = JSON.parse(jsonPayload);
      applyChanges({ body: parsed });
      setBodyText(prettifyJson(jsonPayload));
      setBodyError(null);
    } catch {
      commitBody(prettifyJson(jsonPayload));
    }
  }

  // Tab counts derived from current state.
  const filledRequestCount =
    pathRows.filter((r) => r.value).length +
    queryRows.filter((r) => r.value).length +
    headerRows.filter((r) => r.value).length +
    (node.body !== undefined && node.body !== null ? 1 : 0);
  const wiringCount = shouldRunText.trim().length > 0 ? 1 : 0;
  const groupCartesian = (groupsForNode ?? []).reduce((a, g) => a * Math.max(1, g.repeat?.count ?? 1), groupsForNode && groupsForNode.length > 0 ? 1 : 0);
  const variantFork = caseSetForNode?.variants.length ?? 0;
  const branchingCount = groupCartesian + variantFork;
  const historyCount = iterations?.length ?? 0;

  const counts: Partial<Record<InspectorTab, number>> = {
    request: filledRequestCount,
    wiring: wiringCount,
    branching: branchingCount,
    history: historyCount,
  };

  const noBranching = (groupsForNode?.length ?? 0) === 0 && variantFork === 0;
  const dimmedTabs: InspectorTab[] = [];
  if (noBranching) dimmedTabs.push('branching');
  if (!latestResult) dimmedTabs.push('response');

  // Keyboard shortcut 1–5 to switch tabs (when focus is not in an input).
  useEffect(() => {
    function isInsideInput(t: EventTarget | null): boolean {
      if (!t || !(t instanceof HTMLElement)) return false;
      const tag = t.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
    }
    function onKey(e: KeyboardEvent) {
      if (isInsideInput(e.target)) return;
      const map: Record<string, InspectorTab> = {
        '1': 'overview', '2': 'request', '3': 'wiring', '4': 'branching',
        '5': enableCallGraph ? 'internals' : 'history',
        '6': 'history',
      };
      if (map[e.key]) {
        e.preventDefault();
        setActiveTab(map[e.key]);
      } else if (e.key === 'Escape') {
        onClose();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="inspector inspector-terminal" style={width ? { width } : undefined}>
      <IdentityBlock
        node={node}
        endpoint={endpoint}
        isStartMode={isStartMode}
        isStartNode={isStartNode}
        upstreamCount={upstreamIds?.length ?? 0}
        activeTab={activeTab}
        onToggleStart={onToggleStartNode}
        onClose={onClose}
      />

      <TabBar
        active={activeTab}
        counts={counts}
        dimmed={dimmedTabs}
        hidden={enableCallGraph ? [] : ['internals']}
        errored={[
          ...(bodyError ? ['request' as InspectorTab] : []),
          ...(shouldRunError ? ['wiring' as InspectorTab] : []),
        ]}
        onChange={setActiveTab}
      />

      <div className={`tab-pane ${staggerParent}`} key={activeTab}>
        {activeTab === 'overview' && (
          <div style={staggerChild(0)}>
            <OverviewTab
              node={node}
              endpoint={endpoint}
              defaultRequestSample={defaultRequestSample}
            />
          </div>
        )}
        {activeTab === 'request' && (
          <div style={staggerChild(0)}>
            <RequestTab
              node={node}
              endpoint={endpoint}
              bodySchema={bodySchema}
              pathRows={pathRows}
              queryRows={queryRows}
              headerRows={headerRows}
              declaredPath={declaredPath}
              declaredQuery={declaredQuery}
              declaredHeader={declaredHeader}
              bodyText={bodyText}
              bodyError={bodyError}
              bodyMode={bodyMode}
              onSetBodyMode={(m) => {
                if (m === 'raw') {
                  try { setBodyText(JSON.stringify(node.body ?? null, null, 2)); } catch { /* ignore */ }
                }
                setBodyMode(m);
              }}
              onPathRowsChange={(r) => { setPathRows(r); commitRows('path', r); }}
              onQueryRowsChange={(r) => { setQueryRows(r); commitRows('query', r); }}
              onHeaderRowsChange={(r) => { setHeaderRows(r); commitRows('header', r); }}
              onBodyChange={(v) => applyChanges({ body: v })}
              onBodyTextChange={commitBody}
              onLoadSample={loadSample}
              onStreamingChange={(next) => applyChanges({ streaming: next })}
            />
          </div>
        )}
        {activeTab === 'response' && (
          <div style={staggerChild(0)}>
            <ResponseTab result={latestResult} />
          </div>
        )}
        {activeTab === 'wiring' && (
          <div style={staggerChild(0)}>
            <WiringTab
              node={node}
              endpoint={endpoint}
              isStartMode={isStartMode}
              shouldRunText={shouldRunText}
              shouldRunError={shouldRunError}
              onShouldRunChange={commitShouldRun}
              upstreamIds={upstreamIds ?? []}
              downstreamIds={downstreamIds ?? []}
              siblings={siblings ?? []}
              onFocusNode={onFocusNode}
            />
          </div>
        )}
        {activeTab === 'branching' && (
          <div style={staggerChild(0)}>
            <BranchingTab
              node={node}
              groupsForNode={groupsForNode ?? []}
              allGroups={allGroups}
              onEditGroup={(gid) => onEditGroup?.(gid)}
              onUpdateGroup={onUpdateGroup}
              onDeleteGroup={onDeleteGroup}
              caseSet={caseSetForNode}
              onCaseSetChange={onCaseSetChange}
            />
          </div>
        )}
        {activeTab === 'internals' && (
          <div style={staggerChild(0)}>
            <CallGraphTab endpointId={endpoint?.id} />
          </div>
        )}
        {activeTab === 'history' && (
          <div style={staggerChild(0)}>
            <HistoryTab
              scenariosUsing={scenariosUsing ?? []}
              endpointTotals={endpointTotals ?? { passed: 0, failed: 0 }}
              iterations={iterations}
              scenarioName={scenarioName ?? '(unsaved)'}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Helpers (kept colocated; small + only used here) ────────────────────────────

function buildRows(
  source: Record<string, unknown> | undefined,
  endpoint: EndpointDescriptor | undefined,
  kind: 'path' | 'query' | 'header'
): KV[] {
  const rows: KV[] = [];
  const seen = new Set<string>();
  if (source) {
    for (const [k, v] of Object.entries(source)) {
      rows.push({ key: k, value: stringifyValue(v) });
      seen.add(k);
    }
  }
  for (const p of endpoint?.parameters ?? []) {
    if (p.in !== kind) continue;
    if (seen.has(p.name)) continue;
    rows.push({ key: p.name, value: p.defaultValue !== undefined ? stringifyValue(p.defaultValue) : '' });
  }
  return rows;
}

function declaredNames(endpoint: EndpointDescriptor | undefined, kind: 'path' | 'query' | 'header'): string[] {
  return (endpoint?.parameters ?? []).filter((p) => p.in === kind).map((p) => p.name);
}

function initialBody(node: ApiNode, endpoint?: EndpointDescriptor): string {
  if (node.body !== undefined && node.body !== null) {
    return prettify(node.body);
  }
  const sample = endpoint?.samples?.[0]?.jsonPayload;
  if (sample) return prettifyJson(sample);
  const example = endpoint?.requestBody?.content?.[0]?.example;
  if (example !== undefined) return prettify(example);
  return '';
}

function prettify(value: unknown): string {
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}
function prettifyJson(text: string): string {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

function stringifyOrEmpty(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

function buildDefaultRequest(endpoint: EndpointDescriptor | undefined, bodySchema?: Record<string, unknown>): string {
  if (!endpoint) return 'no discovery metadata';
  const out: Record<string, unknown> = {};
  const path: Record<string, unknown> = {};
  const query: Record<string, unknown> = {};
  const headers: Record<string, unknown> = {};
  for (const p of endpoint.parameters ?? []) {
    const placeholder = p.defaultValue ?? exampleForType(p.type) ?? `<${p.type ?? 'value'}>`;
    if (p.in === 'path') path[p.name] = placeholder;
    else if (p.in === 'query') query[p.name] = placeholder;
    else if (p.in === 'header') headers[p.name] = placeholder;
  }
  if (Object.keys(path).length > 0) out.pathParameters = path;
  if (Object.keys(query).length > 0) out.queryParameters = query;
  if (Object.keys(headers).length > 0) out.headers = headers;

  const sample = endpoint.samples?.[0]?.jsonPayload;
  if (sample) {
    try { out.body = JSON.parse(sample); } catch { out.body = sample; }
  } else if (bodySchema) {
    out.body = sampleFromSchema(bodySchema);
  } else {
    const example = endpoint.requestBody?.content?.[0]?.example;
    if (example !== undefined) out.body = example;
  }
  if (Object.keys(out).length === 0) return '(no parameters · no body)';
  return JSON.stringify(out, null, 2);
}

function exampleForType(type?: string): unknown {
  switch (type?.toLowerCase()) {
    case 'string': return '';
    case 'integer': case 'int32': case 'int64': case 'long': case 'int': return 0;
    case 'number': case 'double': case 'decimal': return 0;
    case 'boolean': case 'bool': return false;
    case 'guid': case 'uuid': return '00000000-0000-0000-0000-000000000000';
    default: return undefined;
  }
}

function sampleFromSchema(schema: Record<string, unknown>): unknown {
  const t = schema.type as string | undefined;
  if (t === 'object' || schema.properties) {
    const props = (schema.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) out[k] = sampleFromSchema(v);
    return out;
  }
  if (t === 'array') {
    const items = schema.items as Record<string, unknown> | undefined;
    return items ? [sampleFromSchema(items)] : [];
  }
  if (t === 'string') return (schema.enum as string[] | undefined)?.[0] ?? '';
  if (t === 'integer' || t === 'number') return 0;
  if (t === 'boolean') return false;
  return null;
}

