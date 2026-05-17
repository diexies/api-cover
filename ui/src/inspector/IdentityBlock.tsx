// Pinned identity card. Top row (method/path/mode/close) stays the same on every tab.
// Bottom zone is contextual: on the Overview tab it shows the endpoint identity (name +
// description + tags); on every other tab it shows a short Turkish primer that explains
// what that tab is for.

import { useState } from 'react';
import type { ApiNode, EndpointDescriptor } from '../api';
import type { InspectorTab } from './TabBar';

interface Props {
  node: ApiNode;
  endpoint?: EndpointDescriptor;
  isStartMode: boolean;
  isStartNode: boolean;
  upstreamCount: number;
  activeTab: InspectorTab;
  onToggleStart: () => void;
  onClose: () => void;
}

const TAB_PRIMERS: Record<Exclude<InspectorTab, 'overview'>, { title: string; lines: string[] }> = {
  request: {
    title: '> request',
    lines: [
      'API\'ye gönderilecek isteğin içeriğini hazırlarsın.',
      'Path / query parametreleri, header\'lar ve gövde (body) burada doldurulur.',
      'Discovery şeması varsa form modu otomatik gelir, yoksa raw JSON moduna geç.',
    ],
  },
  response: {
    title: '< response',
    lines: [
      'Son çalıştırma sonucu — bu node\'un dönen status, body ve header bilgisi.',
      'Tarih seçildiyse o run\'ın geçmiş yanıtı gösterilir (history drawer\'dan tıkla).',
      'Body JSON ise pretty-print + kopyalama; aksi halde ham metin.',
    ],
  },
  wiring: {
    title: '# wiring',
    lines: [
      'Node\'un mantıksal kablo şeması.',
      'Trigger: ne zaman çalışsın? (JSONLogic koşulu)',
      'Bindings: hangi alanı, hangi upstream cevabıyla doldursun?',
      'Depends-on: bu node hangi node\'larla birlikte tetiklenmeli?',
      'Graph: yakın komşuluğun mini haritası — tıkla → seç.',
    ],
  },
  branching: {
    title: '$ branching',
    lines: [
      'Bu node bir Group (alan) içindeyse, her iterasyonda nasıl çoğalır?',
      'Mutation kuralları her döngüde alanları farklı değerlerle yeniden yazar.',
      'Aşağıdaki branch tablosu, simüle edilmiş iterasyonları gösterir.',
    ],
  },
  internals: {
    title: '◊ internals',
    lines: [
      'Endpoint\'in iç çağrı haritası.',
      'Controller → IService → impl → external HTTP / DB sınırlarına kadar IL yürünür.',
      'DI kaydı varsa interface çağrıları concrete impl\'e bağlanır.',
      'PDB varsa her satır için kaynak file:line bilgisi gelir.',
    ],
  },
  history: {
    title: '$ history',
    lines: [
      'Bu API\'nin geçmişi — hem kullanım hem çalıştırma.',
      'Üst blok: bu (METHOD path) hangi senaryolarda var? Her senaryoda kaç kez geçmiş/başarısız olmuş?',
      'Alt blok: mevcut senaryonun bu node için çalıştırma iterasyonları.',
    ],
  },
};

export function IdentityBlock({
  node, endpoint, isStartMode, isStartNode, upstreamCount, activeTab, onToggleStart, onClose,
}: Props) {
  return (
    <div className="ident-frame">
      <div className="ident-frame-top">
        <span className={`term-badge term-badge-${node.method.toLowerCase()}`}>[{node.method.toUpperCase()}]</span>
        <code className="ident-path">{node.path}</code>
        <button
          className={`term-mode-chip ${isStartMode ? 'start' : 'coupled'}`}
          onClick={onToggleStart}
          title={isStartNode
            ? 'click to remove start-node marker'
            : isStartMode
              ? 'no upstream edges — implicit start; click to mark explicitly'
              : `coupled to ${upstreamCount} upstream — click to force-mark as start`}
        >
          <span className="term-mode-dot" />
          {isStartMode ? 'start' : `coupled${upstreamCount > 0 ? ` · ${upstreamCount}` : ''}`}
          {isStartNode && <span className="term-mode-meta"> · explicit</span>}
        </button>
        <button className="term-close-btn" onClick={onClose} title="Close">[×]</button>
      </div>

      <div className="ident-frame-body">
        {activeTab === 'overview' ? (
          <OverviewIdentity node={node} endpoint={endpoint} />
        ) : (
          <TabPrimer tab={activeTab} />
        )}
      </div>
    </div>
  );
}

function OverviewIdentity({ node, endpoint }: { node: ApiNode; endpoint?: EndpointDescriptor }) {
  const [expanded, setExpanded] = useState(false);
  const description = endpoint?.description ?? '';
  const tags = endpoint?.tags ?? [];
  const displayName = endpoint?.displayName ?? endpoint?.purpose ?? humanise(node.id);

  return (
    <>
      <div className="ident-name">{`# ${displayName}`}</div>
      {description && (
        <div className={`ident-desc ${expanded ? 'expanded' : ''}`}>
          {description.split('\n').map((line, i) => (
            <span key={i} className="ident-desc-line">
              <span className="schema-dim">{'> '}</span>
              {line}
              {'\n'}
            </span>
          ))}
          {description.length > 180 && (
            <button className="ident-desc-toggle" onClick={() => setExpanded((v) => !v)}>
              {expanded ? '[− less]' : '[+ more]'}
            </button>
          )}
        </div>
      )}
      {(tags.length > 0 || endpoint?.area || endpoint?.isDeprecated) && (
        <div className="ident-meta">
          {endpoint?.area && (
            <span className="ident-pill ident-pill-area">{endpoint.area}</span>
          )}
          {tags.map((t) => (
            <span key={t} className="ident-pill">{t}</span>
          ))}
          {endpoint?.isDeprecated && (
            <span className="ident-pill ident-pill-warn">⚠ deprecated</span>
          )}
        </div>
      )}
    </>
  );
}

function TabPrimer({ tab }: { tab: Exclude<InspectorTab, 'overview'> }) {
  const primer = TAB_PRIMERS[tab];
  return (
    <div className={`ident-primer ident-primer-${tab}`}>
      <div className="ident-primer-title">{primer.title}</div>
      {primer.lines.map((line, i) => (
        <div key={i} className="ident-primer-line">
          <span className="schema-dim">{i === 0 ? '> ' : '  '}</span>
          {line}
        </div>
      ))}
    </div>
  );
}

function humanise(id: string): string {
  return id.replace(/_/g, '-').toLowerCase();
}
