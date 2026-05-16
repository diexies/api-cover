import type { ApiNode, EndpointDescriptor, StreamingNodeOptions, StreamingMode, StreamParser } from '../api';
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
  /** Patch streaming options. Set to undefined to remove. */
  onStreamingChange?: (next: StreamingNodeOptions | undefined) => void;
}

export function RequestTab({
  node, endpoint, bodySchema,
  pathRows, queryRows, headerRows,
  declaredPath, declaredQuery, declaredHeader,
  bodyText, bodyError, bodyMode, onSetBodyMode,
  onPathRowsChange, onQueryRowsChange, onHeaderRowsChange,
  onBodyChange, onBodyTextChange, onLoadSample, onStreamingChange,
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
                type="button"
                title={s.description}
              >
                {s.name}
              </button>
            ))}
          </div>
        )}
      </TermGroup>

      {/* Streaming response handling — SSE / NDJSON / Raw with stop conditions. */}
      {onStreamingChange && (
        <StreamingSection
          streaming={node.streaming}
          onChange={onStreamingChange}
        />
      )}
    </div>
  );
}

interface StreamingSectionProps {
  streaming?: StreamingNodeOptions;
  onChange: (next: StreamingNodeOptions | undefined) => void;
}

function StreamingSection({ streaming, onChange }: StreamingSectionProps) {
  const enabled = !!streaming;
  const mode: StreamingMode = streaming?.mode ?? 'Collect';
  const parser: StreamParser = streaming?.parser ?? 'Auto';
  const untilText = streaming?.until ? JSON.stringify(streaming.until, null, 2) : '';

  function patch(next: Partial<StreamingNodeOptions>): void {
    onChange({ ...(streaming ?? {}), ...next });
  }

  function commitUntil(v: string): void {
    if (!streaming) return;
    try {
      const parsed = v.trim().length > 0 ? JSON.parse(v) : undefined;
      onChange({ ...streaming, until: parsed });
    } catch { /* invalid JSON — leave previous value */ }
  }

  return (
    <TermGroup
      title="≋ streaming"
      accent="phosphor"
      defaultOpen={enabled}
      hint={enabled ? `${mode.toLowerCase()} · ${parser.toLowerCase()}` : 'off'}
      action={
        <label className="streaming-toggle">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onChange(e.target.checked ? { mode: 'Collect', parser: 'Auto' } : undefined)}
            onClick={(e) => e.stopPropagation()}
          />
        </label>
      }
    >
      {!enabled && (
        <div className="muted small">
          {`> enable to capture SSE / NDJSON / raw streaming responses. Without this, only the first body chunk is read.`}
        </div>
      )}
      {enabled && (
        <div className="streaming-form">
          <label className="term-form-row">
            <span className="term-form-label">mode</span>
            <select
              className="form-input"
              value={mode}
              onChange={(e) => patch({ mode: e.target.value as StreamingMode })}
            >
              <option value="Collect">Collect (until EOF / timeout / max)</option>
              <option value="First">First (one message then close)</option>
              <option value="Until">Until predicate is truthy</option>
            </select>
          </label>
          <label className="term-form-row">
            <span className="term-form-label">parser</span>
            <select
              className="form-input"
              value={parser}
              onChange={(e) => patch({ parser: e.target.value as StreamParser })}
            >
              <option value="Auto">Auto (by Content-Type)</option>
              <option value="Sse">SSE (data: framing)</option>
              <option value="Ndjson">NDJSON (one JSON per line)</option>
              <option value="Raw">Raw (UTF-8 chunks)</option>
            </select>
          </label>
          {mode === 'Until' && (
            <label className="term-form-row">
              <span className="term-form-label-row">
                <span className="term-form-label">until (JSONLogic)</span>
                <JsonLogicHint ctx="streaming" triggerLabel="Streaming context: message, index, elapsed" />
              </span>
              <textarea
                className="body-editor"
                rows={3}
                defaultValue={untilText}
                key={untilText}
                onBlur={(e) => commitUntil(e.target.value)}
                placeholder='{ "==": [ { "var": "message.event" }, "done" ] }'
                spellCheck={false}
              />
              <div className="term-helper">{`// context: { message, index, elapsed }. Run advances when truthy.`}</div>
            </label>
          )}
          <div className="streaming-row-pair">
            <label className="term-form-row">
              <span className="term-form-label">max messages</span>
              <input
                type="number"
                min={1}
                className="form-input"
                value={streaming?.maxMessages ?? ''}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  patch({ maxMessages: Number.isFinite(v) ? v : undefined });
                }}
                placeholder="(none)"
              />
            </label>
            <label className="term-form-row">
              <span className="term-form-label">timeout</span>
              <input
                type="text"
                className="form-input"
                value={streaming?.timeout ?? ''}
                onChange={(e) => patch({ timeout: e.target.value.trim() || undefined })}
                placeholder="PT30S"
              />
            </label>
          </div>
          <div className="muted small">{`> ISO 8601 duration: PT30S = 30s, PT5M = 5min, PT1H = 1h.`}</div>
        </div>
      )}
    </TermGroup>
  );
}
