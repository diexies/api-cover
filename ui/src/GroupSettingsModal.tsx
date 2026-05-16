import { useState } from 'react';
import type { ExecutionGroup, NodeMutation } from './api';
import { Modal } from './components/Modal';
import { JsonLogicHint } from './components/JsonLogicHint';

// Preset rules surfaced as chips beneath each mutation editor. These cover the common
// "replace by index", "1-based step", "string suffix per iteration", and "increment a
// previous value" patterns; users can still type any JSONLogic by hand for everything else.
const ITERATION_PRESETS: { label: string; title: string; rule: unknown }[] = [
  { label: 'iteration',  title: 'current 0-based step index',                   rule: { var: 'iteration' } },
  { label: 'step+1',     title: '1-based step number',                          rule: { '+': [{ var: 'iteration' }, 1] } },
  { label: 'total',      title: 'total iterations in this group',               rule: { var: 'total' } },
  { label: 'random',     title: 'fresh random number per iteration (0..1)',     rule: { var: 'random' } },
  { label: 'cat-suffix', title: 'concatenate "user-" + step index',             rule: { cat: ['user-', { var: 'iteration' }] } },
  { label: 'prev+1',     title: 'previous response field + 1',                  rule: { '+': [{ var: 'previous.body.id' }, 1] } },
];

interface Props {
  initial: ExecutionGroup;
  /** Node ids belonging to this group; mutation editor offers them as targets. */
  groupNodeIds: string[];
  onSave: (next: ExecutionGroup) => void;
  onDelete: () => void;
  onClose: () => void;
}

/**
 * Slide-in modal that edits one execution group: label, repeat count + delay, and the
 * per-iteration mutation list. Mutations target a specific node within the group's nodeIds
 * via a dropdown so the user doesn't have to type the id by hand.
 */
export function GroupSettingsModal({ initial, groupNodeIds, onSave, onDelete, onClose }: Props) {
  const [label, setLabel] = useState(initial.label ?? '');
  const [color, setColor] = useState(initial.backgroundColor ?? '#a855f7');
  const [count, setCount] = useState(initial.repeat?.count ?? 1);
  const [delay, setDelay] = useState(initial.repeat?.delay ?? '');
  const [mutations, setMutations] = useState<NodeMutation[]>(initial.mutations ?? []);

  function addMutation() {
    setMutations([
      ...mutations,
      { nodeId: groupNodeIds[0] ?? '', field: 'body.', rule: { var: 'iteration' } },
    ]);
  }
  function updateMutation(i: number, patch: Partial<NodeMutation>) {
    setMutations(mutations.map((m, idx) => (idx === i ? { ...m, ...patch } : m)));
  }
  function removeMutation(i: number) {
    setMutations(mutations.filter((_, idx) => idx !== i));
  }

  function commit() {
    onSave({
      ...initial,
      label: label || undefined,
      backgroundColor: color,
      repeat: { count, delay: delay || undefined },
      mutations,
    });
    onClose();
  }

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      size="md"
      labelledBy="group-settings-title"
    >
      <Modal.Header>
        <Modal.Title id="group-settings-title">Group settings</Modal.Title>
        <Modal.Close />
      </Modal.Header>
      <Modal.Body>
        <div className="muted small">
          {groupNodeIds.length} node{groupNodeIds.length === 1 ? '' : 's'} in this group: {groupNodeIds.join(', ')}
        </div>

        <label className="form-row stacked">
          <span className="form-label">label</span>
          <input
            className="form-input"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="optional"
          />
        </label>
        <label className="form-row">
          <span className="form-label">color</span>
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            style={{ width: 50, height: 32, border: 'none', background: 'transparent', cursor: 'pointer' }}
          />
          <code style={{ marginLeft: '0.5rem' }}>{color}</code>
        </label>
        <div className="repeat-row">
          <label className="form-row stacked" style={{ flex: 1 }}>
            <span className="form-label">repeat count</span>
            <input
              type="number" min={1} className="form-input"
              value={count}
              onChange={(e) => setCount(Math.max(1, parseInt(e.target.value, 10) || 1))}
            />
          </label>
          <label className="form-row stacked" style={{ flex: 1 }}>
            <span className="form-label">delay</span>
            <input
              type="text" className="form-input"
              value={delay}
              onChange={(e) => setDelay(e.target.value)}
              placeholder="00:00:01"
            />
          </label>
        </div>

        <div className="mutations">
          <div className="mutations-head">
            <span className="muted small">mutations (per-iteration field overrides)</span>
            <JsonLogicHint ctx="group" triggerLabel="Group mutation rules accept iteration / total / previous" />
            <button className="kv-add" onClick={addMutation}>+ add</button>
          </div>
          {mutations.length === 0 && <div className="muted small">no mutations</div>}
          {mutations.map((m, i) => (
            <div key={i} className="mutation-block">
              <div className="mutation-grid">
                <select
                  className="form-input"
                  value={m.nodeId}
                  onChange={(e) => updateMutation(i, { nodeId: e.target.value })}
                >
                  {groupNodeIds.map((nid) => <option key={nid} value={nid}>{nid}</option>)}
                </select>
                <input
                  className="form-input"
                  placeholder="body.field"
                  value={m.field}
                  onChange={(e) => updateMutation(i, { field: e.target.value })}
                />
                <textarea
                  className="form-input mutation-rule"
                  rows={2}
                  placeholder='{"var":"iteration"}'
                  value={typeof m.rule === 'object' ? JSON.stringify(m.rule) : (m.rule as string ?? '')}
                  onChange={(e) => {
                    try { updateMutation(i, { rule: JSON.parse(e.target.value) }); }
                    catch { /* ignore until valid */ }
                  }}
                />
                <button className="kv-del" onClick={() => removeMutation(i)}>×</button>
              </div>
              <div className="mutation-chips">
                <span className="muted small">presets:</span>
                {ITERATION_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    className="chip"
                    onClick={() => updateMutation(i, { rule: p.rule })}
                    title={p.title}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <div className="muted small">
            context: <code>{'{ iteration, total, random, previous }'}</code>
          </div>
        </div>

      </Modal.Body>
      <Modal.Footer>
        <button className="btn danger-btn" onClick={() => { onDelete(); onClose(); }}>🗑 Delete group</button>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={commit}>Save</button>
      </Modal.Footer>
    </Modal>
  );
}
