// Provider discovery state shared by the Settings sidebar's AI Providers
// children and the AI Providers page (hub + per-provider screens).
//
// Why lifted out of `AIProvidersPage`: the sidebar dots and the page are
// two views of the same answer. With each owning its own copy, a Refresh
// on the page would move the page's badges and leave the sidebar stale —
// and a runtime `acp:models` failure would show "Unavailable" on the page
// under a green sidebar dot. One owner, one answer.
//
// Nothing here reads until `request()` is called. The sidebar calls it
// only once the AI Providers group is expanded; the page calls it on
// mount. So opening Settings on General does no discovery at all, which
// is the same footprint as before this state was lifted. Even when it
// does read, a `force: false` read is served from the settings store's
// cached discovery publications (see AGENTS.md "Installed-agent discovery
// is store-owned"); only the page's explicit Refresh passes `force: true`.
//
// `acp:models` probes are NOT issued from here. They spawn the agent, so
// they stay on the page (in-use agents only); the provider just holds the
// results so the sidebar can reflect a failure the page already found.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode
} from "react";
import type {
  AcpAgentDiscovery,
  AcpAgentModelOption,
  DesktopCodexDiscoverySnapshot
} from "@pwrsnap/shared";
import { dispatch } from "../../lib/pwrsnap";
import { describeAiProviders, type AiProviderStatus } from "./ai-provider-status";
import { useSettingsContext } from "./SettingsContext";

export type AiProvidersValue = {
  /** Start the first (cache-served) discovery reads. Idempotent. */
  request: () => void;
  codexSnapshot: DesktopCodexDiscoverySnapshot | null;
  codexSnapshotLoading: boolean;
  refreshCodexSnapshot: (force: boolean) => Promise<DesktopCodexDiscoverySnapshot | null>;
  acpDiscovery: AcpAgentDiscovery | null;
  acpDiscoveryLoading: boolean;
  acpDiscoveryError: string | null;
  refreshAcpDiscovery: (force?: boolean) => Promise<void>;
  acpModels: Readonly<Record<string, readonly AcpAgentModelOption[]>>;
  acpModelErrors: Readonly<Record<string, string | undefined>>;
  acpModelsLoadingIds: readonly string[];
  fetchAcpModels: (agentId: string, refresh?: boolean) => Promise<void>;
  /** Every provider's status, in sidebar order. */
  statuses: readonly AiProviderStatus[];
};

const AiProvidersContext = createContext<AiProvidersValue | null>(null);

export function AiProvidersProvider({ children }: { children: ReactNode }): ReactElement {
  const { settings, secrets, refreshCodex } = useSettingsContext();

  const [codexSnapshot, setCodexSnapshot] = useState<DesktopCodexDiscoverySnapshot | null>(null);
  const [codexSnapshotLoading, setCodexSnapshotLoading] = useState<boolean>(true);
  const [acpDiscovery, setAcpDiscovery] = useState<AcpAgentDiscovery | null>(null);
  const [acpDiscoveryLoading, setAcpDiscoveryLoading] = useState<boolean>(true);
  const [acpDiscoveryError, setAcpDiscoveryError] = useState<string | null>(null);
  const [acpModels, setAcpModels] = useState<Record<string, readonly AcpAgentModelOption[]>>({});
  const [acpModelErrors, setAcpModelErrors] = useState<Record<string, string | undefined>>({});
  const [acpModelsLoadingIds, setAcpModelsLoadingIds] = useState<readonly string[]>([]);

  // Last-issued-wins. Two reads overlap routinely (Pin writes settings, which
  // triggers the dependency re-read below, then asks for a forced one), and
  // `refreshCodex` answers a superseded call with `null` — applying that
  // would blank the snapshot, or worse, land after the newer answer.
  const codexSeq = useRef<number>(0);
  const refreshCodexSnapshot = useCallback(
    async (force: boolean): Promise<DesktopCodexDiscoverySnapshot | null> => {
      const seq = ++codexSeq.current;
      setCodexSnapshotLoading(true);
      const snap = await refreshCodex(force);
      if (seq !== codexSeq.current) return snap;
      setCodexSnapshot(snap);
      setCodexSnapshotLoading(false);
      return snap;
    },
    [refreshCodex]
  );

  const acpSeq = useRef<number>(0);
  const refreshAcpDiscovery = useCallback(async (force = false): Promise<void> => {
    const seq = ++acpSeq.current;
    setAcpDiscoveryLoading(true);
    const result = await dispatch("acp:discover", { force });
    if (seq !== acpSeq.current) return;
    if (result.ok) {
      setAcpDiscovery(result.value);
      setAcpDiscoveryError(null);
    } else {
      setAcpDiscoveryError(result.error.message);
    }
    setAcpDiscoveryLoading(false);
  }, []);

  // Per agent, last-issued-wins like the reads above: the page's first-pass
  // probe and a Refresh overlap routinely. An older probe settling last must
  // not overwrite the newer answer, nor clear the loading flag the newer
  // probe still holds.
  const acpModelsSeq = useRef<Record<string, number>>({});
  const fetchAcpModels = useCallback(async (agentId: string, refresh = false): Promise<void> => {
    const seq = (acpModelsSeq.current[agentId] ?? 0) + 1;
    acpModelsSeq.current[agentId] = seq;
    setAcpModelsLoadingIds((ids) => (ids.includes(agentId) ? ids : [...ids, agentId]));
    const result = await dispatch("acp:models", { agentId, refresh });
    if (acpModelsSeq.current[agentId] !== seq) return;
    setAcpModelErrors((prev) => ({ ...prev, [agentId]: result.ok ? undefined : result.error.message }));
    setAcpModels((prev) => {
      if (result.ok) return { ...prev, [agentId]: result.value.models };
      // A FAILED probe must not blank a list we already have (e.g. a Refresh
      // that errored shouldn't wipe the cached models). Only fall back to `[]`
      // on the INITIAL load — so the picker resolves to "Default" instead of
      // sticking on "Loading…" — never on a refresh of an existing list.
      return agentId in prev ? prev : { ...prev, [agentId]: [] };
    });
    setAcpModelsLoadingIds((ids) => ids.filter((id) => id !== agentId));
  }, []);

  // A ref, not state: StrictMode's double-invoked effects and the sidebar +
  // page both calling `request()` in the same commit must still produce
  // exactly one pair of reads.
  const requestedRef = useRef<boolean>(false);
  const request = useCallback((): void => {
    if (requestedRef.current) return;
    requestedRef.current = true;
    void refreshCodexSnapshot(false);
    void refreshAcpDiscovery(false);
  }, [refreshCodexSnapshot, refreshAcpDiscovery]);

  // Re-read when a setting that discovery depends on changes — Codex mode /
  // pinned path / profile, or an agent's enablement / picked install /
  // override. The page used to get this for free by re-reading on every
  // mount; state that outlives the page has to ask. Still `force: false`:
  // the settings store invalidates exactly the publication whose inputs
  // moved, so this re-runs discovery for what changed and serves everything
  // else from cache.
  //
  // Enablement IS a discovery input: the store's ACP fingerprint includes
  // it, and an agent's `overridePath` is only applied while it is enabled.
  // An agent installed only at its override reads "missing" until enabled,
  // and must re-read the moment it is.
  const codexDepsKey =
    settings === null
      ? null
      : JSON.stringify([settings.codex.mode, settings.codex.pinnedPath, settings.codex.profile]);
  const acpDepsKey =
    settings === null
      ? null
      : JSON.stringify([
          [...settings.ai.acp.enabledAgentIds].sort(),
          settings.ai.acp.agents ?? {}
        ]);
  const seenDepsRef = useRef<{ codex: string | null; acp: string | null }>({
    codex: null,
    acp: null
  });
  useEffect(() => {
    const seen = seenDepsRef.current;
    if (requestedRef.current) {
      if (seen.codex !== null && codexDepsKey !== null && seen.codex !== codexDepsKey) {
        void refreshCodexSnapshot(false);
      }
      if (seen.acp !== null && acpDepsKey !== null && seen.acp !== acpDepsKey) {
        void refreshAcpDiscovery(false);
      }
    }
    seenDepsRef.current = { codex: codexDepsKey, acp: acpDepsKey };
  }, [codexDepsKey, acpDepsKey, refreshCodexSnapshot, refreshAcpDiscovery]);

  const enabledAgentIds = settings?.ai.acp.enabledAgentIds;
  const openaiKey = secrets?.openaiApiKey ?? null;
  const statuses = useMemo(
    () =>
      describeAiProviders({
        codex: codexSnapshot,
        codexLoading: codexSnapshotLoading,
        acpDiscovery,
        acpDiscoveryLoading,
        enabledAgentIds: enabledAgentIds ?? [],
        acpModelErrors,
        openaiKey
      }),
    [
      codexSnapshot,
      codexSnapshotLoading,
      acpDiscovery,
      acpDiscoveryLoading,
      enabledAgentIds,
      acpModelErrors,
      openaiKey
    ]
  );

  const value = useMemo<AiProvidersValue>(
    () => ({
      request,
      codexSnapshot,
      codexSnapshotLoading,
      refreshCodexSnapshot,
      acpDiscovery,
      acpDiscoveryLoading,
      acpDiscoveryError,
      refreshAcpDiscovery,
      acpModels,
      acpModelErrors,
      acpModelsLoadingIds,
      fetchAcpModels,
      statuses
    }),
    [
      request,
      codexSnapshot,
      codexSnapshotLoading,
      refreshCodexSnapshot,
      acpDiscovery,
      acpDiscoveryLoading,
      acpDiscoveryError,
      refreshAcpDiscovery,
      acpModels,
      acpModelErrors,
      acpModelsLoadingIds,
      fetchAcpModels,
      statuses
    ]
  );

  return <AiProvidersContext.Provider value={value}>{children}</AiProvidersContext.Provider>;
}

/** Throws outside `<AiProvidersProvider>` for the same reason
 *  `useSettingsContext` does: a silent "never loaded" default would render
 *  a sidebar of unknown dots forever instead of failing loudly. */
export function useAiProvidersContext(): AiProvidersValue {
  const value = useContext(AiProvidersContext);
  if (value === null) {
    throw new Error("useAiProvidersContext must be called within <AiProvidersProvider>");
  }
  return value;
}
