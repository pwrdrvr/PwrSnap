import { ConnectionIndex } from "./ConnectionIndex";
import { ConnectionPage } from "./ConnectionPage";
// The "Using" pill follows `snapshot.resolvedPath`, NOT
// `settings.codex.mode` — same logic stdio-transport uses to spawn
// Codex, so the renderer doesn't lie about which binary actually runs.

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import type {
  AcpAgentDiscovery,
  AcpAgentDiscoveryEntry,
  AcpAgentPreference,
  AiSurfaceId,
  CodexTestResult,
  DesktopCodexAuthProfile,
  DesktopCodexAuthProfileList,
  DesktopCodexDiscoveryCandidate,
  DesktopCodexDiscoverySnapshot,
  Settings,
  SettingsPatch
} from "@pwrsnap/shared";
import {
  connectionIdOfSettingsSub,
  executablePathExample,
  NEW_CONNECTION_SETTINGS_SUB,
  normalizeManualExecutablePath
} from "@pwrsnap/shared";
import { dispatch } from "../../../lib/pwrsnap";
import {
  Card,
  OptionRow,
  Row,
  SegmentedControl,
  type SegmentOption
} from "../components";
import { useAiProvidersContext, useInUseAcpModelProbes } from "../AiProvidersContext";
import {
  AI_SURFACE_LABELS,
  routedSurfaces,
  statusBadgeClass,
  type AiProviderStatus,
  type AiProviderSub
} from "../ai-provider-status";
import { useSettingsContext } from "../SettingsContext";
import { setActivePage } from "../useActivePage";
import { formatLastSetAt } from "./ai-format";

const CODEX_MODE_OPTIONS: readonly SegmentOption<"auto" | "pinned">[] = [
  { id: "auto", label: "Auto Discovery — Use Newest" },
  { id: "pinned", label: "Specified Path" }
];

export function buildAcpOverridePatch(
  currentEnabledAgentIds: readonly string[],
  id: string,
  path: string,
  enable: boolean
): SettingsPatch {
  const enabledAgentIds =
    enable && !currentEnabledAgentIds.includes(id)
      ? [...currentEnabledAgentIds, id]
      : [...currentEnabledAgentIds];
  return {
    ai: {
      acp: {
        ...(enable ? { enabledAgentIds } : {}),
        agents: { [id]: { overridePath: path } }
      }
    }
  };
}

type AIProvidersPageProps = {
  /** Provider screen to show — `codex`, an ACP agent id, or `openai` —
   *  or `null` for the hub. Validated by the router before it gets here. */
  sub: string | null;
};

export function AIProvidersPage({ sub }: AIProvidersPageProps): ReactElement {
  const {
    settings,
    secrets,
    patch,
    testCodex,
    replaceSecret,
    clearSecret
  } = useSettingsContext();
  // Discovery + ACP model results live in the provider so the sidebar's
  // status dots read the same answer this page renders.
  const {
    request,
    codexSnapshot: snapshot,
    codexSnapshotLoading: snapshotLoading,
    refreshCodexSnapshot,
    acpDiscovery,
    acpDiscoveryLoading,
    acpDiscoveryError,
    refreshAcpDiscovery,
    acpModelErrors,
    fetchAcpModels,
    statuses,
    connections
  } = useAiProvidersContext();
  // The runtime availability / sign-in probe for in-use agents. It runs
  // here as well as on AI Features so a signed-out agent reads
  // "Unavailable" on the page that lists it, not only after a visit there.
  const acpAgentIdsInUse = useInUseAcpModelProbes();
  const [codexTest, setCodexTest] = useState<CodexTestResult | null>(null);
  const [codexTesting, setCodexTesting] = useState<boolean>(false);

  useEffect(() => {
    request();
  }, [request]);

  const enabledAgentIds = settings?.ai.acp.enabledAgentIds ?? [];

  const onRefreshAcp = (): void => {
    // Re-discover installs AND re-probe the in-use agents' model lists, so
    // a stale cache (e.g. one captured before the agent reported its
    // default model) is refreshed along with the install status.
    void refreshAcpDiscovery(true);
    for (const id of acpAgentIdsInUse) void fetchAcpModels(id, true);
  };

  // ---- Direct API connection screens ------------------------------------
  // Keyed by route so moving between connections (or to a new one) starts
  // each page fresh instead of carrying one's draft into another.

  if (sub === NEW_CONNECTION_SETTINGS_SUB) {
    return <ConnectionPage key={sub} connectionId={null} />;
  }
  const connectionId = connectionIdOfSettingsSub(sub);
  if (connectionId !== null) {
    return <ConnectionPage key={sub} connectionId={connectionId} />;
  }

  // ---- Per-provider screens ---------------------------------------------
  // Each sidebar child opens one of these. They share the page's state, so
  // moving between them (or back to the hub) re-fetches nothing.

  const focused = sub !== null ? statuses.find((status) => status.sub === sub) : undefined;
  if (focused !== undefined) {
    const routed = routedSurfaces(settings, focused.sub);
    let body: ReactElement;
    let help: string;
    if (focused.sub === "codex") {
      help =
        "The Codex CLI that PwrSnap drives: which copy of it runs, which account it signs in with, and a test that it starts.";
      body = (
        <CodexCard
          settings={settings}
          snapshot={snapshot}
          snapshotLoading={snapshotLoading}
          codexTest={codexTest}
          codexTesting={codexTesting}
          onRefresh={() => {
            void refreshCodexSnapshot(true);
          }}
          onModeChange={(next) => {
            void patch({ codex: { mode: next } });
          }}
          onPin={async (path) => {
            await patch({ codex: { mode: "pinned", pinnedPath: path } });
            await refreshCodexSnapshot(true);
          }}
          onTest={() => {
            void (async () => {
              setCodexTesting(true);
              try {
                const result = await testCodex();
                if (result !== null) setCodexTest(result);
              } finally {
                setCodexTesting(false);
              }
            })();
          }}
          onSelectProfile={(name) => {
            void patch({ codex: { profile: name } });
          }}
        />
      );
    } else if (focused.sub === "openai") {
      help =
        "Used only for Sizzle Reel voiceover, which turns your script into speech. Every other AI job runs through Codex or an ACP agent.";
      body = (
        <Card eyebrow="PROVIDER" title="OpenAI (Sizzle Reels voiceover)">
          <Row
            label="API Key"
            sub="OpenAI API key. Used by the Sizzle Reels composer for text-to-speech voiceover. Stored in the system keychain via Electron safeStorage."
            tag="keychain"
          >
            <SecretKeyControl
              status={secrets?.openaiApiKey ?? null}
              placeholder="sk-…"
              onReplace={async (value) => {
                await replaceSecret("openaiApiKey", value);
              }}
              onClear={async () => {
                await clearSecret("openaiApiKey");
              }}
            />
          </Row>
        </Card>
      );
    } else {
      const agentId = focused.sub;
      help =
        "An ACP agent CLI. Once it is enabled, you can pick it for any job in AI Features → Default agents.";
      body = (
        <AcpAgentCard
          agentId={agentId}
          title={focused.label}
          discovery={acpDiscovery}
          loading={acpDiscoveryLoading}
          error={acpDiscoveryError}
          onRefresh={onRefreshAcp}
          enabledAgentIds={enabledAgentIds}
          agents={settings?.ai.acp.agents}
          modelErrors={acpModelErrors}
          onToggle={(id, enabled) => {
            const current = settings?.ai.acp.enabledAgentIds ?? [];
            const next = enabled
              ? current.includes(id)
                ? current
                : [...current, id]
              : current.filter((existing) => existing !== id);
            void patch({ ai: { acp: { enabledAgentIds: next } } });
          }}
          onPickInstance={(id, command) => {
            // Pin this instance; clear any override so the pick takes effect
            // (the resolver gives an override precedence over a pick).
            void patch({
              ai: { acp: { agents: { [id]: { selectedPath: command, overridePath: "" } } } }
            });
          }}
          onRevertAuto={(id) => {
            void patch({
              ai: { acp: { agents: { [id]: { selectedPath: "", overridePath: "" } } } }
            });
          }}
          onSetOverride={async (id, path, enable) => {
            const current = settings?.ai.acp.enabledAgentIds ?? [];
            await patch(buildAcpOverridePatch(current, id, path, enable));
            if (enable) await refreshAcpDiscovery();
          }}
          onClearOverride={(id) => {
            void patch({ ai: { acp: { agents: { [id]: { overridePath: "" } } } } });
          }}
        />
      );
    }
    return (
      <>
        <div className="pss__main-hdr">
          <div className="pss__main-hdr-l">
            <div className="pss__main-eyebrow">AI Providers</div>
            <h1 className="pss__main-title">{focused.label}</h1>
            <p className="pss__main-sub">{help}</p>
          </div>
        </div>
        {focused.sub !== "openai" ? (
          <ProviderDefaultsStrip
            routed={routed}
            onEdit={() => {
              setActivePage("ai-features", "default-agents");
            }}
          />
        ) : null}
        {body}
      </>
    );
  }

  // ---- Hub ----------------------------------------------------------------
  // Two ways to run AI, one card each, in sidebar order: the installed
  // agents, then the Direct API connections PwrSnap calls itself.

  const addConnection = (): void => {
    setActivePage("ai", NEW_CONNECTION_SETTINGS_SUB);
  };
  return (
    <>
      <div className="pss__main-hdr">
        <div className="pss__main-hdr-l">
          <div className="pss__main-eyebrow">General</div>
          <h1 className="pss__main-title">AI Providers</h1>
          <p className="pss__main-sub">
            Two ways to run AI. Installed agents are CLIs you already use, signed in to your
            own account. Direct API connections are called by PwrSnap itself, with your key,
            on your provider's bill. Pick which one does each job in{" "}
            <button
              type="button"
              className="pss__text-link"
              onClick={() => {
                setActivePage("ai-features", "default-agents");
              }}
            >
              AI Features
            </button>
            .
          </p>
        </div>
      </div>

      <Card eyebrow="INSTALLED AGENTS" title="Agents">
        <Row
          label="Ready to use?"
          sub="Green is ready. Amber needs attention, usually a sign-in. Red is turned on but can't run. Grey is off or not installed. The same list sits under AI Providers in the sidebar."
        >
          <ProviderIndex
            statuses={statuses}
            onOpen={(next) => {
              setActivePage("ai", next);
            }}
          />
        </Row>
      </Card>
      <Card
        eyebrow="DIRECT API"
        title="Connections"
        headerAction={
          <button className="pss__key-btn is-primary" type="button" onClick={addConnection}>
            + Add connection
          </button>
        }
      >
        <Row
          label="One endpoint, one credential"
          sub="Each connection is a base URL, a protocol and a key or sign-in. Add as many of that endpoint's models as you like; they share the credential. Chat through a connection has no editing tools; captions need a model that accepts images."
        >
          {connections.length > 0 ? (
            <ConnectionIndex
              connections={connections}
              onOpen={(next) => {
                setActivePage("ai", next);
              }}
            />
          ) : (
            <button type="button" className="pss__dapi-empty" onClick={addConnection}>
              + Add connection
            </button>
          )}
        </Row>
      </Card>
    </>
  );
}

type CodexCardProps = {
  settings: Settings | null;
  snapshot: DesktopCodexDiscoverySnapshot | null;
  snapshotLoading: boolean;
  codexTest: CodexTestResult | null;
  codexTesting: boolean;
  onRefresh: () => void;
  onModeChange: (mode: "auto" | "pinned") => void;
  onPin: (path: string) => Promise<void>;
  onTest: () => void;
  onSelectProfile: (name: string) => void;
};

function CodexCard({
  settings,
  snapshot,
  snapshotLoading,
  codexTest,
  codexTesting,
  onRefresh,
  onModeChange,
  onPin,
  onTest,
  onSelectProfile
}: CodexCardProps): ReactElement {
  return (
    <Card
      eyebrow="PROVIDER"
      title="Codex"
      headerAction={
        <button className="pss__top-btn" type="button" onClick={onRefresh}>
          {snapshotLoading ? "Refreshing…" : "Refresh"}
        </button>
      }
    >
      <Row
        label="Codex selection"
        sub="Pick the Codex binary to invoke for captions. Auto Discovery tracks the newest version on disk; Specified Path pins a single binary."
        tag="config"
      >
        <SegmentedControl
          options={CODEX_MODE_OPTIONS}
          value={settings?.codex.mode ?? "auto"}
          onChange={onModeChange}
        />
      </Row>

      <Row
        label="Available paths"
        sub="Detected on this machine. The resolved binary is highlighted; the test below spawns it with --version to confirm it runs."
        tag="config"
      >
        <CodexCandidates snapshot={snapshot} loading={snapshotLoading} onPin={onPin} />
        {snapshot !== null && snapshot.resolvedPath !== null ? (
          <div className="pss__test pss__test--attached">
            <span className="pss__test-icon" aria-hidden="true">
              ›_
            </span>
            <div className="pss__test-l">
              <span className="pss__test-cmd">
                {codexTest?.account ?? "Connection test"}
              </span>
              <span className="pss__test-sub">
                {codexTestSubLine(codexTest, codexTesting)}
              </span>
            </div>
            <div className="pss__test-r">
              <span
                className={
                  "pss__badge" +
                  (codexTest ? ` ${codexTestBadgeClass(codexTest)}` : "")
                }
              >
                {codexTestBadgeLabel(codexTest, codexTesting)}
              </span>
              <button
                className="pss__test-btn"
                type="button"
                disabled={codexTesting}
                onClick={onTest}
              >
                {codexTesting ? "Testing…" : "Test"}
              </button>
            </div>
          </div>
        ) : null}
      </Row>

      <Row
        label="Auth profile"
        sub="Each profile is a separate Codex home (auth, config, sessions, state). Switch accounts, add a profile, or re-login. The selected profile is used for AI features."
        tag="default"
      >
        <CodexProfilesControl
          selectedProfile={settings?.codex.profile ?? ""}
          onSelect={onSelectProfile}
        />
      </Row>
    </Card>
  );
}

// ---- Provider hub index + per-provider routing strip --------------------

/** One row per provider, same order and same status as the sidebar
 *  children — both render `statuses` from `AiProvidersContext`. */
export function ProviderIndex({
  statuses,
  onOpen
}: {
  statuses: readonly AiProviderStatus[];
  onOpen: (sub: AiProviderSub) => void;
}): ReactElement {
  return (
    <div className="pss__prov-index">
      {statuses.map((status) => (
        <button
          key={status.sub}
          type="button"
          className={"pss__prov-row" + (status.tone === "off" ? " is-off" : "")}
          onClick={() => onOpen(status.sub)}
        >
          <span
            aria-hidden="true"
            className={
              "pss__status-dot" +
              (status.tone !== undefined ? ` pss__status-dot--${status.tone}` : "")
            }
          />
          <span className="pss__prov-text">
            <span className="pss__prov-name">{status.label}</span>
            <span className="pss__prov-meta" title={status.meta}>
              {status.meta}
            </span>
          </span>
          <span className={"pss__badge" + statusBadgeClass(status.tone)}>{status.badge}</span>
          <span className="pss__prov-chev" aria-hidden="true">
            ›
          </span>
        </button>
      ))}
    </div>
  );
}

/** Ported from PwrAgnt's `ProviderDefaultsStrip`: a provider screen must not
 *  strand the operator away from the defaults that decide whether it is used
 *  at all, so it leads with that answer and one action to change them. */
function ProviderDefaultsStrip({
  routed,
  onEdit
}: {
  routed: readonly AiSurfaceId[];
  onEdit: () => void;
}): ReactElement {
  return (
    <div className="pss__prov-strip">
      <span className="pss__prov-strip-eyebrow">Default for</span>
      <span className="pss__prov-strip-items">
        {routed.length > 0
          ? routed.map((surface) => AI_SURFACE_LABELS[surface]).join(" · ")
          : "No jobs yet"}
      </span>
      <button className="pss__top-btn" type="button" onClick={onEdit}>
        Change defaults
      </button>
    </div>
  );
}

type CodexCandidatesProps = {
  snapshot: DesktopCodexDiscoverySnapshot | null;
  loading: boolean;
  onPin: (path: string) => Promise<void>;
};

export function CodexCandidates({
  snapshot,
  loading,
  onPin
}: CodexCandidatesProps): ReactElement {
  const [manualPath, setManualPath] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const platform = window.pwrsnapApi?.platform;
  const stillSearching = snapshot === null && loading;
  const trimmed = manualPath.trim();
  const persistPath = async (path: string, updateDraft: boolean): Promise<void> => {
    setSubmitting(true);
    setManualError(null);
    try {
      await onPin(path);
      if (updateDraft) setManualPath(path);
    } catch (cause) {
      setManualError(
        cause instanceof Error ? cause.message : "Could not save this Codex path."
      );
    } finally {
      setSubmitting(false);
    }
  };
  const submitManualPath = async (): Promise<void> => {
    const normalized = normalizeManualExecutablePath(platform, manualPath);
    if (!normalized.ok) {
      setManualError(normalized.error);
      return;
    }
    await persistPath(normalized.path, true);
  };
  const manualControl = stillSearching ? null : (
    <div className="pss__acp-override">
      <input
        className="pss__acp-override-input"
        type="text"
        value={manualPath}
        spellCheck={false}
        placeholder={`Manual path — e.g. ${executablePathExample(platform, "codex")}`}
        aria-label="Manual Codex path"
        aria-invalid={manualError !== null}
        onChange={(e) => {
          setManualPath(e.currentTarget.value);
          setManualError(null);
        }}
      />
      <button
        className="pss__top-btn"
        type="button"
        disabled={trimmed.length === 0 || submitting}
        onClick={() => {
          void submitManualPath();
        }}
      >
        {submitting ? "Saving…" : "Use path"}
      </button>
      {manualError !== null ? (
        <p className="pss__opt-sub pss__opt-sub--error" role="alert">
          {manualError}
        </p>
      ) : null}
    </div>
  );
  if (snapshot === null || snapshot.candidates.length === 0) {
    return (
      <>
        <div className="pss__opt">
          <span className="pss__opt-icon">{stillSearching ? "…" : "!"}</span>
          <div className="pss__opt-text">
            <span className="pss__opt-primary">
              {stillSearching
                ? "Discovering Codex binaries…"
                : "Codex not found on this machine"}
            </span>
            <span className="pss__opt-sub">
              {platform === "darwin" ? (
                <>
                  Install Codex Desktop or run <code>brew install codex</code>, then
                  Refresh — or pin the binary&apos;s full path below.
                </>
              ) : (
                <>
                  Install Codex Desktop or the Codex CLI, then Refresh — or pin
                  the binary&apos;s full path below.
                </>
              )}
            </span>
          </div>
        </div>
        {manualControl}
      </>
    );
  }
  return (
    <>
      {snapshot.candidates.map((c) => (
        <CandidateRow
          key={c.path}
          candidate={c}
          using={c.path === snapshot.resolvedPath}
          onPin={() => {
            void persistPath(c.path, false);
          }}
        />
      ))}
      {manualControl}
    </>
  );
}

type CandidateRowProps = {
  candidate: DesktopCodexDiscoveryCandidate;
  using: boolean;
  onPin: () => void;
};

function CandidateRow({ candidate, using, onPin }: CandidateRowProps): ReactElement {
  // The path gets its own full-width line (never squeezed by the badges, which
  // is what chopped `/Applications/Code…` before). Source/version/status drop
  // to a muted meta line below — the same shape as the ACP installed-agent card.
  return (
    <div className={"pss__cand" + (using ? " is-using" : "")}>
      <span className="pss__cand-icon" aria-hidden="true">
        C
      </span>
      <div className="pss__cand-body">
        <span className="pss__cand-path" title={candidate.path}>
          {candidate.path}
        </span>
        <span className="pss__cand-meta">
          <span>{candidate.source}</span>
          {candidate.version !== null ? (
            <>
              <span className="pss__cand-sep" aria-hidden="true">
                ·
              </span>
              <span>v{candidate.version}</span>
            </>
          ) : null}
          <span className="pss__cand-sep" aria-hidden="true">
            ·
          </span>
          <span className={candidate.available ? undefined : "pss__cand-unavail"}>
            {candidate.available ? "available" : "unavailable"}
          </span>
        </span>
      </div>
      <div className="pss__cand-action">
        {using ? (
          <span className="pss__badge is-using">Using</span>
        ) : (
          <button
            className="pss__opt-use"
            type="button"
            onClick={onPin}
            disabled={!candidate.available}
          >
            Use
          </button>
        )}
      </div>
    </div>
  );
}

// ---- Codex auth-profile management ------------------------------------
//
// Lists the user's Codex auth profiles (each a CODEX_HOME), shows each
// profile's signed-in status + account email, and lets the user pick the
// active profile, create a new one, and re-login. All backed by the kit via
// the `codex:profiles:*` command-bus verbs. Selecting a profile is a settings
// patch to `codex.profile` (handled by the parent via `onSelect`).

type LoginState =
  | { phase: "idle" }
  | { phase: "waiting"; profile: string }
  | { phase: "done"; profile: string; message: string }
  | { phase: "error"; profile: string; message: string };

type CodexProfilesControlProps = {
  selectedProfile: string;
  onSelect: (name: string) => void;
};

function profileStatusBadge(profile: DesktopCodexAuthProfile): {
  label: string;
  className: string;
} {
  switch (profile.status) {
    case "authenticated":
      return { label: "Signed in", className: "is-using" };
    case "unauthenticated":
      return { label: "Not signed in", className: "is-accent" };
    case "failed":
      return { label: "Check failed", className: "is-accent" };
  }
}

function profileSubLine(profile: DesktopCodexAuthProfile): string {
  if (profile.status === "authenticated") {
    const account =
      profile.email !== undefined && profile.email.length > 0
        ? profile.email
        : "signed in";
    return profile.planType !== undefined && profile.planType.length > 0
      ? `${account} · ${profile.planType}`
      : account;
  }
  if (profile.status === "unauthenticated") {
    return "Not signed in — click Re-login to sign in through Codex.";
  }
  return "Could not confirm sign-in status for this profile.";
}

function CodexProfilesControl({
  selectedProfile,
  onSelect
}: CodexProfilesControlProps): ReactElement {
  const [list, setList] = useState<DesktopCodexAuthProfileList | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [creating, setCreating] = useState<boolean>(false);
  const [newName, setNewName] = useState<string>("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState<boolean>(false);
  const [loginState, setLoginState] = useState<LoginState>({ phase: "idle" });

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    const result = await dispatch("codex:profiles:list", {});
    if (result.ok) setList(result.value);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selected =
    list?.profiles.find((p) => p.name === selectedProfile) ??
    list?.profiles.find((p) => p.selected) ??
    null;

  const onLogin = useCallback(
    async (name: string): Promise<void> => {
      setLoginState({ phase: "waiting", profile: name });
      const result = await dispatch("codex:profiles:login", { name });
      if (!result.ok) {
        setLoginState({
          phase: "error",
          profile: name,
          message: result.error.message
        });
        return;
      }
      const value = result.value;
      const message =
        value.authenticated === true
          ? "Signed in."
          : value.loginUrl !== undefined
            ? "Opened the sign-in page in your browser. Finish signing in there, then Refresh."
            : "Started Codex login. Finish in your browser, then Refresh.";
      setLoginState({ phase: "done", profile: name, message });
      void refresh();
    },
    [refresh]
  );

  const onCreate = useCallback(async (): Promise<void> => {
    setCreateBusy(true);
    setCreateError(null);
    const result = await dispatch("codex:profiles:create", { name: newName });
    setCreateBusy(false);
    if (!result.ok) {
      setCreateError(result.error.message);
      return;
    }
    const created = result.value;
    setCreating(false);
    setNewName("");
    onSelect(created.name);
    await refresh();
    // A brand-new profile has no auth — prompt the login immediately.
    void onLogin(created.name);
  }, [newName, onSelect, refresh, onLogin]);

  return (
    <div className="pss__codex-profiles">
      <div className="pss__model-picker">
        <select
          className="pss__select"
          value={selectedProfile}
          disabled={loading || list === null || list.profiles.length === 0}
          onChange={(e) => {
            onSelect(e.target.value);
          }}
          aria-label="Active Codex auth profile"
        >
          {(list?.profiles ?? []).map((profile) => {
            const account =
              profile.status === "authenticated" &&
              profile.email !== undefined &&
              profile.email.length > 0
                ? ` — ${profile.email}`
                : profile.status === "authenticated"
                  ? " — signed in"
                  : " — no auth";
            return (
              <option key={profile.name} value={profile.name}>
                {profile.displayName}
                {account}
              </option>
            );
          })}
        </select>
        {loading ? (
          <span className="pss__model-loading">loading profiles</span>
        ) : null}
      </div>

      {selected !== null ? (
        <OptionRow
          icon={selected.name === "" ? "~" : "P"}
          primary={selected.displayName}
          sub={profileSubLine(selected)}
          using={true}
          badges={
            <span
              className={"pss__badge " + profileStatusBadge(selected).className}
            >
              {profileStatusBadge(selected).label}
            </span>
          }
          action={
            <button
              className="pss__opt-use"
              type="button"
              disabled={
                loginState.phase === "waiting" &&
                loginState.profile === selected.name
              }
              onClick={() => {
                void onLogin(selected.name);
              }}
            >
              {loginState.phase === "waiting" &&
              loginState.profile === selected.name
                ? "Signing in…"
                : "Re-login"}
            </button>
          }
        />
      ) : null}

      {loginState.phase === "done" && selected?.name === loginState.profile ? (
        <p className="pss__opt-sub">{loginState.message}</p>
      ) : null}
      {loginState.phase === "error" && selected?.name === loginState.profile ? (
        <p className="pss__opt-sub pss__opt-sub--error">{loginState.message}</p>
      ) : null}

      {list?.error !== undefined ? (
        <p className="pss__opt-sub pss__opt-sub--error">{list.error}</p>
      ) : null}

      {creating ? (
        <div className="pss__profile-create">
          <input
            className="pss__input"
            type="text"
            value={newName}
            placeholder="Profile name (e.g. work, personal)"
            maxLength={64}
            autoFocus
            onChange={(e) => {
              setNewName(e.target.value);
              setCreateError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newName.trim().length > 0 && !createBusy) {
                void onCreate();
              }
            }}
            aria-label="New profile name"
          />
          <button
            className="pss__opt-use"
            type="button"
            disabled={createBusy || newName.trim().length === 0}
            onClick={() => {
              void onCreate();
            }}
          >
            {createBusy ? "Creating…" : "Create"}
          </button>
          <button
            className="pss__top-btn"
            type="button"
            disabled={createBusy}
            onClick={() => {
              setCreating(false);
              setNewName("");
              setCreateError(null);
            }}
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          className="pss__top-btn"
          type="button"
          onClick={() => {
            setCreating(true);
          }}
        >
          Create profile…
        </button>
      )}
      {createError !== null ? (
        <p className="pss__opt-sub pss__opt-sub--error">{createError}</p>
      ) : null}
    </div>
  );
}

// ---- ACP agents (discovery + enable) ----------------------------------
//
// Discovers which built-in ACP agents (Kimi / Qwen / Gemini / Grok) are
// installed via the `acp:discover` verb. Each agent has its own provider
// screen (a sidebar child under AI Providers) showing its install status.
// Installed agents get an enable checkbox that patches
// `ai.acp.enabledAgentIds`; not-installed agents show an install hint and a
// disabled checkbox. Enabling an agent makes it selectable in AI Features →
// Default agents.

type AcpAgentCardProps = {
  agentId: string;
  title: string;
  discovery: AcpAgentDiscovery | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  enabledAgentIds: readonly string[];
  agents: Record<string, AcpAgentPreference> | undefined;
  modelErrors: Record<string, string | undefined>;
  onToggle: (id: string, enabled: boolean) => void;
  onPickInstance: (id: string, command: string) => void;
  onRevertAuto: (id: string) => void;
  onSetOverride: (id: string, path: string, enable: boolean) => Promise<void>;
  onClearOverride: (id: string) => void;
};

function AcpAgentCard({
  agentId,
  title,
  discovery,
  loading,
  error,
  onRefresh,
  enabledAgentIds,
  agents,
  modelErrors,
  onToggle,
  onPickInstance,
  onRevertAuto,
  onSetOverride,
  onClearOverride
}: AcpAgentCardProps): ReactElement {
  return (
    <Card
      eyebrow="PROVIDER"
      title={title}
      headerAction={
        <button
          className="pss__top-btn"
          type="button"
          disabled={loading}
          onClick={onRefresh}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      }
    >
      <Row
        label="Install"
        sub="Where PwrSnap found this agent's CLI. Pick which install to use when several are found, or set a manual path."
        tag="config"
      >
        <AcpAgentList
          only={agentId}
          discovery={discovery}
          loading={loading}
          error={error}
          enabledAgentIds={enabledAgentIds}
          agents={agents}
          modelErrors={modelErrors}
          onToggle={onToggle}
          onPickInstance={onPickInstance}
          onRevertAuto={onRevertAuto}
          onSetOverride={onSetOverride}
          onClearOverride={onClearOverride}
        />
      </Row>
    </Card>
  );
}

type AcpAgentListProps = {
  /** Render just this agent (a provider screen) instead of every agent. */
  only?: string;
  discovery: AcpAgentDiscovery | null;
  loading: boolean;
  error: string | null;
  enabledAgentIds: readonly string[];
  agents: Record<string, AcpAgentPreference> | undefined;
  modelErrors: Record<string, string | undefined>;
  onToggle: (id: string, enabled: boolean) => void;
  onPickInstance: (id: string, command: string) => void;
  onRevertAuto: (id: string) => void;
  onSetOverride: (id: string, path: string, enable: boolean) => Promise<void>;
  onClearOverride: (id: string) => void;
};

export function AcpAgentList({
  only,
  discovery,
  loading,
  error,
  enabledAgentIds,
  agents,
  modelErrors,
  onToggle,
  onPickInstance,
  onRevertAuto,
  onSetOverride,
  onClearOverride
}: AcpAgentListProps): ReactElement {
  if (discovery === null) {
    return (
      <div className="pss__opt">
        <span className="pss__opt-icon">{loading ? "…" : "!"}</span>
        <div className="pss__opt-text">
          <span className="pss__opt-primary">
            {loading ? "Discovering ACP agents…" : "ACP agent discovery unavailable"}
          </span>
          {error !== null ? (
            <span className="pss__opt-sub pss__opt-sub--error">{error}</span>
          ) : null}
        </div>
      </div>
    );
  }
  return (
    <>
      {error !== null ? (
        <p className="pss__opt-sub pss__opt-sub--error">{error}</p>
      ) : null}
      {only !== undefined && !discovery.agents.some((agent) => agent.id === only) ? (
        <p className="pss__opt-sub">Discovery did not report this agent.</p>
      ) : null}
      {discovery.agents
        .filter((agent) => only === undefined || agent.id === only)
        .map((agent) => (
        <AcpAgentRow
          key={agent.id}
          agent={agent}
          enabled={enabledAgentIds.includes(agent.id)}
          pref={agents?.[agent.id]}
          modelError={modelErrors[agent.id]}
          onToggle={(next) => onToggle(agent.id, next)}
          onPickInstance={(command) => onPickInstance(agent.id, command)}
          onRevertAuto={() => onRevertAuto(agent.id)}
          onSetOverride={(path, enable) => onSetOverride(agent.id, path, enable)}
          onClearOverride={() => onClearOverride(agent.id)}
        />
      ))}
    </>
  );
}

function AcpAgentRow({
  agent,
  enabled,
  pref,
  modelError,
  onToggle,
  onPickInstance,
  onRevertAuto,
  onSetOverride,
  onClearOverride
}: {
  agent: AcpAgentDiscoveryEntry;
  enabled: boolean;
  pref: AcpAgentPreference | undefined;
  modelError: string | undefined;
  onToggle: (enabled: boolean) => void;
  onPickInstance: (command: string) => void;
  onRevertAuto: () => void;
  onSetOverride: (path: string, enable: boolean) => Promise<void>;
  onClearOverride: () => void;
}): ReactElement {
  const instanceCount = agent.instances.length;
  const isAuto =
    (pref?.selectedPath ?? "") === "" && (pref?.overridePath ?? "") === "";
  const summarySub = agent.installed
    ? modelError !== undefined
      ? `Not available: ${modelError}`
      : `${instanceCount} install${instanceCount === 1 ? "" : "s"} found${
          agent.version !== undefined ? ` · active v${agent.version}` : ""
        }${isAuto ? " · auto" : " · pinned"}`
    : (agent.detail ?? "Not installed");

  return (
    <div className="pss__acp-agent">
      <OptionRow
        icon={agent.displayName.charAt(0).toUpperCase()}
        primary={agent.displayName}
        sub={summarySub}
        using={agent.installed && enabled}
        badges={
          modelError !== undefined ? (
            <span className="pss__badge is-danger">Unavailable</span>
          ) : agent.installed ? (
            enabled ? (
              <span className="pss__badge is-using">Enabled</span>
            ) : (
              <span className="pss__badge">Installed</span>
            )
          ) : (
            <span className="pss__badge">Not installed</span>
          )
        }
        action={
          <label className="pss__acp-toggle">
            <input
              type="checkbox"
              checked={enabled}
              disabled={!agent.installed && !enabled}
              aria-label={`Enable ${agent.displayName}`}
              onChange={(e) => {
                onToggle(e.target.checked);
              }}
            />
            <span>Enable</span>
          </label>
        }
      />
      <div className="pss__acp-detail">
        {agent.installed ? (
          <div className="pss__acp-instances" role="list">
            {agent.instances.map((inst) => {
              const active = inst.command === agent.activeCommand;
              const meta = [
                inst.version !== undefined ? `v${inst.version}` : null,
                inst.source === "override"
                  ? "override"
                  : inst.source === "fallback"
                    ? "fallback path"
                    : "found"
              ]
                .filter((part): part is string => part !== null)
                .join(" · ");
              return (
                <button
                  key={inst.command}
                  type="button"
                  role="listitem"
                  className={"pss__acp-instance" + (active ? " is-active" : "")}
                  aria-pressed={active}
                  title={
                    active
                      ? "Active — click to revert to auto (use the first found)"
                      : "Click to always use this install"
                  }
                  onClick={() => {
                    if (active) onRevertAuto();
                    else onPickInstance(inst.command);
                  }}
                >
                  <span className="pss__acp-instance-path">{inst.command}</span>
                  <span className="pss__acp-instance-meta">{meta}</span>
                  {active ? <span className="pss__badge is-using">Using</span> : null}
                </button>
              );
            })}
          </div>
        ) : null}
        <AcpOverrideInput
          executableName={agent.id}
          overridePath={pref?.overridePath ?? ""}
          saveLabel={agent.installed ? "Save" : "Save & enable"}
          onSave={(path) => onSetOverride(path, !agent.installed)}
          onClear={onClearOverride}
        />
      </div>
    </div>
  );
}

/** Manual override-path input for one ACP agent — mirrors PwrAgnt's per-agent
 *  "Custom path" control. Save persists the path (it's probed on the next
 *  Refresh and, when valid, becomes the active instance); Clear reverts to
 *  discovery + any pinned instance. */
function AcpOverrideInput({
  executableName,
  overridePath,
  saveLabel,
  onSave,
  onClear
}: {
  executableName: string;
  overridePath: string;
  saveLabel: string;
  onSave: (path: string) => Promise<void>;
  onClear: () => void;
}): ReactElement {
  const [draft, setDraft] = useState<string>(overridePath);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Re-sync the draft when the persisted value changes out from under us
  // (e.g. a settings broadcast from another window).
  useEffect(() => {
    setDraft(overridePath);
  }, [overridePath]);
  const trimmed = draft.trim();
  const dirty = trimmed !== overridePath;
  const submit = async (): Promise<void> => {
    const normalized = normalizeManualExecutablePath(
      window.pwrsnapApi?.platform,
      draft
    );
    if (!normalized.ok) {
      setSubmissionError(normalized.error);
      return;
    }
    setSubmitting(true);
    setSubmissionError(null);
    try {
      await onSave(normalized.path);
      setDraft(normalized.path);
    } catch (cause) {
      setSubmissionError(
        cause instanceof Error ? cause.message : "Could not save this agent path."
      );
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <div className="pss__acp-override">
      <input
        className="pss__acp-override-input"
        type="text"
        value={draft}
        spellCheck={false}
        placeholder={`Manual path — e.g. ${executablePathExample(window.pwrsnapApi?.platform, executableName)}`}
        aria-label="Manual override path"
        aria-invalid={submissionError !== null}
        onChange={(e) => {
          setDraft(e.currentTarget.value);
          setSubmissionError(null);
        }}
      />
      <button
        className="pss__top-btn"
        type="button"
        disabled={!dirty || trimmed.length === 0 || submitting}
        onClick={() => {
          void submit();
        }}
      >
        {submitting ? "Saving…" : saveLabel}
      </button>
      <button
        className="pss__top-btn is-muted"
        type="button"
        disabled={overridePath.length === 0 && draft.length === 0}
        onClick={() => {
          setDraft("");
          onClear();
        }}
      >
        Clear
      </button>
      {submissionError !== null ? (
        <p className="pss__opt-sub pss__opt-sub--error" role="alert">
          {submissionError}
        </p>
      ) : null}
    </div>
  );
}

type SecretKeyControlProps = {
  status: { configured: boolean; lastSetAt: string | null } | null;
  placeholder: string;
  onReplace: (value: string) => Promise<void>;
  onClear: () => Promise<void>;
};

export function SecretKeyControl({
  status,
  placeholder,
  onReplace,
  onClear
}: SecretKeyControlProps): ReactElement {
  const [editing, setEditing] = useState<boolean>(false);
  const [draft, setDraft] = useState<string>("");
  const [working, setWorking] = useState<boolean>(false);
  const configured = status?.configured === true;
  const canSubmit = draft.length > 0;

  // Cancel disables itself while a write is in flight (see the
  // disabled={working} below), but the user can still trigger
  // unmount via window close or page navigation mid-await. Guard
  // the `finally` setState so we don't fire on an unmounted control.
  const mountedRef = useRef<boolean>(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setWorking(true);
    try {
      await onReplace(draft);
      if (!mountedRef.current) return;
      setDraft("");
      setEditing(false);
    } catch {
      // useSettings has already surfaced the error; just bail.
    } finally {
      if (mountedRef.current) setWorking(false);
    }
  };

  const startEditing = (): void => {
    if (working) return;
    setEditing(true);
  };

  return (
    <>
      <div className="pss__keyrow">
        <input
          className="pss__input"
          type="password"
          autoFocus={editing}
          readOnly={!editing}
          value={editing ? draft : configured ? "••••••••••••••••" : ""}
          placeholder={editing ? placeholder : configured ? "" : "Enter a key"}
          onFocus={startEditing}
          onClick={startEditing}
          onChange={(e) => {
            if (editing) setDraft(e.target.value);
          }}
          onKeyDown={(e) => {
            if (!editing) return;
            if (e.key === "Enter") {
              void submit();
            } else if (e.key === "Escape") {
              setDraft("");
              setEditing(false);
            }
          }}
        />
        <button
          className="pss__key-btn"
          type="button"
          onClick={() => {
            void submit();
          }}
          disabled={working || !canSubmit}
        >
          {configured ? "Replace" : "Set"}
        </button>
        {editing ? (
          <button
            className="pss__key-btn"
            type="button"
            disabled={working}
            onClick={() => {
              setDraft("");
              setEditing(false);
            }}
          >
            Cancel
          </button>
        ) : (
          <button
            className="pss__key-btn is-danger"
            type="button"
            disabled={!configured}
            onClick={() => {
              void onClear();
            }}
          >
            Clear
          </button>
        )}
      </div>
      <div className="pss__key-meta">
        {configured ? (
          <>
            <span>
              set <b style={{ color: "var(--text-primary)" }}>{formatLastSetAt(status?.lastSetAt ?? null)}</b>
            </span>
            <span>·</span>
            <span>keychain</span>
          </>
        ) : (
          <span>Not set</span>
        )}
      </div>
    </>
  );
}

// ---- Per-surface default provider / model / reasoning -------------------

/** One option in a chat surface's provider dropdown — an enabled ACP agent.
 *  `value` is the persisted `acp:<id>` selector; `label` is the agent's
 *  discovery display name (falls back to its id before names resolve). */
export function codexTestBadgeLabel(
  result: CodexTestResult | null,
  testing: boolean
): string {
  if (testing) return "Testing…";
  if (result === null) return "Not tested";
  switch (result.status) {
    case "ok": return result.detail ?? "OK";
    case "unset": return "No Codex";
    case "failed": return "Failed";
  }
}

export function codexTestBadgeClass(result: CodexTestResult): string {
  switch (result.status) {
    case "ok": return "is-using";
    case "unset": return "";
    case "failed": return "is-accent";
  }
}

export function codexTestSubLine(
  result: CodexTestResult | null,
  testing: boolean
): string {
  if (testing) return "spawn --version";
  if (result === null) return "spawn --version";
  if (result.status === "ok") {
    return `${result.durationMs}ms · ${formatLastSetAt(result.testedAt)}`;
  }
  if (result.status === "unset") {
    return "no Codex binary resolved";
  }
  return result.errorMessage ?? "spawn failed";
}
