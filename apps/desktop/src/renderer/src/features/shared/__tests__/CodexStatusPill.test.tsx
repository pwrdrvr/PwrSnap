import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CodexStatusPill } from "../CodexStatusPill";

describe("CodexStatusPill configuration failures", () => {
  it.each(["failed to load workspace requirements", "failed to reload workspace requirements"])(
    "explains a Codex startup failure: %s",
    (error) => {
      const container = document.createElement("div");
      container.innerHTML = renderToStaticMarkup(
        <CodexStatusPill status="failed" providerLabel={null} error={error} />
      );
      expect(container.textContent).toContain("Codex could not load its configuration, so AI did not run.");
      expect(container.textContent).toContain("Settings → AI Providers → Codex");
      expect(container.textContent).toContain("Update PwrSnap");
      expect(container.textContent).not.toContain("could not read this snap");
      expect(container.querySelector(".ps-codex-pill__summary")?.getAttribute("title"))
        .toContain(`Technical detail: ${error}`);
    }
  );
});
