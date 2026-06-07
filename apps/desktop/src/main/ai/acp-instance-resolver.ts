// Single source of truth for "which discovered ACP instance is active" — used
// by both the discovery handler (to mark the active instance in Settings) and
// the chat backend resolver (to spawn the chosen one). Keeping the precedence
// in one place means the badge the user sees and the binary that actually runs
// can never disagree.

import type { AcpAgentInstance, AcpAgentPreference } from "@pwrsnap/shared";

/**
 * Pick the active instance from a discovered list, honoring the user's
 * preference. Precedence:
 *   1. An override instance (discovery probes the override path and tags it
 *      `source: "override"`), so a manual path wins when it's installed.
 *   2. The user-picked `selectedPath`, when it's still among the instances.
 *   3. The first discovered instance (auto).
 *
 * `instances` MUST be non-empty (callers only resolve installed agents).
 */
export function resolveActiveAcpInstance(
  instances: readonly AcpAgentInstance[],
  pref: AcpAgentPreference | undefined
): AcpAgentInstance {
  const override = instances.find((inst) => inst.source === "override");
  if (override !== undefined) return override;

  const selected = pref?.selectedPath?.trim();
  if (selected) {
    const match = instances.find((inst) => inst.command === selected);
    if (match !== undefined) return match;
  }

  // Non-empty by contract; fall back to the first if a caller violates it.
  return instances[0] as AcpAgentInstance;
}
