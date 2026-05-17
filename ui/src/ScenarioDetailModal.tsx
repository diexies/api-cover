import { useState } from 'react';
import { Modal } from './components/Modal';

interface Props {
  name: string;
  description: string;
  tags: string[];
  onNameChange: (v: string) => void;
  onDescriptionChange: (v: string) => void;
  onTagsChange: (v: string[]) => void;
  onClose: () => void;
}

/**
 * Edits the scenario's narrative metadata (name + description + tag chips). Surfaced via
 * the run history drawer's "Detail" button so the title bar can stay clean.
 */
export function ScenarioDetailModal({
  name, description, tags,
  onNameChange, onDescriptionChange, onTagsChange,
  onClose,
}: Props) {
  const [tagDraft, setTagDraft] = useState('');

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
    <Modal
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      size="md"
      labelledBy="scenario-detail-title"
    >
      <Modal.Header>
        <Modal.Title id="scenario-detail-title">Scenario detail</Modal.Title>
        <Modal.Close />
      </Modal.Header>
      <Modal.Body>
        <label className="term-form-row">
          <span className="term-form-label">name</span>
          <input
            className="form-input"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="Untitled flow"
            spellCheck={false}
            autoFocus
          />
        </label>

        <label className="term-form-row">
          <span className="term-form-label">description</span>
          <textarea
            className="form-input"
            rows={3}
            value={description}
            onChange={(e) => onDescriptionChange(e.target.value)}
            placeholder="What does this flow do?"
            spellCheck={false}
          />
        </label>

        <label className="term-form-row">
          <span className="term-form-label">tags</span>
          <div className="scenario-detail-tags">
            {tags.map((t) => (
              <span key={t} className="flow-tag">
                {t}
                <button type="button" onClick={() => removeTag(t)} title="Remove tag">×</button>
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
        </label>
      </Modal.Body>
      <Modal.Footer>
        <button className="btn primary" onClick={onClose}>Done</button>
      </Modal.Footer>
    </Modal>
  );
}
