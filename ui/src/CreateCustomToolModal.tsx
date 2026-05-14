import { useState } from 'react';
import { type CustomToolDefinition, createCustomTool } from './api';

type ParamRow = {
  name: string;
  type: 'string' | 'integer' | 'number' | 'boolean' | 'object';
  description: string;
  required: boolean;
};

type HeaderRow = { key: string; value: string };

/**
 * Form for defining a new HTTP-proxy custom tool. Validates client-side mirroring backend
 * rules (name regex, relative URL, method enum) so the user gets immediate feedback.
 * Builds the {properties,required} schema from row-based param input — easier than asking
 * users to hand-write JSON Schema.
 */
export function CreateCustomToolModal({
  onClose, onCreated,
}: {
  onClose: () => void;
  onCreated: (name: string) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [whenTriggered, setWhenTriggered] = useState('');
  const [method, setMethod] = useState<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'>('GET');
  const [urlTemplate, setUrlTemplate] = useState('/');
  const [headers, setHeaders] = useState<HeaderRow[]>([]);
  const [bodyTemplate, setBodyTemplate] = useState('');
  const [params, setParams] = useState<ParamRow[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  function addParam() {
    setParams((p) => [...p, { name: '', type: 'string', description: '', required: true }]);
  }
  function updateParam(idx: number, patch: Partial<ParamRow>) {
    setParams((p) => p.map((row, i) => (i === idx ? { ...row, ...patch } : row)));
  }
  function removeParam(idx: number) {
    setParams((p) => p.filter((_, i) => i !== idx));
  }

  function addHeader() {
    setHeaders((h) => [...h, { key: '', value: '' }]);
  }
  function updateHeader(idx: number, patch: Partial<HeaderRow>) {
    setHeaders((h) => h.map((row, i) => (i === idx ? { ...row, ...patch } : row)));
  }
  function removeHeader(idx: number) {
    setHeaders((h) => h.filter((_, i) => i !== idx));
  }

  function buildSchema(): unknown {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const p of params) {
      if (!p.name) continue;
      const node: Record<string, unknown> = { type: p.type };
      if (p.description) node.description = p.description;
      properties[p.name] = node;
      if (p.required) required.push(p.name);
    }
    const schema: Record<string, unknown> = { properties };
    if (required.length > 0) schema.required = required;
    return schema;
  }

  function validate(): string[] {
    const errs: string[] = [];
    if (!/^[a-z0-9._-]+$/.test(name)) errs.push('name must match ^[a-z0-9._-]+$');
    if (name.length < 3 || name.length > 64) errs.push('name must be 3..64 characters');
    if (!description.trim()) errs.push('description is required');
    if (!whenTriggered.trim()) errs.push('whenTriggered is required');
    if (!urlTemplate.startsWith('/')) errs.push('urlTemplate must start with /');
    if (urlTemplate.startsWith('//')) errs.push('urlTemplate must not start with //');
    if (urlTemplate.includes('..')) errs.push('urlTemplate must not contain ..');
    if (bodyTemplate.trim()) {
      try { JSON.parse(bodyTemplate.replace(/\{\{[a-zA-Z_][a-zA-Z0-9_]*\}\}/g, 'null')); }
      catch { errs.push('bodyTemplate is not valid JSON (after placeholder stripping)'); }
    }
    return errs;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const v = validate();
    if (v.length > 0) { setErrors(v); return; }
    setErrors([]);
    setSubmitting(true);
    const def: CustomToolDefinition = {
      name,
      description,
      whenTriggered,
      method,
      urlTemplate,
      headers: headers.filter((h) => h.key && h.value).reduce<Record<string, string>>((acc, h) => { acc[h.key] = h.value; return acc; }, {}),
      bodyTemplate: bodyTemplate.trim() || undefined,
      paramsSchema: buildSchema(),
    };
    if (def.headers && Object.keys(def.headers).length === 0) delete def.headers;
    try {
      const res = await createCustomTool(def);
      if (!res.ok) {
        setErrors(res.errors ?? ['Server rejected the tool definition.']);
      } else {
        onCreated(def.name);
      }
    } catch (e) {
      setErrors([`Submission failed: ${(e as Error).message}`]);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="agent-mcp-modal-backdrop" onClick={onClose}>
      <div className="agent-mcp-modal" onClick={(e) => e.stopPropagation()}>
        <header className="agent-mcp-modal-head">
          <button type="button" className="agent-memory-iconbtn" onClick={onClose} aria-label="close">✕</button>
          <h3>New custom tool</h3>
          <button
            type="button"
            className="agent-mcp-modal-save"
            disabled={submitting || validate().length > 0}
            onClick={(e) => handleSubmit(e as unknown as React.FormEvent)}
          >{submitting ? 'Saving…' : 'Save'}</button>
        </header>
        <form onSubmit={handleSubmit} className="agent-mcp-modal-body">
          {errors.length > 0 && (
            <div className="agent-mcp-modal-errors">
              {errors.map((e) => <div key={e}>· {e}</div>)}
            </div>
          )}

          <label className="agent-mcp-field">
            <span>name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="users.fetch"
              required
            />
          </label>

          <label className="agent-mcp-field">
            <span>description</span>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Fetch a user by id and return the full profile."
              required
            />
          </label>

          <label className="agent-mcp-field">
            <span>when triggered</span>
            <input
              value={whenTriggered}
              onChange={(e) => setWhenTriggered(e.target.value)}
              placeholder="user asks to look up a specific user."
              required
            />
          </label>

          <div className="agent-mcp-field-row">
            <label className="agent-mcp-field" style={{ flex: '0 0 6rem' }}>
              <span>method</span>
              <select value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
                <option>GET</option>
                <option>POST</option>
                <option>PUT</option>
                <option>PATCH</option>
                <option>DELETE</option>
              </select>
            </label>
            <label className="agent-mcp-field" style={{ flex: 1 }}>
              <span>url template (relative)</span>
              <input
                value={urlTemplate}
                onChange={(e) => setUrlTemplate(e.target.value)}
                placeholder="/api/users/{{id}}"
                required
              />
            </label>
          </div>

          <fieldset className="agent-mcp-rows">
            <legend>headers (optional)</legend>
            {headers.map((h, i) => (
              <div key={i} className="agent-mcp-row">
                <input
                  placeholder="X-Trace-Id"
                  value={h.key}
                  onChange={(e) => updateHeader(i, { key: e.target.value })}
                />
                <input
                  placeholder="value"
                  value={h.value}
                  onChange={(e) => updateHeader(i, { value: e.target.value })}
                />
                <button type="button" className="agent-memory-iconbtn" onClick={() => removeHeader(i)} aria-label="remove header">✕</button>
              </div>
            ))}
            <button type="button" className="agent-mcp-row-add" onClick={addHeader}>+ add header</button>
          </fieldset>

          <fieldset className="agent-mcp-rows">
            <legend>params</legend>
            {params.map((p, i) => (
              <div key={i} className="agent-mcp-row agent-mcp-row-param">
                <input
                  placeholder="name"
                  value={p.name}
                  onChange={(e) => updateParam(i, { name: e.target.value })}
                />
                <select value={p.type} onChange={(e) => updateParam(i, { type: e.target.value as ParamRow['type'] })}>
                  <option value="string">string</option>
                  <option value="integer">integer</option>
                  <option value="number">number</option>
                  <option value="boolean">boolean</option>
                  <option value="object">object</option>
                </select>
                <input
                  placeholder="description"
                  value={p.description}
                  onChange={(e) => updateParam(i, { description: e.target.value })}
                />
                <label className="agent-mcp-row-required">
                  <input type="checkbox" checked={p.required} onChange={(e) => updateParam(i, { required: e.target.checked })} />
                  required
                </label>
                <button type="button" className="agent-memory-iconbtn" onClick={() => removeParam(i)} aria-label="remove param">✕</button>
              </div>
            ))}
            <button type="button" className="agent-mcp-row-add" onClick={addParam}>+ add param</button>
          </fieldset>

          <label className="agent-mcp-field">
            <span>body template (JSON, optional — use {`{{name}}`} placeholders)</span>
            <textarea
              value={bodyTemplate}
              onChange={(e) => setBodyTemplate(e.target.value)}
              rows={4}
              placeholder='{"value": {{value}}}'
            />
          </label>

        </form>
      </div>
    </div>
  );
}
