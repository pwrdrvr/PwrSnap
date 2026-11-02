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

describe("CodexStatusPill caption fallback", () => {
  function render(node: Parameters<typeof renderToStaticMarkup>[0]): HTMLDivElement {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(node);
    return container;
  }

  it("names the backend that answered, marks it, and says why in the tooltip", () => {
    const container = render(
      <CodexStatusPill status="completed" accepted providerLabel="Codex" fallbackFrom="qwen3-vl-8b" />
    );
    expect(container.querySelector(".ps-codex-pill__summary")?.textContent).toBe("Description filled from Codex.");
    expect(container.querySelector(".ps-codex-pill__fallback")?.textContent).toBe("Fallback");
    expect(container.querySelector(".ps-codex-pill__summary")?.getAttribute("title"))
      .toBe("Description filled from Codex. qwen3-vl-8b could not be reached, so Codex stood in.");
  });

  it("a failed fallback names both failures", () => {
    const container = render(
      <CodexStatusPill status="failed" providerLabel="Codex" error="model overloaded" fallbackFrom="qwen3-vl-8b" />
    );
    expect(container.querySelector(".ps-codex-pill__summary")?.textContent)
      .toBe("Codex could not read this snap: model overloaded. qwen3-vl-8b could not be reached.");
  });

  it("no chip without a fallback, or before any run", () => {
    expect(render(<CodexStatusPill status="completed" accepted providerLabel="Codex" />)
      .querySelector(".ps-codex-pill__fallback")).toBeNull();
    expect(render(<CodexStatusPill status={null} providerLabel="Codex" fallbackFrom="qwen3-vl-8b" />)
      .querySelector(".ps-codex-pill__fallback")).toBeNull();
  });
});
