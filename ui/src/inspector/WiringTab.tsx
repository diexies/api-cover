import type { ApiNode, EndpointDescriptor } from '../api';
import { DependencyGraphMini } from './DependencyGraphMini';
import { TermGroup } from './TermGroup';

interface Props {
  node: ApiNode;
  endpoint?: EndpointDescriptor;
  isStartMode: boolean;
  shouldRunText: string;
  shouldRunError: string | null;
  onShouldRunChange: (text: string) => void;
  upstreamIds: string[];
  downstreamIds: string[];
  siblings: ApiNode[];
  onFocusNode?: (id: string) => void;
}

export function WiringTab({
  node,
  isStartMode,
  shouldRunText, shouldRunError, onShouldRunChange,
  upstreamIds, downstreamIds, siblings, onFocusNode,
}: Props) {
  const hasShouldRun = shouldRunText.trim().length > 0;

  return (
    <div className="tab-pane-content">
      <TermGroup
        title={isStartMode ? '# trigger condition' : '# run condition'}
        accent="violet"
        defaultOpen={hasShouldRun}
        badge={hasShouldRun ? 1 : 0}
        hint={isStartMode ? 'when does this node start?' : 'when does this node fire?'}
      >
        <label className="term-form-row">
          <span className="term-form-label">JSONLogic predicate</span>
          <textarea
            className="body-editor wiring-jsonlogic"
            rows={4}
            value={shouldRunText}
            onChange={(e) => onShouldRunChange(e.target.value)}
            placeholder={isStartMode
              ? '{ "==": [ { "var": "input.mode" }, "live" ] }'
              : '{ "!=": [ { "var": "nodes.login.response.body.token" }, null ] }'}
            spellCheck={false}
          />
        </label>
        {shouldRunError && <div className="term-error">{`[!] invalid JSON · ${shouldRunError}`}</div>}
        <div className="term-helper">{`// empty → always runs. falsy result → node skipped, descendants follow.`}</div>
      </TermGroup>

      <TermGroup
        title="> graph (neighborhood)"
        accent="magenta"
        defaultOpen
        hint={`up ${upstreamIds.length} · down ${downstreamIds.length}`}
      >
        <DependencyGraphMini
          selfId={node.id}
          selfMethod={node.method.toUpperCase()}
          upstreamIds={upstreamIds}
          downstreamIds={downstreamIds}
          dependencyIds={[]}
          siblings={siblings}
          onFocus={onFocusNode}
        />
      </TermGroup>

      {isStartMode && (
        <TermGroup
          title="# iteration tips"
          accent="dim"
          defaultOpen={false}
          hint="for groups with repeat ≥ 2"
        >
          <div className="muted small">
            {`> the engine binds these into each iteration:`}
          </div>
          <ul className="iter-tip-list">
            <li><code>{'{ "var": "iteration" }'}</code> — current step (0-based)</li>
            <li><code>{'{ "+": [ { "var": "iteration" }, 1 ] }'}</code> — 1-based step</li>
            <li><code>{'{ "cat": [ "user-", { "var": "iteration" } ] }'}</code> — suffix per step</li>
            <li><code>{'{ "var": "previous.body.id" }'}</code> — previous iteration's response</li>
          </ul>
        </TermGroup>
      )}
    </div>
  );
}
