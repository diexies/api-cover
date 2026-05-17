import { Handle, Position, type NodeProps } from '@xyflow/react';
import { memo, useEffect, useState } from 'react';
import type { NodeStatus } from './api';
import { hexToRgba } from './colors';
import { ResponseViewer } from './components/ResponseViewer';

export interface ApiNodeData extends Record<string, unknown> {
  label: string;
  method: string;
  path: string;
  status: NodeStatus;
  response?: unknown;
  /** Full response snapshot including status code + headers, surfaced for ResponseViewer. */
  responseStatus?: number;
  responseHeaders?: Record<string, string>;
  /** Request snapshot — method/path/headers/body actually sent during the run. */
  request?: { method?: string; path?: string; headers?: Record<string, string>; body?: unknown };
  error?: string;
  hasBreakpoint?: boolean;
  /** True when no run is active; suppresses the "pending = faded" treatment for editing. */
  idle?: boolean;
  /** Number of groups this node belongs to. >1 means cartesian fan-out applies. */
  groupCount?: number;
  /** Total cartesian iteration count when in multiple groups. */
  cartesianIterations?: number;
  /** Marked as a start node — shows a visible badge and outlines the node on canvas. */
  isStart?: boolean;
  /** Number of CaseSet variants attached to this node (>0 ⇒ fork anchor). */
  caseVariantCount?: number;
  /** Optional case-anchor tint for the badge. */
  caseAnchorColor?: string;
  /** Side the response balloon should anchor to — alternates per node so neighbours
   *  don't overlap when a whole chain has responses open. */
  balloonSide?: 'left' | 'right';
  /** When this RF node is a per-branch fan-out clone, the human-readable branch label
   *  (e.g. "g_alpha ×2") rendered as a small corner pill so the user can tell iterations apart. */
  branchLabel?: string;
}

const statusClass: Record<NodeStatus, string> = {
  pending: 'node-pending',
  running: 'node-running',
  succeeded: 'node-succeeded',
  failed: 'node-failed',
  skipped: 'node-skipped',
  paused: 'node-paused',
  cancelled: 'node-cancelled',
};

// Icon + label for each status. Pairs with the border colour so the signal isn't
// colour-only — meets accessibility floor for colourblind users.
const statusBadge: Record<NodeStatus, { icon: string; label: string } | null> = {
  pending:   null,
  running:   { icon: '⏵', label: 'running' },
  succeeded: { icon: '✓', label: 'succeeded' },
  failed:    { icon: '✗', label: 'failed' },
  skipped:   { icon: '⊘', label: 'skipped' },
  paused:    { icon: '⏸', label: 'paused' },
  cancelled: { icon: '⊘', label: 'cancelled' },
};

const methodClass: Record<string, string> = {
  GET: 'method-get',
  POST: 'method-post',
  PUT: 'method-put',
  DELETE: 'method-delete',
  PATCH: 'method-patch',
};

function ApiNodeViewImpl({ data }: NodeProps & { data: ApiNodeData }) {
  const canShowResponse = data.status === 'succeeded' || data.status === 'failed';
  const [open, setOpen] = useState(false);
  // Auto-open the balloon the moment a node finishes; user can still close manually.
  // Reset to closed if the status leaves a finished state (e.g. user reruns the scenario).
  useEffect(() => {
    if (canShowResponse) setOpen(true);
    else setOpen(false);
  }, [canShowResponse, data.status]);

  const baseCls = data.idle && data.status === 'pending'
    ? 'api-node node-idle'
    : `api-node ${statusClass[data.status]}`;
  const cls = data.isStart ? `${baseCls} is-start` : baseCls;
  const variantCount = data.caseVariantCount ?? 0;
  const anchorTint = data.caseAnchorColor ?? '#a855f7';
  // Suppress the status pill in idle/editing mode — the badge is run-time signal,
  // not editor decoration.
  const badge = data.idle ? null : statusBadge[data.status];
  return (
    <div className={cls}>
      {data.isStart && <span className="start-flag" title="start node — kicks off the scenario">▶ start</span>}
      {data.branchLabel && (
        <span className="branch-clone-pill" title={`branch: ${data.branchLabel}`}>
          {data.branchLabel}
        </span>
      )}
      {variantCount > 0 && (
        <span
          className="case-anchor-pill"
          style={{
            background: hexToRgba(anchorTint, 0.18),
            borderColor: anchorTint,
            color: anchorTint,
          }}
          title={`${variantCount} variant${variantCount === 1 ? '' : 's'} — forks downstream into ${variantCount} branches`}
        >
          ⑂ {variantCount}
        </span>
      )}
      <Handle type="target" position={Position.Top} />
      {data.status === 'failed' && data.error && (
        <div className="api-node-error-chip" role="alert" title={data.error}>
          <span className="api-node-error-icon" aria-hidden="true">✗</span>
          <span className="api-node-error-msg">{data.error}</span>
        </div>
      )}
      <div className="api-node-row">
        <span className={`method-badge ${methodClass[data.method] ?? ''}`}>{data.method}</span>
        <span className="path">{data.path}</span>
        {badge && (
          <span
            className={`node-status-pill node-status-${data.status}`}
            role="status"
            aria-label={badge.label}
            title={badge.label}
          >
            <span aria-hidden="true">{badge.icon}</span>
            <span className="node-status-text">{badge.label}</span>
          </span>
        )}
        {(data.groupCount ?? 0) > 1 && (
          <span
            className="overlap-badge"
            title={`in ${data.groupCount} groups → ${data.cartesianIterations}× cartesian`}
          >
            ⚠
          </span>
        )}
        {data.hasBreakpoint && <span className="bp-dot" title="breakpoint" />}
      </div>
      <div className="api-node-row label">{data.label}</div>
      {canShowResponse && (
        <button
          type="button"
          className="response-toggle"
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
        >
          {open ? 'hide response' : 'response'}
        </button>
      )}
      {open && canShowResponse && (
        <div
          className={`response-balloon balloon-${data.balloonSide ?? 'right'}`}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Error chip already lives on the left edge; balloon focuses on body/status. */}
          <ResponseViewer
            compact
            response={{
              status: data.responseStatus,
              headers: data.responseHeaders,
              body: data.response,
            }}
          />
        </div>
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

export const ApiNodeView = memo(ApiNodeViewImpl);
