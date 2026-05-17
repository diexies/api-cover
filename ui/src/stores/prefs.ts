import { create } from 'zustand';
import { persist, type PersistStorage, type StorageValue } from 'zustand/middleware';
import type { AuthConfig } from '../auth';

export type ThemeChoice = 'light' | 'dark' | 'system';
export type Locale = 'en' | 'tr';
export type SourceDrawerView = 'source' | 'diagram' | 'callers';
export type ServiceMapMode = string;
export type ServiceMapDirection = string;
export type SettingsTab = 'auth' | 'agent' | 'settings';

export interface PrefsState {
  lastScenarioId: string | null;
  settingsTab: SettingsTab;
  chatDraft: string;
  idleDiscover: { dismissed: boolean; inflightAt: number | null };
  agent: { model: string | null };
  /** Collapsed/expanded section state for the scenario list sidebar. */
  scenarioListSections: Record<string, boolean>;
  auth: AuthConfig;
  sourceDrawerView: SourceDrawerView;
  serviceMap: {
    mode: ServiceMapMode | null;
    drillDirection: ServiceMapDirection | null;
    sideRail: Record<string, boolean>;
    recent: string[];
  };
  locale: Locale;
  theme: ThemeChoice;
  /** Width-by-key map for every column that uses useResizableWidth. */
  widths: Record<string, number>;
  /** Toggle for the run history drawer on the scenario canvas (right-side overlay). */
  runHistoryOpen: boolean;
  /** Last tab the user had open in the NodeInspector — restored when re-opening any node. */
  inspectorTab: string;
}

export interface PrefsActions {
  set<K extends keyof PrefsState>(key: K, value: PrefsState[K]): void;
  setWidth(key: string, value: number): void;
  setScenarioListSection(key: string, expanded: boolean): void;
  setServiceMap<K extends keyof PrefsState['serviceMap']>(key: K, value: PrefsState['serviceMap'][K]): void;
  setIdleDiscover<K extends keyof PrefsState['idleDiscover']>(key: K, value: PrefsState['idleDiscover'][K]): void;
}

export type PrefsStore = PrefsState & PrefsActions;

function detectInitialLocale(): Locale {
  if (typeof window === 'undefined') return 'en';
  const nav = window.navigator?.language?.toLowerCase() ?? '';
  if (nav.startsWith('tr')) return 'tr';
  return 'en';
}

const defaultState: PrefsState = {
  lastScenarioId: null,
  settingsTab: 'auth',
  chatDraft: '',
  idleDiscover: { dismissed: false, inflightAt: null },
  agent: { model: null },
  scenarioListSections: {},
  auth: { type: 'none' },
  sourceDrawerView: 'source',
  serviceMap: { mode: null, drillDirection: null, sideRail: {}, recent: [] },
  locale: detectInitialLocale(),
  theme: 'system',
  widths: {},
  runHistoryOpen: false,
  inspectorTab: 'overview',
};

const STORAGE_KEY = 'apicover.prefs.v1';

interface LegacyKey {
  key: string;
  apply: (state: PrefsState, raw: string) => void;
}

/**
 * One-shot legacy-key migration. Reads every old localStorage key, seeds the new store,
 * and clears the legacy entries so they don't drift. Safe to re-run — only acts when the
 * v1 blob is missing.
 */
const LEGACY_KEYS: LegacyKey[] = [
  { key: 'apicover.lastScenarioId', apply: (s, v) => { if (v) s.lastScenarioId = v; } },
  { key: 'apicover.settingsTab', apply: (s, v) => {
    if (v === 'auth' || v === 'agent' || v === 'settings') s.settingsTab = v;
  } },
  { key: 'apicover.chatDraft', apply: (s, v) => { s.chatDraft = v; } },
  { key: 'apicover.idleDiscoverDismissed.v2', apply: (s, v) => { s.idleDiscover.dismissed = v === '1'; } },
  { key: 'apicover.idleDiscoverInflight', apply: (s, v) => {
    const n = Number(v);
    if (Number.isFinite(n)) s.idleDiscover.inflightAt = n;
  } },
  { key: 'apicover.agent.model', apply: (s, v) => { s.agent.model = v || null; } },
  { key: 'apicover.model', apply: (s, v) => { s.agent.model = v || null; } },
  { key: 'utopia.inspector.sidebar.sections', apply: (s, v) => {
    try {
      const parsed = JSON.parse(v);
      if (parsed && typeof parsed === 'object') {
        const map: Record<string, boolean> = {};
        for (const [k, val] of Object.entries(parsed)) map[k] = !!val;
        s.scenarioListSections = map;
      }
    } catch { /* malformed, drop */ }
  } },
  { key: 'utopia.inspector.auth', apply: (s, v) => {
    try {
      const parsed = JSON.parse(v) as AuthConfig;
      if (parsed && parsed.type) s.auth = parsed;
    } catch { /* malformed, drop */ }
  } },
  { key: 'apicover.sourceDrawerView', apply: (s, v) => {
    if (v === 'source' || v === 'diagram' || v === 'callers') s.sourceDrawerView = v;
  } },
  { key: 'apicover.sourceDrawer.view', apply: (s, v) => {
    if (v === 'source' || v === 'diagram' || v === 'callers') s.sourceDrawerView = v;
  } },
  { key: 'apicover.servicemap.mode', apply: (s, v) => { s.serviceMap.mode = v; } },
  { key: 'apicover.servicemap.direction', apply: (s, v) => { s.serviceMap.drillDirection = v; } },
  { key: 'apicover.side.sections', apply: (s, v) => {
    try {
      const parsed = JSON.parse(v);
      if (parsed && typeof parsed === 'object') {
        const map: Record<string, boolean> = {};
        for (const [k, val] of Object.entries(parsed)) map[k] = !!val;
        s.serviceMap.sideRail = map;
      }
    } catch { /* malformed, drop */ }
  } },
  // NOTE: 'apicover.recent.endpoints' is intentionally NOT migrated. ServiceMapPanel
  // listens to the `storage` event to react when another tab updates the list — moving it
  // into the zustand blob would break that cross-tab channel.
  // 'apicover.language' was the legacy key — current locale lives at 'apicover.locale'.
  { key: 'apicover.locale', apply: (s, v) => { if (v === 'en' || v === 'tr') s.locale = v; } },
  { key: 'apicover.language', apply: (s, v) => { if (v === 'en' || v === 'tr') s.locale = v; } },
  { key: 'apicover.theme', apply: (s, v) => {
    if (v === 'light' || v === 'dark' || v === 'system') s.theme = v;
  } },
];

const WIDTH_KEYS = ['utopia.sidebar.width'];

function readStorage(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function removeStorage(key: string): void {
  try { window.localStorage.removeItem(key); } catch { /* ignore */ }
}

function migrateLegacy(): PrefsState | null {
  if (typeof window === 'undefined') return null;
  // Skip if already migrated.
  if (readStorage(STORAGE_KEY)) return null;
  const seed: PrefsState = JSON.parse(JSON.stringify(defaultState));
  let touched = false;
  for (const { key, apply } of LEGACY_KEYS) {
    const raw = readStorage(key);
    if (raw == null) continue;
    apply(seed, raw);
    removeStorage(key);
    touched = true;
  }
  for (const key of WIDTH_KEYS) {
    const raw = readStorage(key);
    if (raw == null) continue;
    const n = parseInt(raw, 10);
    if (Number.isFinite(n)) {
      seed.widths[key] = n;
      touched = true;
    }
    removeStorage(key);
  }
  return touched ? seed : null;
}

const safeStorage: PersistStorage<PrefsState> = {
  getItem(name) {
    try {
      const raw = window.localStorage.getItem(name);
      if (!raw) return null;
      return JSON.parse(raw) as StorageValue<PrefsState>;
    } catch { return null; }
  },
  setItem(name, value) {
    try { window.localStorage.setItem(name, JSON.stringify(value)); } catch { /* quota */ }
  },
  removeItem(name) {
    try { window.localStorage.removeItem(name); } catch { /* ignore */ }
  },
};

// Run migration before store creation so seed lands in initial state.
const seeded = migrateLegacy();

export const usePrefs = create<PrefsStore>()(
  persist(
    (set) => ({
      ...defaultState,
      ...(seeded ?? {}),
      set: (key, value) => set({ [key]: value } as Partial<PrefsState>),
      setWidth: (key, value) => set((s) => ({ widths: { ...s.widths, [key]: value } })),
      setScenarioListSection: (key, expanded) => set((s) => ({
        scenarioListSections: { ...s.scenarioListSections, [key]: expanded },
      })),
      setServiceMap: (key, value) => set((s) => ({ serviceMap: { ...s.serviceMap, [key]: value } })),
      setIdleDiscover: (key, value) => set((s) => ({ idleDiscover: { ...s.idleDiscover, [key]: value } })),
    }),
    {
      name: STORAGE_KEY,
      storage: safeStorage,
      version: 1,
      partialize: (state) => {
        // Exclude action functions from persisted blob.
        const { set: _set, setWidth: _w, setScenarioListSection: _ss, setServiceMap: _sm, setIdleDiscover: _id, ...rest } = state;
        return rest;
      },
    },
  ),
);

/** Test-only: reset the entire store to defaults and clear persisted blob. */
export function __resetPrefsForTests(): void {
  usePrefs.setState({ ...defaultState }, false);
  try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

/** Test-only: re-run legacy migration (call after seeding localStorage). */
export function __migrateLegacyForTests(): PrefsState | null {
  return migrateLegacy();
}
