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
    suggestedTitle: initial.suggestedTitle,
    acceptedTitle: initial.suggestedTitle,
    titleAcceptedAt: "2026-05-15T18:25:00.000Z",
    suggestedDescription: initial.suggestedDescription,
    acceptedDescription: initial.suggestedDescription,
    descriptionAcceptedAt: "2026-05-15T18:25:00.000Z"
  });
  const dispatch = vi.fn(async (name: string) => {
    if (name === "codex:enrichment") return { ok: true, value: initial };
    if (name === "codex:acceptDescription") return { ok: true, value: accepted };
    if (name === "codex:acceptTitle") return { ok: true, value: accepted };
    if (name === "codex:acceptTag") return { ok: true, value: accepted };
    if (name === "codex:rejectTag") return { ok: true, value: accepted };
    if (name === "codex:enrich") return { ok: true, value: { runId: "run_2" } };
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
  test("Use draft accepts both title and description via codex:accept verbs", async () => {
    const { el, dispatch } = await renderDetailRail(
      enrichment({
        suggestedTitle: "LINE chat with PwrAgent help",
        suggestedDescription: "Dark-mode LINE desktop chat showing PwrAgent command help."
      })
    );

    const button = Array.from(el.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === "Use draft"
    ) as HTMLButtonElement | undefined;

    expect(button).toBeDefined();

    await act(async () => {
      button?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const titleCalls = dispatch.mock.calls.filter(([name]) => name === "codex:acceptTitle");
    const descCalls = dispatch.mock.calls.filter(([name]) => name === "codex:acceptDescription");
    expect(titleCalls[0]?.[1]).toEqual({
      captureId: "cap_1",
      title: "LINE chat with PwrAgent help"
    });
    expect(descCalls[0]?.[1]).toEqual({
      captureId: "cap_1",
      description: "Dark-mode LINE desktop chat showing PwrAgent command help."
    });
  });

  test("title and description render as editable inputs with the suggested-state class", async () => {
    const { el } = await renderDetailRail(
      enrichment({
        suggestedTitle: "Headline draft",
        suggestedDescription: "Body draft"
      })
    );

    const titleInput = el.querySelector<HTMLInputElement>(".psl__field-input");
    const descriptionInput = el.querySelector<HTMLTextAreaElement>(".psl__field-textarea");

    expect(titleInput?.value).toBe("Headline draft");
    expect(titleInput?.classList.contains("is-suggested")).toBe(true);
    expect(descriptionInput?.value).toBe("Body draft");
    expect(descriptionInput?.classList.contains("is-suggested")).toBe(true);
  });

  test("OCR tab surfaces the full extracted text, not the Detail tab", async () => {
    const fullOcr = `${"line\n".repeat(80)}final visible line`;
    const { el } = await renderDetailRail(enrichment({ ocrText: fullOcr }));

    // Detail tab is the default tab; OCR text must NOT appear there now.
    expect(el.querySelector(".psl__ocr-tab-body")).toBeNull();

    const ocrTab = Array.from(el.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.startsWith("OCR")
    ) as HTMLButtonElement | undefined;
    expect(ocrTab).toBeDefined();
    await act(async () => {
      ocrTab?.click();
      await Promise.resolve();
    });

    expect(el.querySelector(".psl__ocr-tab-body")?.textContent).toContain("final visible line");
  });
});
