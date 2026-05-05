// Helper for staggered reveal animations. Apply to a parent that contains the children to be
// staggered; each child reads its index from `--i` and computes `animation-delay` via CSS.
//
// Usage:
//   <div className={staggerParent}>
//     {items.map((it, i) => <div key={i} style={staggerChild(i)}>...</div>)}
//   </div>

import type { CSSProperties } from 'react';

export const staggerParent = 'staggered-reveal';

export function staggerChild(index: number): CSSProperties {
  return { ['--i' as string]: index } as CSSProperties;
}
