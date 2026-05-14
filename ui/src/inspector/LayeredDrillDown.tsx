import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge as RFEdge,
  type Node as RFNode,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from 'dagre';
import type { CallGraphDto, CallNodeDto, CallSignalDto, ServiceCallersDto, ServiceMap, ServiceMapNodeKind, ServiceUsageEntry } from '../api';
import { getCallGraph, getServiceCallers, getServiceCatalog, grepSource, type SourceGrepHit } from '../api';
import { memo } from 'react';
import { CallGraphTab } from './CallGraphTab';
import { SourceDrawer } from './SourceDrawer';
import Prism from 'prismjs';
import 'prismjs/components/prism-csharp';

export type DrillDirection = 'forward' | 'reverse';

interface Props {
  map: ServiceMap;
  visibleKinds: ReadonlySet<ServiceMapNodeKind>;
  search?: string;
  selectedId?: string | null;
  /** Externally-requested focus root — pick from side rail (Recent / Hot spots) flips this
   * pair (id + bump) so the canvas opens the requested endpoint without colliding with
   * internal click focus state. The bump counter forces a re-fire even when the same id
   * is picked twice. */
  requestedFocusId?: { id: string; bump: number } | null;
  /** 'forward' (default) = endpoint → services chain.
   *  'reverse' = service → caller endpoints chain. Picker source flips, fetch source flips,
   *  the `flat` builder takes a different branch. Node rendering / drawer / source view all
   *  stay the same because `flat.nodes` shape is unchanged. */
  direction?: DrillDirection;
  onSelect: (id: string | null) => void;
}

interface NodeData extends Record<string, unknown> {
  originalId: string;
  label: string;
  kind: ServiceMapNodeKind;
  method?: string;
  area?: string;
  summary?: string;
  filePath?: string;
  lineNumber?: number;
  signals?: CallSignalDto[];
  bodySnippet?: string;
  highlighted: boolean;
  expanded: boolean;
  hasChildren: boolean;
  /** When a SourceDrawer is open, true on the node whose method is currently shown. */
  drawerActive?: boolean;
  /** When a SourceDrawer is open, true on every other node — used to dim them. */
  drawerDim?: boolean;
  /** True when the canvas is laid out left→right (reverse mode). Flips XyFlow handle
   * positions so edges enter on the left and exit on the right; otherwise routing renders
   * vertical lines across an LR graph. */
  horizontal?: boolean;
  onRightClick: (originalId: string, evt: React.MouseEvent) => void;
  onShowSource?: (originalId: string) => void;
}

const NODE_W = 220;
const NODE_H = 56;
const KIND_COLOR: Record<ServiceMapNodeKind, string> = {
  endpoint: '#3b82f6',
  service: '#a855f7',
  externalHttp: '#f59e0b',
  database: '#14b8a6',
};

/**
 * Top-down drill-down tree view of the service map.
 *
 * Default: shows only endpoint nodes (depth 0) — fast initial render even with 243 endpoints.
 * Click an endpoint or service to expand its full transitive descendant tree (outgoing
 * `invokes`/`calls`/`http`/`database` edges). Click again to collapse.
 *
 * Replaces the O(N²) force-directed view for large graphs. Layout done once via Dagre TB and
 * memoised so React + XyFlow only re-render when the visible subset changes.
 */
function LayeredDrillDownImpl({ map, visibleKinds, search = '', selectedId, requestedFocusId, direction = 'forward', onSelect }: Props) {
  // The "focus root" — exactly one node selected from a sidebar picker, whose
  // FULL transitive outgoing subgraph fills the canvas. Default: null → empty
  // canvas with prompt to pick. Rendering 243 endpoints + 666 edges at once is
  // exactly the problem we are solving.
  const [focusId, setFocusId] = useState<string | null>(null);

  // Stop-list: nodes whose descendants are hidden. Lets the user collapse a
  // single subtree without un-focusing the whole root.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // Picker-local filters (independent of the system-map header search/kind toggle).
  // Lets the user narrow the 243-endpoint list inline.
  const [pickerSearch, setPickerSearch] = useState('');
  const [pickerMethod, setPickerMethod] = useState<string>('ALL');
  const [pickerVersion, setPickerVersion] = useState<string>('ALL');

  // Focus view mode: 'graph' (Dagre call-graph) | 'trace' (textual IL call tree).
  const [focusView, setFocusView] = useState<'graph' | 'trace'>('graph');

  // Per-endpoint call graph fetched lazily when focusId changes. Using the
  // service-map for BFS would pull in unrelated outgoing edges of any shared
  // service (e.g. a facade used by 30 endpoints), so we render the endpoint's
  // own IL-walked tree instead.
  const [callGraph, setCallGraph] = useState<CallGraphDto | null>(null);
  const [callGraphLoading, setCallGraphLoading] = useState(false);
  const [callGraphError, setCallGraphError] = useState<string | null>(null);

  // External focus request from the side rail (Recent / Hot spots). Setting via effect
  // keeps the caller free of LayeredDrillDown internals; we only react when the value
  // actually changes to a non-null id.
  useEffect(() => {
    if (!requestedFocusId) return;
    setFocusId(requestedFocusId.id);
    setCollapsed(new Set());
  }, [requestedFocusId]);

  // Mark endpoint as "recently visited" after 5s of focus. Filters bursts of clicks where
  // the user is just browsing; only commits when the user has actually spent time on a
  // method. List is capped at 8 most-recent IDs in localStorage so other tabs (the side
  // rail in ServiceMapPanel) can read it.
  useEffect(() => {
    if (!focusId) return;
    const RECENT_KEY = 'apicover.recent.endpoints';
    const MAX = 8;
    const handle = window.setTimeout(() => {
      try {
        const raw = window.localStorage?.getItem(RECENT_KEY);
        const arr = raw ? (JSON.parse(raw) as string[]) : [];
        const filtered = arr.filter((id) => id !== focusId);
        filtered.unshift(focusId);
        window.localStorage?.setItem(RECENT_KEY, JSON.stringify(filtered.slice(0, MAX)));
        window.dispatchEvent(new CustomEvent('apicover.recent.changed'));
      } catch { /* storage off */ }
    }, 5000);
    return () => window.clearTimeout(handle);
  }, [focusId]);

  // Reverse-mode payload — fetched when direction === 'reverse'. Holds the picked service's
  // fan-in (direct callers + intermediate services + method-level breakdown).
  const [serviceCallers, setServiceCallers] = useState<ServiceCallersDto | null>(null);

  // Source-grep hits for the focused service. The IL walker skips logger/framework calls;
  // a text grep across the repo finds them anyway. Only fetched in reverse mode and only
  // when the user expands the "source hits" panel — keeps idle reverse views cheap.
  const [grepHits, setGrepHits] = useState<SourceGrepHit[] | null>(null);
  const [grepLoading, setGrepLoading] = useState(false);
  const [grepOpen, setGrepOpen] = useState(false);
  const [grepCapped, setGrepCapped] = useState(false);

  // Local UI state for the grep panel: which file groups are expanded.
  const [grepFileOpen, setGrepFileOpen] = useState<Set<string>>(new Set());
  const toggleGrepFile = (path: string) => setGrepFileOpen((prev) => {
    const next = new Set(prev);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return next;
  });

  const runGrep = useCallback(async (term: string) => {
    if (!term) return;
    setGrepLoading(true);
    try {
      const r = await grepSource(term, 200);
      setGrepHits(r.hits);
      setGrepCapped(r.capped);
    } catch {
      setGrepHits([]);
      setGrepCapped(false);
    } finally {
      setGrepLoading(false);
    }
  }, []);

  // Service catalog for the reverse-mode picker. Fetched once when the user flips into
  // reverse mode for the first time and cached for the session.
  const [serviceCatalog, setServiceCatalog] = useState<ServiceUsageEntry[] | null>(null);
  useEffect(() => {
    if (direction !== 'reverse') return;
    if (serviceCatalog) return;
    let cancelled = false;
    (async () => {
      try {
        const cat = await getServiceCatalog();
        if (!cancelled && cat) setServiceCatalog(cat.services);
      } catch { /* swallow — picker will simply be empty */ }
    })();
    return () => { cancelled = true; };
  }, [direction, serviceCatalog]);

  useEffect(() => {
    setGrepHits(null);
    setGrepCapped(false);
    if (direction !== 'reverse' || !focusId || !grepOpen) return;
    // Use the short type name as the grep term — full-qualified types are rare in source code.
    runGrep(shortLabelFromId(focusId));
  }, [direction, focusId, grepOpen, runGrep]);

  // Auto-open grep only when BOTH live reverse-index and ServiceCatalog have nothing for
  // this id — we fall back to a text grep so the user still gets something usable. With even
  // one caller surfaced we leave the panel closed; grep stays one click away on the toolbar.
  useEffect(() => {
    if (direction !== 'reverse' || !focusId) return;
    if (callGraphLoading) return;
    const indexCallers = serviceCallers?.directCallers.length ?? 0;
    const catalogEntry = (serviceCatalog ?? []).find((s) =>
      s.declaringType === focusId || s.resolvedImplType === focusId,
    );
    const catalogCallers = catalogEntry?.usedByEndpoints.length ?? 0;
    if (indexCallers === 0 && catalogCallers === 0) setGrepOpen(true);
  }, [direction, focusId, serviceCallers, serviceCatalog, callGraphLoading]);

  useEffect(() => {
    if (!focusId) {
      setCallGraph(null); setServiceCallers(null); setCallGraphError(null);
      return;
    }
    let cancelled = false;
    setCallGraphLoading(true);
    setCallGraphError(null);
    setCallGraph(null);
    setServiceCallers(null);
    (async () => {
      try {
        if (direction === 'forward') {
          const g = await getCallGraph(focusId);
          if (!cancelled) setCallGraph(g);
        } else {
          const c = await getServiceCallers(focusId);
          if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
            // Temporary diagnostic — answers "why is reverse canvas empty?" instantly.
            // eslint-disable-next-line no-console
            console.debug('[reverse-fetch]', focusId,
              'directCallers=', c?.directCallers?.length,
              'callerServices=', c?.callerServices?.length);
          }
          if (!cancelled) setServiceCallers(c);
        }
      } catch (e) {
        if (!cancelled) setCallGraphError((e as Error).message);
      } finally {
        if (!cancelled) setCallGraphLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [focusId, direction]);

  // Per-endpoint call-graph flattened into (id, kind, label, parentId, hasChildren) records.
  // Skips Cycle / DepthCap / Framework noise so the canvas stays focused on real
  // dependencies. Each method is keyed by `${declaringType}.${methodName}` so the same
  // method invoked from two parents merges into a single visible node (avoids the
  // duplicate IProductSpecService / ProductSpecService columns the user saw).
  interface FlatNode {
    id: string;
    kind: ServiceMapNodeKind;
    label: string;
    method?: string;
    area?: string;
    /** Short business intent pulled from C# /// &lt;summary&gt; XML doc on the method. */
    summary?: string;
    /** PDB-resolved file/line so the user can open the source. */
    filePath?: string;
    lineNumber?: number;
    /** PDB-resolved end line of the method body — pairs with lineNumber for range highlight. */
    endLine?: number;
    /** IL-extracted intent signals (throws, log msgs, branch count, literals). */
    signals?: CallSignalDto[];
    /** First 6–8 lines of method body — renders inline so the user reads real C#. */
    bodySnippet?: string;
    /** Actual C# method name (used for drawer click-jump matching). */
    methodName?: string;
  }
  interface FlatEdge { from: string; to: string }

  function isDataCarrierType(fullName: string): boolean {
    if (!fullName) return false;
    if (fullName.includes('Culture=') || fullName.includes('PublicKeyToken=') || fullName.includes('Version=')) return true;
    const dot = fullName.lastIndexOf('.');
    const simple = dot >= 0 ? fullName.substring(dot + 1) : fullName;
    const suffixes = ['Dto', 'Dtos', 'ViewModel', 'VM', 'Request', 'Response', 'Command', 'Query', 'Event', 'Payload', 'Entity', 'Model', 'Options'];
    for (const s of suffixes) if (simple.endsWith(s)) return true;
    if (fullName.includes('.Dtos.') || fullName.includes('.Dto.') || fullName.includes('.Contracts.Dtos')
      || fullName.includes('.ViewModels.') || fullName.includes('.Entities.') || fullName.includes('.Models.')) return true;
    return false;
  }

  function nodeKindForCall(c: CallNodeDto): ServiceMapNodeKind | null {
    if (c.kind === 'externalHttp') return 'externalHttp';
    if (c.kind === 'database') return 'database';
    if (c.kind === 'interface' || c.kind === 'method' || c.kind === 'controllerMethod') {
      // Skip data carriers — DTOs / view-models / requests / entities / contracts aren't
      // services. ServiceMapBuilder filters them server-side; the call-graph endpoint
      // still includes them so apply the same filter on the consumer.
      if (c.declaringType && isDataCarrierType(c.declaringType)) return null;
      return 'service';
    }
    return null;
  }

  function callId(c: CallNodeDto): string {
    // Stable key. Use the resolved impl when interface dispatch produced one so the
    // graph shows the concrete implementor (e.g. ChannelService) rather than the
    // interface alias.
    if (c.kind === 'interface' && c.resolvedImplType) return c.resolvedImplType;
    if (c.declaringType) return c.declaringType;
    return c.displayName;
  }

  function shortLabel(c: CallNodeDto): string {
    if (c.kind === 'interface' && c.resolvedImplType) {
      const dot = c.resolvedImplType.lastIndexOf('.');
      return dot >= 0 ? c.resolvedImplType.substring(dot + 1) : c.resolvedImplType;
    }
    if (c.declaringType) {
      const dot = c.declaringType.lastIndexOf('.');
      return dot >= 0 ? c.declaringType.substring(dot + 1) : c.declaringType;
    }
    return c.displayName;
  }

  const flat = useMemo(() => {
    const nodeMap = new Map<string, FlatNode>();
    const edgeSet = new Set<string>();
    const edges: FlatEdge[] = [];
    const hasKids = new Set<string>();

    if (!focusId) return { nodes: nodeMap, edges, hasChildren: hasKids };

    // ── Reverse mode — picked service is the sink, callers fan in from above. ─────────
    if (direction === 'reverse') {
      // Find this service's ServiceCatalog entry — it carries `usedByEndpoints` which works
      // even when the live reverse-index missed the service (factory registrations etc.).
      // Either / both data sources can be empty; we union them so the user sees every
      // endpoint that the catalog knows about.
      // Match on declaringType, resolvedImplType, or short-name fallback (catches
      // namespace-drift cases where the picker id and catalog id share only their leaf).
      const focusShort = shortLabelFromId(focusId);
      const catalogEntry = (serviceCatalog ?? []).find((s) =>
        s.declaringType === focusId
        || (s.resolvedImplType && s.resolvedImplType === focusId)
        || shortLabelFromId(s.declaringType) === focusShort,
      );
      if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
        // eslint-disable-next-line no-console
        console.debug('[reverse-memo]', {
          focusId,
          hasCallers: !!serviceCallers,
          directCallers: serviceCallers?.directCallers?.length ?? 0,
          catalogEntryFound: !!catalogEntry,
          catalogEps: catalogEntry?.usedByEndpoints?.length ?? 0,
          catalogSize: serviceCatalog?.length ?? 0,
        });
      }

      const shortLabel = serviceCallers?.shortName ?? (catalogEntry ? shortLabelFromId(catalogEntry.declaringType) : shortLabelFromId(focusId));
      // Root: the focused service. Sits at the bottom of the Dagre TB layout because every
      // edge flows endpoint → … → service (caller → callee).
      nodeMap.set(focusId, {
        id: focusId,
        kind: 'service',
        label: shortLabel,
      });

      const addEdge = (from: string, to: string) => {
        if (from === to) return;
        const key = from + ' ' + to;
        if (edgeSet.has(key)) return;
        edgeSet.add(key);
        edges.push({ from, to });
        hasKids.add(from);
      };

      // Intermediate services pulled from the DTO. They carry the same source metadata we
      // already display for forward nodes — drawer / snippet rendering reuses it as-is.
      for (const cs of serviceCallers?.callerServices ?? []) {
        if (!nodeMap.has(cs.id)) {
          nodeMap.set(cs.id, {
            id: cs.id,
            kind: 'service',
            label: cs.shortName,
            filePath: cs.filePath,
            lineNumber: cs.lineNumber,
            endLine: cs.endLine,
            bodySnippet: cs.bodySnippet,
            summary: cs.summary,
            methodName: cs.methodName,
          });
        }
      }

      for (const caller of serviceCallers?.directCallers ?? []) {
        const epId = caller.endpointId;
        if (!nodeMap.has(epId)) {
          nodeMap.set(epId, {
            id: epId,
            kind: 'endpoint',
            label: shortEndpointLabelFromId(epId),
            method: epId.split(' ')[0],
          });
        }
        // Materialise every intermediate hop. Without this, Mediator / handler / facade
        // nodes only had edges drawn — they never landed in `flat.nodes`, so the BFS in
        // `visibleNodes` couldn't reach them and the canvas collapsed to focus + the one
        // direct parent listed in callerServices.
        for (const hop of caller.via) {
          if (nodeMap.has(hop)) continue;
          const meta = serviceCallers?.callerServices.find((cs) => cs.id === hop);
          nodeMap.set(hop, {
            id: hop,
            kind: 'service',
            label: shortLabelFromId(hop),
            filePath: meta?.filePath,
            lineNumber: meta?.lineNumber,
            endLine: meta?.endLine,
            bodySnippet: meta?.bodySnippet,
            summary: meta?.summary,
            methodName: meta?.methodName,
          });
        }
        // Walk the shortest "via" chain: endpoint → via[0] → via[1] → … → focusedService.
        // When via is empty the endpoint hits the service directly. `addEdge` dedupes so
        // a backend chain with adjacent duplicates (handler echoed twice) costs nothing.
        const chain = [epId, ...caller.via, focusId];
        for (let i = 0; i < chain.length - 1; i++) {
          addEdge(chain[i], chain[i + 1]);
        }
      }

      // Fallback only: when the live reverse-index produced zero callers, fall back to the
      // ServiceCatalog's `usedByEndpoints` list. Drawing endpoint → service edges directly
      // would otherwise short-circuit the realistic call chain (an endpoint never calls an
      // interface in C# — DI resolves it via a service that calls the interface), so we keep
      // this off when the index already wired up the proper intermediates.
      if (!serviceCallers || serviceCallers.directCallers.length === 0) {
        for (const epId of catalogEntry?.usedByEndpoints ?? []) {
          if (!nodeMap.has(epId)) {
            nodeMap.set(epId, {
              id: epId,
              kind: 'endpoint',
              label: shortEndpointLabelFromId(epId),
              method: epId.split(' ')[0],
            });
          }
          addEdge(epId, focusId);
        }
      }
      return { nodes: nodeMap, edges, hasChildren: hasKids };
    }

    // ── Forward mode — original call-graph walk (kept as-is). ─────────────────────────
    if (!callGraph) return { nodes: nodeMap, edges, hasChildren: hasKids };

    // Root = the focused endpoint itself.
    nodeMap.set(focusId, {
      id: focusId,
      kind: 'endpoint',
      label: callGraph.rootMethod || focusId,
      method: focusId.split(' ')[0],
    });

    function visit(parent: string, c: CallNodeDto) {
      const kind = nodeKindForCall(c);
      if (kind === null) {
        // Cycle / DepthCap / Framework / Dynamic — recurse but don't surface a node.
        for (const child of c.calls ?? []) visit(parent, child);
        return;
      }
      // Skip accessor / ctor noise (`get_X`, `set_X`, `.ctor`) — surfaces as ChannelDto.Id
      // bumping the graph without semantic value.
      const mname = c.methodName ?? '';
      if (mname === '.ctor' || mname.startsWith('get_') || mname.startsWith('set_')) {
        for (const child of c.calls ?? []) visit(parent, child);
        return;
      }
      const id = callId(c);
      if (!nodeMap.has(id)) {
        nodeMap.set(id, {
          id, kind, label: shortLabel(c),
          summary: c.summary,
          filePath: c.filePath,
          lineNumber: c.lineNumber,
          endLine: c.endLine,
          signals: c.signals,
          bodySnippet: c.bodySnippet,
          methodName: c.methodName,
        });
      } else {
        // Merge: first hit may have lacked summary/path (cached); fill if present here.
        const existing = nodeMap.get(id)!;
        if (!existing.summary && c.summary) existing.summary = c.summary;
        if (!existing.filePath && c.filePath) existing.filePath = c.filePath;
        if (!existing.lineNumber && c.lineNumber) existing.lineNumber = c.lineNumber;
        if (!existing.endLine && c.endLine) existing.endLine = c.endLine;
        if (!existing.signals && c.signals) existing.signals = c.signals;
        if (!existing.bodySnippet && c.bodySnippet) existing.bodySnippet = c.bodySnippet;
        if (!existing.methodName && c.methodName) existing.methodName = c.methodName;
      }
      const edgeKey = parent + ' ' + id;
      if (parent !== id && !edgeSet.has(edgeKey)) {
        edgeSet.add(edgeKey);
        edges.push({ from: parent, to: id });
        hasKids.add(parent);
      }
      for (const child of c.calls ?? []) visit(id, child);
    }

    for (const child of callGraph.rootCall.calls ?? []) {
      visit(focusId, child);
    }
    return { nodes: nodeMap, edges, hasChildren: hasKids };
  }, [callGraph, serviceCallers, serviceCatalog, focusId, direction]);

  // Pre-compute the endpoint pool plus its method / version axes for the picker filters.
  // Service-map is still the source of truth for "which endpoints exist".
  const allEndpoints = useMemo(() => {
    return map.nodes
      .filter((n) => n.kind === 'endpoint')
      .map((n) => ({ node: n, version: extractVersion(n.id) }));
  }, [map.nodes]);

  // byId from service-map (used by edge styling lookups). Kept for label fallbacks.
  const serviceMapById = useMemo(() => {
    const m = new Map<string, { id: string; kind: ServiceMapNodeKind; label: string }>();
    for (const n of map.nodes) m.set(n.id, n);
    return m;
  }, [map.nodes]);

  const methodOptions = useMemo(() => {
    const set = new Set<string>();
    for (const e of allEndpoints) if (e.node.httpMethod) set.add(e.node.httpMethod.toUpperCase());
    return ['ALL', ...[...set].sort()];
  }, [allEndpoints]);

  const versionOptions = useMemo(() => {
    const set = new Set<string>();
    for (const e of allEndpoints) if (e.version) set.add(e.version);
    return ['ALL', ...[...set].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))];
  }, [allEndpoints]);

  // Reverse picker source — drop singletons (1 endpoint), search filter, sort by usage desc.
  const filteredServices = useMemo<ServiceUsageEntry[]>(() => {
    if (direction !== 'reverse' || !serviceCatalog) return [];
    const innerQ = pickerSearch.toLowerCase().trim();
    return serviceCatalog
      .filter((s) => (s.usedByEndpoints?.length ?? 0) > 1)
      .filter((s) => {
        if (!innerQ) return true;
        const hay = (s.declaringType + ' ' + (s.resolvedImplType ?? '') + ' ' + (s.calledMethods ?? []).join(' ')).toLowerCase();
        return hay.includes(innerQ);
      })
      .slice()
      .sort((a, b) => (b.usedByEndpoints?.length ?? 0) - (a.usedByEndpoints?.length ?? 0));
  }, [direction, serviceCatalog, pickerSearch]);

  // Group interface entries with their resolved impl entries so the picker shows one card
  // per logical service rather than two rows (IUserService + UserService side by side).
  interface ServiceGroup {
    primary: ServiceUsageEntry;            // header — interface preferred, falls back to class
    impl?: ServiceUsageEntry;              // resolved concrete (when separate entry exists)
    methods: string[];                     // union of called methods, sorted
    endpointCount: number;                 // de-duped union
  }
  const serviceGroups = useMemo<ServiceGroup[]>(() => {
    if (direction !== 'reverse') return [];
    if (filteredServices.length === 0) return [];
    const byId = new Map(filteredServices.map((s) => [s.declaringType, s] as const));
    const consumed = new Set<string>();
    const groups: ServiceGroup[] = [];
    for (const svc of filteredServices) {
      if (consumed.has(svc.declaringType)) continue;
      if (svc.isInterface && svc.resolvedImplType && byId.has(svc.resolvedImplType)) {
        const impl = byId.get(svc.resolvedImplType)!;
        consumed.add(svc.declaringType);
        consumed.add(impl.declaringType);
        const methods = Array.from(new Set([...(svc.calledMethods ?? []), ...(impl.calledMethods ?? [])])).sort();
        const endpoints = new Set([...(svc.usedByEndpoints ?? []), ...(impl.usedByEndpoints ?? [])]);
        groups.push({ primary: svc, impl, methods, endpointCount: endpoints.size });
      } else {
        // No interface↔impl pairing — single-card group.
        consumed.add(svc.declaringType);
        groups.push({
          primary: svc,
          methods: (svc.calledMethods ?? []).slice().sort(),
          endpointCount: svc.usedByEndpoints?.length ?? 0,
        });
      }
    }
    return groups;
  }, [direction, filteredServices]);

  // Track which groups the user has expanded — collapsed by default so the list stays scannable.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (id: string) => setExpandedGroups((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  // Picker list — every endpoint filtered by the picker controls AND the system-map
  // header search (so the two stay consistent).
  const pickerEndpoints = useMemo(() => {
    const outerQ = search.toLowerCase().trim();
    const innerQ = pickerSearch.toLowerCase().trim();
    return allEndpoints
      .filter(({ node, version }) => {
        if (pickerMethod !== 'ALL' && (node.httpMethod ?? '').toUpperCase() !== pickerMethod) return false;
        if (pickerVersion !== 'ALL' && version !== pickerVersion) return false;
        const haystack = `${node.label} ${node.area ?? ''} ${node.httpMethod ?? ''} ${node.id}`.toLowerCase();
        if (outerQ && !haystack.includes(outerQ)) return false;
        if (innerQ && !haystack.includes(innerQ)) return false;
        return true;
      })
      .map((e) => e.node);
  }, [allEndpoints, pickerMethod, pickerVersion, pickerSearch, search]);

  // Source the visible subgraph from the focused endpoint's IL call graph (`flat` above).
  // Apply kind filter + collapse-set: nodes whose id is in `collapsed` are kept but their
  // descendants are dropped.
  const { visibleNodes, visibleEdges, hasChildren } = useMemo(() => {
    const nodeSet = new Set<string>();
    const edgeList: FlatEdge[] = [];

    if (!focusId || flat.nodes.size === 0) {
      return { visibleNodes: nodeSet, visibleEdges: edgeList, hasChildren: new Set<string>() };
    }

    // Adjacency on the flat tree. In forward mode edges flow root → descendants so we walk
    // `from → to`. In reverse mode edges flow caller → focusService (the service is the sink),
    // so we walk the inverse: `to → from` to fan upward from the picked service through its
    // intermediate services to the caller endpoints.
    const adj = new Map<string, string[]>();
    for (const e of flat.edges) {
      const [src, dst] = direction === 'reverse' ? [e.to, e.from] : [e.from, e.to];
      if (!adj.has(src)) adj.set(src, []);
      adj.get(src)!.push(dst);
    }

    // BFS from the focus root through the (direction-aware) adjacency, honouring kind filter
    // + collapse stop-list.
    const queue = [focusId];
    nodeSet.add(focusId);
    const seen = new Set<string>([focusId]);
    while (queue.length) {
      const cur = queue.shift()!;
      if (collapsed.has(cur) && cur !== focusId) continue;
      const outs = adj.get(cur) ?? [];
      for (const to of outs) {
        const child = flat.nodes.get(to);
        if (!child) continue;
        if (!visibleKinds.has(child.kind)) continue;
        if (seen.has(to)) continue;
        seen.add(to);
        nodeSet.add(to);
        queue.push(to);
      }
    }
    for (const e of flat.edges) {
      if (!nodeSet.has(e.from) || !nodeSet.has(e.to)) continue;
      const target = flat.nodes.get(e.to);
      if (target && !visibleKinds.has(target.kind)) continue;
      edgeList.push(e);
    }
    return { visibleNodes: nodeSet, visibleEdges: edgeList, hasChildren: flat.hasChildren };
  }, [focusId, flat, collapsed, visibleKinds, direction]);

  // Build layout via Dagre TB on every visible-set change. Dagre cost is O(V+E)
  // on the visible subset only, so collapsed default = 243 endpoints in a single
  // row, which Dagre handles in <20ms.
  const layout = useMemo(
    () => layoutDagre(
      [...visibleNodes],
      visibleEdges,
      // Reverse mode crams many nodes side-by-side; varying heights from inline snippets
      // produced overlaps where two adjacent service nodes landed on the same ranker row
      // with different vertical extents. Lock every node to NODE_H in reverse so Dagre's
      // collision math has a uniform grid. Forward mode keeps the tall snippet rows.
      direction === 'reverse'
        ? () => NODE_H
        : (id) => flat.nodes.get(id)?.bodySnippet ? 200 : NODE_H,
      direction === 'reverse' ? 'LR' : 'TB',
    ),
    [visibleNodes, visibleEdges, flat.nodes, direction],
  );

  // Map raw IDs (which contain slashes, braces, dots) to stable, DOM-safe synthetic
  // ones so XyFlow can use them in selectors / aria attributes. The original ID is
  // preserved in node.data.originalId for click → onSelect.
  const idMap = useMemo(() => {
    const m = new Map<string, string>();
    let i = 0;
    for (const id of visibleNodes) m.set(id, `n${i++}`);
    return m;
  }, [visibleNodes]);


  const edges = useMemo<RFEdge[]>(() => {
    return visibleEdges
      .map((e, i) => {
        const s = idMap.get(e.from);
        const t = idMap.get(e.to);
        if (!s || !t) return null;
        const targetKind = flat.nodes.get(e.to)?.kind ?? 'service';
        return {
          id: `e${i}`,
          source: s,
          target: t,
          type: 'smoothstep',
          animated: false,
          style: {
            stroke: KIND_COLOR[targetKind],
            strokeWidth: 1.5,
            opacity: 0.7,
          },
        } as RFEdge;
      })
      .filter((e): e is RFEdge => e !== null);
  }, [visibleEdges, flat.nodes, idMap]);

  const handleNodeClick = useCallback((_evt: React.MouseEvent, node: RFNode<NodeData>) => {
    const realId = node.data.originalId;
    onSelect(realId);
    if (!node.data.hasChildren) return;
    if (realId === focusId) return; // root is always expanded
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(realId)) next.delete(realId);
      else next.add(realId);
      return next;
    });
  }, [onSelect, focusId]);

  // Floating context menu anchored to the cursor on right-click. Opens at exact pointer
  // coordinates so the user doesn't lose their place when scanning the canvas.
  interface CtxMenu {
    x: number; y: number;
    nodeId: string;
    path?: string;
    line?: number;
    endLine?: number;
    methodName?: string;
  }
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  interface SourceFrame { nodeId: string; path?: string; line?: number; endLine?: number; methodName?: string }
  const [sourceOpen, setSourceOpen] = useState<SourceFrame | null>(null);
  const [sourceHistory, setSourceHistory] = useState<SourceFrame[]>([]);

  // React Flow controller — used to smoothly center the canvas on whichever node the
  // SourceDrawer is currently viewing (right-pane source ↔ left-pane node always in sync).
  // The drawer covers the right ~820px of the viewport, so we shift the target X right by
  // half the drawer width (in world coordinates given the zoom) so the centered node lands
  // in the still-visible left band rather than under the drawer.
  const rf = useReactFlow();
  useEffect(() => {
    if (!sourceOpen) return;
    const target = layout.nodes.find((n) => n.id === sourceOpen.nodeId);
    if (!target) return;
    const raf = requestAnimationFrame(() => {
      const zoom = 1.15;
      // Centre the node in the strip of canvas that's still visible — i.e. between the
      // endpoint picker on the left (~280px) and the SourceDrawer on the right (~820px).
      // setCenter places the given world point at the VIEWPORT centre, so we offset by
      //   shift_px = visibleCanvasCentre - viewportCentre
      // and convert to world units via the chosen zoom.
      const drawerWidth = Math.min(820, window.innerWidth * 0.8);
      const pickerWidth = 280;
      const viewportCentre = window.innerWidth / 2;
      const visibleCanvasCentre = pickerWidth + (window.innerWidth - pickerWidth - drawerWidth) / 2;
      const shiftPx = visibleCanvasCentre - viewportCentre;
      const offsetWorld = -shiftPx / zoom;
      rf.setCenter(target.x + offsetWorld, target.y, { zoom, duration: 600 });
    });
    return () => cancelAnimationFrame(raf);
  }, [sourceOpen, layout.nodes, rf]);

  const handleShowSource = useCallback((realId: string) => {
    const node = flat.nodes.get(realId);
    setSourceOpen({
      nodeId: realId,
      path: node?.filePath,
      line: node?.lineNumber,
      endLine: node?.endLine,
      methodName: node?.methodName,
    });
    setSourceHistory([]);
  }, [flat.nodes]);

  const handleJumpInDrawer = useCallback((target: SourceFrame) => {
    setSourceOpen((prev) => {
      if (prev) setSourceHistory((h) => [...h, prev]);
      return target;
    });
  }, []);

  const handleBackInDrawer = useCallback(() => {
    setSourceHistory((h) => {
      if (h.length === 0) return h;
      const next = h.slice(0, -1);
      setSourceOpen(h[h.length - 1]);
      return next;
    });
  }, []);

  // Method-name → node info, so the SourceDrawer can turn `_service.X(...)` mentions into
  // click-through jumps into the relevant method's own drawer view. Built from the current
  // call graph's flat nodes — only names that actually show up downstream of the focus root
  // are present.
  const methodIndex = useMemo(() => {
    const map = new Map<string, { id: string; path?: string; line?: number; endLine?: number }>();
    for (const [id, n] of flat.nodes) {
      if (!n.filePath) continue;
      const name = n.methodName && n.methodName.length > 1 ? n.methodName : null;
      if (!name) continue;
      // Strip async suffix variants — body usually mentions the public Async method by name.
      const canonical = name;
      if (!map.has(canonical)) {
        map.set(canonical, { id, path: n.filePath, line: n.lineNumber, endLine: n.endLine });
      }
    }
    return map;
  }, [flat.nodes]);

  const handleNodeRightClick = useCallback((realId: string, evt: React.MouseEvent) => {
    evt.preventDefault();
    const node = flat.nodes.get(realId);
    setCtxMenu({
      x: evt.clientX,
      y: evt.clientY,
      nodeId: realId,
      path: node?.filePath,
      line: node?.lineNumber,
      endLine: node?.endLine,
      methodName: node?.methodName,
    });
  }, [flat.nodes]);

  // Close context menu on outside click / escape.
  useEffect(() => {
    if (!ctxMenu) return;
    const onDocClick = () => setCtxMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setCtxMenu(null); };
    // Defer so the current right-click event doesn't immediately close the menu.
    const t = setTimeout(() => {
      document.addEventListener('click', onDocClick);
      document.addEventListener('contextmenu', onDocClick);
    }, 0);
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('contextmenu', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [ctxMenu]);

  const nodes = useMemo<RFNode<NodeData>[]>(() => {
    return layout.nodes.map((n) => {
      const node = flat.nodes.get(n.id);
      const safe = idMap.get(n.id) ?? n.id;
      return {
        id: safe,
        type: 'layered',
        position: { x: n.x - NODE_W / 2, y: n.y - NODE_H / 2 },
        data: {
          originalId: n.id,
          label: node?.label ?? n.id,
          kind: node?.kind ?? 'service',
          method: node?.method,
          area: node?.area,
          summary: node?.summary,
          filePath: node?.filePath,
          lineNumber: node?.lineNumber,
          signals: node?.signals,
          // Hide inline snippet in reverse mode — too dense, layout overlaps. Right-click /
          // "Show full source" link still opens the drawer with the full method body.
          bodySnippet: direction === 'reverse' ? undefined : node?.bodySnippet,
          highlighted: selectedId === n.id,
          expanded: !collapsed.has(n.id),
          hasChildren: hasChildren.has(n.id),
          drawerActive: sourceOpen?.nodeId === n.id,
          drawerDim: !!sourceOpen && sourceOpen.nodeId !== n.id,
          horizontal: direction === 'reverse',
          onRightClick: handleNodeRightClick,
          onShowSource: handleShowSource,
        },
      };
    });
  }, [layout.nodes, flat.nodes, collapsed, hasChildren, selectedId, idMap, handleNodeRightClick, handleShowSource, sourceOpen, direction]);

  const handlePickEndpoint = useCallback((id: string) => {
    setFocusId(id);
    setCollapsed(new Set());
    onSelect(id);
  }, [onSelect]);

  const nodeTypes = useMemo(() => ({ layered: LayeredNode }), []);

  const focusNode = focusId ? serviceMapById.get(focusId) : null;

  return (
    <div className="layered-drill">
      <aside className="layered-picker" aria-label={direction === 'reverse' ? 'service picker' : 'endpoint picker'}>
        <div className="layered-picker-head">
          <strong>{direction === 'reverse' ? 'Services' : 'Endpoints'}</strong>
          <span className="muted small">
            {direction === 'reverse'
              ? `${filteredServices.length} / ${(serviceCatalog ?? []).length}`
              : `${pickerEndpoints.length} / ${allEndpoints.length}`}
          </span>
        </div>
        <div className="layered-picker-filters">
          <input
            type="search"
            className="layered-picker-search"
            placeholder={direction === 'reverse' ? 'filter by service name…' : 'filter by name / path…'}
            value={pickerSearch}
            onChange={(e) => setPickerSearch(e.target.value)}
            aria-label="search"
          />
          {direction === 'forward' && (
            <div className="layered-picker-selects">
              <select
                className="layered-picker-select"
                value={pickerMethod}
                onChange={(e) => setPickerMethod(e.target.value)}
                aria-label="filter by HTTP method"
              >
                {methodOptions.map((m) => (
                  <option key={m} value={m}>{m === 'ALL' ? 'All methods' : m}</option>
                ))}
              </select>
              <select
                className="layered-picker-select"
                value={pickerVersion}
                onChange={(e) => setPickerVersion(e.target.value)}
                aria-label="filter by API version"
              >
                {versionOptions.map((v) => (
                  <option key={v} value={v}>{v === 'ALL' ? 'All versions' : v}</option>
                ))}
              </select>
            </div>
          )}
          {(pickerSearch || pickerMethod !== 'ALL' || pickerVersion !== 'ALL') && (
            <button
              type="button"
              className="layered-picker-clear"
              onClick={() => { setPickerSearch(''); setPickerMethod('ALL'); setPickerVersion('ALL'); }}
            >
              Clear filters
            </button>
          )}
        </div>
        <div className="layered-picker-list">
          {direction === 'reverse' ? (
            serviceGroups.map((g) => {
              const id = g.primary.declaringType;
              const isActive = id === focusId || g.impl?.declaringType === focusId;
              const isOpen = expandedGroups.has(id);
              const headerLabel = shortLabelFromId(id);
              const implLabel = g.impl ? shortLabelFromId(g.impl.declaringType) : null;
              return (
                <div key={id} className="layered-picker-group">
                  <button
                    type="button"
                    className={`layered-picker-item layered-picker-group-head${isActive ? ' is-active' : ''}`}
                    onClick={() => handlePickEndpoint(id)}
                    onContextMenu={(e) => { e.preventDefault(); toggleGroup(id); }}
                    title={`${id}${g.impl ? `\n→ ${g.impl.declaringType}` : ''}`}
                  >
                    <span
                      className="layered-picker-caret"
                      role="button"
                      onClick={(e) => { e.stopPropagation(); toggleGroup(id); }}
                      aria-label={isOpen ? 'collapse' : 'expand'}
                    >{isOpen ? '▾' : '▸'}</span>
                    <span className="layered-picker-label">{headerLabel}</span>
                    <span className="layered-picker-area">{g.endpointCount} ep</span>
                  </button>
                  {isOpen && (
                    <div className="layered-picker-group-body">
                      {implLabel && (
                        <button
                          type="button"
                          className={`layered-picker-item layered-picker-subitem${g.impl?.declaringType === focusId ? ' is-active' : ''}`}
                          onClick={() => handlePickEndpoint(g.impl!.declaringType)}
                          title={g.impl?.declaringType}
                        >
                          <span className="layered-picker-sub-tag">impl</span>
                          <span className="layered-picker-label">{implLabel}</span>
                        </button>
                      )}
                      {g.methods.length === 0 && (
                        <div className="layered-picker-sub-empty muted small">no methods recorded</div>
                      )}
                      {g.methods.map((m) => (
                        <div
                          key={m}
                          className="layered-picker-method"
                          title={`${headerLabel}.${m}`}
                        >
                          <span className="layered-picker-sub-tag">fn</span>
                          <span className="layered-picker-label">{m}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          ) : pickerEndpoints.map((ep) => (
            <button
              type="button"
              key={ep.id}
              className={`layered-picker-item${ep.id === focusId ? ' is-active' : ''}`}
              onClick={() => handlePickEndpoint(ep.id)}
              title={ep.label}
            >
              {ep.httpMethod && (
                <span className={`method-badge method-${ep.httpMethod.toLowerCase()}`}>{ep.httpMethod}</span>
              )}
              <span className="layered-picker-label">{shortEndpointLabel(ep.label)}</span>
              {ep.area && <span className="layered-picker-area">{ep.area}</span>}
            </button>
          ))}
          {direction === 'forward' && pickerEndpoints.length === 0 && (
            <span className="muted small layered-picker-empty">no endpoints match</span>
          )}
          {direction === 'reverse' && serviceGroups.length === 0 && (
            <span className="muted small layered-picker-empty">
              {serviceCatalog === null ? 'loading services…' : 'no services with multiple callers'}
            </span>
          )}
        </div>
      </aside>
      <div className="layered-canvas">
        <div className="layered-toolbar">
          {focusNode ? (
            <>
              <button type="button" className="layered-btn" onClick={() => { setFocusId(null); setCollapsed(new Set()); }}>
                ← Clear focus
              </button>
              <strong className="layered-focus-label">{focusNode.label}</strong>
              <span className="layered-view-toggle" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={focusView === 'graph'}
                  className={`layered-view-btn${focusView === 'graph' ? ' is-active' : ''}`}
                  onClick={() => setFocusView('graph')}
                  title="Service-map: outgoing service / interface nodes"
                >Graph</button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={focusView === 'trace'}
                  className={`layered-view-btn${focusView === 'trace' ? ' is-active' : ''}`}
                  onClick={() => setFocusView('trace')}
                  title="IL call trace: full recursive method tree (MediatR / EF / repo)"
                  disabled={focusNode.kind !== 'endpoint'}
                >Trace</button>
              </span>
              <span className="muted small">
                {focusView === 'graph' ? (
                  <>
                    {callGraphLoading && 'loading…'}
                    {callGraphError && <span className="error">{callGraphError}</span>}
                    {!callGraphLoading && !callGraphError && (
                      <>
                        {visibleNodes.size} node{visibleNodes.size === 1 ? '' : 's'} ·{' '}
                        {visibleEdges.length} link{visibleEdges.length === 1 ? '' : 's'}
                        {collapsed.size > 0 && ` · ${collapsed.size} collapsed`}
                      </>
                    )}
                  </>
                ) : (
                  <>IL call trace</>
                )}
              </span>
              {focusView === 'graph' && collapsed.size > 0 && (
                <button type="button" className="layered-btn" onClick={() => setCollapsed(new Set())}>
                  Expand all
                </button>
              )}
              {direction === 'reverse' && (
                <button
                  type="button"
                  className={`layered-btn${grepOpen ? ' is-active' : ''}`}
                  onClick={() => setGrepOpen((v) => !v)}
                  title="Text grep across the source tree — catches references the IL walker skips (logger calls, dynamic dispatch, nameof references)."
                >
                  Source grep
                </button>
              )}
            </>
          ) : (
            <span className="muted small">Pick an endpoint on the left to see its full transitive call tree.</span>
          )}
        </div>
        {focusNode && focusView === 'graph' && (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodeClick={handleNodeClick}
            onPaneClick={() => onSelect(null)}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={true}
            fitView
            fitViewOptions={{ padding: 0.15 }}
            minZoom={0.1}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={20} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}
        {focusNode && focusView === 'trace' && (
          <div className="layered-trace">
            {focusNode.kind === 'endpoint' ? (
              <CallGraphTab endpointId={focusId ?? undefined} />
            ) : (
              <div className="layered-empty">
                <p className="muted small">Trace view is only available for endpoint roots.</p>
              </div>
            )}
          </div>
        )}
        {!focusNode && (
          <div className="layered-empty">
            <p>No focus root selected.</p>
            <p className="muted small">Pick an endpoint on the left.</p>
          </div>
        )}
        {focusNode && direction === 'reverse' && grepOpen && (
          <div className="layered-grep-panel" aria-label="source grep results">
            <div className="layered-grep-head">
              <strong>Source grep — {shortLabelFromId(focusId!)}</strong>
              <span className="muted small">
                {grepLoading ? 'searching…' : `${grepHits?.length ?? 0} hit${(grepHits?.length ?? 0) === 1 ? '' : 's'}`}
                {grepCapped && ' (capped)'}
              </span>
              <button type="button" className="layered-btn" onClick={() => setGrepOpen(false)} title="Close grep">×</button>
            </div>
            {grepHits && grepHits.length === 0 && !grepLoading && (
              <div className="muted small layered-grep-empty">No textual references found.</div>
            )}
            <div className="layered-grep-body">
              {(() => {
                if (!grepHits) return null;
                // Group by full path so the same file's matches collapse into one row.
                const groups = new Map<string, SourceGrepHit[]>();
                for (const h of grepHits) {
                  if (!groups.has(h.path)) groups.set(h.path, []);
                  groups.get(h.path)!.push(h);
                }
                // Sort: controller / endpoint files first (the user thinks in API terms),
                // then everything else alphabetically.
                const ordered = [...groups.entries()].sort((a, b) => {
                  const score = (p: string) => {
                    const f = p.toLowerCase();
                    if (f.includes('controller')) return 0;
                    if (f.includes('endpoint') || f.includes('handler')) return 1;
                    if (f.includes('test')) return 5;
                    return 3;
                  };
                  const sa = score(a[0]); const sb = score(b[0]);
                  if (sa !== sb) return sa - sb;
                  return a[0].localeCompare(b[0]);
                });
                return ordered.map(([path, hits]) => {
                  const fileName = path.split('/').pop() ?? path;
                  const isOpen = grepFileOpen.has(path);
                  const isControllerish = /controller|endpoint|handler/i.test(fileName);
                  return (
                    <div key={path} className={`layered-grep-group${isControllerish ? ' is-api' : ''}`}>
                      <button
                        type="button"
                        className="layered-grep-group-head"
                        onClick={() => toggleGrepFile(path)}
                        title={path}
                      >
                        <span className="layered-grep-caret">{isOpen ? '▾' : '▸'}</span>
                        <span className="layered-grep-file">{fileName}</span>
                        <span className="layered-grep-count">{hits.length}</span>
                      </button>
                      {isOpen && (
                        <div className="layered-grep-group-body">
                          {hits.map((h, i) => (
                            <button
                              type="button"
                              key={`${h.line}:${i}`}
                              className="layered-grep-row"
                              onClick={() => setSourceOpen({ nodeId: `${fileName}:${h.line}`, path: h.path, line: h.line, endLine: h.line + 20 })}
                              title={`${path}:${h.line}`}
                            >
                              <span className="layered-grep-line">{h.line}</span>
                              <code className="layered-grep-preview">{h.preview}</code>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                });
              })()}
            </div>
          </div>
        )}
      </div>
      {ctxMenu && (
        <div
          className="layered-ctxmenu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          role="menu"
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button
            type="button"
            role="menuitem"
            className="layered-ctxmenu-item"
            disabled={!ctxMenu.path}
            onClick={() => {
              setSourceOpen({ nodeId: ctxMenu.nodeId, path: ctxMenu.path, line: ctxMenu.line, endLine: ctxMenu.endLine, methodName: ctxMenu.methodName });
              setCtxMenu(null);
            }}
          >
            <span className="layered-ctxmenu-icon">⌥</span>
            <span>View source</span>
            {!ctxMenu.path && <span className="muted small" style={{ marginLeft: 'auto' }}>no PDB</span>}
          </button>
          <button
            type="button"
            role="menuitem"
            className="layered-ctxmenu-item"
            onClick={() => {
              navigator.clipboard?.writeText(ctxMenu.nodeId).catch(() => {});
              setCtxMenu(null);
            }}
          >
            <span className="layered-ctxmenu-icon">⎘</span>
            <span>Copy id</span>
          </button>
          {ctxMenu.path && (
            <button
              type="button"
              role="menuitem"
              className="layered-ctxmenu-item"
              onClick={() => {
                navigator.clipboard?.writeText(`${ctxMenu.path}:${ctxMenu.line ?? 1}`).catch(() => {});
                setCtxMenu(null);
              }}
            >
              <span className="layered-ctxmenu-icon">⎘</span>
              <span>Copy file:line</span>
            </button>
          )}
        </div>
      )}
      {sourceOpen && (
        <SourceDrawer
          nodeId={sourceOpen.nodeId}
          path={sourceOpen.path}
          line={sourceOpen.line}
          endLine={sourceOpen.endLine}
          methodName={sourceOpen.methodName}
          methodIndex={methodIndex}
          canGoBack={sourceHistory.length > 0}
          onJumpTo={(target) => handleJumpInDrawer({
            nodeId: target.id,
            path: target.path,
            line: target.line,
            endLine: target.endLine,
            methodName: target.methodName,
          })}
          onBack={handleBackInDrawer}
          onClose={() => { setSourceOpen(null); setSourceHistory([]); }}
        />
      )}
    </div>
  );
}

export const LayeredDrillDown = memo(function LayeredDrillDownWrap(props: Props) {
  return (
    <ReactFlowProvider>
      <LayeredDrillDownImpl {...props} />
    </ReactFlowProvider>
  );
});

function LayeredNodeImpl({ data }: NodeProps & { data: NodeData }) {
  const color = KIND_COLOR[data.kind];
  const throws = (data.signals ?? []).filter((s) => s.kind === 'throws');
  const logs = (data.signals ?? []).filter((s) => s.kind === 'logMessage');
  const branches = (data.signals ?? []).find((s) => s.kind === 'branches');
  const tooltip = [
    data.label,
    data.summary ?? '',
    throws.length ? `Throws: ${throws.map((t) => t.text).join(', ')}` : '',
    branches ? `Branches: ${branches.text}` : '',
    logs.length ? `Logs: ${logs.slice(0, 3).map((l) => `"${l.text}"`).join(' · ')}` : '',
    'Right-click for source.',
  ].filter(Boolean).join('\n');
  return (
    <div className="layered-node-wrap">
      {data.summary && (
        // Left-side bubble: business intent pulled from XML docs. Kept off the main node so the
        // primary tree silhouette stays compact and aligned; bubble has its own connector.
        <div className="layered-summary-bubble" title={data.summary}>
          <span className="layered-summary-icon" aria-hidden="true">💬</span>
          <span className="layered-summary-text">{data.summary}</span>
        </div>
      )}
      <div
        className={`layered-node kind-${data.kind}${data.highlighted ? ' is-selected' : ''}${data.bodySnippet ? ' has-snippet' : ''}${data.drawerActive ? ' is-drawer-active' : ''}${data.drawerDim ? ' is-drawer-dim' : ''}`}
        style={{ borderColor: color, width: NODE_W, minHeight: NODE_H }}
        onContextMenu={(e) => data.onRightClick(data.originalId, e)}
        title={tooltip}
      >
        <Handle type="target" position={data.horizontal ? Position.Left : Position.Top} style={{ background: color, opacity: 0.6 }} />
        <div className="layered-node-head">
          {data.method && (
            <span className={`method-badge method-${data.method.toLowerCase()}`}>{data.method}</span>
          )}
          <span className="layered-node-kind" style={{ background: color }}>{data.kind}</span>
          {data.filePath && <span className="layered-node-src" aria-label="source available" title="Right-click for source">⌥</span>}
          {data.hasChildren && (
            <span className="layered-node-toggle" aria-label={data.expanded ? 'expanded' : 'collapsed'}>
              {data.expanded ? '−' : '+'}
            </span>
          )}
        </div>
        <div className="layered-node-label" title={data.label}>{data.label}</div>
        {data.area && <div className="layered-node-area">{data.area}</div>}
        {data.bodySnippet && (
          <pre
            className="layered-node-snippet language-csharp"
            aria-label="method body preview"
            title="Click to open full source"
            onClick={(e) => {
              e.stopPropagation();
              if (data.filePath) data.onShowSource?.(data.originalId);
            }}
            dangerouslySetInnerHTML={{ __html: Prism.highlight(data.bodySnippet, Prism.languages.csharp, 'csharp') }}
          />
        )}
        {data.bodySnippet && data.filePath && data.onShowSource && (
          <button
            type="button"
            className="layered-node-snippet-more"
            onClick={(e) => { e.stopPropagation(); data.onShowSource?.(data.originalId); }}
          >Show full source →</button>
        )}
        {(throws.length > 0 || branches || logs.length > 0) && (
          <div className="layered-node-signals" aria-label="il signals">
            {throws.slice(0, 3).map((t) => (
              <span key={`th-${t.text}`} className="sig sig-throw" title={`throws ${t.text}`}>⚠ {t.text}</span>
            ))}
            {branches && (
              <span className="sig sig-branch" title={`${branches.text} conditional branches`}>⊥ {branches.text}</span>
            )}
            {logs.length > 0 && (
              <span className="sig sig-log" title={logs.map((l) => `"${l.text}"`).join('\n')}>
                📜 {logs.length}
              </span>
            )}
          </div>
        )}
        <Handle type="source" position={data.horizontal ? Position.Right : Position.Bottom} style={{ background: color, opacity: 0.6 }} />
      </div>
    </div>
  );
}
const LayeredNode = memo(LayeredNodeImpl);

/** "PVC.WebApi.Controllers.X.YController.Method (PVC.WebApi)" → "Method". Mirrors the
 * sysmap side-rail label so the picker stays compact in 280px width. */
function shortEndpointLabel(label: string): string {
  const beforeParen = label.split(' (')[0];
  const dot = beforeParen.lastIndexOf('.');
  return dot >= 0 ? beforeParen.substring(dot + 1) : beforeParen;
}

/** "PVC.Modules.Identity.Application.Services.UserService" → "UserService". For the
 * reverse-mode service picker where the id is the full type name. */
function shortLabelFromId(id: string): string {
  const dot = id.lastIndexOf('.');
  return dot >= 0 ? id.substring(dot + 1) : id;
}

/** "POST /api/v1/pvc/authorization/permissions" → "permissions" (last 1-2 path segments).
 * Lets reverse-mode endpoint nodes stay compact when many of them stack on the left lane. */
function shortEndpointLabelFromId(epId: string): string {
  const spaceIdx = epId.indexOf(' ');
  const path = spaceIdx >= 0 ? epId.substring(spaceIdx + 1) : epId;
  const segs = path.split('/').filter(Boolean);
  if (segs.length === 0) return path;
  // Keep the last segment, prepend the previous one when the last looks like a route token
  // (e.g. {id}) so the user sees `roles/{roleId}` instead of just `{roleId}`.
  const last = segs[segs.length - 1];
  if (segs.length > 1 && (last.startsWith('{') || last === 'assign' || last === 'merge')) {
    return segs[segs.length - 2] + '/' + last;
  }
  return last;
}

/** Pull an `vN` version segment out of an endpoint id like
 *  `POST /api/v1/pvc/notification/test-email` → `"v1"`. Returns null if absent. */
function extractVersion(endpointId: string): string | null {
  const m = endpointId.match(/\/v(\d+)(?:[/.]|$)/i);
  return m ? `v${m[1]}` : null;
}

/** Pure Dagre TB layout on the visible subgraph. Returns positioned nodes.
 * `heightOf` lets the caller widen a node's lane when it carries a body snippet
 * so siblings don't overlap the inline source preview. */
function layoutDagre(
  visibleIds: string[],
  edges: { from: string; to: string }[],
  heightOf?: (id: string) => number,
  rankdir: 'TB' | 'LR' = 'TB',
): { nodes: { id: string; x: number; y: number }[] } {
  const g = new dagre.graphlib.Graph();
  // LR (left → right) keeps reverse fan-in compact: many endpoint nodes stack vertically on
  // the left, the focus service sits on the right, so wide trees don't push the canvas off-
  // screen the way TB does. Forward keeps TB. `tight-tree` ranker spaces nodes so edges
  // don't pile on top of each other when the focus has 10+ callers.
  g.setGraph({
    rankdir,
    nodesep: rankdir === 'LR' ? 30 : 30,
    ranksep: rankdir === 'LR' ? 120 : 70,
    ranker: rankdir === 'LR' ? 'tight-tree' : 'network-simplex',
  });
  g.setDefaultEdgeLabel(() => ({}));
  const idSet = new Set(visibleIds);
  for (const id of visibleIds) {
    g.setNode(id, { width: NODE_W, height: heightOf?.(id) ?? NODE_H });
  }
  for (const e of edges) {
    if (idSet.has(e.from) && idSet.has(e.to)) {
      g.setEdge(e.from, e.to);
    }
  }
  dagre.layout(g);
  const placed = visibleIds.map((id) => {
    const p = g.node(id);
    return { id, x: p?.x ?? 0, y: p?.y ?? 0 };
  });
  return { nodes: placed };
}
