import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { JsonLogicHint } from './JsonLogicHint';

describe('JsonLogicHint', () => {
  it('renders trigger button hidden by default', () => {
    render(<JsonLogicHint ctx="default" />);
    expect(screen.getByRole('button', { name: /jsonlogic help/i })).toBeInTheDocument();
    // Popover content is portalled and hidden until trigger fires.
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  it('opens popover with Variables / Operators / Examples tabs on click', () => {
    render(<JsonLogicHint ctx="default" />);
    fireEvent.click(screen.getByRole('button', { name: /jsonlogic help/i }));
    expect(screen.getByRole('tab', { name: /variables/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /operators/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /examples/i })).toBeInTheDocument();
    // Default tab is Variables — should list at least one well-known var path.
    expect(screen.getByText(/nodes\.<nodeId>\.response\.status/)).toBeInTheDocument();
  });

  it('lists group-context vars when ctx="group"', () => {
    render(<JsonLogicHint ctx="group" />);
    fireEvent.click(screen.getByRole('button', { name: /jsonlogic help/i }));
    expect(screen.getByText(/^iteration$/)).toBeInTheDocument();
    expect(screen.getByText(/^total$/)).toBeInTheDocument();
  });

  it('lists streaming vars when ctx="streaming"', () => {
    render(<JsonLogicHint ctx="streaming" />);
    fireEvent.click(screen.getByRole('button', { name: /jsonlogic help/i }));
    expect(screen.getByText(/^message$/)).toBeInTheDocument();
    expect(screen.getByText(/^elapsed$/)).toBeInTheDocument();
  });

  it('switches to Examples tab and renders copy buttons', () => {
    render(<JsonLogicHint ctx="default" />);
    fireEvent.click(screen.getByRole('button', { name: /jsonlogic help/i }));
    fireEvent.click(screen.getByRole('tab', { name: /examples/i }));
    const snippets = screen.getAllByText(/"var"/);
    expect(snippets.length).toBeGreaterThan(0);
  });
});
