import type { CSSProperties, ReactElement, ReactNode } from "react";
import type { AiRunStatus } from "@pwrsnap/shared";

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
 *  default. `provider` is a backend selector ("" / "codex" / "acp:<id>").
 *
 *  The per-surface `model` is a Codex concept: the enrichment handler passes the
 *  stored model id ONLY for Codex and `null` for ACP (the agent runs on its own
 *  default). So we surface a model name for Codex only — showing it for an ACP
 *  provider would label a model that never runs, and would leak a stale
 *  cross-provider id (e.g. "Kimi … (gpt-5.4-mini)") left over from a Codex
 *  selection made before the backend was switched. */
export function enrichmentBackendLabel(
  enrichment: { provider?: string; model?: string } | undefined
): { providerLabel: string; modelLabel: string | undefined } {
  const provider = enrichment?.provider ?? "";
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

export type CodexStatusPillProps = {
  readonly status: AiRunStatus | null;
  readonly variant?: CodexStatusPillVariant;
  readonly draftAvailable?: boolean;
  readonly accepted?: boolean;
  readonly needsConsent?: boolean;
  readonly safetyDisabled?: boolean;
  /** Human label for the enrichment backend (e.g. "Codex", "Gemini"). The
   *  enrichment provider isn't always Codex anymore, so the copy is
   *  parameterized. Defaults to "Codex". */
  readonly providerLabel?: string | undefined;
  /** Optional model id shown in parens (e.g. "gemini-3-flash-preview"). */
  readonly modelLabel?: string | undefined;
  /** Failure message from the latest run, when available. */
  readonly error?: string | null | undefined;
  readonly action?: ReactNode;
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
  if (status === "cancelled") return "idle";
  if (safetyDisabled) return "safety-disabled";
  if (accepted) return "accepted";
  if (draftAvailable && status === "completed") return "ready";
  if (needsConsent) return "needs-consent";
  return "idle";
}

function failedLabelFor(provider: string, error: string | null | undefined): ReactNode {
  const message = error?.trim();
  if (message === undefined || message.length === 0) {
    return <>{provider} could not read this snap.</>;
  }
  if (/(auth|login|logged|credential|ineligibletier|unsupported_client|unsupported client|not supported|no longer supported)/i.test(message)) {
    return (
      <>
        {provider} is not available: {message}
      </>
    );
  }
  return (
    <>
      {provider} could not read this snap: {message}
    </>
  );
}

function labelFor(
  kind: StatusKind,
  provider: string,
  model: string | undefined,
  error: string | null | undefined
): ReactNode {
  const withModel = model !== undefined && model.length > 0 ? ` (${model})` : "";
  switch (kind) {
    case "running":
      return (
        <>
          {provider} is reading the snap{withModel}
          <span className="ps-codex-pill__dots" />
        </>
      );
    case "queued":
      return (
        <>
          {provider} is queued<span className="ps-codex-pill__dots" />
        </>
      );
    case "ready":
      return <>{provider} drafted a title + description.</>;
    case "accepted":
      return <>Description filled from {provider}.</>;
    case "failed":
      return failedLabelFor(provider, error);
    case "safety-disabled":
      return <>AI enrichment was disabled for cost safety.</>;
    case "needs-consent":
      return <>Enable AI to read a bounded copy of this snap.</>;
    case "idle":
      return <>{provider} has no suggestion yet.</>;
  }
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
  action,
  style,
  className
}: CodexStatusPillProps): ReactElement {
  const kind = resolveKind(status, draftAvailable, accepted, needsConsent, safetyDisabled);
  const classes = [
    "ps-codex-pill",
    `ps-codex-pill--${variant}`,
    `is-${kind}`,
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
      <span className="ps-codex-pill__text">{labelFor(kind, providerLabel, modelLabel, error)}</span>
      {action !== undefined ? <span className="ps-codex-pill__action">{action}</span> : null}
    </div>
  );
}
