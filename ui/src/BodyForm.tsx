import { useMemo } from 'react';
import { ConditionalValueChip } from './ConditionalValueChip';

/**
 * Schema-driven body editor. Renders an arbitrary value alongside its JSON Schema, surfacing
 * one input per field with type-aware UI (text/number/checkbox/enum select/array). Null-safe
 * — schema may be missing or partial; fall back to a generic "any" input. Pure controlled
 * component: parent owns the value, this only emits onChange.
 *
 * Recursion guard via $defs lookup; depth-capped to avoid runaway recursive types.
 */
type AnyJson = unknown;

interface SchemaNode {
  type?: string | string[];
  format?: string;
  enum?: AnyJson[];
  properties?: Record<string, SchemaNode>;
  required?: string[];
  items?: SchemaNode;
  additionalProperties?: SchemaNode | boolean;
  $ref?: string;
  $defs?: Record<string, SchemaNode>;
  description?: string;
  anyOf?: SchemaNode[];
  oneOf?: SchemaNode[];
}

interface Props {
  schema: SchemaNode | undefined;
  value: AnyJson;
  onChange: (value: AnyJson) => void;
}

export function BodyForm({ schema, value, onChange }: Props) {
  const defs = useMemo(() => schema?.$defs ?? {}, [schema]);
  if (!schema) {
    return <div className="muted small">no schema available — use raw JSON</div>;
  }
  return (
    <div className="body-form">
      <FieldRenderer
        schema={schema}
        value={value}
        onChange={onChange}
        defs={defs}
        path=""
        depth={0}
        required
      />
    </div>
  );
}

interface FieldProps {
  schema: SchemaNode;
  value: AnyJson;
  onChange: (value: AnyJson) => void;
  defs: Record<string, SchemaNode>;
  path: string;
  depth: number;
  required?: boolean;
  label?: string;
}

const MAX_DEPTH = 10;

function FieldRenderer({ schema, value, onChange, defs, path, depth, required, label }: FieldProps) {
  if (depth > MAX_DEPTH) {
    return <div className="muted small">… (depth limit)</div>;
  }

  // $ref → resolve from $defs.
  if (schema.$ref) {
    const key = schema.$ref.startsWith('#/$defs/') ? schema.$ref.substring('#/$defs/'.length) : null;
    const target = key ? defs[key] : undefined;
    if (target) {
      return (
        <FieldRenderer
          schema={target}
          value={value}
          onChange={onChange}
          defs={defs}
          path={path}
          depth={depth + 1}
          required={required}
          label={label}
        />
      );
    }
    return <div className="muted small">unresolved $ref: {schema.$ref}</div>;
  }

  // anyOf/oneOf → take first non-null option (best-effort; full polymorphism UX is v2).
  if (schema.anyOf || schema.oneOf) {
    const options = (schema.anyOf ?? schema.oneOf)!;
    const nonNull = options.find((o) => o.type !== 'null') ?? options[0];
    return (
      <FieldRenderer
        schema={nonNull}
        value={value}
        onChange={onChange}
        defs={defs}
        path={path}
        depth={depth + 1}
        required={required}
        label={label}
      />
    );
  }

  const primary = pickPrimaryType(schema.type);

  // Enum (any underlying type) → select.
  if (schema.enum && schema.enum.length > 0) {
    return (
      <Row label={label} required={required} description={schema.description}>
        <ConditionalValueChip
          value={value}
          onChange={onChange}
          varPath={varPathForLeaf(path)}
          valueType={condTypeForSchema(schema)}
          renderPlain={(v, oc) => (
            <select
              className="form-input"
              value={v === undefined || v === null ? '' : String(v)}
              onChange={(e) => oc(coerceEnumValue(e.target.value, schema.enum!))}
            >
              <option value="">— select —</option>
              {schema.enum!.map((opt, i) => (
                <option key={i} value={String(opt)}>{String(opt)}</option>
              ))}
            </select>
          )}
        />
      </Row>
    );
  }

  switch (primary) {
    case 'object':
      return (
        <ObjectField
          schema={schema}
          value={(value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, AnyJson>}
          onChange={onChange}
          defs={defs}
          path={path}
          depth={depth}
          label={label}
          required={required}
        />
      );
    case 'array':
      return (
        <ArrayField
          schema={schema}
          value={Array.isArray(value) ? value : []}
          onChange={onChange}
          defs={defs}
          path={path}
          depth={depth}
          label={label}
          required={required}
        />
      );
    case 'boolean':
      return (
        <Row label={label} required={required} description={schema.description}>
          <ConditionalValueChip
            value={value}
            onChange={onChange}
            varPath={varPathForLeaf(path)}
            valueType={condTypeForSchema(schema)}
            renderPlain={(v, oc) => (
              <input
                type="checkbox"
                checked={v === true}
                onChange={(e) => oc(e.target.checked)}
              />
            )}
          />
        </Row>
      );
    case 'integer':
    case 'number':
      return (
        <Row label={label} required={required} description={schema.description}>
          <ConditionalValueChip
            value={value}
            onChange={onChange}
            varPath={varPathForLeaf(path)}
            valueType={condTypeForSchema(schema)}
            renderPlain={(v, oc) => (
              <input
                type="number"
                className="form-input"
                value={v === undefined || v === null ? '' : Number(v)}
                step={primary === 'integer' ? 1 : 'any'}
                onChange={(e) => {
                  const txt = e.target.value;
                  if (txt === '') oc(undefined);
                  else oc(primary === 'integer' ? parseInt(txt, 10) : parseFloat(txt));
                }}
              />
            )}
          />
        </Row>
      );
    case 'string':
      return (
        <Row label={label} required={required} description={schema.description}>
          <ConditionalValueChip
            value={value}
            onChange={onChange}
            varPath={varPathForLeaf(path)}
            valueType={condTypeForSchema(schema)}
            renderPlain={(v, oc) => (
              <input
                type={inputTypeForStringFormat(schema.format)}
                className="form-input"
                value={v === undefined || v === null ? '' : String(v)}
                onChange={(e) => oc(e.target.value)}
                placeholder={schema.format ?? ''}
              />
            )}
          />
        </Row>
      );
    case 'null':
      return <Row label={label} required={required} description={schema.description}><span className="muted small">null</span></Row>;
    default:
      // Unknown / "any" — fall back to raw JSON one-liner.
      return (
        <Row label={label} required={required} description={schema.description}>
          <ConditionalValueChip
            value={value}
            onChange={onChange}
            varPath={varPathForLeaf(path)}
            valueType={condTypeForSchema(schema)}
            renderPlain={(v, oc) => (
              <input
                className="form-input"
                value={v === undefined ? '' : JSON.stringify(v)}
                onChange={(e) => {
                  try { oc(JSON.parse(e.target.value)); }
                  catch { oc(e.target.value); }
                }}
              />
            )}
          />
        </Row>
      );
  }
}

function ObjectField({ schema, value, onChange, defs, path, depth, label, required }: FieldProps & { value: Record<string, AnyJson> }) {
  const requiredFields = new Set(schema.required ?? []);
  const props = schema.properties ?? {};
  const keys = Object.keys(props);

  function update(key: string, v: AnyJson) {
    const next = { ...value };
    if (v === undefined) delete next[key];
    else next[key] = v;
    onChange(next);
  }

  const isRoot = depth === 0;
  const inner = (
    <div className={isRoot ? 'form-object-root' : 'form-object'}>
      {keys.length === 0 && <div className="muted small">no declared properties</div>}
      {keys.map((k) => (
        <FieldRenderer
          key={k}
          label={k}
          required={requiredFields.has(k)}
          schema={props[k]}
          value={value[k]}
          onChange={(v) => update(k, v)}
          defs={defs}
          path={`${path}.${k}`}
          depth={depth + 1}
        />
      ))}
    </div>
  );

  if (isRoot) return inner;
  return (
    <Row label={label} required={required} description={schema.description} stacked>
      {inner}
    </Row>
  );
}

function ArrayField({ schema, value, onChange, defs, path, depth, label, required }: FieldProps & { value: AnyJson[] }) {
  const itemSchema = schema.items ?? {};
  function update(i: number, v: AnyJson) {
    const next = value.slice();
    next[i] = v;
    onChange(next);
  }
  function remove(i: number) { onChange(value.filter((_, idx) => idx !== i)); }
  function add() { onChange([...value, defaultForSchema(itemSchema, defs)]); }

  return (
    <Row label={label} required={required} description={schema.description} stacked>
      <div className="form-array">
        {value.length === 0 && <div className="muted small">empty</div>}
        {value.map((item, i) => (
          <div key={i} className="form-array-row">
            <div className="form-array-body">
              <FieldRenderer
                schema={itemSchema}
                value={item}
                onChange={(v) => update(i, v)}
                defs={defs}
                path={`${path}[${i}]`}
                depth={depth + 1}
              />
            </div>
            <button className="kv-del" onClick={() => remove(i)} title="Remove item">×</button>
          </div>
        ))}
        <button className="kv-add" onClick={add}>+ add item</button>
      </div>
    </Row>
  );
}

function Row({
  label, required, description, stacked, children,
}: {
  label?: string; required?: boolean; description?: string; stacked?: boolean;
  children: React.ReactNode;
}) {
  if (!label) return <>{children}</>;
  return (
    <div className={`form-row${stacked ? ' stacked' : ''}`}>
      <label className="form-label" title={description}>
        {label}
        {required && <span className="form-required" title="required">*</span>}
      </label>
      <div className="form-control">{children}</div>
    </div>
  );
}

function varPathForLeaf(path: string): string {
  // BodyForm tracks an internal dot-path like ".name" or ".user.email" for each leaf.
  // For conditional inputs the LHS variable is the same field on the run input DTO.
  const stripped = path.replace(/^\.+/, '');
  return stripped ? `input.${stripped}` : 'input';
}

function condTypeForSchema(schema: SchemaNode): 'number' | 'string' | 'boolean' {
  const t = pickPrimaryType(schema.type);
  if (t === 'integer' || t === 'number') return 'number';
  if (t === 'boolean') return 'boolean';
  return 'string';
}

function pickPrimaryType(t: string | string[] | undefined): string | undefined {
  if (!t) return undefined;
  if (typeof t === 'string') return t;
  return t.find((x) => x !== 'null') ?? t[0];
}

function inputTypeForStringFormat(format?: string): string {
  if (format === 'date-time') return 'datetime-local';
  if (format === 'date') return 'date';
  if (format === 'time') return 'time';
  if (format === 'email') return 'email';
  if (format === 'uri' || format === 'url') return 'url';
  return 'text';
}

function coerceEnumValue(text: string, options: AnyJson[]): AnyJson {
  if (text === '') return undefined;
  // Try to round-trip via the matching original value (preserves number/bool typing).
  const exact = options.find((o) => String(o) === text);
  return exact !== undefined ? exact : text;
}

function defaultForSchema(schema: SchemaNode, defs: Record<string, SchemaNode>): AnyJson {
  if (schema.$ref) {
    const key = schema.$ref.startsWith('#/$defs/') ? schema.$ref.substring('#/$defs/'.length) : null;
    if (key && defs[key]) return defaultForSchema(defs[key], defs);
  }
  const t = pickPrimaryType(schema.type);
  switch (t) {
    case 'object': {
      const obj: Record<string, AnyJson> = {};
      for (const [k, v] of Object.entries(schema.properties ?? {})) {
        obj[k] = defaultForSchema(v, defs);
      }
      return obj;
    }
    case 'array': return [];
    case 'integer':
    case 'number': return 0;
    case 'boolean': return false;
    case 'string': return '';
    default: return null;
  }
}
