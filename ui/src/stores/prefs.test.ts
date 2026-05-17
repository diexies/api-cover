import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { usePrefs, __resetPrefsForTests, __migrateLegacyForTests } from './prefs';

const STORAGE_KEY = 'apicover.prefs.v1';

function seedLegacy(entries: Record<string, string>): void {
  for (const [k, v] of Object.entries(entries)) window.localStorage.setItem(k, v);
}

describe('prefs store', () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetPrefsForTests();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('returns defaults when nothing persisted', () => {
    const s = usePrefs.getState();
    expect(s.lastScenarioId).toBeNull();
    expect(s.theme).toBe('system');
    expect(s.auth.type).toBe('none');
  });

  it('round-trips set/get via localStorage', () => {
    usePrefs.getState().set('lastScenarioId', 'flow-42');
    usePrefs.getState().set('theme', 'dark');
    const blob = window.localStorage.getItem(STORAGE_KEY);
    expect(blob).toBeTruthy();
    const parsed = JSON.parse(blob!).state;
    expect(parsed.lastScenarioId).toBe('flow-42');
    expect(parsed.theme).toBe('dark');
  });

  it('persists widths via setWidth and exposes them by key', () => {
    usePrefs.getState().setWidth('utopia.sidebar.width', 420);
    expect(usePrefs.getState().widths['utopia.sidebar.width']).toBe(420);
  });

  it('migrates legacy localStorage keys and clears them', () => {
    seedLegacy({
      'apicover.lastScenarioId': 'legacy-flow',
      'apicover.theme': 'dark',
      'apicover.locale': 'tr',
      'utopia.inspector.auth': JSON.stringify({ type: 'bearer', bearer: { token: 't0k' } }),
      'utopia.sidebar.width': '420',
      'apicover.idleDiscoverDismissed.v2': '1',
      'apicover.servicemap.mode': 'force',
      'apicover.servicemap.direction': 'reverse',
      'utopia.inspector.sidebar.sections': JSON.stringify({ complex: false, oneDir: true }),
    });
    const seed = __migrateLegacyForTests();
    expect(seed).not.toBeNull();
    expect(seed!.lastScenarioId).toBe('legacy-flow');
    expect(seed!.theme).toBe('dark');
    expect(seed!.locale).toBe('tr');
    expect(seed!.auth.type).toBe('bearer');
    expect(seed!.auth.bearer?.token).toBe('t0k');
    expect(seed!.widths['utopia.sidebar.width']).toBe(420);
    expect(seed!.idleDiscover.dismissed).toBe(true);
    expect(seed!.serviceMap.mode).toBe('force');
    expect(seed!.serviceMap.drillDirection).toBe('reverse');
    expect(seed!.scenarioListSections.complex).toBe(false);
    expect(seed!.scenarioListSections.oneDir).toBe(true);
    // Legacy keys must be cleared after migration.
    expect(window.localStorage.getItem('apicover.lastScenarioId')).toBeNull();
    expect(window.localStorage.getItem('apicover.theme')).toBeNull();
    expect(window.localStorage.getItem('utopia.inspector.auth')).toBeNull();
    expect(window.localStorage.getItem('utopia.sidebar.width')).toBeNull();
  });

  it('skips migration when v1 blob already exists', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ state: {}, version: 1 }));
    seedLegacy({ 'apicover.lastScenarioId': 'should-be-ignored' });
    expect(__migrateLegacyForTests()).toBeNull();
    // Legacy key still present because migration didn't run.
    expect(window.localStorage.getItem('apicover.lastScenarioId')).toBe('should-be-ignored');
  });

  it('shapes serviceMap.sideRail as a record after migration', () => {
    seedLegacy({
      'apicover.side.sections': JSON.stringify({ filters: true, recent: false }),
    });
    const seed = __migrateLegacyForTests();
    expect(seed!.serviceMap.sideRail.filters).toBe(true);
    expect(seed!.serviceMap.sideRail.recent).toBe(false);
  });
});
