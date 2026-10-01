import { useState, type ReactElement } from "react";
import type { DesktopCodexVersionAdvisory } from "@pwrsnap/shared";
import { dispatch } from "../../lib/pwrsnap";

export const CODEX_RELEASES_URL = "https://github.com/openai/codex/releases";

/** Installer-specific instructions shared by Settings and the Library toast. */
export function CodexUpgradeHelp({ advisory }: {
  advisory: DesktopCodexVersionAdvisory;
}): ReactElement {
  const [actionResult, setActionResult] = useState<string | null>(null);
  const runAction = async (): Promise<void> => {
    const result = advisory.upgradeCommand
      ? await dispatch("clipboard:copyText", { text: advisory.upgradeCommand })
      : await dispatch("app:openExternal", { url: CODEX_RELEASES_URL });
    setActionResult(result.ok
      ? advisory.upgradeCommand ? "Command copied" : null
      : result.error.message);
  };
  return (
    <div className="codex-upgrade-help">
      <p>
        {advisory.upgradeCommand
          ? "Run this in a terminal, then restart PwrSnap:"
          : advisory.installer === "application"
            ? "Update the ChatGPT / Codex app that supplies this binary, then restart PwrSnap."
            : "Update Codex the same way you installed it, or download a current CLI release for macOS, Windows or Linux, then restart PwrSnap."}
      </p>
      {advisory.upgradeCommand ? <code>{advisory.upgradeCommand}</code> : null}
      <button className="pss__top-btn" type="button" onClick={() => { void runAction(); }}>
        {advisory.upgradeCommand ? "Copy command" : "Open Codex releases"}
      </button>
      {actionResult ? <p role="status">{actionResult}</p> : null}
    </div>
  );
}
