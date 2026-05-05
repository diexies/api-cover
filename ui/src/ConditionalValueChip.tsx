import { useState, type ReactNode } from 'react';

/**
 * Wraps a single leaf input with a conditional-value toggle. When active, the user edits a
 * list of (when, then) pairs plus a default. The condition reuses the LHS variable path and
 * value type that the caller already knows from schema (e.g. body field <c>name</c> →
 * <c>input.name</c> typed as string), so only the operator, comparison value, and replacement
 * are exposed to the user. The result serialises as a JSONLogic
 * <c>{ "if": [w1, t1, w2, t2, …, default] }</c> chain.
 *
 * Operators are typed: numeric values expose math comparisons; strings expose equality plus
 * <c>contains</c>/<c>starts with</c>/<c>ends with</c> implemented through the
 * <c>regex_match</c> custom operator (with regex metacharacters escaped). A per-row "raw"
 * escape hatch keeps power-user JSONLogic editing available.
 */

type CondType = 'number' | 'string' | 'boolean';
type CondOp = '==' | '!=' | '>' | '>=' | '<' | '<=' | 'contains' | 'startsWith' | 'endsWith';

const OPS_BY_TYPE: Record<CondType, CondOp[]> = {
  number: ['==', '!=', '>', '>=', '<', '<='],
  string: ['==', '!=', 'contains', 'startsWith', 'endsWith'],
  boolean: ['==', '!='],
};

const OP_LABELS: Record<CondOp, string> = {
  '==': 'equals',
  '!=': 'not equals',
  '>': 'greater than',
  '>=': 'greater or equal',
  '<': 'less than',
  '<=': 'less or equal',
  'contains': 'contains',
  'startsWith': 'starts with',
  'endsWith': 'ends with',
};

interface CondRow {
  op: CondOp;
  rhs: string;
  raw: boolean;
  rawWhen: string;
  then: string;
}

interface Props {
  value: unknown;
  onChange: (v: unknown) => void;
  /**
   * The JSONLogic var path used as the predicate's left-hand side. Caller derives this from
   * the schema location of the leaf being edited (e.g. body field <c>name</c> →
   * <c>input.name</c>). Hidden from the user.
   */
  varPath: string;
  /**
   * The JSON-schema-derived type of the field. Drives which operators appear in the dropdown
   * and how the right-hand side input is coerced. Hidden from the user.
   */
  valueType: CondType;
  /** Plain-mode renderer; called when conditional toggle is off. */
  renderPlain: (value: unknown, onChange: (v: unknown) => void) => ReactNode;
}

export function ConditionalValueChip({ value, onChange, varPath, valueType, renderPlain }: Props) {
  const initial = parseConditional(value);
  const [active, setActive] = useState<boolean>(initial !== null);
  const [rows, setRows] = useState<CondRow[]>(initial?.rows ?? [emptyRow(valueType)]);
  const [fallback, setFallback] = useState<string>(initial?.fallback ?? '');

  function commit(nextRows: CondRow[], nextFallback: string) {
    setRows(nextRows);
    setFallback(nextFallback);
    onChange(buildConditional(nextRows, nextFallback, varPath, valueType));
  }

  function enableConditional() {
    setActive(true);
    const seed: CondRow[] = [{ ...emptyRow(valueType), then: jsonifyForInput(value) }];
    setRows(seed);
    setFallback('');
    onChange(buildConditional(seed, '', varPath, valueType));
  }

  function disableConditional() {
    setActive(false);
    const first = rows[0]?.then ?? '';
    onChange(parseMaybeJson(first));
  }

  if (!active) {
    return (
      <div className="cond-shell">
        <button
          type="button"
          className="cond-spike"
          onClick={enableConditional}
          aria-label="Switch to conditional value"
          title="Switch to conditional value (if/else)"
        >
          <span className="cond-spike-label">conditional</span>
        </button>
        <div className="cond-plain">{renderPlain(value, onChange)}</div>
      </div>
    );
  }

  return (
    <div className="cond-shell active">
      <button
        type="button"
        className="cond-spike active"
        onClick={disableConditional}
        aria-label="Drop conditional, use plain value"
        title="Drop conditional, use plain value"
      >
        <span className="cond-spike-label">plain</span>
      </button>
      <div className="cond-list">
        {rows.map((r, i) => (
          <div key={i} className={`cond-row-block ${r.raw ? 'raw' : ''}`}>
            <span className="cond-label">when</span>
            {r.raw ? (
              <input
                className="form-input cond-raw"
                placeholder='{ "==": [ { "var": "input.x" }, 10 ] }'
                value={r.rawWhen}
                onChange={(e) => commit(rows.map((x, idx) => (idx === i ? { ...x, rawWhen: e.target.value } : x)), fallback)}
              />
            ) : (
              <>
                <select
                  className="form-input cond-op"
                  value={r.op}
                  onChange={(e) => commit(rows.map((x, idx) => (idx === i ? { ...x, op: e.target.value as CondOp } : x)), fallback)}
                >
                  {OPS_BY_TYPE[valueType].map((op) => (
                    <option key={op} value={op}>{OP_LABELS[op]}</option>
                  ))}
                </select>
                <input
                  className="form-input cond-rhs"
                  type={valueType === 'number' ? 'number' : 'text'}
                  placeholder={valueType === 'boolean' ? 'true / false' : 'compare value'}
                  value={r.rhs}
                  onChange={(e) => commit(rows.map((x, idx) => (idx === i ? { ...x, rhs: e.target.value } : x)), fallback)}
                />
              </>
            )}
            <span className="cond-replace-label">replace →</span>
            <input
              className="form-input cond-then"
              type={valueType === 'number' ? 'number' : 'text'}
              placeholder="value to inject"
              value={r.then}
              onChange={(e) => commit(rows.map((x, idx) => (idx === i ? { ...x, then: e.target.value } : x)), fallback)}
            />
            <button
              className="cond-mode-toggle"
              title={r.raw ? 'switch to structured editor' : 'switch to raw JSONLogic'}
              onClick={() => commit(
                rows.map((x, idx) => (idx === i
                  ? { ...x, raw: !x.raw, rawWhen: x.raw ? x.rawWhen : jsonifyForInput(buildWhen(x, varPath, valueType)) }
                  : x)),
                fallback
              )}
            >
              {r.raw ? 'form' : 'raw'}
            </button>
            <button
              className="kv-del"
              onClick={() => commit(rows.filter((_, idx) => idx !== i), fallback)}
              title="Remove condition"
            >
              ×
            </button>
          </div>
        ))}
        <button
          className="kv-add"
          onClick={() => commit([...rows, emptyRow(valueType)], fallback)}
        >
          + add condition
        </button>
        <div className="cond-row default-row">
          <span className="cond-label default">default</span>
          <input
            className="form-input cond-then"
            type={valueType === 'number' ? 'number' : 'text'}
            placeholder='value when no condition matches'
            value={fallback}
            onChange={(e) => commit(rows, e.target.value)}
          />
        </div>
      </div>
    </div>
  );
}

function emptyRow(type: CondType): CondRow {
  return { op: OPS_BY_TYPE[type][0], rhs: '', raw: false, rawWhen: '', then: '' };
}

function buildWhen(r: CondRow, varPath: string, type: CondType): unknown {
  if (r.raw) {
    try { return JSON.parse(r.rawWhen); } catch { return r.rawWhen; }
  }
  const lhs = { var: varPath };
  const rhsLit = coerceRhs(r.rhs, type);
  switch (r.op) {
    case '==': case '!=': case '>': case '>=': case '<': case '<=':
      return { [r.op]: [lhs, rhsLit] };
    case 'contains':
      return { regex_match: [escapeRegex(String(rhsLit)), lhs] };
    case 'startsWith':
      return { regex_match: [`^${escapeRegex(String(rhsLit))}`, lhs] };
    case 'endsWith':
      return { regex_match: [`${escapeRegex(String(rhsLit))}$`, lhs] };
  }
}

function coerceRhs(text: string, type: CondType): unknown {
  if (type === 'number') {
    const n = Number(text);
    return Number.isFinite(n) ? n : 0;
  }
  if (type === 'boolean') {
    return text.trim().toLowerCase() === 'true';
  }
  return text;
}

function coerceThen(text: string, type: CondType): unknown {
  const trimmed = text.trim();
  if (!trimmed) return '';
  // Allow JSONLogic / object / array literals through unchanged (advanced users).
  const first = trimmed[0];
  if (first === '{' || first === '[') {
    try { return JSON.parse(trimmed); } catch { /* fall through */ }
  }
  return coerceRhs(text, type);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseConditional(v: unknown): { rows: CondRow[]; fallback: string } | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 1 || keys[0] !== 'if') return null;
  const arr = obj.if;
  if (!Array.isArray(arr) || arr.length < 2) return null;
  const rows: CondRow[] = [];
  let i = 0;
  while (i + 1 < arr.length) {
    rows.push(decodeWhen(arr[i], jsonifyForInput(arr[i + 1])));
    i += 2;
  }
  const fallback = i < arr.length ? jsonifyForInput(arr[i]) : '';
  return { rows, fallback };
}

function decodeWhen(when: unknown, then: string): CondRow {
  const fallback = (): CondRow => ({
    op: '==', rhs: '', raw: true, rawWhen: jsonifyForInput(when), then,
  });
  if (!when || typeof when !== 'object' || Array.isArray(when)) return fallback();
  const obj = when as Record<string, unknown>;
  const k = Object.keys(obj);
  if (k.length !== 1) return fallback();
  const op = k[0];
  const args = obj[op];
  if (!Array.isArray(args) || args.length !== 2) return fallback();

  if (['==', '!=', '>', '>=', '<', '<='].includes(op)) {
    const lhs = args[0] as Record<string, unknown> | undefined;
    if (lhs && typeof lhs === 'object' && 'var' in lhs && typeof lhs.var === 'string') {
      const rhs = args[1];
      return { op: op as CondOp, rhs: String(rhs ?? ''), raw: false, rawWhen: '', then };
    }
  }

  if (op === 'regex_match') {
    const pattern = args[0];
    const lhs = args[1] as Record<string, unknown> | undefined;
    if (typeof pattern === 'string' && lhs && typeof lhs === 'object' && 'var' in lhs) {
      let condOp: CondOp = 'contains';
      let raw = pattern;
      if (pattern.startsWith('^')) { condOp = 'startsWith'; raw = pattern.slice(1); }
      else if (pattern.endsWith('$')) { condOp = 'endsWith'; raw = pattern.slice(0, -1); }
      raw = raw.replace(/\\([.*+?^${}()|[\]\\])/g, '$1');
      return { op: condOp, rhs: raw, raw: false, rawWhen: '', then };
    }
  }

  return fallback();
}

function buildConditional(rows: CondRow[], fallback: string, varPath: string, type: CondType): unknown {
  const live = rows.filter((r) => isRowFilled(r));
  if (live.length === 0) {
    if (fallback.trim().length > 0) return coerceThen(fallback, type);
    if (rows[0] && rows[0].then.trim().length > 0) return coerceThen(rows[0].then, type);
    return undefined;
  }
  const flat: unknown[] = [];
  for (const r of live) {
    flat.push(buildWhen(r, varPath, type));
    flat.push(coerceThen(r.then, type));
  }
  flat.push(fallback.trim().length > 0 ? coerceThen(fallback, type) : null);
  return { if: flat };
}

function isRowFilled(r: CondRow): boolean {
  if (r.raw) return r.rawWhen.trim().length > 0;
  return r.rhs.trim().length > 0;
}

function parseMaybeJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const first = trimmed[0];
  if (
    first === '{' || first === '[' || first === '"' ||
    trimmed === 'true' || trimmed === 'false' || trimmed === 'null' ||
    /^-?\d/.test(trimmed)
  ) {
    try { return JSON.parse(trimmed); } catch { /* fall through */ }
  }
  return text;
}

function jsonifyForInput(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}
