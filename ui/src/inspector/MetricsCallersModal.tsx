import { useEffect } from 'react';
import { ServiceCallersList } from './ServiceCallersList';

interface Props {
  serviceId: string;
  shortName: string;
  onFocus?: (id: string) => void;
  onClose: () => void;
}

/**
 * Floating modal that surfaces the same ServiceCallersList content as the SourceDrawer's
 * Callers tab but reachable from the Metrics table without leaving the metrics view.
 * "Focus in map" hands the id back to the parent so ServiceMapPanel can flip its view to
 * the tree and pin the node via requestedFocus.
 */
export function MetricsCallersModal({ serviceId, shortName, onFocus, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div className="metrics-callers-backdrop" onClick={onClose} />
      <aside className="metrics-callers-modal" role="dialog" aria-modal="true" aria-label={`Callers of ${shortName}`}>
        <header className="metrics-callers-head">
          <div className="metrics-callers-title">
            <strong>{shortName}</strong>
            <span className="muted small">{serviceId}</span>
          </div>
          <div className="metrics-callers-actions">
            {onFocus && (
              <button
                type="button"
                className="metrics-callers-focus-btn"
                onClick={() => { onFocus(serviceId); onClose(); }}
                title="Focus this node in the system map tree view"
              >Focus in map</button>
            )}
            <button
              type="button"
              className="metrics-callers-close"
              onClick={onClose}
              aria-label="close"
            >×</button>
          </div>
        </header>
        <div className="metrics-callers-body">
          <ServiceCallersList serviceId={serviceId} />
        </div>
      </aside>
    </>
  );
}
