import { ServiceCallersList } from './ServiceCallersList';
import { Modal } from '../components/Modal';

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
  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      size="lg"
      labelledBy="metrics-callers-title"
    >
      <Modal.Header>
        <div className="metrics-callers-title">
          <Modal.Title id="metrics-callers-title">{shortName}</Modal.Title>
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
          <Modal.Close />
        </div>
      </Modal.Header>
      <Modal.Body>
        <ServiceCallersList serviceId={serviceId} />
      </Modal.Body>
    </Modal>
  );
}
