import { useState } from 'react';
import type { ApiNode, EndpointDescriptor } from '../api';
import { RequestSchemaPreview } from './RequestSchemaPreview';

interface Props {
  node: ApiNode;
  endpoint?: EndpointDescriptor;
  defaultRequestSample: string;
}

export function OverviewTab({ node: _node, endpoint, defaultRequestSample }: Props) {
  if (!endpoint) {
    return (
      <div className="tab-pane-content">
        <div className="muted small">{`> no discovery metadata. fill request manually in [req] tab.`}</div>
      </div>
    );
  }
  const bodySchema = pickBodySchema(endpoint);
  return (
    <div className="tab-pane-content">
      <Section title="# about" defaultOpen>
        <div className="overview-about">
          {endpoint.description ? (
            <div className="overview-desc">
              {endpoint.description}
            </div>
          ) : (
            <div className="muted small">{`> no description provided.`}</div>
          )}
          <dl className="overview-dl">
            <dt>method</dt><dd><code>{endpoint.method.toUpperCase()}</code></dd>
            <dt>path</dt><dd><code>{endpoint.path}</code></dd>
            {endpoint.area && (<><dt>area</dt><dd><code>{endpoint.area}</code></dd></>)}
            {endpoint.purpose && (<><dt>purpose</dt><dd>{endpoint.purpose}</dd></>)}
            {endpoint.isDeprecated && (<><dt>status</dt><dd className="overview-warn">⚠ deprecated</dd></>)}
          </dl>
        </div>
      </Section>

      <Section title="> schema preview" defaultOpen={false}>
        <RequestSchemaPreview schema={bodySchema} />
      </Section>

      <Section title="$ sample request" defaultOpen={false} action={
        <CopyButton text={defaultRequestSample} />
      }>
        <pre className="overview-sample">{defaultRequestSample}</pre>
      </Section>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="term-action"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }).catch(() => {});
      }}
    >
      {copied ? '[copied]' : '[copy]'}
    </button>
  );
}

interface SectionProps {
  title: string;
  defaultOpen?: boolean;
  action?: React.ReactNode;
  children: React.ReactNode;
}

function Section({ title, defaultOpen = true, action, children }: SectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`term-section ${open ? 'open' : 'closed'}`}>
      <div className="term-section-head" onClick={() => setOpen((v) => !v)}>
        <span className="term-caret">{open ? '▾' : '▸'}</span>
        <span className="term-section-title">{title}</span>
        {action && <span className="term-section-action" onClick={(e) => e.stopPropagation()}>{action}</span>}
      </div>
      <div className="term-section-body">
        {open && children}
      </div>
    </div>
  );
}

function pickBodySchema(endpoint: EndpointDescriptor): Record<string, unknown> | undefined {
  const content = endpoint.requestBody?.content ?? [];
  const json = content.find((c) => c.contentType.includes('json')) ?? content[0];
  return (json?.schema as Record<string, unknown> | undefined) ?? undefined;
}
