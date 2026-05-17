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

  // Suppress unused-prop lints — name/tags still flow through for autosave bookkeeping
  // even though they aren't rendered here (sidebar shows the name, tag editor removed).
  void name;
  void onNameChange;
  void tags;
  void onTagsChange;
  void tagDraft;
  void setTagDraft;
  void commitTag;
  void removeTag;
  return (
    <div className="flow-header">
      <div className="flow-header-row">
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
