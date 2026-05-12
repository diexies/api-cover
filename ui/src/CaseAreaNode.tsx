import { type NodeProps } from '@xyflow/react';
import { memo } from 'react';
import { hexToRgba } from './colors';

export interface CaseAreaData extends Record<string, unknown> {
  label?: string;
  color?: string;
  variantCount?: number;
}

function CaseAreaNodeImpl({ data }: NodeProps & { data: CaseAreaData }) {
  const tint = data.color ?? '#a855f7';
  const bg = hexToRgba(tint, 0.06);
  return (
    <div
      className="case-area"
      style={{ background: bg, borderColor: tint }}
    >
      <div className="case-area-label" style={{ background: tint }}>
        ⑂ {data.label ?? 'cases'}
        {data.variantCount && data.variantCount > 0 ? ` ×${data.variantCount}` : ''}
      </div>
    </div>
  );
}

export const CaseAreaNode = memo(CaseAreaNodeImpl);
