import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { CaptureEnrichment, CaptureRecord } from "@pwrsnap/shared";
import { DetailRail } from "../DetailRail";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const record: CaptureRecord = {
  id: "cap_1",
  kind: "image",
  captured_at: "2026-05-15T18:24:00.000Z",
  src_path: "/tmp/cap_1.png",
  width_px: 2654,
  height_px: 1922,
  device_pixel_ratio: 2,
  byte_size: 263_168,
  sha256: "sha_cap_1",
  source_app_bundle_id: "jp.naver.line.mac",
  source_app_name: "LINE",
  overlays_version: 0,
  deleted_at: null
};

function enrichment(patch: Partial<CaptureEnrichment> = {}): CaptureEnrichment {
  return {
    captureId: "cap_1",
    latestRunId: "run_1",
    status: "completed",
    ocrText: "Search by display name\n\nhuntharo\nKeep Memo\nAll albums\nFriends 2",
    suggestedTitle: null,
    acceptedTitle: null,
    titleAcceptedAt: null,
    suggestedDescription: "Dark-mode LINE desktop chat showing PwrAgent command help.",
    acceptedDescription: null,
    descriptionAcceptedAt: null,
    suggestedTags: [],
    acceptedTags: [],
    ...patch
  };
}

function installFakeApi(initial: CaptureEnrichment): {
  dispatch: ReturnType<typeof vi.fn>;
} {
  const accepted = enrichment({
    acceptedDescription: initial.suggestedDescription,
    descriptionAcceptedAt: "2026-05-15T18:25:00.000Z"
  });
  const dispatch = vi.fn(async (name: string) => {
    if (name === "codex:enrichment") return { ok: true, value: initial };
    if (name === "codex:acceptDescription") return { ok: true, value: accepted };
    if (name === "capture:presetMetrics") return { ok: true, value: { metrics: [] } };
    return { ok: true, value: undefined };
  });
  (globalThis as unknown as { window: Window }).window.pwrsnapApi = {
    dispatch,
    on: () => () => undefined,
    startCaptureDrag: () => undefined
  } as unknown as NonNullable<Window["pwrsnapApi"]>;
  return { dispatch };
}

async function renderDetailRail(initial: CaptureEnrichment): Promise<{
  el: HTMLDivElement;
  dispatch: ReturnType<typeof vi.fn>;
}> {
  const { dispatch } = installFakeApi(initial);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(DetailRail, {
      view: {
        kind: "focus",
        selectedRecordId: record.id,
        returnAnchor: { scrollTop: 0, cellId: record.id }
      },
      record
    }));
  });
  await act(async () => {
    await Promise.resolve();
  });
  return { el: container, dispatch };
}

async function unmount(): Promise<void> {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
}

afterEach(async () => {
  await unmount();
});

describe("DetailRail", () => {
  test("accepts the suggested caption and shows accepted state immediately", async () => {
    const { el } = await renderDetailRail(enrichment());
    const button = Array.from(el.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === "Use caption"
    ) as HTMLButtonElement | undefined;

    expect(button).toBeDefined();
    expect(button?.disabled).toBe(false);

    await act(async () => {
      button?.click();
      await Promise.resolve();
    });

    const usedButton = Array.from(el.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === "Caption used"
    ) as HTMLButtonElement | undefined;
    expect(usedButton).toBeDefined();
    expect(usedButton?.disabled).toBe(true);
  });

  test("renders full OCR text instead of a clipped prefix", async () => {
    const fullOcr = `${"line\n".repeat(80)}final visible line`;
    const { el } = await renderDetailRail(enrichment({ ocrText: fullOcr }));

    expect(el.querySelector(".psl__ai-card-scroll")).not.toBeNull();
    expect(el.querySelector(".psl__ai-card-ocr")?.textContent).toContain("final visible line");
  });

  test("apply tags accepts only the visible suggested tags", async () => {
    const { el, dispatch } = await renderDetailRail(
      enrichment({
        suggestedTags: [
          { id: "tag_line", label: "line", confidence: 0.95, accepted_at: null, rejected_at: null },
          { id: "tag_chat", label: "chat", confidence: 0.9, accepted_at: null, rejected_at: null },
          { id: "tag_bot", label: "bot", confidence: 0.8, accepted_at: null, rejected_at: null },
          { id: "tag_commands", label: "commands", confidence: 0.7, accepted_at: null, rejected_at: null }
        ]
      })
    );
    const button = Array.from(el.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === "Apply tags"
    ) as HTMLButtonElement | undefined;

    expect(button).toBeDefined();
    await act(async () => {
      button?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const acceptedTagIds = dispatch.mock.calls
      .filter(([name]) => name === "codex:acceptTag")
      .map(([, req]) => (req as { tagId: string }).tagId);
    expect(acceptedTagIds).toEqual(["tag_line", "tag_chat"]);
  });
});
