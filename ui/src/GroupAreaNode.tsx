import { NodeResizer, type NodeProps } from '@xyflow/react';
import { hexToRgba } from './colors';

export interface GroupAreaData extends Record<string, unknown> {
  label?: string;
  color?: string;
  count?: number;
  selected?: boolean;
  onOpenSettings?: () => void;
  /** Live iteration progress; only set during an active run. */
  runningIter?: number;
  /** Total iterations for the in-flight run (= repeat.count once a run is wired up). */
  totalIter?: number;
  /** Final pass count after a run completes. */
  iterPassed?: number;
  /** Final fail count after a run completes. */
  iterFailed?: number;
  /** True between BranchSpawned of the first iter and finalisation of the last. */
  isRunning?: boolean;
}

/**
 * Visual rectangle on the canvas representing an ExecutionGroup. Pure geometry — engine
 * membership is resolved at save time by intersecting node positions with the group bounds.
 * Renders behind ApiNodes via a low z-index and a translucent tint. While a run fans the group
 * out across N iterations, the label surfaces a live progress counter and pulses; after the
 * run completes the counter switches to a pass/fail tally.
 */
export function GroupAreaNode({ data, selected }: NodeProps & { data: GroupAreaData }) {
  const tint = data.color ?? '#a855f7';
  const bg = hexToRgba(tint, 0.08);
  const total = data.totalIter ?? data.count ?? 1;
  const cls = ['group-area'];
  if (selected) cls.push('selected');
  if (data.isRunning) cls.push('is-running');
  return (
    <div
      className={cls.join(' ')}
      style={{
        background: bg,
        borderColor: tint,
        boxShadow: selected ? `0 0 0 2px ${tint}` : undefined,
        ['--group-tint' as string]: tint,
      }}
      onDoubleClick={(e) => { e.stopPropagation(); data.onOpenSettings?.(); }}
    >
      <NodeResizer
        color={tint}
        isVisible={!!selected}
        minWidth={120}
        minHeight={80}
      />
      <div className="group-area-label" style={{ background: tint }}>
        {data.label ?? 'group'}
        {total > 1 ? ` ×${total}` : ''}
        {data.isRunning && data.runningIter !== undefined && total > 1 && (
          <span className="group-area-progress"> · running {data.runningIter}/{total}</span>
        )}
        {!data.isRunning && (data.iterPassed !== undefined || data.iterFailed !== undefined) && (data.iterPassed! + data.iterFailed! > 0) && (
          <span className="group-area-progress">
            {' · '}
            {data.iterPassed ? `${data.iterPassed} ✓` : ''}
            {data.iterPassed && data.iterFailed ? ' / ' : ''}
            {data.iterFailed ? `${data.iterFailed} ✗` : ''}
          </span>
        )}
      </div>
    </div>
  );
}

