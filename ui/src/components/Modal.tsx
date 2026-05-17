import * as Dialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';

type Size = 'sm' | 'md' | 'lg' | 'full';

interface ModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  size?: Size;
  /** Optional extra class on the content card. */
  className?: string;
  /** id of the element labelling the dialog (Modal.Title's id). */
  labelledBy?: string;
  /** id of the element describing the dialog. */
  describedBy?: string;
  children: ReactNode;
}

/**
 * Modal wrapper around Radix Dialog. Handles focus trap, scroll lock, ESC, backdrop click,
 * `aria-modal`, `role="dialog"` automatically. Pair with Modal.Header / Modal.Body /
 * Modal.Footer / Modal.Title / Modal.Close slots for a consistent layout.
 */
export function Modal({ open, onOpenChange, size = 'md', className, labelledBy, describedBy, children }: ModalProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-backdrop" />
        <Dialog.Content
          className={`modal-card modal-size-${size}${className ? ` ${className}` : ''}`}
          aria-modal="true"
          aria-labelledby={labelledBy}
          aria-describedby={describedBy}
        >
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ModalHeader({ children }: { children: ReactNode }) {
  return <div className="modal-head">{children}</div>;
}

function ModalTitle({ id, children }: { id?: string; children: ReactNode }) {
  return <Dialog.Title id={id} className="modal-title" asChild><h2>{children}</h2></Dialog.Title>;
}

function ModalDescription({ id, children }: { id?: string; children: ReactNode }) {
  return <Dialog.Description id={id} className="modal-desc">{children}</Dialog.Description>;
}

function ModalBody({ children }: { children: ReactNode }) {
  return <div className="modal-body">{children}</div>;
}

function ModalFooter({ children }: { children: ReactNode }) {
  return <div className="modal-foot">{children}</div>;
}

function ModalClose({ children, asChild }: { children?: ReactNode; asChild?: boolean }) {
  if (asChild) return <Dialog.Close asChild>{children}</Dialog.Close>;
  return (
    <Dialog.Close className="modal-close" aria-label="Close">
      {children ?? '×'}
    </Dialog.Close>
  );
}

Modal.Header = ModalHeader;
Modal.Title = ModalTitle;
Modal.Description = ModalDescription;
Modal.Body = ModalBody;
Modal.Footer = ModalFooter;
Modal.Close = ModalClose;
