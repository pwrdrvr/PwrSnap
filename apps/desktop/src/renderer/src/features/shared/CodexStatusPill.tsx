import type { CSSProperties, ReactElement, ReactNode } from "react";
import { type AiRunStatus, type CustomModel, type CustomConnection } from "@pwrsnap/shared";
import { ChatgptUsageAction, isChatgptUsageLimit } from "./chat/ChatgptUsageAction";

// CodexStatusPill — single source of truth for "what is Codex doing"
// across both the float-over toast and the Library Detail rail.
//
// Old behavior: each surface rendered its own tiny status text. The
// sidebar had a 9px mono "ready"/"failed" with no animation; the
// float-over had an inline animated copy "Codex is reading the snap..".
// Same enum, two visual languages. Now they share this pill so the
// states stay in sync as the feature evolves.
//
// Surface variants:
//   - "strip" (default) — wide pill with sparkle + animated dots, used
//     as a row in the float-over and at the top of the sidebar card.
//   - "inline" — compact tag-style pill rendered next to a header.

export type CodexStatusPillVariant = "strip" | "inline";

const ACP_PROVIDER_LABELS: Record<string, string> = {
  gemini: "Gemini",
  grok: "Grok",
  kimi: "Kimi",
  qwen: "Qwen"
};

/** Derive the status-pill provider + model labels from the enrichment surface
 *  default. Custom selectors resolve through saved model/connection IDs; the
 *  display label never changes the model ID sent to the endpoint.
 *
 *  The per-surface `model` is a Codex concept: the enrichment handler passes the
 *  stored model id ONLY for Codex and `null` for ACP (the agent runs on its own
 *  default). So we surface a model name for Codex only — showing it for an ACP
 *  provider would label a model that never runs, and would leak a stale
 *  cross-provider id (e.g. "Kimi … (gpt-5.4-mini)") left over from a Codex
 *  selection made before the backend was switched. */
export function enrichmentBackendLabel(
  enrichment: { provider?: string; model?: string } | undefined,
  custom: { customModels?: readonly CustomModel[] | undefined; customConnections?: readonly CustomConnection[] | undefined } = {}
): { providerLabel: string; modelLabel: string | undefined } {
  const provider = enrichment?.provider ?? "";
  if (provider.startsWith("custom:")) {
    const model = custom.customModels?.find((m) => `custom:${m.id}` === provider);
    const connection = custom.customConnections?.find((c) => c.id === model?.connectionId);
    const name = model?.displayName ?? "Removed model";
    return { providerLabel: name, modelLabel: connection?.name === name ? undefined : connection?.name };
  }
  const isAcp = provider.startsWith("acp:");
  const providerLabel = isAcp
    ? (ACP_PROVIDER_LABELS[provider.slice("acp:".length)] ?? provider.slice("acp:".length))
    : "Codex";
  const model = enrichment?.model;
  return {
    providerLabel,
    modelLabel: !isAcp && model !== undefined && model.length > 0 ? model : undefined
  };
}

/** The next action's target, never historical run attribution. */
export function enrichmentRegenerateLabel(
  enrichment: { provider?: string; model?: string } | undefined,
  custom: { customModels?: readonly CustomModel[] | undefined; customConnections?: readonly CustomConnection[] | undefined } = {}
): string {
  const { providerLabel, modelLabel } = enrichmentBackendLabel(enrichment, custom);
  const provider = enrichment?.provider ?? "";
  if (provider.startsWith("custom:")) return modelLabel ? `${providerLabel} (${modelLabel})` : providerLabel;
  // Codex's managed default is resolved per run against the live catalog, so
  // without a pinned model this cannot name a specific id truthfully.
  const model = enrichment?.model || (provider.startsWith("acp:") ? "agent default" : "default model");
  return `${providerLabel} (${model})`;
}

export type CodexStatusPillProps = {
  readonly status: AiRunStatus | null;
  readonly variant?: CodexStatusPillVariant;
  readonly draftAvailable?: boolean;
  readonly accepted?: boolean;
  readonly needsConsent?: boolean;
  readonly safetyDisabled?: boolean;
  /** Human label for the enrichment backend (e.g. "Codex", "Gemini"). The
   *  enrichment provider isn't always Codex anymore, so the copy is
   *  parameterized. Defaults to "Codex"; null uses neutral status copy when
   *  the run metadata owns attribution. */
  readonly providerLabel?: string | null | undefined;
  /** Optional context in parens: a built-in model or a custom connection name. */
  readonly modelLabel?: string | undefined;
  /** Failure message from the latest run, when available. */
  readonly error?: string | null | undefined;
  /** Compact run metadata rendered on the SAME row as the status text,
   *  separated by a middot (e.g. `· GPT-5.6-Luna · <$0.001`). Exists so
   *  a surface can fold a second boxed "model / cost" card into this
   *  one row instead of stacking two bordered strips above the first
   *  field. Omitted → the row is exactly what it was before. */
  readonly meta?: ReactNode;
  readonly action?: ReactNode;
  /** A full-width row under the status text, inside the pill. Use it when a
   *  surface has more than one control to offer: side-by-side buttons next to
   *  the text squeeze the sentence into a few words per line (the Library
   *  rail is ~280px wide). The float-over keeps the one-line `action` slot. */
  readonly footer?: ReactNode;
  readonly style?: CSSProperties;
  readonly className?: string;
};

type StatusKind =
  | "idle"
  | "queued"
  | "running"
  | "ready"
  | "accepted"
  | "failed"
  | "cancelled"
  | "safety-disabled"
  | "needs-consent";

function resolveKind(
  status: AiRunStatus | null,
  draftAvailable: boolean,
  accepted: boolean,
  needsConsent: boolean,
  safetyDisabled: boolean
): StatusKind {
  if (status === "running") return "running";
  if (status === "queued") return "queued";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  if (safetyDisabled) return "safety-disabled";
  if (accepted) return "accepted";
  if (draftAvailable && status === "completed") return "ready";
  if (needsConsent) return "needs-consent";
  return "idle";
}

function failedLabelFor(provider: string, error: string | null | undefined): string {
  const message = error?.trim();
  if (message === undefined || message.length === 0) {
    return `${provider} could not read this snap.`;
  }
  if (/^failed to (?:load|reload) workspace requirements$/i.test(message)) {
    return "Codex could not load its configuration, so AI did not run. Update PwrSnap or check Settings → AI Providers → Codex.";
  }
  if (/(auth|login|logged|credential|ineligibletier|unsupported_client|unsupported client|not supported|no longer supported)/i.test(message)) {
    return `${provider} is not available: ${message}`;
  }
  return `${provider} could not read this snap: ${message}`;
}

/** The status sentence as plain text. The summary's `title` includes this
 *  sentence and any raw failure detail replaced by friendlier copy, so a
 *  surface that clamps the pill still offers the whole diagnostic. */
function labelTextFor(
  kind: StatusKind,
  provider: string | null,
  model: string | undefined,
  error: string | null | undefined,
  hasMeta: boolean
): string {
  const withModel = model !== undefined && model.length > 0 ? ` (${model})` : "";
  switch (kind) {
    case "running":
      return provider === null ? "Reading the snap" : `${provider} is reading the snap${withModel}`;
    case "queued":
      return provider === null ? "Queued" : `${provider} is queued`;
    case "ready":
      return provider === null ? "Drafted a title + description" : `${provider} drafted a title + description${hasMeta ? "" : "."}`;
    case "accepted":
      return provider === null ? "Description filled" : `Description filled from ${provider}${hasMeta ? "" : "."}`;
    case "failed":
      return failedLabelFor(provider ?? "AI", error);
    case "cancelled":
      return "Enrichment cancelled.";
    case "safety-disabled":
      return "AI enrichment was disabled for cost safety.";
    case "needs-consent":
      return "Enable AI to read a bounded copy of this snap.";
    case "idle":
      return provider === null ? "No suggestion yet." : `${provider} has no suggestion yet.`;
  }
}

function labelFor(kind: StatusKind, text: string): ReactNode {
  if (kind === "running" || kind === "queued") {
    return (
      <>
        {text}
        <span className="ps-codex-pill__dots" />
      </>
    );
  }
  return text;
}

function shortLabelFor(kind: StatusKind): string {
  switch (kind) {
    case "running":
      return "reading";
    case "queued":
      return "queued";
    case "ready":
      return "draft ready";
    case "accepted":
      return "used";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "safety-disabled":
      return "safety off";
    case "needs-consent":
      return "disabled";
    case "idle":
      return "not run";
  }
}

export function CodexStatusPill({
  status,
  variant = "strip",
  draftAvailable = false,
  accepted = false,
  needsConsent = false,
  safetyDisabled = false,
  providerLabel = "Codex",
  modelLabel,
  error,
  meta,
  action,
  footer,
  style,
  className
}: CodexStatusPillProps): ReactElement {
  const kind = resolveKind(status, draftAvailable, accepted, needsConsent, safetyDisabled);
  const hasMeta = meta !== undefined && meta !== null;
  const summaryText = labelTextFor(kind, providerLabel, modelLabel, error, hasMeta);
  const summaryTitle = kind === "failed" && error?.trim()
    && !summaryText.includes(error.trim())
    ? `${summaryText} Technical detail: ${error.trim()}`
    : summaryText;
  const classes = [
    "ps-codex-pill",
    `ps-codex-pill--${variant}`,
    `is-${kind}`,
    hasMeta ? "has-meta" : "",
    footer !== undefined && footer !== null ? "has-footer" : "",
    className ?? ""
  ]
    .join(" ")
    .trim();

  if (variant === "inline") {
    return (
      <span className={classes} style={style} role="status">
        <span className="ps-codex-pill__dot" aria-hidden />
        {shortLabelFor(kind)}
      </span>
    );
  }

  return (
    <div className={classes} style={style} role="status">
      <span className="ps-codex-pill__spark" aria-hidden>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="m12 2 2.5 5 5.5.5-4 4 1 5.5-5-3-5 3 1-5.5-4-4 5.5-.5z" />
        </svg>
      </span>
      <span className="ps-codex-pill__text">
        <span className="ps-codex-pill__summary" title={summaryTitle}>
          {labelFor(kind, summaryText)}
        </span>
        {hasMeta ? (
          <span className="ps-codex-pill__meta">{meta}</span>
        ) : null}
      </span>
      {isChatgptUsageLimit(error ?? "") ? <span className="ps-codex-pill__action"><ChatgptUsageAction /></span> : action !== undefined ? <span className="ps-codex-pill__action">{action}</span> : null}
      {footer !== undefined && footer !== null ? <div className="ps-codex-pill__footer">{footer}</div> : null}
    </div>
  );
}
