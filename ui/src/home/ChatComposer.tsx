import { useEffect, useLayoutEffect, useRef } from 'react';

interface Props {
  value: string;
  onChange: (v: string) => void;
  /** Fired when the user presses Enter (without Shift) on a non-empty value. */
  onSubmit: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /** Hint shown below the textarea — used for the agent-busy / not-configured state. */
  hint?: string;
  /** Slash-command mode lifted out of the textarea — rendered as an inline chip. */
  mode?: string | null;
  /** Called when the user clears the chip via × or Backspace at start of empty text. */
  onClearMode?: () => void;
}

const MIN_HEIGHT_PX = 28;
const MAX_HEIGHT_PX = 240;

/**
 * Multiline chat composer with auto-grow and Enter-to-submit. Single textarea
 * + a Send button, no toolbar — the parent owns slash command suggestions.
 *
 * Auto-grow strategy: native `field-sizing: content` first, with a JS fallback
 * (set height to scrollHeight clamped to MAX_HEIGHT_PX) for browsers that
 * haven't shipped it yet (Safari < 18.1). Both paths converge on the same
 * visual behavior so we don't duplicate state.
 */
export function ChatComposer({ value, onChange, onSubmit, disabled, placeholder, hint, mode, onClearMode }: Props) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // JS fallback for browsers that don't support field-sizing: content. The
  // CSS rule sets field-sizing first; this effect only mutates inline height
  // when the computed value isn't 'auto'. Cheap to run on every keystroke.
  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    const supportsFieldSizing =
      typeof CSS !== 'undefined' &&
      typeof CSS.supports === 'function' &&
      CSS.supports('field-sizing', 'content');
    if (supportsFieldSizing) return;
    el.style.height = 'auto';
    const next = Math.min(MAX_HEIGHT_PX, Math.max(MIN_HEIGHT_PX, el.scrollHeight));
    el.style.height = `${next}px`;
  }, [value]);

  // Submit on Enter unless Shift held. Empty / whitespace-only is a no-op so
  // an accidental Enter on an empty composer doesn't fire the handler.
  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Backspace at the very start of an empty textarea pops the mode chip
    // off — natural editor behavior, like email recipient pills.
    if (
      e.key === 'Backspace' &&
      mode &&
      onClearMode &&
      value.length === 0
    ) {
      e.preventDefault();
      onClearMode();
      return;
    }
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    const t = value.trim();
    if (!t || disabled) return;
    onSubmit(t);
  }

  // Refocus the input when it transitions from disabled → enabled, so a
  // user who started typing before agent status finished loading lands
  // back in the field once it unlocks.
  useEffect(() => {
    if (!disabled) taRef.current?.focus({ preventScroll: true });
  }, [disabled]);

  const trimmed = value.trim();

  return (
    <div className={`home-composer${disabled ? ' is-disabled' : ''}${mode ? ' has-mode' : ''}`}>
      <div className="home-composer-input">
        {mode && (
          <span className="home-composer-mode" data-mode={mode}>
            <span className="home-composer-mode-slash" aria-hidden="true">/</span>
            <span className="home-composer-mode-name">{mode}</span>
            {onClearMode && (
              <button
                type="button"
                className="home-composer-mode-clear"
                onClick={onClearMode}
                aria-label={`clear ${mode} mode`}
                tabIndex={-1}
              >×</button>
            )}
          </span>
        )}
        <textarea
          ref={taRef}
          className="home-composer-textarea"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={mode
            ? `${mode} prompt — describe what you want…`
            : placeholder ?? 'Build a flow, ask a question…'}
          rows={1}
          disabled={disabled}
          aria-label="chat composer"
        />
      </div>
      <div className="home-composer-foot">
        <span className="home-composer-hint" aria-live="polite">
          {hint ?? (
            <>
              <kbd>↵</kbd> send <span className="home-composer-sep">·</span>{' '}
              <kbd>shift</kbd>+<kbd>↵</kbd> newline
            </>
          )}
        </span>
        <button
          type="button"
          className="home-composer-send"
          onClick={() => trimmed && !disabled && onSubmit(trimmed)}
          disabled={disabled || !trimmed}
          aria-label="send"
        >
          Send →
        </button>
      </div>
    </div>
  );
}
