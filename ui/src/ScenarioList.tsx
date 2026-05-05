import { useEffect, useState } from 'react';
import type { Scenario } from './api';

interface Props {
  scenarios: Scenario[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

const STORAGE_KEY = 'utopia.inspector.sidebar.sections';
type Sections = { complex: boolean; oneDir: boolean };

function loadSections(): Sections {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Sections>;
      const complex = parsed.complex ?? true;
      const oneDir = parsed.oneDir ?? true;
      // Both can never be closed at the same time — fall back to both open.
      if (!complex && !oneDir) return { complex: true, oneDir: true };
      return { complex, oneDir };
    }
  } catch { /* ignore */ }
  return { complex: true, oneDir: true };
}

function isComplex(s: Scenario): boolean {
  return s.nodes.length > 1 || (s.groups?.length ?? 0) > 0;
}

/**
 * Sidebar scenario list, split into two collapsible sections (Complex vs One-Direction).
 * Invariant: at least one section stays open. State persists in localStorage.
 */
export function ScenarioList({ scenarios, selectedId, onSelect }: Props) {
  const [sections, setSections] = useState<Sections>(() => loadSections());
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sections));
  }, [sections]);

  function toggle(key: keyof Sections) {
    setSections((cur) => {
      const next: Sections = { ...cur, [key]: !cur[key] };
      // Enforce: one must remain open. If user just closed the last open one, force the other open.
      if (!next.complex && !next.oneDir) {
        return key === 'complex' ? { complex: false, oneDir: true } : { complex: true, oneDir: false };
      }
      return next;
    });
  }

  if (scenarios.length === 0) {
    return (
      <div className="scenario-list-empty">
        no scenarios yet — PUT one to <code>/apicover/api/scenarios/{'{id}'}</code>
      </div>
    );
  }

  const complex = scenarios.filter(isComplex);
  const oneDir = scenarios.filter((s) => !isComplex(s));
  const bothOpen = sections.complex && sections.oneDir;

  return (
    <div className="scenario-split">
      <Section
        title="Multi-step Flows"
        items={complex}
        open={sections.complex}
        flex={bothOpen ? 1 : (sections.complex ? 1 : 0)}
        onToggle={() => toggle('complex')}
        selectedId={selectedId}
        onSelect={onSelect}
      />
      <Section
        title="Single Calls"
        items={oneDir}
        open={sections.oneDir}
        flex={bothOpen ? 1 : (sections.oneDir ? 1 : 0)}
        onToggle={() => toggle('oneDir')}
        selectedId={selectedId}
        onSelect={onSelect}
      />
    </div>
  );
}

function Section({
  title, items, open, flex, onToggle, selectedId, onSelect,
}: {
  title: string;
  items: Scenario[];
  open: boolean;
  flex: number;
  onToggle: () => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className={`scn-section ${open ? 'open' : 'closed'}`} style={open ? { flex } : undefined}>
      <button className="scn-section-head" onClick={onToggle}>
        <span className="caret">{open ? '▾' : '▸'}</span>
        <span className="scn-section-title">{title}</span>
        <span className="scn-section-count">{items.length}</span>
      </button>
      {open && (
        <ul className="scenario-list">
          {items.length === 0 && <li className="empty">none</li>}
          {items.map((s) => (
            <li
              key={s.id}
              className={selectedId === s.id ? 'selected' : ''}
              onClick={() => onSelect(s.id)}
            >
              <div className="title">{s.name}</div>
              {s.description && (
                <div className="desc">{s.description}</div>
              )}
              <div className="meta">
                {s.id} · {s.nodes.length} node{s.nodes.length === 1 ? '' : 's'}
              </div>
              {s.tags && s.tags.length > 0 && (
                <div className="tags">
                  {s.tags.map((t) => (
                    <span key={t} className="tag-chip">{t}</span>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
