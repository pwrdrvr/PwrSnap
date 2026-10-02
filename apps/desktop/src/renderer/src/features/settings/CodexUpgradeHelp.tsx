import { useState, type ReactElement } from "react";
import type { DesktopCodexVersionAdvisory } from "@pwrsnap/shared";
import { dispatch } from "../../lib/pwrsnap";

export const CODEX_RELEASES_URL = "https://github.com/openai/codex/releases";

/** What the user does next, by installer. Shared by the Library toast and
 *  the Settings strip so the two never give different instructions. */
export function codexUpgradeNextStep(advisory: DesktopCodexVersionAdvisory): string {
  if (advisory.upgradeCommand) return "Run this, then restart PwrSnap:";
  if (advisory.installer === "application") {
    return "Update the ChatGPT or Codex app it ships with, then restart PwrSnap.";
  }
  return "Update it the way you installed it, then restart PwrSnap.";
}

export type CopyState = "idle" | "copied" | "failed";

/** Copy feedback flips the button's own label (and its accessible name)
 *  instead of adding a status line, so the surface never resizes on click. */
export function useCopyCommand(command: string | undefined): {
  state: CopyState;
  copy: () => Promise<void>;
} {
  const [state, setState] = useState<CopyState>("idle");
  const copy = async (): Promise<void> => {
    if (!command) return;
    const result = await dispatch("clipboard:copyText", { text: command });
    setState(result.ok ? "copied" : "failed");
  };
  return { state, copy };
}

export function copyLabel(state: CopyState, idle: string): string {
  return state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : idle;
}

export function copyAccessibleName(state: CopyState): string {
  return state === "copied"
    ? "Copied Codex update command"
    : state === "failed"
      ? "Copying Codex update command failed"
      : "Copy Codex update command";
}

export function openCodexReleases(): void {
  void dispatch("app:openExternal", { url: CODEX_RELEASES_URL });
}

/** Settings → Codex: folded under the binary it is about, in the same
 *  command + Copy pair the Local Agents recipes use. */
export function CodexUpgradeStrip({ advisory }: {
  advisory: DesktopCodexVersionAdvisory;
}): ReactElement {
  const { state, copy } = useCopyCommand(advisory.upgradeCommand);
  const title = advisory.blocking
    ? `Codex ${advisory.version} is too old to run. Update to ${advisory.minimumVersion} or newer.`
    : `Update to ${advisory.minimumVersion} or newer for GPT-6.1-Sol`;
  return (
    <div className={"pss__codex-update" + (advisory.blocking ? " is-blocking" : "")}>
      <div className="pss__codex-update-hdr">
        <span className="pss__codex-update-title">{title}</span>
        {advisory.upgradeCommand ? (
          <button
            className="pss__key-btn"
            type="button"
            aria-label={copyAccessibleName(state)}
            onClick={() => { void copy(); }}
          >
            {copyLabel(state, "Copy")}
          </button>
        ) : advisory.installer === "unknown" ? (
          <button className="pss__key-btn" type="button" onClick={openCodexReleases}>
            Codex releases
          </button>
        ) : null}
      </div>
      {advisory.upgradeCommand ? (
        <pre className="pss__pair-command">{advisory.upgradeCommand}</pre>
      ) : null}
      <span className="pss__codex-update-sub">
        {advisory.upgradeCommand ? "Then restart PwrSnap." : codexUpgradeNextStep(advisory)}
      </span>
    </div>
  );
}
