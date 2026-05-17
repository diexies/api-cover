import { useState } from 'react';
import { Modal } from './components/Modal';
import { JsonLogicHint } from './components/JsonLogicHint';
import type { ApiNode } from './api';

type Field = 'header' | 'queryParameter' | 'pathParameter';

interface Props {
  selectedIds: string[];
  apiNodes: ApiNode[];
  onApply: (patch: { nodeId: string; field: Field; key: string; value: unknown }[]) => void;
  onClose: () => void;
}

/**
 * Bulk-edit drawer for multi-selected api nodes. Lets the user push a single
 * header / query-param / path-param key=value into every selected node in one shot.
 * Value field accepts literals OR JSONLogic (`{"var":"…"}`) — the engine evaluates at
 * run time, same as inline node fields.
 */
export function BulkEditModal({ selectedIds, apiNodes, onApply, onClose }: Props) {
  const [field, setField] = useState<Field>('header');
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');

  const targetNodes = apiNodes.filter((n) => selectedIds.includes(n.id));

  function apply() {
    if (!key.trim()) return;
    // Try to parse value as JSON (number, bool, object, JSONLogic rule). Fall back to raw string.
    let parsed: unknown = value;
    try { parsed = value.trim().length > 0 ? JSON.parse(value) : ''; } catch { /* keep as string */ }
    const patches = selectedIds.map((nodeId) => ({ nodeId, field, key: key.trim(), value: parsed }));
    onApply(patches);
    onClose();
  }

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      size="md"
      labelledBy="bulk-edit-title"
    >
      <Modal.Header>
        <Modal.Title id="bulk-edit-title">Bulk edit — {selectedIds.length} nodes</Modal.Title>
        <Modal.Close />
      </Modal.Header>
      <Modal.Body>
        <p className="muted small">
          {`Set the same field on every selected node. Existing keys with the same name are overwritten; other fields stay untouched.`}
        </p>

        <label className="term-form-row">
          <span className="term-form-label">field type</span>
          <select
            className="form-input"
            value={field}
            onChange={(e) => setField(e.target.value as Field)}
          >
            <option value="header">Header</option>
            <option value="queryParameter">Query parameter</option>
            <option value="pathParameter">Path parameter</option>
          </select>
        </label>

        <label className="term-form-row">
          <span className="term-form-label">key</span>
          <input
            className="form-input"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={field === 'header' ? 'Authorization' : 'limit'}
            autoFocus
          />
        </label>

        <label className="term-form-row">
          <span className="term-form-label-row">
            <span className="term-form-label">value (literal or JSONLogic)</span>
            <JsonLogicHint ctx="default" triggerLabel="Value accepts literals or JSONLogic" />
          </span>
          <textarea
            className="body-editor"
            rows={3}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder='Bearer abc123 — or {"cat":["Bearer ",{"var":"nodes.login.response.body.token"}]}'
            spellCheck={false}
          />
        </label>

        <details className="bulk-edit-targets">
          <summary className="muted small">{`targets (${targetNodes.length})`}</summary>
          <ul className="bulk-edit-target-list">
            {targetNodes.map((n) => (
              <li key={n.id}><code>{n.method}</code> {n.path} <span className="muted small">({n.id})</span></li>
            ))}
          </ul>
        </details>
      </Modal.Body>
      <Modal.Footer>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button
          className="btn primary"
          onClick={apply}
          disabled={!key.trim()}
        >Apply to {selectedIds.length} nodes</button>
      </Modal.Footer>
    </Modal>
  );
}
