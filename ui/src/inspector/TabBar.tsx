export type InspectorTab = 'overview' | 'request' | 'wiring' | 'branching' | 'internals' | 'history';

const TABS: InspectorTab[] = ['overview', 'request', 'wiring', 'branching', 'internals', 'history'];

const TAB_LABELS: Record<InspectorTab, string> = {
  overview: 'overview',
  request: 'req',
  wiring: 'wire',
  branching: 'branch',
  internals: 'inter',
  history: 'hist',
};

interface Props {
  active: InspectorTab;
  counts: Partial<Record<InspectorTab, number>>;
  /** Tabs that should appear dimmed (no content). Still clickable. */
  dimmed?: InspectorTab[];
  /** Tabs that should not render at all (feature off / N/A). */
  hidden?: InspectorTab[];
  onChange: (tab: InspectorTab) => void;
}

export function TabBar({ active, counts, dimmed = [], hidden = [], onChange }: Props) {
  const visible = TABS.filter((t) => !hidden.includes(t));
  return (
    <nav className="term-tabs" role="tablist" aria-label="Inspector sections">
      {visible.map((t) => {
        const isActive = t === active;
        const count = counts[t];
        const isDim = dimmed.includes(t);
        return (
          <button
            key={t}
            role="tab"
            aria-selected={isActive}
            className={`term-tab term-tab-${t} ${isActive ? 'active' : ''} ${isDim ? 'dim' : ''}`}
            onClick={() => onChange(t)}
          >
            <span className="term-tab-bracket">[</span>
            <span className="term-tab-label">{TAB_LABELS[t]}</span>
            {count != null && count > 0 && (
              <sup className="term-tab-count">{count}</sup>
            )}
            <span className="term-tab-bracket">]</span>
          </button>
        );
      })}
    </nav>
  );
}
