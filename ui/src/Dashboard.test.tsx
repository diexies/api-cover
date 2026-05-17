import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { Dashboard } from './Dashboard';
import type { EndpointDescriptor, Run, Scenario } from './api';

vi.mock('./api', async (orig) => {
  const real = await orig<typeof import('./api')>();
  return {
    ...real,
    getServiceMap: vi.fn().mockResolvedValue(null),
    getGitLog: vi.fn().mockResolvedValue({ commits: [], lastScenarioUpdate: null }),
  };
});

function ep(id: string, method: string, path: string, extra: Partial<EndpointDescriptor> = {}): EndpointDescriptor {
  return { id, method, path, ...extra };
}

function scn(id: string, name: string, nodes: { method: string; path: string }[], extra: Partial<Scenario> = {}): Scenario {
  return {
    id,
    name,
    nodes: nodes.map((n, i) => ({ id: `${id}-n${i}`, method: n.method, path: n.path })),
    edges: [],
    ...extra,
  };
}

function run(id: string, scenarioId: string, status: Run['status'], startedAt: string, completedAt?: string): Run {
  return { id, scenarioId, status, nodeResults: [], startedAt, completedAt };
}

const ENDPOINTS: EndpointDescriptor[] = [
  ep('e1', 'GET', '/users'),
  ep('e2', 'GET', '/users/{id}'),
  ep('e3', 'POST', '/users'),
  ep('e4', 'POST', '/billing/invoices'),
  ep('e5', 'PUT', '/users/{id}'),
  ep('e6', 'DELETE', '/users/{id}', { isDeprecated: true }),
  ep('e7', 'GET', '/legacy/ping', { isDeprecated: true }),
  ep('e8', 'GET', '/health'),
  ep('e9', 'PATCH', '/users/{id}', { area: 'users' }),
  ep('e10', 'GET', '/billing/invoices/{id}', { area: 'billing' }),
];

const SCENARIOS: Scenario[] = [
  scn('s1', 'happy-path', [{ method: 'GET', path: '/users' }, { method: 'POST', path: '/users' }], { tags: ['core', 'smoke'], description: 'baseline' }),
  scn('s2', 'billing-flow', [{ method: 'POST', path: '/billing/invoices' }]),
  scn('s3', 'unused', [{ method: 'GET', path: '/missing' }]),
];

const NOW = Date.parse('2026-05-16T12:00:00Z');
const RUNS: Run[] = [
  run('r1', 's1', 'succeeded', new Date(NOW - 1_000_000).toISOString(), new Date(NOW - 990_000).toISOString()),
  run('r2', 's1', 'succeeded', new Date(NOW - 5_000_000).toISOString(), new Date(NOW - 4_950_000).toISOString()),
  run('r3', 's1', 'failed',    new Date(NOW - 10_000_000).toISOString(), new Date(NOW - 9_900_000).toISOString()),
  run('r4', 's2', 'failed',    new Date(NOW - 60_000_000).toISOString(), new Date(NOW - 59_900_000).toISOString()),
  run('r5', 's2', 'succeeded', new Date(NOW - 2_000_000).toISOString(), new Date(NOW - 1_950_000).toISOString()),
];

function renderStats() {
  return render(
    <Dashboard
      scenarios={SCENARIOS}
      endpoints={ENDPOINTS}
      runs={RUNS}
      onOpenGlobalSettings={() => {}}
      agentEnabled={false}
      agentStatus={null}
      auth={{ type: 'none' }}
      onSendPrompt={() => {}}
      section="stats"
      onSectionChange={() => {}}
    />,
  );
}

describe('StatsSection v2', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });

  it('renders KPI grid with 12 tiles including correct counts', () => {
    renderStats();
    expect(screen.getByRole('heading', { name: 'Headline' })).toBeInTheDocument();
    // APIs and Scenarios totals
    const headlineBlock = screen.getByRole('heading', { name: 'Headline' }).closest('section')!;
    expect(within(headlineBlock).getByText('APIs').parentElement).toHaveTextContent('10');
    expect(within(headlineBlock).getByText('Scenarios').parentElement).toHaveTextContent('3');
    expect(within(headlineBlock).getByText('Runs total').parentElement).toHaveTextContent('5');
    // Succeeded = 3, Failed = 2 from fixture
    expect(within(headlineBlock).getByText('Succeeded').parentElement).toHaveTextContent('3');
    expect(within(headlineBlock).getByText('Failed').parentElement).toHaveTextContent('2');
    // Deprecated = 2
    expect(within(headlineBlock).getByText('Deprecated').parentElement).toHaveTextContent('2');
  });

  it('renders HTTP method breakdown with correct per-verb counts', () => {
    renderStats();
    const block = screen.getByRole('heading', { name: 'HTTP methods' }).closest('section')!;
    expect(within(block).getByText('GET')).toBeInTheDocument();
    expect(within(block).getByText('POST')).toBeInTheDocument();
    expect(within(block).getByText('PUT')).toBeInTheDocument();
    expect(within(block).getByText('PATCH')).toBeInTheDocument();
    expect(within(block).getByText('DELETE')).toBeInTheDocument();
    // GET fixture count = 5 (e1, e2, e7, e8, e10)
    const getTile = within(block).getByText('GET').closest('.method-tile')!;
    expect(getTile).toHaveTextContent('5');
  });

  it('renders deprecated list with two entries', () => {
    renderStats();
    const block = screen.getByRole('heading', { name: 'Deprecated' }).closest('section')!;
    expect(within(block).getByText('/users/{id}')).toBeInTheDocument();
    expect(within(block).getByText('/legacy/ping')).toBeInTheDocument();
  });

  it('renders templates sorted by last-run desc — happy-path leads', () => {
    renderStats();
    const block = screen.getByRole('heading', { name: 'Scenario templates' }).closest('section')!;
    const cards = within(block).getAllByRole('article');
    expect(cards.length).toBe(3);
    expect(cards[0]).toHaveTextContent('happy-path');
    // s2 (billing-flow) last run is more recent than s3 (no runs)
    expect(cards[1]).toHaveTextContent('billing-flow');
    expect(cards[2]).toHaveTextContent('unused');
  });

  it('shows activity timeline with status pills for succeeded and failed runs', () => {
    renderStats();
    const block = screen.getByRole('heading', { name: 'Recent run activity' }).closest('section')!;
    const succeededPills = within(block).getAllByText('succeeded');
    const failedPills = within(block).getAllByText('failed');
    expect(succeededPills.length).toBeGreaterThanOrEqual(1);
    expect(failedPills.length).toBeGreaterThanOrEqual(1);
  });

  it('shows granular sub-totals footer', () => {
    renderStats();
    const block = screen.getByRole('heading', { name: 'Granular totals' }).closest('section')!;
    expect(within(block).getByText('endpoints')).toBeInTheDocument();
    expect(within(block).getByText('scenarios')).toBeInTheDocument();
    expect(within(block).getByText('breakpoints')).toBeInTheDocument();
  });

  it('renders area histogram with at least the explicit areas + uncategorised bucket', () => {
    renderStats();
    const block = screen.getByRole('heading', { name: 'Endpoints by area' }).closest('section')!;
    expect(within(block).getByText('users')).toBeInTheDocument();
    expect(within(block).getByText('billing')).toBeInTheDocument();
    expect(within(block).getByText('uncategorised')).toBeInTheDocument();
  });
});
