import { useEffect, useRef, useState } from 'react';

interface Props {
  onCreate: (id: string) => void | Promise<void>;
  existingIds: string[];
  onError?: (msg: string) => void;
}

/**
 * Sidebar control that idles as a chunky 3D button and morphs into a text input on hover (or
 * when focused). Enter commits and creates the scenario; Escape / blur reverts and clears.
 * Defending against accidental commits when the user briefly hovers and leaves: input mode
 * sticks once they actually start typing or focus the field.
 */
export function NewScenarioControl({ onCreate, existingIds, onError }: Props) {
  const [active, setActive] = useState(false);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (active) inputRef.current?.focus();
  }, [active]);

  function commit() {
    const id = value.trim();
    if (!id) { setActive(false); return; }
    if (existingIds.includes(id)) {
      onError?.(`scenario "${id}" already exists`);
      return;
    }
    onCreate(id);
    setValue('');
    setActive(false);
  }

  function cancel() {
    setValue('');
    setActive(false);
  }

  return (
    <div
      className={`new-control ${active ? 'active' : ''}`}
      onMouseEnter={() => setActive(true)}
      onMouseLeave={() => { if (!value && document.activeElement !== inputRef.current) setActive(false); }}
    >
      {!active && (
        <button className="new-btn-3d" onClick={(e) => { e.stopPropagation(); setActive(true); }}>+ New</button>
      )}
      {active && (
        <input
          ref={inputRef}
          className="new-input"
          placeholder="scenario id…"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            else if (e.key === 'Escape') cancel();
          }}
          onBlur={() => { if (!value) cancel(); }}
        />
      )}
    </div>
  );
}
