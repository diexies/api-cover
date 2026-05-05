/** Convert a #rrggbb string to rgba(...) with the given alpha. Falls back to the input
 * unchanged if the hex isn't 6 chars. Shared between GroupAreaNode (rectangle tint) and
 * ApiNodeView (case-anchor badge tint). */
export function hexToRgba(hex: string, alpha: number): string {
  const m = hex.replace('#', '');
  if (m.length !== 6) return hex;
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
