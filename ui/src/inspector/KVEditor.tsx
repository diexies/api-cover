export type KV = { key: string; value: string };

interface Props {
  rows: KV[];
  setRows: (rows: KV[]) => void;
  declared: string[];
  /** Optional kind label rendered as a left-edge pill (used by RequestTab to merge path/query). */
  kind?: 'path' | 'query' | 'header';
}

export function KVEditor({ rows, setRows, declared, kind }: Props) {
  function update(i: number, patch: Partial<KV>) {
    const next = rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
    setRows(next);
  }
  function remove(i: number) {
    setRows(rows.filter((_, idx) => idx !== i));
  }
  function add() {
    setRows([...rows, { key: '', value: '' }]);
  }

  return (
    <div className="kv-editor">
      {rows.length === 0 && <div className="muted small">no entries</div>}
      {rows.map((r, i) => (
        <div key={i} className="kv-row">
          {kind && <span className={`kv-kind kv-kind-${kind}`}>{kind}</span>}
          <input
            className={declared.includes(r.key) ? 'kv-key declared' : 'kv-key'}
            placeholder="name"
            value={r.key}
            onChange={(e) => update(i, { key: e.target.value })}
          />
          <input
            className="kv-val"
            placeholder='value or { "var": "..." }'
            value={r.value}
            onChange={(e) => update(i, { value: e.target.value })}
          />
          <button className="kv-del" onClick={() => remove(i)} title="Remove">×</button>
        </div>
      ))}
      <button className="kv-add" onClick={add}>+ add</button>
    </div>
  );
}

/**
 * Parse a value as JSON if it looks like JSON; otherwise treat as a literal string.
 */
export function parseMaybeJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const first = trimmed[0];
  if (first === '{' || first === '[' || first === '"' || trimmed === 'true' || trimmed === 'false' || trimmed === 'null'
    || /^-?\d/.test(trimmed)) {
    try { return JSON.parse(trimmed); } catch { /* fall through to literal */ }
  }
  return text;
}

export function stringifyValue(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}
