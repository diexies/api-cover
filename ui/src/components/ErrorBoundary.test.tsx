import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ErrorBoundary } from './ErrorBoundary';

function Boom({ when = true, msg = 'boom' }: { when?: boolean; msg?: string }): JSX.Element {
  if (when) throw new Error(msg);
  return <span>ok</span>;
}

describe('ErrorBoundary', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  it('renders children when no error', () => {
    render(
      <ErrorBoundary name="Region">
        <span>child</span>
      </ErrorBoundary>,
    );
    expect(screen.getByText('child')).toBeInTheDocument();
  });

  it('renders fallback when child throws and isolates the crash', () => {
    render(
      <ErrorBoundary name="Region">
        <Boom msg="kaboom" />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Region crashed')).toBeInTheDocument();
    expect(screen.getByText(/kaboom/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reload component/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copy error/i })).toBeInTheDocument();
  });

  it('copies an error payload to clipboard', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: write } });
    render(
      <ErrorBoundary name="Canvas">
        <Boom msg="payload-x" />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: /copy error/i }));
    await Promise.resolve();
    expect(write).toHaveBeenCalledOnce();
    const arg = write.mock.calls[0][0] as string;
    expect(arg).toContain('Component: Canvas');
    expect(arg).toContain('payload-x');
    expect(arg).toContain('Stack:');
  });
});
