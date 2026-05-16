import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Modal } from './Modal';

describe('Modal', () => {
  it('renders content with dialog role and aria-modal', () => {
    render(
      <Modal open onOpenChange={() => {}} labelledBy="t">
        <Modal.Header>
          <Modal.Title id="t">Hello</Modal.Title>
          <Modal.Close />
        </Modal.Header>
        <Modal.Body>body</Modal.Body>
      </Modal>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby', 't');
    expect(screen.getByText('Hello')).toBeInTheDocument();
    expect(screen.getByText('body')).toBeInTheDocument();
  });

  it('fires onOpenChange(false) when ESC pressed', () => {
    const onOpenChange = vi.fn();
    render(
      <Modal open onOpenChange={onOpenChange}>
        <Modal.Body>body</Modal.Body>
      </Modal>,
    );
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('fires onOpenChange(false) when default close button clicked', () => {
    const onOpenChange = vi.fn();
    render(
      <Modal open onOpenChange={onOpenChange}>
        <Modal.Header>
          <Modal.Title>title</Modal.Title>
          <Modal.Close />
        </Modal.Header>
        <Modal.Body>body</Modal.Body>
      </Modal>,
    );
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('renders nothing in DOM when open=false', () => {
    render(
      <Modal open={false} onOpenChange={() => {}}>
        <Modal.Body>hidden</Modal.Body>
      </Modal>,
    );
    expect(screen.queryByText('hidden')).not.toBeInTheDocument();
  });
});
