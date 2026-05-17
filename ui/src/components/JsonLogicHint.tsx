import * as Popover from '@radix-ui/react-popover';
import { useState } from 'react';
import { JSONLOGIC_OPS, JSONLOGIC_VARS, type JsonLogicContext } from '../inspector/jsonlogic-help';

interface Props {
  ctx: JsonLogicContext;
  /** Optional tooltip-style label override on the trigger button. */
  triggerLabel?: string;
}

type Tab = 'vars' | 'ops' | 'examples';

/**
 * Popover hint surfaced next to JSONLogic editors (Wiring shouldRun, Request body, Branching
 * variant overrides, Group mutation rules). Three tabs: available variables for the given
 * context, operators supported by the in-UI preview evaluator, and copy-ready examples.
 */
export function JsonLogicHint({ ctx, triggerLabel }: Props) {
  const [tab, setTab] = useState<Tab>('vars');
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="jl-hint-trigger"
          aria-label={triggerLabel ?? 'JSONLogic help'}
          title={triggerLabel ?? 'JSONLogic help'}
        >ⓘ</button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="jl-hint-popover"
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={12}
        >
          <header className="jl-hint-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'vars'}
              className={`jl-hint-tab${tab === 'vars' ? ' is-active' : ''}`}
              onClick={() => setTab('vars')}
            >Variables</button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'ops'}
              className={`jl-hint-tab${tab === 'ops' ? ' is-active' : ''}`}
              onClick={() => setTab('ops')}
            >Operators</button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'examples'}
              className={`jl-hint-tab${tab === 'examples' ? ' is-active' : ''}`}
              onClick={() => setTab('examples')}
            >Examples</button>
          </header>
          <div className="jl-hint-body">
            {tab === 'vars' && (
              <ul className="jl-hint-list">
                {JSONLOGIC_VARS[ctx].map((v) => (
                  <li key={v.path}>
                    <code className="jl-hint-path">{v.path}</code>
                    <span className="jl-hint-type">{v.type}</span>
                    <p className="jl-hint-doc">{v.doc}</p>
                  </li>
                ))}
              </ul>
            )}
            {tab === 'ops' && (
              <ul className="jl-hint-list">
                {JSONLOGIC_OPS.map((o) => (
                  <li key={o.op}>
                    <code className="jl-hint-path">{o.op}</code>
                    <code className="jl-hint-args">{o.args}</code>
                    <p className="jl-hint-doc">{o.doc}</p>
                  </li>
                ))}
              </ul>
            )}
            {tab === 'examples' && (
              <ul className="jl-hint-examples">
                {JSONLOGIC_OPS.map((o) => (
                  <li key={o.op}>
                    <span className="jl-hint-example-op">{o.op}</span>
                    <CopyableSnippet text={o.example} />
                  </li>
                ))}
              </ul>
            )}
          </div>
          <Popover.Arrow className="jl-hint-arrow" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function CopyableSnippet({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="jl-hint-snippet"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        } catch { /* ignore */ }
      }}
      title="Click to copy"
    >
      <code>{text}</code>
      <span className="jl-hint-copy">{copied ? '✓' : '⧉'}</span>
    </button>
  );
}
