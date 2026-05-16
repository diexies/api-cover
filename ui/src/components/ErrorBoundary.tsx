import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  /** Region name shown in the fallback heading and copied error payload. */
  name: string;
  children: ReactNode;
  /** Optional custom fallback. Defaults to a CrashCard with reload + copy actions. */
  fallback?: (ctx: FallbackContext) => ReactNode;
}

interface State {
  error: Error | null;
  info: ErrorInfo | null;
  resetKey: number;
}

export interface FallbackContext {
  name: string;
  error: Error;
  info: ErrorInfo | null;
  onReload: () => void;
  onCopy: () => void;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null, resetKey: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ info });
    // TODO emit telemetry
    if (typeof console !== 'undefined') {
      console.error(`[ErrorBoundary:${this.props.name}]`, error, info);
    }
  }

  private reload = () => {
    this.setState((s) => ({ error: null, info: null, resetKey: s.resetKey + 1 }));
  };

  private copy = async () => {
    const { name } = this.props;
    const { error, info } = this.state;
    if (!error) return;
    const payload = [
      `Component: ${name}`,
      `Error: ${error.name}: ${error.message}`,
      '',
      'Stack:',
      error.stack ?? '(no stack)',
      '',
      'Component stack:',
      info?.componentStack ?? '(no component stack)',
    ].join('\n');
    try {
      await navigator.clipboard.writeText(payload);
    } catch {
      // Clipboard blocked — fall back to selection.
      const ta = document.createElement('textarea');
      ta.value = payload;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* ignore */ }
      document.body.removeChild(ta);
    }
  };

  render() {
    const { error, info, resetKey } = this.state;
    const { name, children, fallback } = this.props;

    if (error) {
      const ctx: FallbackContext = {
        name,
        error,
        info,
        onReload: this.reload,
        onCopy: this.copy,
      };
      if (fallback) return <>{fallback(ctx)}</>;
      return <CrashCard {...ctx} />;
    }

    return <div key={resetKey} style={{ display: 'contents' }}>{children}</div>;
  }
}

function CrashCard({ name, error, onReload, onCopy }: FallbackContext) {
  return (
    <div className="error-boundary-card" role="alert" aria-live="assertive">
      <div className="eb-head">
        <span className="eb-icon" aria-hidden="true">⚠</span>
        <h3 className="eb-title">{name} crashed</h3>
      </div>
      <p className="eb-message">{error.name}: {error.message}</p>
      <div className="eb-actions">
        <button type="button" className="eb-btn primary" onClick={onReload}>
          Reload component
        </button>
        <button type="button" className="eb-btn" onClick={onCopy}>
          Copy error
        </button>
      </div>
    </div>
  );
}
