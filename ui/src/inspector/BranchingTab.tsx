import type { ApiNode, CaseSet, CaseVariant, ExecutionGroup, NodeFieldOverride } from '../api';
import { BranchSimulator } from './BranchSimulator';
import { JsonLogicHint } from '../components/JsonLogicHint';

interface Props {
  node: ApiNode;
  groupsForNode: ExecutionGroup[];
  onEditGroup: (groupId: string) => void;
  caseSet?: CaseSet;
  onCaseSetChange?: (next: CaseSet | null) => void;
}

export function BranchingTab({ node, groupsForNode, onEditGroup, caseSet, onCaseSetChange }: Props) {
  const inAnyGroup = groupsForNode.length > 0;
  const hasCases = !!caseSet && caseSet.variants.length > 0;
  const cartesian = groupsForNode.reduce((a, g) => a * Math.max(1, g.repeat?.count ?? 1), 1);

  function addCaseSet() {
    if (!onCaseSetChange) return;
    onCaseSetChange({
      id: `cs-${node.id}-${Date.now().toString(36)}`,
      anchorNodeId: node.id,
      label: undefined,
      variants: [
        { id: 'v1', label: 'variant 1', overrides: [] },
        { id: 'v2', label: 'variant 2', overrides: [] },
      ],
    });
  }

  function removeCaseSet() {
    if (!onCaseSetChange) return;
    onCaseSetChange(null);
  }

  function patchCaseSet(patch: Partial<CaseSet>) {
    if (!caseSet || !onCaseSetChange) return;
    onCaseSetChange({ ...caseSet, ...patch });
  }

  function patchVariant(idx: number, patch: Partial<CaseVariant>) {
    if (!caseSet || !onCaseSetChange) return;
    const next = caseSet.variants.map((v, i) => (i === idx ? { ...v, ...patch } : v));
    patchCaseSet({ variants: next });
  }

  function addVariant() {
    if (!caseSet) return;
    const ids = new Set(caseSet.variants.map((v) => v.id));
    let i = caseSet.variants.length + 1;
    while (ids.has(`v${i}`)) i++;
    const newVar: CaseVariant = { id: `v${i}`, label: `variant ${i}`, overrides: [] };
    patchCaseSet({ variants: [...caseSet.variants, newVar] });
  }

  function removeVariant(idx: number) {
    if (!caseSet) return;
    patchCaseSet({ variants: caseSet.variants.filter((_, i) => i !== idx) });
  }

  function patchOverride(vIdx: number, oIdx: number, patch: Partial<NodeFieldOverride>) {
    if (!caseSet) return;
    const variant = caseSet.variants[vIdx];
    const overrides = (variant.overrides ?? []).map((o, i) => (i === oIdx ? { ...o, ...patch } : o));
    patchVariant(vIdx, { overrides });
  }

  function addOverride(vIdx: number) {
    if (!caseSet) return;
    const variant = caseSet.variants[vIdx];
    const overrides = [...(variant.overrides ?? []), { field: '', value: '' as unknown }];
    patchVariant(vIdx, { overrides });
  }

  function removeOverride(vIdx: number, oIdx: number) {
    if (!caseSet) return;
    const variant = caseSet.variants[vIdx];
    const overrides = (variant.overrides ?? []).filter((_, i) => i !== oIdx);
    patchVariant(vIdx, { overrides });
  }

  return (
    <div className="tab-pane-content">
      {/* ── Repeats (existing ExecutionGroup view) ─────────────────────── */}
      {inAnyGroup ? (
        <div className="branch-summary">
          <div className="term-heading term-heading-comment">{`# repeats (group${groupsForNode.length > 1 ? 's' : ''})`}</div>
          <ul className="group-list">
            {groupsForNode.map((g) => (
              <li key={g.id}>
                <span className="group-chip" style={{ background: g.backgroundColor ?? '#a855f7' }} />
                <code>{g.label ?? g.id}</code>
                <span className="muted small">×{g.repeat?.count ?? 1}{g.repeat?.delay ? ` · ${g.repeat.delay}` : ''}</span>
                {(g.mutations?.filter((m) => m.nodeId === node.id).length ?? 0) > 0 && (
                  <span className="muted small">{` · ${g.mutations!.filter((m) => m.nodeId === node.id).length} mutation${g.mutations!.filter((m) => m.nodeId === node.id).length === 1 ? '' : 's'}`}</span>
                )}
                <button className="term-action" onClick={() => onEditGroup(g.id)}>[edit mutations]</button>
              </li>
            ))}
          </ul>
          {groupsForNode.length === 1 && cartesian > 1 && (
            <div className="muted small">{`> total: ${cartesian} iterations per scenario run.`}</div>
          )}
          <BranchSimulator groups={groupsForNode} nodeId={node.id} />
        </div>
      ) : (
        <div className="branch-empty">
          <div className="term-heading term-heading-data">{`> no repeats on this node`}</div>
          <div className="muted small">
            {`> drop this api inside a group rectangle on the canvas to multiply it across iterations.`}
          </div>
        </div>
      )}

      {/* ── Cases (case-based branching) ───────────────────────────────── */}
      <div className="case-set-block">
        <div className="term-heading term-heading-comment">{`# cases (variants on this anchor)`}</div>
        {!hasCases ? (
          <div className="case-empty">
            <div className="muted small">
              {`> attach a case set to fork the run into N branches at this node.`}
            </div>
            <button className="term-action" onClick={addCaseSet}>[+ add case set]</button>
          </div>
        ) : (
          <div className="case-set-editor">
            <div className="case-set-head">
              <input
                className="case-set-label"
                placeholder="case-set label (optional)"
                value={caseSet!.label ?? ''}
                onChange={(e) => patchCaseSet({ label: e.target.value || undefined })}
              />
              <span className="muted small">{`fork → ${caseSet!.variants.length} branches`}</span>
              <JsonLogicHint ctx="default" triggerLabel="Variant overrides accept literals or JSONLogic" />
              <button className="term-action danger" onClick={removeCaseSet}>[remove]</button>
            </div>
            {caseSet!.variants.map((v, vi) => (
              <div className="case-variant" key={v.id}>
                <div className="case-variant-head">
                  <span className="case-variant-id">{v.id}</span>
                  <input
                    className="case-variant-label"
                    placeholder="variant label"
                    value={v.label}
                    onChange={(e) => patchVariant(vi, { label: e.target.value })}
                  />
                  <button className="term-action danger" onClick={() => removeVariant(vi)}>[×]</button>
                </div>
                <div className="case-variant-body">
                  {(v.overrides ?? []).length === 0 && (
                    <div className="muted small">{`> no overrides — anchor sends with default request.`}</div>
                  )}
                  {(v.overrides ?? []).map((o, oi) => (
                    <div className="case-override-row" key={oi}>
                      <input
                        className="case-override-field"
                        placeholder="body.email"
                        value={o.field}
                        onChange={(e) => patchOverride(vi, oi, { field: e.target.value })}
                      />
                      <span className="binding-arrow">←</span>
                      <input
                        className="case-override-value"
                        placeholder="literal or {&quot;var&quot;:&quot;...&quot;}"
                        value={typeof o.value === 'string' ? o.value : JSON.stringify(o.value ?? '')}
                        onChange={(e) => {
                          const raw = e.target.value;
                          try { patchOverride(vi, oi, { value: JSON.parse(raw), isRule: typeof JSON.parse(raw) === 'object' && JSON.parse(raw) !== null }); }
                          catch { patchOverride(vi, oi, { value: raw, isRule: false }); }
                        }}
                      />
                      <button className="kv-del" onClick={() => removeOverride(vi, oi)}>×</button>
                    </div>
                  ))}
                  <button className="kv-add" onClick={() => addOverride(vi)}>+ add override</button>
                </div>
              </div>
            ))}
            <button className="kv-add" onClick={addVariant}>+ add variant</button>
          </div>
        )}
      </div>
    </div>
  );
}
