// Per-chat backend selectors. On a NEW (not-yet-started) chat these are
// editable chip-style dropdowns — Provider, Model (required), and Reasoning
// (Codex only). Seeded from the surface's Settings default, freely changeable
// until the first message; the panel locks them on send. On a STARTED thread
// they render as read-only chips showing the thread's locked config.
//
// Scope is deliberately just Provider / Model / Reasoning — never Access Mode,
// Worktree, sandbox, etc.

import { useEffect, useRef, useState, type ReactElement } from "react";
import {
  AI_REASONING_EFFORTS,
  CODEX_CAPTION_MODELS,
  builtInAcpAgentDisplayName,
  type AcpAgentModelOption,
  type CodexModelOption
} from "@pwrsnap/shared";
import { dispatch } from "../../../lib/pwrsnap";
import "./chat-backend-chips.css";

export type ChatBackendChoice = {
  /** "" / "codex" / "acp:<id>". */
  provider: string;
  /** Pinned model id (required before the first message). null = unset. */
  model: string | null;
  /** "low" | "medium" | "high" | null. Codex only. */
  reasoning: string | null;
};

type ModelOption = { id: string; label: string; isDefault?: boolean };

const REASONING_LABEL: Record<string, string> = { low: "Low", medium: "Medium", high: "High" };

function providerLabel(provider: string): string {
  if (provider === "" || provider === "codex") return "Codex";
  if (provider.startsWith("acp:")) return builtInAcpAgentDisplayName(provider.slice("acp:".length));
  return provider;
}

/** Reasoning applies only to the Codex backend — ACP agents use arbitrary,
 *  agent-defined modes the kit can't map to low/medium/high, so we don't offer
 *  it there (it would be silently ignored). */
function providerSupportsReasoning(provider: string): boolean {
  return provider === "" || provider === "codex";
}

function toModelOptions(provider: string, raw: unknown): ModelOption[] {
  const list = (raw as { models?: unknown })?.models;
  if (provider === "" || provider === "codex") {
    const liveOptions = Array.isArray(list)
      ? (list as CodexModelOption[])
          .filter((m) => !m.hidden && m.inputModalities.includes("text") && m.inputModalities.includes("image"))
          .map((m) => ({
            id: m.id,
            label: m.displayName && m.displayName !== m.id ? `${m.displayName}` : m.id,
            ...(m.isDefault ? { isDefault: true } : {})
          }))
      : [];
    return liveOptions.length > 0 ? liveOptions : CODEX_CAPTION_MODELS.map((id) => ({ id, label: id }));
  }
  if (!Array.isArray(list)) return [];
  return (list as AcpAgentModelOption[]).map((m) => ({
    id: m.id,
    label: m.label || m.id,
    ...(m.isDefault === true ? { isDefault: true } : {})
  }));
}

// ---- Locked (read-only) chips ------------------------------------------

export function LockedBackendChips({ choice }: { choice: ChatBackendChoice }): ReactElement {
  return (
    <div className="ps-bchips ps-bchips--locked" data-testid="chat-backend-chips-locked">
      <span className="ps-bchip">
        <span className="ps-bchip-dot" aria-hidden="true" />
        {providerLabel(choice.provider)}
      </span>
      {choice.model !== null && choice.model !== "" ? (
        <span className="ps-bchip ps-bchip--muted">{choice.model}</span>
      ) : null}
      {choice.reasoning !== null && choice.reasoning !== "" ? (
        <span className="ps-bchip ps-bchip--muted">{REASONING_LABEL[choice.reasoning] ?? choice.reasoning}</span>
      ) : null}
    </div>
  );
}

// ---- Draft (editable) chips --------------------------------------------

export function NewChatConfigChips({
  /** Provider options for this surface: "codex" + the user's enabled ACP agents. */
  providers,
  value,
  onChange
}: {
  providers: string[];
  value: ChatBackendChoice;
  onChange: (next: ChatBackendChoice) => void;
}): ReactElement {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState<boolean>(true);
  // Drop a stale model fetch if the provider changes again before it resolves.
  const fetchSeq = useRef(0);

  useEffect(() => {
    const seq = ++fetchSeq.current;
    setModelsLoading(true);
    void (async () => {
      const provider = value.provider === "" ? "codex" : value.provider;
      const result =
        provider === "codex"
          ? await dispatch("codex:models", {})
          : await dispatch("acp:models", { agentId: provider.slice("acp:".length) });
      if (fetchSeq.current !== seq) return;
      const opts = result.ok ? toModelOptions(provider, result.value) : [];
      setModels(opts);
      setModelsLoading(false);
      // If the current model isn't valid for this provider, clear it so the
      // user must pick one (required) rather than silently carrying a stale id.
      if (value.model !== null && !opts.some((o) => o.id === value.model)) {
        onChange({ ...value, model: null });
        return;
      }
      const defaultModel = opts.find((o) => o.isDefault === true);
      if (value.model === null && defaultModel !== undefined) {
        onChange({ ...value, model: defaultModel.id });
      }
    })();
    // Only refetch when the provider changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.provider]);

  const showReasoning = providerSupportsReasoning(value.provider);

  return (
    <div className="ps-bchips" data-testid="chat-backend-chips-draft">
      <label className="ps-bchip-field">
        <span className="ps-bchip-label">Provider</span>
        <select
          className="ps-bchip-select"
          aria-label="New chat provider"
          value={value.provider === "" ? "codex" : value.provider}
          onChange={(e) =>
            onChange({
              provider: e.target.value,
              model: null, // reset — a model id is provider-specific
              reasoning: providerSupportsReasoning(e.target.value) ? value.reasoning : null
            })
          }
        >
          {providers.map((p) => (
            <option key={p} value={p}>
              {providerLabel(p)}
            </option>
          ))}
        </select>
      </label>

      <label className="ps-bchip-field">
        <span className="ps-bchip-label">Model</span>
        <select
          className={
            "ps-bchip-select" + (value.model === null && !modelsLoading ? " ps-bchip-select--required" : "")
          }
          aria-label="New chat model"
          disabled={modelsLoading}
          value={value.model ?? ""}
          onChange={(e) => onChange({ ...value, model: e.target.value === "" ? null : e.target.value })}
        >
          {modelsLoading ? (
            <option value="">Loading…</option>
          ) : (
            <>
              <option value="" disabled>
                Choose a model…
              </option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </>
          )}
        </select>
      </label>

      {showReasoning ? (
        <label className="ps-bchip-field">
          <span className="ps-bchip-label">Reasoning</span>
          <select
            className="ps-bchip-select"
            aria-label="New chat reasoning"
            value={value.reasoning ?? "medium"}
            onChange={(e) => onChange({ ...value, reasoning: e.target.value })}
          >
            {AI_REASONING_EFFORTS.map((r) => (
              <option key={r} value={r}>
                {REASONING_LABEL[r] ?? r}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}
