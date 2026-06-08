// PwrSnap's ACP surfaces (Settings → AI) expose only two thinking states —
// "Fast" and "Thinking" — but the stored `reasoning` field is the SHARED Codex
// effort enum ("low" | "medium" | "high"). The agent-acp kit maps the effort
// hint onto the agent's `thought_level` config option at turn start: "low" →
// thinking OFF, "high" → thinking ON. It has NO mapping for "medium", so a
// "medium" silently falls through to the agent's own default.
//
// "medium" can still reach an ACP backend two ways: a chat surface's default
// effort is "medium", and a surface can carry a stale Codex "medium" left over
// from when its provider was Codex before the user switched it to an ACP agent.
// Collapse any effort to the two states the kit actually honors here, at every
// ACP boundary, so we never hand the agent a value it drops on the floor:
// "low" → Fast (off); everything else → Thinking (on).

/** Collapse a Codex-style reasoning effort to the two thinking states an ACP
 *  agent exposes. `"low"` → `"low"` (Fast / thinking off); any other value
 *  (including `"medium"`) → `"high"` (Thinking / thinking on). */
export function acpReasoningEffort(effort: string): "low" | "high" {
  return effort === "low" ? "low" : "high";
}
