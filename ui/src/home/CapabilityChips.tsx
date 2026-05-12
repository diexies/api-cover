interface Capability {
  token: string;
  hint: string;
}

const CAPABILITIES: Capability[] = [
  { token: '/scenario', hint: 'scaffold a scenario from your code' },
  { token: '/discover', hint: 'infer likely scenarios from the api surface' },
  { token: '/scan',     hint: 'index endpoints and populate memory' },
  { token: '/explain',  hint: 'explain how an endpoint behaves' },
  { token: '/map',      hint: 'service / dependency map' },
];

interface Props {
  /** Click writes the token (with trailing space) into the composer; no auto-submit. */
  onPick: (token: string) => void;
  disabled?: boolean;
}

/**
 * Slash-command shortcuts — rendered as a terminal-style tree under an
 * "available commands" header. Mono branch glyphs (├─ / └─ / →) make the
 * structure read like a `--help` block: indented, ASCII-friendly, no
 * decorative chrome. Click a row to write the token into the composer.
 */
export function CapabilityChips({ onPick, disabled }: Props) {
  return (
    <section className="cap-tree" aria-label="quick commands">
      <header className="cap-tree-head">
        <span className="cap-tree-head-icon" aria-hidden="true">⌘</span>
        <span>available commands</span>
      </header>
      <ul className="cap-tree-list" role="list">
        {CAPABILITIES.map((c, i, arr) => {
          const isLast = i === arr.length - 1;
          return (
            <li key={c.token} className="cap-tree-item">
              <button
                type="button"
                className="cap-tree-row"
                onClick={() => onPick(c.token)}
                disabled={disabled}
              >
                <span className="cap-tree-branch" aria-hidden="true">
                  {isLast ? '└─' : '├─'}
                </span>
                <span className="cap-tree-arrow" aria-hidden="true">→</span>
                <span className="cap-tree-token">{c.token}</span>
                <span className="cap-tree-hint">{c.hint}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
