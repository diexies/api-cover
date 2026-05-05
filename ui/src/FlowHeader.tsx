import { useState } from 'react';

interface Props {
  name: string;
  description: string;
  tags: string[];
  onNameChange: (v: string) => void;
  onDescriptionChange: (v: string) => void;
  onTagsChange: (v: string[]) => void;
}

/**
 * Business-flow header above the canvas: editable name, description, tag chips.
 * Reframes a "scenario" as a named user journey ("Checkout flow", "User signup", …).
 */
export function FlowHeader({
  name, description, tags,
  onNameChange, onDescriptionChange, onTagsChange,
}: Props) {
  const [tagDraft, setTagDraft] = useState('');
  const [descOpen, setDescOpen] = useState(description.length > 0);

  function commitTag() {
    const t = tagDraft.trim();
    if (!t) return;
    if (tags.includes(t)) { setTagDraft(''); return; }
    onTagsChange([...tags, t]);
    setTagDraft('');
  }

  function removeTag(t: string) {
    onTagsChange(tags.filter((x) => x !== t));
  }

  return (
    <div className="flow-header">
      <div className="flow-header-row">
        <input
          className="flow-name"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="Untitled flow"
          spellCheck={false}
        />
        <div className="flow-tags">
          {tags.map((t) => (
            <span key={t} className="flow-tag">
              {t}
              <button onClick={() => removeTag(t)} title="Remove tag">×</button>
            </span>
          ))}
          <input
            className="flow-tag-input"
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commitTag(); }
              else if (e.key === 'Backspace' && tagDraft.length === 0 && tags.length > 0) {
                onTagsChange(tags.slice(0, -1));
              }
            }}
            onBlur={commitTag}
            placeholder="+ tag"
          />
        </div>
        <button
          className="flow-desc-toggle"
          onClick={() => setDescOpen((v) => !v)}
          title={descOpen ? 'Hide description' : 'Show description'}
        >
          {descOpen ? '▾ desc' : '▸ desc'}
        </button>
      </div>
      {descOpen && (
        <textarea
          className="flow-description"
          value={description}
          onChange={(e) => onDescriptionChange(e.target.value)}
          placeholder="What does this flow do? (e.g. 'User checks out: cart → payment → order')"
          rows={2}
          spellCheck={false}
        />
      )}
    </div>
  );
}
