// Read-only ASCII tree of a request body schema. Type/required/format chips beside each leaf.

interface SchemaNode {
  type?: string | string[];
  format?: string;
  enum?: unknown[];
  properties?: Record<string, SchemaNode>;
  required?: string[];
  items?: SchemaNode;
  $ref?: string;
  $defs?: Record<string, SchemaNode>;
  description?: string;
  anyOf?: SchemaNode[];
  oneOf?: SchemaNode[];
}

interface Props {
  schema: SchemaNode | undefined;
  rootLabel?: string;
}

export function RequestSchemaPreview({ schema, rootLabel = 'body' }: Props) {
  if (!schema) {
    return <div className="muted small">{`> no schema`}</div>;
  }
  const defs = schema.$defs ?? {};
  return (
    <pre className="schema-tree">
      {renderNode({ name: rootLabel, schema, defs, prefix: '', isLast: true, depth: 0, required: false })}
    </pre>
  );
}

interface RenderArgs {
  name: string;
  schema: SchemaNode;
  defs: Record<string, SchemaNode>;
  prefix: string;
  isLast: boolean;
  depth: number;
  required: boolean;
}

function renderNode(args: RenderArgs): React.ReactNode[] {
  const { name, schema, defs, prefix, isLast, depth, required } = args;
  if (depth > 8) return [<span key={`${prefix}${name}-cap`} className="schema-line"><span className="schema-dim">{prefix}{isLast ? '└─ ' : '├─ '}…</span>{'\n'}</span>];

  const resolved = resolveRef(schema, defs);
  const t = pickType(resolved.type);
  const isObj = (t === 'object' || resolved.properties) && resolved.properties;
  const isArr = t === 'array' && resolved.items;

  const branch = depth === 0 ? '' : (isLast ? '└─ ' : '├─ ');
  const out: React.ReactNode[] = [];

  out.push(
    <span key={`${prefix}${name}`} className="schema-line">
      <span className="schema-dim">{prefix}{branch}</span>
      <span className="schema-key">{name}</span>
      <span className="schema-meta">
        {' : '}
        <span className="schema-type">{describeType(resolved)}</span>
        {required && <span className="schema-required"> *</span>}
        {resolved.format && <span className="schema-format"> ({resolved.format})</span>}
      </span>
      {'\n'}
    </span>
  );

  const childPrefix = depth === 0 ? '' : prefix + (isLast ? '   ' : '│  ');

  if (isObj) {
    const props = resolved.properties ?? {};
    const keys = Object.keys(props);
    const requiredSet = new Set(resolved.required ?? []);
    keys.forEach((k, i) => {
      out.push(
        ...renderNode({
          name: k,
          schema: props[k],
          defs,
          prefix: childPrefix,
          isLast: i === keys.length - 1,
          depth: depth + 1,
          required: requiredSet.has(k),
        })
      );
    });
  } else if (isArr) {
    out.push(
      ...renderNode({
        name: '[0]',
        schema: resolved.items!,
        defs,
        prefix: childPrefix,
        isLast: true,
        depth: depth + 1,
        required: false,
      })
    );
  }

  return out;
}

function resolveRef(s: SchemaNode, defs: Record<string, SchemaNode>): SchemaNode {
  if (s.$ref && s.$ref.startsWith('#/$defs/')) {
    const key = s.$ref.substring('#/$defs/'.length);
    if (defs[key]) return defs[key];
  }
  if (s.anyOf || s.oneOf) {
    const opts = (s.anyOf ?? s.oneOf)!;
    return opts.find((o) => o.type !== 'null') ?? opts[0] ?? s;
  }
  return s;
}

function pickType(t: string | string[] | undefined): string | undefined {
  if (!t) return undefined;
  if (typeof t === 'string') return t;
  return t.find((x) => x !== 'null') ?? t[0];
}

function describeType(s: SchemaNode): string {
  const t = pickType(s.type);
  if (!t) return 'any';
  if (t === 'array') return 'array';
  if (t === 'object') return 'object';
  if (s.enum && s.enum.length > 0) {
    return `enum<${s.enum.slice(0, 3).map((v) => JSON.stringify(v)).join('|')}${s.enum.length > 3 ? '|…' : ''}>`;
  }
  return t;
}
