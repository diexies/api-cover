import type { CallerServiceEntryDto, CallNodeDto } from '../api';

/**
 * Canonical "Service.Method:Line" formatter. Mirrors the backend `CallSiteRef.Format`
 * so MCP tool output and UI rows share the same shape. Null fields degrade to `?`.
 */
export function formatRef(opts: { declaringType?: string | null; methodName?: string | null; line?: number | null }): string {
  const type = shortName(opts.declaringType);
  const method = opts.methodName ?? '?';
  const line = opts.line == null ? '?' : String(opts.line);
  return `${type}.${method}:${line}`;
}

export function formatCallerRef(c: CallerServiceEntryDto): string {
  return formatRef({ declaringType: c.id, methodName: c.methodName, line: c.lineNumber });
}

export function formatCallNodeRef(c: CallNodeDto): string {
  return formatRef({ declaringType: c.declaringType, methodName: c.methodName, line: c.lineNumber });
}

function shortName(fqtn?: string | null): string {
  if (!fqtn) return '?';
  const dot = fqtn.lastIndexOf('.');
  return dot >= 0 ? fqtn.slice(dot + 1) : fqtn;
}
