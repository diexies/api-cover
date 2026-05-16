import type { ApiNode, EndpointDescriptor } from '../api';
import { BodyForm } from '../BodyForm';
import { KVEditor, type KV } from './KVEditor';
import { TermGroup } from './TermGroup';
import { JsonLogicHint } from '../components/JsonLogicHint';

interface Props {
  node: ApiNode;
  endpoint?: EndpointDescriptor;
  bodySchema?: Record<string, unknown>;
  pathRows: KV[];
  queryRows: KV[];
  headerRows: KV[];
  declaredPath: string[];
  declaredQuery: string[];
  declaredHeader: string[];
  bodyText: string;
  bodyError: string | null;
  bodyMode: 'form' | 'raw';
  onSetBodyMode: (m: 'form' | 'raw') => void;
  onPathRowsChange: (rows: KV[]) => void;
  onQueryRowsChange: (rows: KV[]) => void;
  onHeaderRowsChange: (rows: KV[]) => void;
  onBodyChange: (v: unknown) => void;
  onBodyTextChange: (text: string) => void;
  onLoadSample: (jsonPayload: string) => void;
}

export function RequestTab({
  node, endpoint, bodySchema,
  pathRows, queryRows, headerRows,
  declaredPath, declaredQuery, declaredHeader,
  bodyText, bodyError, bodyMode, onSetBodyMode,
  onPathRowsChange, onQueryRowsChange, onHeaderRowsChange,
  onBodyChange, onBodyTextChange, onLoadSample,
}: Props) {
  const totalPathQuery = pathRows.length + queryRows.length;
  const hasBody = !!node.body || !!bodySchema || bodyText.trim().length > 0;

  return (
    <div className="tab-pane-content">
      <TermGroup
        title="> path & query"
        accent="cyan"
        defaultOpen={totalPathQuery > 0}
        badge={totalPathQuery}
        hint={
          declaredPath.length + declaredQuery.length > 0
            ? `expected: ${[...declaredPath, ...declaredQuery].join(', ')}`
            : undefined
        }
      >
        {pathRows.length === 0 && queryRows.length === 0 && (
          <div className="muted small">{`> no path or query parameters declared.`}</div>
        )}
        {pathRows.length > 0 && (
          <>
            <div className="term-sub-label">path</div>
            <KVEditor rows={pathRows} setRows={onPathRowsChange} declared={declaredPath} />
          </>
        )}
        {queryRows.length > 0 && (
          <>
            <div className="term-sub-label">query</div>
            <KVEditor rows={queryRows} setRows={onQueryRowsChange} declared={declaredQuery} />
          </>
        )}
        <div className="term-helper">{`// value can be literal OR JSONLogic, e.g. {"var":"nodes.login.response.body.id"}`}</div>
      </TermGroup>

      <TermGroup
        title="> headers"
        accent="amber"
        defaultOpen={headerRows.length > 0}
        badge={headerRows.length}
        hint={declaredHeader.length > 0 ? `expected: ${declaredHeader.join(', ')}` : undefined}
      >
        <KVEditor rows={headerRows} setRows={onHeaderRowsChange} declared={declaredHeader} />
        <div className="term-helper">{`// value can be literal OR JSONLogic, e.g. {"cat":["Bearer ",{"var":"nodes.login.response.body.token"}]}`}</div>
      </TermGroup>

      <TermGroup
        title="$ body"
        accent="phosphor"
        defaultOpen={hasBody}
        action={
          <div className="term-segmented">
            <button className={bodyMode === 'form' ? 'active' : ''} onClick={(e) => { e.stopPropagation(); onSetBodyMode('form'); }}>form</button>
            <button className={bodyMode === 'raw' ? 'active' : ''} onClick={(e) => { e.stopPropagation(); onSetBodyMode('raw'); }}>raw</button>
            <JsonLogicHint ctx="default" triggerLabel="JSONLogic help" />
          </div>
        }
      >
        {bodyMode === 'form' ? (
          <BodyForm
            schema={bodySchema}
            value={node.body}
            onChange={onBodyChange}
          />
        ) : (
          <>
            <textarea
              className="body-editor"
              rows={12}
              value={bodyText}
              onChange={(e) => onBodyTextChange(e.target.value)}
              placeholder="{}"
              spellCheck={false}
            />
            {bodyError && <div className="error small">{`[!] invalid JSON: ${bodyError}`}</div>}
            <div className="term-helper">{`// any subtree like {"var":"nodes.x.response.body.field"} resolves at run time.`}</div>
          </>
        )}
        {endpoint?.samples && endpoint.samples.length > 0 && (
          <div className="samples">
            <span className="muted small">{`> load sample:`}</span>
            {endpoint.samples.map((s) => (
              <button
                key={s.name}
                className="chip"
                onClick={() => onLoadSample(s.jsonPayload)}
                title={s.description}
              >
                {s.name}
              </button>
            ))}
          </div>
        )}
      </TermGroup>
    </div>
  );
}
