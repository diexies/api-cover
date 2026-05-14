import type { ServiceMapNode } from '../api';

export type MetricKey =
  | 'coupling' | 'fanIn' | 'fanOut' | 'depth'
  | 'externalReach' | 'databaseReach' | 'serviceReach'
  | 'siblingEndpoints' | 'instability';

export function metricValue(n: ServiceMapNode, key: MetricKey): number {
  if (key === 'instability') return n.metrics.instability ?? -1;
  return (n.metrics[key] as number | undefined) ?? 0;
}

export function compareByMetric(a: ServiceMapNode, b: ServiceMapNode, key: MetricKey): number {
  return metricValue(b, key) - metricValue(a, key);
}

export function topByMetric(nodes: readonly ServiceMapNode[], key: MetricKey, take = 10): ServiceMapNode[] {
  return [...nodes].sort((a, b) => compareByMetric(a, b, key)).slice(0, take);
}
