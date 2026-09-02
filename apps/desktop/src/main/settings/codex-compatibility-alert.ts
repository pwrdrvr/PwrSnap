import type { CodexCliCompatibilityAlert } from "@pwrsnap/shared";

type CompatibilityAlertListener = (alert: CodexCliCompatibilityAlert | null) => void;

let activeAlert: CodexCliCompatibilityAlert | null = null;
const listeners = new Set<CompatibilityAlertListener>();

function compatibilityKey(
  command: string,
  detectedVersion: string,
  requiredVersion: string
): string {
  return `codex-cli-too-old:${JSON.stringify([
    command,
    detectedVersion,
    requiredVersion
  ])}`;
}

function alertsMatch(
  left: CodexCliCompatibilityAlert | null,
  right: CodexCliCompatibilityAlert | null
): boolean {
  return left?.key === right?.key;
}

function replaceAlert(
  next: CodexCliCompatibilityAlert | null,
  notify: boolean
): boolean {
  if (alertsMatch(activeAlert, next)) return false;
  activeAlert = next;
  if (notify) {
    for (const listener of [...listeners]) listener(next);
  }
  return true;
}

/**
 * Report the exact too-old condition from the settings store's cached
 * compatibility guard. Repeated
 * attempts against the same command/version pair do not emit again while the
 * condition remains active, preventing a burst of identical renderer toasts.
 */
export function reportCodexCliTooOld(
  command: string,
  detectedVersion: string,
  requiredVersion: string
): CodexCliCompatibilityAlert {
  const alert: CodexCliCompatibilityAlert = {
    kind: "too-old",
    key: compatibilityKey(command, detectedVersion, requiredVersion),
    command,
    detectedVersion,
    requiredVersion,
    detectedAt: new Date().toISOString()
  };
  replaceAlert(alert, true);
  return activeAlert ?? alert;
}

/** A successful store-owned command guard resolves the active condition and re-arms
 * the dedupe key, allowing a later downgrade to surface again. */
export function clearCodexCliCompatibilityAlert(): void {
  replaceAlert(null, true);
}

export function getCodexCliCompatibilityAlert(): CodexCliCompatibilityAlert | null {
  return activeAlert;
}

export function onCodexCliCompatibilityAlertChanged(
  listener: CompatibilityAlertListener
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Persist a peer-process event without notifying local listeners. The process
 * bridge already delivered that event to local renderers; notifying here
 * would re-broadcast it and create an echo loop.
 */
export function rememberRelayedCodexCompatibilityAlert(
  alert: CodexCliCompatibilityAlert | null
): void {
  replaceAlert(alert, false);
}

export function resetCodexCompatibilityAlertForTests(): void {
  activeAlert = null;
  listeners.clear();
}

export class CodexCliTooOldError extends Error {
  constructor(public readonly alert: CodexCliCompatibilityAlert) {
    super(
      `Codex CLI ${alert.detectedVersion} is older than the minimum supported ` +
        `version ${alert.requiredVersion}: ${alert.command}`
    );
    this.name = "CodexCliTooOldError";
  }
}
