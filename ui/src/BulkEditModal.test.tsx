import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { BulkEditModal } from './BulkEditModal';
import type { ApiNode } from './api';

const NODES: ApiNode[] = [
  { id: 'a', method: 'GET', path: '/a' },
  { id: 'b', method: 'POST', path: '/b' },
];

describe('BulkEditModal', () => {
  it('renders selected node count in title', () => {
    render(
      <BulkEditModal
        selectedIds={['a', 'b']}
        apiNodes={NODES}
        onApply={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/Bulk edit — 2 nodes/)).toBeInTheDocument();
  });

  it('apply disabled when key empty', () => {
    render(
      <BulkEditModal
        selectedIds={['a']}
        apiNodes={NODES}
        onApply={() => {}}
        onClose={() => {}}
      />,
    );
    const btn = screen.getByRole('button', { name: /apply to 1 nodes/i });
    expect(btn).toBeDisabled();
  });

  it('emits patches for every selected node on apply', () => {
    const onApply = vi.fn();
    const onClose = vi.fn();
    render(
      <BulkEditModal
        selectedIds={['a', 'b']}
        apiNodes={NODES}
        onApply={onApply}
        onClose={onClose}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText(/Authorization/), { target: { value: 'X-Trace' } });
    fireEvent.change(screen.getByPlaceholderText(/Bearer abc123/), { target: { value: 'xyz' } });
    fireEvent.click(screen.getByRole('button', { name: /apply to 2 nodes/i }));
    expect(onApply).toHaveBeenCalledOnce();
    const patches = onApply.mock.calls[0][0] as Array<{ nodeId: string; field: string; key: string; value: unknown }>;
    expect(patches).toHaveLength(2);
    expect(patches[0]).toMatchObject({ nodeId: 'a', field: 'header', key: 'X-Trace', value: 'xyz' });
    expect(patches[1]).toMatchObject({ nodeId: 'b', field: 'header', key: 'X-Trace', value: 'xyz' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('parses JSON value when valid', () => {
    const onApply = vi.fn();
    render(
      <BulkEditModal
        selectedIds={['a']}
        apiNodes={NODES}
        onApply={onApply}
        onClose={() => {}}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText(/Authorization/), { target: { value: 'limit' } });
    fireEvent.change(screen.getByPlaceholderText(/Bearer abc123/), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: /apply to 1 nodes/i }));
    const patches = onApply.mock.calls[0][0] as Array<{ value: unknown }>;
    expect(patches[0].value).toBe(50);
  });

  it('preserves raw string when value is not valid JSON', () => {
    const onApply = vi.fn();
    render(
      <BulkEditModal
        selectedIds={['a']}
        apiNodes={NODES}
        onApply={onApply}
        onClose={() => {}}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText(/Authorization/), { target: { value: 'X' } });
    fireEvent.change(screen.getByPlaceholderText(/Bearer abc123/), { target: { value: 'Bearer abc' } });
    fireEvent.click(screen.getByRole('button', { name: /apply to 1 nodes/i }));
    const patches = onApply.mock.calls[0][0] as Array<{ value: unknown }>;
    expect(patches[0].value).toBe('Bearer abc');
  });
});
