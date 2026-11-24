import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
import type { Settings } from "@pwrsnap/shared";
import { APPLE_FM_PROVIDER } from "@pwrsnap/shared";
import { jobRunners } from "../../ai-provider-status";
import { baseSettings } from "../../__tests__/settings-fixture";
import { JobsSummaryCard } from "../JobsSummaryCard";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

async function renderCard(settings: Settings): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    // No provider statuses yet: discovery and macOS have not answered.
    root?.render(
      createElement(JobsSummaryCard, {
        settings,
        runners: jobRunners(settings),
        statuses: [],
        connections: [],
        acpModels: {}
      })
    );
  });
  return container;
}

function row(el: HTMLElement, job: string): { name: string | undefined; model: string | undefined } {
  const li = Array.from(el.querySelectorAll(".pss__jobs-summary-row")).find(
    (r) => r.querySelector(".pss__jobs-summary-job")?.textContent === job
  );
  return {
    name: li?.querySelector(".pss__jobs-summary-name")?.textContent ?? undefined,
    model: li?.querySelector(".pss__jobs-summary-model")?.textContent ?? undefined
  };
}

describe("JobsSummaryCard", () => {
  test("names Apple Intelligence before macOS has answered, never the route id", async () => {
    const el = await renderCard({
      ...baseSettings,
      ai: { ...baseSettings.ai, defaults: { ...baseSettings.ai.defaults, enrichment: { provider: APPLE_FM_PROVIDER } } }
    });
    expect(row(el, "Capture captions, tags & OCR")).toEqual({
      name: "Apple Intelligence",
      model: "on this Mac"
    });
  });

  test("a job on a disabled agent runs on Codex and shows no agent model under it", async () => {
    const el = await renderCard({
      ...baseSettings,
      ai: {
        ...baseSettings.ai,
        acp: { enabledAgentIds: [] },
        defaults: {
          ...baseSettings.ai.defaults,
          libraryChat: { provider: "acp:grok", model: "grok-build" },
          sizzleChat: { provider: "codex", model: "gpt-6-luna" }
        }
      }
    });
    expect(row(el, "Library chat")).toEqual({ name: "Codex", model: "default model" });
    expect(row(el, "Sizzle Reel chat")).toEqual({ name: "Codex", model: "gpt-6-luna" });
  });
});
