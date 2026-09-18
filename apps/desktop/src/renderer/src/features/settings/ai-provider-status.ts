// One status read per AI provider, shared by the Settings sidebar's
// AI Providers children and the hub's provider index. Ported from
// PwrAgnt's settings nav (`SettingsScreen.tsx` `navChildren` /
// `describeGitNavChild`) and adapted to PwrSnap's opt-in ACP model.
//
// Pure on purpose: the sidebar dot and the hub badge for a provider are
// two renderings of ONE answer, so they cannot disagree — PwrAgnt shipped
// a green nav dot over a card that said the binary was broken when the
// two were computed separately.
//
// The dot is `aria-hidden`, so every state that is not "fine" also carries
// a word in `chip`. Colour is the redundant channel, never the only one.

import type {
  AcpAgentDiscovery,
  AcpAgentDiscoveryEntry,
  AiProvidersSettingsSub,
  AiSurfaceId,
  BuiltInAcpAgentId,
  DesktopCodexDiscoverySnapshot,
  SecretStatus,
  Settings
} from "@pwrsnap/shared";
import { BUILT_IN_ACP_AGENT_IDS, builtInAcpAgentDisplayName } from "@pwrsnap/shared";

/** Sub-route ids under the `ai` Settings page. One per provider screen. The
 *  SET is owned by `SETTINGS_PAGE_SUBS` in @pwrsnap/shared — main validates
 *  `settings:open` deep links against it — and this module only orders it. */
export type AiProviderSub = AiProvidersSettingsSub;

/**
 * Sidebar + hub order. Gemini CLI sorts last, as it does in PwrAgnt:
 * Google withdrew CLI access for regular consumer accounts, so it is the
 * provider most operators cannot use. Display-only — discovery order and
 * `BUILT_IN_ACP_AGENT_IDS` are unchanged for every other consumer.
 */
export const ACP_AGENT_DISPLAY_ORDER: readonly BuiltInAcpAgentId[] = [
  ...BUILT_IN_ACP_AGENT_IDS.filter((id) => id !== "gemini"),
  ...BUILT_IN_ACP_AGENT_IDS.filter((id) => id === "gemini")
];

export const AI_PROVIDER_SUBS: readonly AiProviderSub[] = [
  "codex",
  ...ACP_AGENT_DISPLAY_ORDER,
  "openai"
];

/**
 * - `ok`: configured and usable.
 * - `off`: not turned on (or no key) — a choice, not a fault.
 * - `warn`: on, found, but needs attention (sign in, failed probe).
 * - `bad`: on, but cannot run (binary missing).
 */
export type AiProviderTone = "ok" | "off" | "warn" | "bad";

export type AiProviderStatus = {
  sub: AiProviderSub;
  label: string;
  /** Undefined while the answer is unknown (discovery hasn't landed).
   *  An absent dot reads as "we do not know", which is honest; a green
   *  one would be a guess. */
  tone?: AiProviderTone;
  /** Tiny uppercase word in the sidebar for every non-ok state. */
  chip?: string;
  /** Hub-index badge text. */
  badge: string;
  /** Hub-index secondary line — where it lives, what version. */
  meta: string;
};

export type AiProviderStatusInput = {
  codex: DesktopCodexDiscoverySnapshot | null;
  codexLoading: boolean;
  acpDiscovery: AcpAgentDiscovery | null;
  acpDiscoveryLoading: boolean;
  enabledAgentIds: readonly string[];
  /** Runtime probe failures from `acp:models`, keyed by agent id. Only the
   *  AI Providers page issues those probes; the sidebar just reflects them. */
  acpModelErrors: Readonly<Record<string, string | undefined>>;
  openaiKey: SecretStatus | null;
};

export function describeCodexStatus(
  snapshot: DesktopCodexDiscoverySnapshot | null,
  loading: boolean
): AiProviderStatus {
  const base = { sub: "codex" as const, label: "Codex" };
  if (snapshot === null) {
    return { ...base, badge: loading ? "Checking…" : "Unknown", meta: "Discovery has not reported yet" };
  }
  if (snapshot.resolvedPath === null) {
    return {
      ...base,
      tone: "bad",
      chip: "missing",
      badge: "Not found",
      meta: "No usable Codex binary found on this machine"
    };
  }
  const version = snapshot.candidates.find((c) => c.path === snapshot.resolvedPath)?.version;
  const meta = version !== null && version !== undefined
    ? `v${version} · ${snapshot.resolvedPath}`
    : snapshot.resolvedPath;
  if (snapshot.auth?.status === "unauthenticated") {
    return { ...base, tone: "warn", chip: "sign in", badge: "Sign in", meta };
  }
  if (snapshot.auth?.status === "failed") {
    return { ...base, tone: "warn", chip: "check", badge: "Auth check failed", meta };
  }
  return { ...base, tone: "ok", badge: "Ready", meta };
}

/**
 * ACP agents are OPT-IN in PwrSnap (`ai.acp.enabledAgentIds` defaults to
 * empty), unlike PwrAgnt where they default on. So "off" alone would paint
 * every agent the same grey on a fresh install and hide the one thing the
 * row should say — whether the CLI is even there. Disabled agents therefore
 * keep a grey dot but split their chip: `off` (installed, ready to enable)
 * vs `missing` (nothing to enable).
 */
export function describeAcpAgentStatus(
  id: BuiltInAcpAgentId,
  entry: AcpAgentDiscoveryEntry | undefined,
  discoveryLoading: boolean,
  enabled: boolean,
  modelError: string | undefined
): AiProviderStatus {
  const label = entry?.displayName ?? builtInAcpAgentDisplayName(id);
  const base = { sub: id, label };
  if (entry === undefined) {
    if (!enabled) return { ...base, tone: "off", chip: "off", badge: "Off", meta: "Not enabled" };
    return {
      ...base,
      badge: discoveryLoading ? "Checking…" : "Unknown",
      meta: "Discovery has not reported yet"
    };
  }
  const installedMeta = [
    entry.version !== undefined ? `v${entry.version}` : null,
    entry.activeCommand ?? null
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
  const meta = entry.installed
    ? installedMeta.length > 0 ? installedMeta : "Installed"
    : "Not installed";
  if (!enabled) {
    return entry.installed
      ? { ...base, tone: "off", chip: "off", badge: "Off", meta }
      : { ...base, tone: "off", chip: "missing", badge: "Not installed", meta };
  }
  if (!entry.installed) {
    return { ...base, tone: "bad", chip: "missing", badge: "Not installed", meta };
  }
  if (modelError !== undefined) {
    return { ...base, tone: "warn", chip: "error", badge: "Unavailable", meta: modelError };
  }
  return { ...base, tone: "ok", badge: "Enabled", meta };
}

export function describeOpenAiStatus(key: SecretStatus | null): AiProviderStatus {
  const base = { sub: "openai" as const, label: "OpenAI" };
  const meta = "API key for Sizzle Reels voiceover";
  if (key === null) return { ...base, badge: "Checking…", meta };
  return key.configured
    ? { ...base, tone: "ok", badge: "Key set", meta }
    : { ...base, tone: "off", chip: "no key", badge: "No key", meta };
}

/** Every provider, in sidebar order. */
export function describeAiProviders(input: AiProviderStatusInput): AiProviderStatus[] {
  const enabled = new Set(input.enabledAgentIds);
  const byId = new Map(input.acpDiscovery?.agents.map((a) => [a.id, a] as const) ?? []);
  return [
    describeCodexStatus(input.codex, input.codexLoading),
    ...ACP_AGENT_DISPLAY_ORDER.map((id) =>
      describeAcpAgentStatus(
        id,
        byId.get(id),
        input.acpDiscoveryLoading,
        enabled.has(id),
        input.acpModelErrors[id]
      )
    ),
    describeOpenAiStatus(input.openaiKey)
  ];
}

/** Job names as the hub's Job routing card labels them. */
export const AI_SURFACE_LABELS: Readonly<Record<AiSurfaceId, string>> = {
  enrichment: "Capture captions, tags & OCR",
  libraryChat: "Library chat",
  sizzleChat: "Sizzle Reel chat"
};

const AI_SURFACE_ORDER: readonly AiSurfaceId[] = ["enrichment", "libraryChat", "sizzleChat"];

/**
 * The jobs that will actually RUN on `sub`, in Job routing order.
 *
 * Mirrors the runtime's resolution, not the stored string: `""`, `"codex"`
 * and an `acp:<id>` whose agent is no longer enabled all land on Codex, so a
 * Codex screen that only counted literal "codex" would claim no jobs while
 * every capture was running through it. OpenAI is not a job backend (it
 * serves Sizzle voiceover), so it never has routed jobs.
 */
export function routedSurfaces(settings: Settings | null, sub: AiProviderSub): AiSurfaceId[] {
  if (settings === null || sub === "openai") return [];
  const enabled = new Set(settings.ai.acp.enabledAgentIds);
  return AI_SURFACE_ORDER.filter((surface) => {
    const provider = settings.ai.defaults[surface].provider ?? "";
    const agentId = provider.startsWith("acp:") ? provider.slice("acp:".length) : null;
    const backend = agentId !== null && enabled.has(agentId) ? agentId : "codex";
    return backend === sub;
  });
}
