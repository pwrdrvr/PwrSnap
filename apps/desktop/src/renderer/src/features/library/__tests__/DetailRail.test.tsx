import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import type {
  AiEnrichmentBudgetStatus,
  AiRunUsageDetail,
  CaptureEnrichment,
  CaptureRecord,
  SettingsChangedEvent
} from "@pwrsnap/shared";
import { DetailRail, AiRunUsageStrip } from "../DetailRail";
import type { LibraryView } from "../library-view";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const record: CaptureRecord = {
  id: "cap_1",
  kind: "image",
  captured_at: "2026-05-15T18:24:00.000Z",
  legacy_src_path: "/tmp/cap_1.png",
  bundle_path: null,
  flat_png_path: null,
  bundle_modified_at: null,
  bundle_format_version: 1,
  bundle_edits_version: 0,
  width_px: 2654,
  height_px: 1922,
  device_pixel_ratio: 2,
  byte_size: 263_168,
  sha256: "sha_cap_1",
  source_app_bundle_id: "jp.naver.line.mac",
  source_app_name: "LINE",
  edits_version: 0,
  deleted_at: null
};

function enrichment(patch: Partial<CaptureEnrichment> = {}): CaptureEnrichment {
  return {
    captureId: "cap_1",
    latestRunId: "run_1",
    status: "completed",
    error: null,
    ocrText: "Search by display name\n\nhuntharo\nKeep Memo\nAll albums\nFriends 2",
    suggestedTitle: null,
    acceptedTitle: null,
    titleAcceptedAt: null,
    suggestedFilenameStem: null,
    acceptedFilenameStem: null,
    filenameAcceptedAt: null,
    suggestedDescription: "Dark-mode LINE desktop chat showing PwrAgent command help.",
    acceptedDescription: null,
    descriptionAcceptedAt: null,
    suggestedTags: [],
    acceptedTags: [],
    ...patch
  };
}

function aiUsageDetail(patch: Partial<AiRunUsageDetail> = {}): AiRunUsageDetail {
  const detail: AiRunUsageDetail = {
    run: {
      id: "run_1",
      captureId: "cap_1",
      kind: "enrich",
      task: "enrich",
      triggerSource: "library-regenerate",
      selectedModel: "gpt-5.4-mini",
      status: "completed",
      error: null,
      latencyMs: 1000,
      createdAt: "2026-05-15T18:25:00.000Z",
      startedAt: "2026-05-15T18:25:00.000Z",
      completedAt: "2026-05-15T18:25:01.000Z"
    },
    threadId: "thread-1",
    turnId: "turn-1",
    model: "gpt-5.4-mini",
    modelProvider: "openai",
    serviceTier: null,
    usageStatus: "available",
    usageUnavailableReason: null,
    tokens: {
      totalTokens: 1200,
      inputTokens: 900,
      cachedInputTokens: 100,
      outputTokens: 300,
      reasoningOutputTokens: 25,
      modelContextWindow: 400_000
    },
    cost: {
      status: "available",
      currency: "USD",
      catalogVersion: "2026-05-30",
      pricingSourceUrl: "https://developers.openai.com/api/docs/pricing",
      pricedAt: "2026-05-30T00:00:00.000Z",
      rateSnapshot: {
        model: "gpt-5.4-mini",
        serviceTier: null,
        contextClass: "standard",
        inputUsdPerMillion: 0.75,
        cachedInputUsdPerMillion: 0.075,
        outputUsdPerMillion: 4.5
      },
      uncachedInputTokens: 800,
      cachedInputTokens: 100,
      outputTokens: 300,
      uncachedInputCostMicros: 600,
      cachedInputCostMicros: 8,
      outputCostMicros: 1350,
      totalCostMicros: 1958
    },
    mediaInputs: [
      {
        id: "media_1",
        aiRunId: "run_1",
        ordinal: 0,
        role: "capture",
        transform: "prepared-jpeg",
        sourceMimeType: "image/png",
        sentMimeType: "image/jpeg",
        format: "jpeg",
        encoder: "sharp mozjpeg",
        quality: 75,
        sourceWidthPx: 2654,
        sourceHeightPx: 1922,
        sentWidthPx: 1024,
        sentHeightPx: 742,
        sentByteSize: 123456,
        maxEdgePx: 1024,
        maxBytes: 1_000_000,
        scaleRatio: 0.385832,
        videoPositionPct: null,
        videoTimestampSec: null,
        createdAt: "2026-05-15T18:25:00.000Z"
      }
    ]
  };
  return { ...detail, ...patch };
}

function installFakeApi(
  initial: CaptureEnrichment,
  options?: {
    usageDetail?: () => AiRunUsageDetail;
  }
): {
  dispatch: ReturnType<typeof vi.fn>;
  pushEvent: (channel: string, payload: unknown) => void;
} {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  const budgetStatus: AiEnrichmentBudgetStatus = {
    mode: "available",
    tokensAvailable: 5,
    capacity: 5,
    refillIntervalMs: 30_000,
    nextTokenAt: null,
    limitedAttemptsLastHour: 0,
    disableThreshold: 3,
    disabledAt: null
  };
  const accepted = enrichment({
    suggestedTitle: initial.suggestedTitle,
    acceptedTitle: initial.suggestedTitle,
    titleAcceptedAt: "2026-05-15T18:25:00.000Z",
    suggestedDescription: initial.suggestedDescription,
    acceptedDescription: initial.suggestedDescription,
    descriptionAcceptedAt: "2026-05-15T18:25:00.000Z",
    suggestedFilenameStem: initial.suggestedFilenameStem,
    acceptedFilenameStem: initial.suggestedFilenameStem,
    filenameAcceptedAt: "2026-05-15T18:25:00.000Z"
  });
  const defaultUsageDetail = aiUsageDetail();
  const getUsageDetail = options?.usageDetail ?? (() => defaultUsageDetail);
  const dispatch = vi.fn(async (name: string) => {
    if (name === "codex:enrichment") return { ok: true, value: initial };
    if (name === "codex:usageRunDetail") return { ok: true, value: getUsageDetail() };
    if (name === "codex:acceptDescription") return { ok: true, value: accepted };
    if (name === "codex:acceptTitle") return { ok: true, value: accepted };
    if (name === "codex:acceptFilenameStem") return { ok: true, value: accepted };
    if (name === "codex:acceptAllDrafts") return { ok: true, value: accepted };
    if (name === "codex:acceptTag") return { ok: true, value: accepted };
    if (name === "codex:rejectTag") return { ok: true, value: accepted };
    if (name === "codex:enrich") return { ok: true, value: { runId: "run_2" } };
    if (name === "codex:budgetStatus") return { ok: true, value: budgetStatus };
    if (name === "library:addTag") return { ok: true, value: accepted };
    if (name === "library:removeTag") return { ok: true, value: accepted };
    if (name === "clipboard:copyText") return { ok: true, value: undefined };
    if (name === "capture:presetMetrics") return { ok: true, value: { metrics: [] } };
    if (name === "codex:libraryChat:list") return { ok: true, value: { threads: [] } };
    if (name === "codex:libraryChat:history") return { ok: true, value: { messages: [] } };
    return { ok: true, value: undefined };
  });
  (globalThis as unknown as { window: Window }).window.pwrsnapApi = {
    dispatch,
    on: (channel: string, handler: (payload: unknown) => void) => {
      const subscribers = handlers.get(channel) ?? new Set<(payload: unknown) => void>();
      subscribers.add(handler);
      handlers.set(channel, subscribers);
      return () => {
        subscribers.delete(handler);
      };
    },
    startCaptureDrag: () => undefined
  } as unknown as NonNullable<Window["pwrsnapApi"]>;
  return {
    dispatch,
    pushEvent: (channel, payload) => {
      for (const handler of handlers.get(channel) ?? []) {
        handler(payload);
      }
    }
  };
}

async function renderDetailRail(
  initial: CaptureEnrichment,
  options?: {
    usageDetail?: () => AiRunUsageDetail;
  }
): Promise<{
  el: HTMLDivElement;
  dispatch: ReturnType<typeof vi.fn>;
  pushEvent: (channel: string, payload: unknown) => void;
}> {
  const { dispatch, pushEvent } = installFakeApi(initial, options);
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
    await Promise.resolve();
  });
  return { el: container, dispatch, pushEvent };
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
  test("per-field Use button promotes Codex's initial draft to accepted", async () => {
    const { el, dispatch } = await renderDetailRail(
      enrichment({
        suggestedTitle: "LINE chat with PwrAgent help",
        suggestedDescription: "Dark-mode LINE desktop chat showing PwrAgent command help."
      })
    );

    const useButtons = Array.from(
      el.querySelectorAll<HTMLButtonElement>(".psl__field-use")
    );
    // Two Use buttons — one per field (title + description). The
    // previous bulk "Use draft" button is gone so tags can't be
    // accepted as a side effect.
    expect(useButtons).toHaveLength(2);

    await act(async () => {
      useButtons[0]?.click();
      useButtons[1]?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const titleCalls = dispatch.mock.calls.filter(([name]) => name === "codex:acceptTitle");
    const descCalls = dispatch.mock.calls.filter(([name]) => name === "codex:acceptDescription");
    const tagCalls = dispatch.mock.calls.filter(([name]) => name === "codex:acceptTag");
    expect(titleCalls[0]?.[1]).toEqual({
      captureId: "cap_1",
      title: "LINE chat with PwrAgent help"
    });
    expect(descCalls[0]?.[1]).toEqual({
      captureId: "cap_1",
      description: "Dark-mode LINE desktop chat showing PwrAgent command help."
    });
    // Crucial: no tag-accept side effects. Bug #7 of the user report.
    expect(tagCalls).toHaveLength(0);
  });

  test("DraftPreview surfaces a Codex suggestion that diverges from the accepted value", async () => {
    const { el, dispatch } = await renderDetailRail(
      enrichment({
        suggestedTitle: "Codex headline",
        acceptedTitle: "Custom user title - Cats",
        titleAcceptedAt: "2026-05-19T18:00:00.000Z",
        suggestedDescription: "Codex body draft",
        acceptedDescription: null
      })
    );

    // Title input shows the user's accepted value; the Codex draft
    // is surfaced in a DraftPreview block beneath it so the user
    // can see what they'd be replacing.
    const titleInput = el.querySelector<HTMLInputElement>(".psl__field-input");
    expect(titleInput?.value).toBe("Custom user title - Cats");
    expect(titleInput?.classList.contains("is-suggested")).toBe(false);

    const previews = Array.from(
      el.querySelectorAll<HTMLDivElement>(".psl__draft-preview")
    );
    // Only the title diverges (description has no acceptedDescription
    // so it's still showing as a "suggested" input). One preview block.
    expect(previews).toHaveLength(1);
    expect(previews[0]?.textContent).toContain("Codex headline");

    const previewUse = previews[0]?.querySelector<HTMLButtonElement>(
      ".psl__draft-preview-use"
    );
    expect(previewUse).not.toBeNull();
    await act(async () => {
      previewUse?.click();
      await Promise.resolve();
    });

    const titleCalls = dispatch.mock.calls.filter(([name]) => name === "codex:acceptTitle");
    expect(titleCalls[0]?.[1]).toEqual({ captureId: "cap_1", title: "Codex headline" });
    // Description was untouched.
    expect(dispatch.mock.calls.some(([name]) => name === "codex:acceptDescription")).toBe(false);
  });

  test("header only carries the source-app chip, not accepted content tags", async () => {
    const { el } = await renderDetailRail(
      enrichment({ acceptedTags: ["chat", "pwrsnap", "bot"] })
    );

    // The .psl__detail-tags row used to render accepted tags AND was
    // mirrored below by the TagEditor — a duplicated "live" list.
    // Now: header only carries the source-app chip; TagEditor below
    // is the single tag surface.
    const headerTags = el.querySelector(".psl__detail-tags");
    expect(headerTags?.querySelectorAll(".ps-tag").length ?? 0).toBe(0);

    const tagEditor = el.querySelector(".psl__tag-editor");
    const editorTagLabels = Array.from(
      tagEditor?.querySelectorAll(".psl__tag-accepted > span") ?? []
    ).map((node) => node.textContent?.trim());
    expect(editorTagLabels).toEqual(["chat", "pwrsnap", "bot"]);
  });

  test("× on an accepted tag chip dispatches library:removeTag with the label", async () => {
    const { el, dispatch } = await renderDetailRail(
      enrichment({ acceptedTags: ["chat", "pwrsnap", "github"] })
    );

    const removeButtons = Array.from(
      el.querySelectorAll<HTMLButtonElement>(".psl__tag-remove")
    );
    expect(removeButtons.map((b) => b.getAttribute("aria-label"))).toEqual([
      "remove chat",
      "remove pwrsnap",
      "remove github"
    ]);

    await act(async () => {
      removeButtons[2]?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const removeCall = dispatch.mock.calls.find(([name]) => name === "library:removeTag");
    expect(removeCall?.[1]).toEqual({ captureId: "cap_1", label: "github" });
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

    // Info tab is the default tab; OCR text must NOT appear there now.
    expect(el.querySelector(".psl__ocr-tab-body")).toBeNull();

    const ocrTab = el.querySelector<HTMLButtonElement>(
      '[data-testid="psl-right-tab-ocr"]'
    );
    expect(ocrTab).not.toBeNull();
    await act(async () => {
      ocrTab?.click();
      await Promise.resolve();
    });

    expect(el.querySelector(".psl__ocr-tab-body")?.textContent).toContain("final visible line");
  });

  test("Enter in the tag input dispatches library:addTag with the trimmed label", async () => {
    const { el, dispatch } = await renderDetailRail(enrichment());
    const tagInput = el.querySelector<HTMLInputElement>(".psl__tag-input");
    expect(tagInput).not.toBeNull();

    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set;
      nativeSetter?.call(tagInput, "  triage  ");
      tagInput?.dispatchEvent(new Event("input", { bubbles: true }));
      tagInput?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const addTagCall = dispatch.mock.calls.find(([name]) => name === "library:addTag");
    expect(addTagCall?.[1]).toEqual({ captureId: "cap_1", label: "triage" });
  });

  test("OCR Copy text routes through clipboard:copyText, not navigator.clipboard", async () => {
    const { el, dispatch } = await renderDetailRail(enrichment({ ocrText: "secret contents" }));

    const ocrTab = el.querySelector<HTMLButtonElement>(
      '[data-testid="psl-right-tab-ocr"]'
    );
    expect(ocrTab).not.toBeNull();
    await act(async () => {
      ocrTab?.click();
      await Promise.resolve();
    });

    const copyButton = Array.from(el.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === "Copy text"
    ) as HTMLButtonElement | undefined;
    expect(copyButton).toBeDefined();
    await act(async () => {
      copyButton?.click();
      await Promise.resolve();
    });

    const copyCall = dispatch.mock.calls.find(([name]) => name === "clipboard:copyText");
    expect(copyCall?.[1]).toEqual({ text: "secret contents" });
  });

  test("Export filename: renders Codex's suggested filename as the current value without a draft Use action", async () => {
    const { el, dispatch } = await renderDetailRail(
      enrichment({ suggestedFilenameStem: "telegram-aquarium-chat-thread" })
    );

    const monoInput = el.querySelector<HTMLInputElement>(".psl__field-input--mono");
    expect(monoInput?.value).toBe("telegram-aquarium-chat-thread");
    expect(monoInput?.classList.contains("is-suggested")).toBe(false);

    const filenameLabel = Array.from(el.querySelectorAll(".psl__field-label")).find((node) =>
      node.textContent?.includes("Export filename")
    );
    const copyButton = filenameLabel?.querySelector<HTMLButtonElement>(".psl__field-use");
    expect(copyButton?.textContent).toBe("Copy");
    await act(async () => {
      copyButton?.click();
      await Promise.resolve();
    });

    expect(dispatch.mock.calls.some(([name]) => name === "codex:acceptFilenameStem")).toBe(false);
    const copyCall = dispatch.mock.calls.find(([name]) => name === "clipboard:copyText");
    expect(copyCall?.[1]).toEqual({ text: "telegram-aquarium-chat-thread" });
  });

  test("Export filename: once accepted, the label exposes a Copy button that routes through clipboard:copyText", async () => {
    const { el, dispatch } = await renderDetailRail(
      enrichment({
        suggestedFilenameStem: "telegram-chat-thread",
        acceptedFilenameStem: "telegram-chat-thread",
        filenameAcceptedAt: "2026-05-19T18:00:00.000Z"
      })
    );

    const filenameLabel = Array.from(el.querySelectorAll(".psl__field-label")).find((node) =>
      node.textContent?.includes("Export filename")
    );
    const copyButton = filenameLabel?.querySelector<HTMLButtonElement>(".psl__field-use");
    expect(copyButton?.textContent).toBe("Copy");

    await act(async () => {
      copyButton?.click();
      await Promise.resolve();
    });

    const copyCall = dispatch.mock.calls.find(([name]) => name === "clipboard:copyText");
    expect(copyCall?.[1]).toEqual({ text: "telegram-chat-thread" });
  });

  test("DraftPreview Use button overrides the user's mid-edit manual value", async () => {
    // Reproduces the user-reported bug: type into the description
    // (origin becomes "manual"), then click "Use this" on the
    // DraftPreview block. The Use action should win — the textarea
    // must flip to the Codex draft, not keep the user's mid-edit
    // text just because origin was manual.
    const { el } = await renderDetailRail(
      enrichment({
        suggestedDescription: "Codex draft body",
        acceptedDescription: "User's earlier accepted body",
        descriptionAcceptedAt: "2026-05-19T18:00:00.000Z"
      })
    );

    const textarea = el.querySelector<HTMLTextAreaElement>(".psl__field-textarea");
    expect(textarea).not.toBeNull();
    expect(textarea?.value).toBe("User's earlier accepted body");

    // User starts typing — origin flips to "manual".
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value"
      )?.set;
      nativeSetter?.call(textarea, "halfway through editing");
      textarea?.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    expect(textarea?.value).toBe("halfway through editing");

    // User notices the Codex draft block below the textarea and
    // clicks "Use this" — they want the Codex draft, not their
    // mid-typing text.
    const previews = Array.from(
      el.querySelectorAll<HTMLDivElement>(".psl__draft-preview")
    );
    const descriptionPreview = previews.find((node) =>
      node.textContent?.includes("Codex draft body")
    );
    expect(descriptionPreview).toBeDefined();
    const useThis = descriptionPreview?.querySelector<HTMLButtonElement>(
      ".psl__draft-preview-use"
    );
    await act(async () => {
      useThis?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The textarea must show Codex's draft now, not the user's
    // half-typed string.
    expect(textarea?.value).toBe("Codex draft body");
  });

  test("AI strip shows a prominent Use draft button and a de-emphasized Regenerate link", async () => {
    const { el, dispatch } = await renderDetailRail(
      enrichment({
        suggestedTitle: "Codex headline",
        suggestedDescription: "Codex body",
        suggestedFilenameStem: "codex-stem"
      })
    );

    // Bulk Use button is the prominent accent chip on the AI strip.
    const useBulk = el.querySelector<HTMLButtonElement>(".ps-codex-pill .psl__chip-btn--accent");
    expect(useBulk?.textContent).toBe("Use draft");

    // Regenerate is now the text-link sibling, not a full chip.
    const regen = el.querySelector<HTMLButtonElement>(".ps-codex-pill .psl__chip-link");
    expect(regen?.textContent).toBe("Regenerate");

    // Clicking the bulk Use fires the atomic accept verb (one call,
    // not three) and no tag accepts.
    await act(async () => {
      useBulk?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const acceptAllCalls = dispatch.mock.calls.filter(
      ([name]) => name === "codex:acceptAllDrafts"
    );
    expect(acceptAllCalls).toHaveLength(1);
    expect(acceptAllCalls[0]?.[1]).toEqual({
      captureId: "cap_1",
      title: "Codex headline",
      description: "Codex body"
    });
    const tagCalls = dispatch.mock.calls.filter(([name]) => name === "codex:acceptTag");
    expect(tagCalls).toHaveLength(0);
  });

  test("image LOW/MED/HIGH card body copies a named PNG file, not raw image bytes", async () => {
    const { el, dispatch } = await renderDetailRail(
      enrichment({ suggestedFilenameStem: "library-sidebar-export" })
    );

    const lowButton = el.querySelector<HTMLButtonElement>(".fo__copy-btn");
    await act(async () => {
      lowButton?.click();
      await Promise.resolve();
    });

    const fileCopyCall = dispatch.mock.calls.find(([name]) => name === "clipboard:copy-file");
    expect(fileCopyCall).toEqual([
      "clipboard:copy-file",
      { captureId: "cap_1", preset: "low" }
    ]);
    expect(dispatch.mock.calls.some(([name]) => name === "clipboard:copy")).toBe(false);
  });

  test("shows latest AI run usage and sent media accounting", async () => {
    const { el } = await renderDetailRail(enrichment());

    const usage = el.querySelector(".psl__ai-usage");
    expect(usage?.textContent).toContain("gpt-5.4-mini");
    expect(usage?.textContent).toContain("$0.002");
    expect(usage?.textContent).toContain("800 uncached in");
    expect(usage?.textContent).toContain("100 cached");
    expect(usage?.textContent).toContain("300 out (25 reasoning)");
    expect(usage?.textContent).toContain("1024×742 JPEG");
    expect(usage?.textContent).toContain("q75");
  });

  test("refreshes latest AI run usage when the same run completes", async () => {
    let currentUsage = aiUsageDetail({
      run: { ...aiUsageDetail().run, status: "running", completedAt: null },
      usageStatus: "unavailable",
      usageUnavailableReason: "usage has not been recorded for this run",
      tokens: null,
      cost: { status: "unavailable", reason: "usage unavailable" },
      mediaInputs: []
    });
    const { el, dispatch, pushEvent } = await renderDetailRail(
      enrichment({ status: "running" }),
      { usageDetail: () => currentUsage }
    );

    const usage = el.querySelector(".psl__ai-usage");
    expect(usage?.textContent).toContain("Usage unavailable");
    expect(
      dispatch.mock.calls.filter(([name]) => name === "codex:usageRunDetail")
    ).toHaveLength(1);

    currentUsage = aiUsageDetail();
    await act(async () => {
      pushEvent(EVENT_CHANNELS.aiRunUpdated, {
        run: currentUsage.run,
        enrichment: enrichment({ status: "completed" })
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(el.querySelector(".psl__ai-usage")?.textContent).toContain("800 uncached in");
    expect(
      dispatch.mock.calls.filter(([name]) => name === "codex:usageRunDetail")
    ).toHaveLength(2);
  });

  test("Bulk Use draft overrides title and description manual values but leaves filename edits alone", async () => {
    const { el } = await renderDetailRail(
      enrichment({
        suggestedTitle: "Codex headline",
        acceptedTitle: "old title",
        titleAcceptedAt: "2026-05-19T18:00:00.000Z",
        suggestedDescription: "Codex body",
        acceptedDescription: "old body",
        descriptionAcceptedAt: "2026-05-19T18:00:00.000Z",
        suggestedFilenameStem: "codex-stem",
        acceptedFilenameStem: "old-stem",
        filenameAcceptedAt: "2026-05-19T18:00:00.000Z"
      })
    );

    const titleInput = el.querySelector<HTMLInputElement>(".psl__field-input");
    const descTextarea = el.querySelector<HTMLTextAreaElement>(".psl__field-textarea");
    const filenameInput = el.querySelector<HTMLInputElement>(".psl__field-input--mono");

    // User types into all three.
    const setInputValue = (node: HTMLInputElement | HTMLTextAreaElement | null, value: string): void => {
      if (node === null) return;
      const proto =
        node instanceof HTMLTextAreaElement
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      setter?.call(node, value);
      node.dispatchEvent(new Event("input", { bubbles: true }));
    };
    await act(async () => {
      setInputValue(titleInput, "mid-edit title");
      setInputValue(descTextarea, "mid-edit body");
      setInputValue(filenameInput, "mid-edit-stem");
      await Promise.resolve();
    });

    const bulkUse = el.querySelector<HTMLButtonElement>(".ps-codex-pill .psl__chip-btn--accent");
    await act(async () => {
      bulkUse?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(titleInput?.value).toBe("Codex headline");
    expect(descTextarea?.value).toBe("Codex body");
    expect(filenameInput?.value).toBe("mid-edit-stem");
  });

  test("AI strip hides Use draft once title and description drafts are already accepted", async () => {
    const { el } = await renderDetailRail(
      enrichment({
        suggestedTitle: "Codex headline",
        acceptedTitle: "Codex headline",
        titleAcceptedAt: "2026-05-19T18:00:00.000Z",
        suggestedDescription: "Codex body",
        acceptedDescription: "Codex body",
        descriptionAcceptedAt: "2026-05-19T18:00:00.000Z",
        suggestedFilenameStem: "codex-stem"
      })
    );

    expect(el.querySelector(".ps-codex-pill .psl__chip-btn--accent")).toBeNull();
    // Regenerate stays available.
    expect(el.querySelector(".ps-codex-pill .psl__chip-link")?.textContent).toBe("Regenerate");
  });

  test("settings change that clears budget safety refreshes budget status", async () => {
    const { dispatch, pushEvent } = await renderDetailRail(enrichment());
    const initialBudgetReads = dispatch.mock.calls.filter(
      ([name]) => name === "codex:budgetStatus"
    ).length;

    await act(async () => {
      pushEvent(EVENT_CHANNELS.settingsChanged, {
        settings: {
          ai: {
            budgetSafetyDisabledAt: null
          }
        }
      } as SettingsChangedEvent);
      await Promise.resolve();
    });

    const nextBudgetReads = dispatch.mock.calls.filter(
      ([name]) => name === "codex:budgetStatus"
    ).length;
    expect(nextBudgetReads).toBe(initialBudgetReads + 1);
  });

  test("per-field Use rolls back the optimistic commit when the dispatch fails", async () => {
    // Simulate a server error on codex:acceptTitle — local state
    // should NOT remain in the optimistically-committed shape.
    const initial = enrichment({
      suggestedTitle: "Codex draft headline",
      acceptedTitle: "Prior accepted headline",
      titleAcceptedAt: "2026-05-19T18:00:00.000Z"
    });
    const dispatch = vi.fn(async (name: string) => {
      if (name === "codex:enrichment") return { ok: true, value: initial };
      if (name === "codex:acceptTitle")
        return {
          ok: false,
          error: { kind: "internal", code: "boom", message: "simulated failure" }
        };
      if (name === "capture:presetMetrics") return { ok: true, value: { metrics: [] } };
      return { ok: true, value: undefined };
    });
    (globalThis as unknown as { window: Window }).window.pwrsnapApi = {
      dispatch,
      on: () => () => undefined,
      startCaptureDrag: () => undefined
    } as unknown as NonNullable<Window["pwrsnapApi"]>;

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(DetailRail, {
          view: {
            kind: "focus",
            selectedRecordId: record.id,
            returnAnchor: { scrollTop: 0, cellId: record.id }
          },
          record
        })
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const titleInput = container.querySelector<HTMLInputElement>(".psl__field-input");
    expect(titleInput?.value).toBe("Prior accepted headline");

    // The DraftPreview block shows "Codex draft headline" with a Use
    // button; click it.
    const previewUse = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".psl__draft-preview-use")
    )[0];
    expect(previewUse).toBeDefined();
    await act(async () => {
      previewUse?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Dispatch returned err — rollback should have restored the
    // prior accepted value. The optimistic flip to "Codex draft
    // headline" must not be visible after rollback.
    expect(titleInput?.value).toBe("Prior accepted headline");
  });

  test("vertical activity bar renders Info / OCR / Chat tabs with role=tab", async () => {
    const { el } = await renderDetailRail(enrichment({ ocrText: "some text" }));

    const infoTab = el.querySelector<HTMLButtonElement>(
      '[data-testid="psl-right-tab-info"]'
    );
    const ocrTab = el.querySelector<HTMLButtonElement>(
      '[data-testid="psl-right-tab-ocr"]'
    );
    const chatTab = el.querySelector<HTMLButtonElement>(
      '[data-testid="psl-right-tab-chat"]'
    );
    expect(infoTab).not.toBeNull();
    expect(ocrTab).not.toBeNull();
    expect(chatTab).not.toBeNull();
    expect(infoTab?.getAttribute("role")).toBe("tab");
    expect(ocrTab?.getAttribute("role")).toBe("tab");
    expect(chatTab?.getAttribute("role")).toBe("tab");

    // Pinned by default — the Info panel renders as a region with role
    // tabpanel; the active tab is Info on first paint.
    const tabPanels = el.querySelectorAll('[role="tabpanel"]');
    expect(tabPanels.length).toBeGreaterThanOrEqual(1);

    // Persistent footer that hosts the L/M/H copy row + actions never
    // disappears across tab switches.
    expect(el.querySelector('[data-testid="psl-right-footer"]')).not.toBeNull();
  });

  test("OCR tab shows a notification badge when extracted text exists", async () => {
    const { el } = await renderDetailRail(enrichment({ ocrText: "snap content" }));
    const ocrTab = el.querySelector<HTMLButtonElement>(
      '[data-testid="psl-right-tab-ocr"]'
    );
    expect(ocrTab?.querySelector(".rab__act-badge")).not.toBeNull();
  });

  test("OCR tab badge is absent when there is no extracted text", async () => {
    const { el } = await renderDetailRail(enrichment({ ocrText: null }));
    const ocrTab = el.querySelector<HTMLButtonElement>(
      '[data-testid="psl-right-tab-ocr"]'
    );
    expect(ocrTab?.querySelector(".rab__act-badge")).toBeNull();
  });

  test("grid → focus mode transition does not violate Rules of Hooks", async () => {
    // Regression: a prior iteration of DetailRail kept `useMemo(tabs)`
    // BELOW the `view.kind === "grid"` early return. In grid mode the
    // component bailed before the useMemo, so the hook count was N. On
    // the user's first cell click the component re-rendered in focus
    // mode, ran past the early return, and reached the useMemo for
    // (N+1) hooks — React detects the mismatch ("Rendered more hooks
    // than during the previous render"), aborts the parent commit, and
    // the outer `.psl[data-mode]` attribute is stuck at "grid". The
    // E2E surface caught it (library-source-filter.spec L373 hung on
    // the focus-mode wait); this unit case locks the fix in by
    // rendering DetailRail twice — first in grid mode (returns null
    // after the same N hooks as before), then in focus mode (runs
    // past the early returns and reaches the additional hooks). React
    // must not warn or throw across the transition.
    installFakeApi(enrichment());
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    const errors: unknown[][] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
      origError(...args);
    };

    try {
      // 1. Mount in grid mode — DetailRail returns null after the
      //    early return; hooks execute up to that point.
      await act(async () => {
        root?.render(
          createElement(DetailRail, {
            view: {
              kind: "grid",
              selectedRecordId: null,
              returnAnchor: null
            } as LibraryView,
            record
          })
        );
        await Promise.resolve();
      });

      // 2. Transition to focus mode on the same component instance —
      //    DetailRail now renders past the early returns. The hook
      //    count MUST match the grid-mode render exactly. If it
      //    doesn't, React fires a console.error with the "Rendered
      //    more/fewer hooks" message AND aborts the render.
      await act(async () => {
        root?.render(
          createElement(DetailRail, {
            view: {
              kind: "focus",
              selectedRecordId: record.id,
              returnAnchor: { scrollTop: 0, cellId: record.id }
            },
            record
          })
        );
        await Promise.resolve();
        await Promise.resolve();
      });

      // Component rendered past the early returns — the activity bar
      // icons appear, the rail is in its full focus-mode shape.
      expect(
        container?.querySelector('[data-testid="psl-right-tab-info"]')
      ).not.toBeNull();

      // No "Rendered more hooks" or "Rendered fewer hooks" warning
      // from React in either render phase.
      const hookCountErrors = errors.filter((args) =>
        args.some(
          (a: unknown) =>
            typeof a === "string" &&
            (a.includes("Rendered more hooks") ||
              a.includes("Rendered fewer hooks") ||
              a.includes("change in the order of Hooks"))
        )
      );
      expect(hookCountErrors).toEqual([]);
    } finally {
      console.error = origError;
    }
  });

  test("controlled mode: parent's pinned + activeTab props win over local state", async () => {
    // When Library threads `pinned` + `onPinChange` + `activeTab` +
    // `onActiveTabChange` in, the rail is controlled by Library — its
    // own local state and settings:read effect are bypassed. The
    // title-bar LayoutToggleButtons and the rail then share a single
    // source of truth without cross-component broadcasts.
    const onPinChange = vi.fn();
    const onActiveTabChange = vi.fn();
    installFakeApi(enrichment());
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(DetailRail, {
          view: {
            kind: "focus",
            selectedRecordId: record.id,
            returnAnchor: { scrollTop: 0, cellId: record.id }
          } as LibraryView,
          record,
          pinned: true,
          onPinChange,
          activeTab: "ocr",
          onActiveTabChange
        })
      );
      await Promise.resolve();
    });

    // OCR tab is active (parent set it via prop).
    const ocrTab = container.querySelector<HTMLButtonElement>(
      '[data-testid="psl-right-tab-ocr"]'
    );
    expect(ocrTab?.getAttribute("aria-selected")).toBe("true");

    // Click chat tab → onActiveTabChange fires, local state does NOT
    // hold the new value (parent owns it).
    const chatTab = container.querySelector<HTMLButtonElement>(
      '[data-testid="psl-right-tab-chat"]'
    );
    await act(async () => {
      chatTab?.click();
      await Promise.resolve();
    });
    expect(onActiveTabChange).toHaveBeenCalledWith("chat");
    // Active tab is still "ocr" because the parent hasn't re-rendered
    // with the new value yet (test never updates the props).
    expect(
      container.querySelector('[data-testid="psl-right-tab-ocr"]')?.getAttribute(
        "aria-selected"
      )
    ).toBe("true");
  });

  test("controlled mode: pin and tab pairs are independently controllable", async () => {
    // Pass ONLY the pin pair. The tab pair stays local-state-only —
    // a controlled pin caller (e.g. Library's title-bar toggle)
    // doesn't have to also take over tab persistence.
    const onPinChange = vi.fn();
    installFakeApi(enrichment({ ocrText: "x" }));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(DetailRail, {
          view: {
            kind: "focus",
            selectedRecordId: record.id,
            returnAnchor: { scrollTop: 0, cellId: record.id }
          } as LibraryView,
          record,
          pinned: true,
          onPinChange
          // intentionally omit activeTab + onActiveTabChange
        })
      );
      await Promise.resolve();
    });
    // Pin pair is controlled: clicking the active tab routes through
    // the parent's onPinChange, not local state.
    await act(async () => {
      container?.querySelector<HTMLButtonElement>(
        '[data-testid="psl-right-tab-info"]'
      )?.click();
      await Promise.resolve();
    });
    expect(onPinChange).toHaveBeenLastCalledWith(false);

    // Tab pair is uncontrolled: clicking the OCR tab updates local
    // state and the rail re-renders with OCR active.
    await act(async () => {
      container?.querySelector<HTMLButtonElement>(
        '[data-testid="psl-right-tab-ocr"]'
      )?.click();
      await Promise.resolve();
    });
    // OCR tab is now selected (local state moved). Pin remains
    // whatever the controlled prop says — still true, since the
    // parent didn't re-render.
    expect(
      container?.querySelector('[data-testid="psl-right-tab-ocr"]')?.getAttribute(
        "aria-selected"
      )
    ).toBe("true");
  });

  test("partial control (pinned without onPinChange) warns via console.warn", async () => {
    // The "controlled" contract requires BOTH halves of a pair. The
    // previous all-or-nothing isControlled silently degraded a
    // half-passed caller to fully-uncontrolled — the user-facing
    // symptom would be "I passed pinned=false but the rail is still
    // open". We now warn loudly during dev so the bug surfaces.
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      const msg = args.map((a) => String(a)).join(" ");
      warnings.push(msg);
    };

    try {
      installFakeApi(enrichment());
      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
      await act(async () => {
        root?.render(
          createElement(DetailRail, {
            view: {
              kind: "focus",
              selectedRecordId: record.id,
              returnAnchor: { scrollTop: 0, cellId: record.id }
            } as LibraryView,
            record,
            pinned: true
            // intentionally omit onPinChange to trigger the warning
          })
        );
        await Promise.resolve();
      });
      const pinPartial = warnings.find((m) =>
        m.includes("partial pin control")
      );
      expect(pinPartial).toBeDefined();
    } finally {
      console.warn = origWarn;
    }
  });

  test("uncontrolled: user click before settings:read resolves is preserved (race guard)", async () => {
    // Race: settings:read is a real IPC round-trip (~10-50ms). If
    // the user clicks the toggle during the in-flight window, the
    // resolved settings value would overwrite their click without
    // the `initialReadDoneRef` gate — surfacing as "I clicked and
    // nothing happened." This spec wires a deferred settings:read
    // mock so we can interleave the click before resolution.
    const accepted = enrichment();
    let resolveSettingsRead: (value: unknown) => void = () => undefined;
    const settingsReadPromise = new Promise<unknown>((resolve) => {
      resolveSettingsRead = resolve;
    });

    const dispatch = vi.fn(async (name: string) => {
      if (name === "settings:read") return settingsReadPromise;
      if (name === "codex:enrichment") return { ok: true, value: accepted };
      if (name === "capture:presetMetrics") {
        return { ok: true, value: { metrics: [] } };
      }
      return { ok: true, value: undefined };
    });
    (globalThis as unknown as { window: Window }).window.pwrsnapApi = {
      dispatch,
      on: () => () => undefined,
      startCaptureDrag: () => undefined
    } as unknown as NonNullable<Window["pwrsnapApi"]>;

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    // Mount uncontrolled — settings:read in-flight, default pinned=true.
    await act(async () => {
      root?.render(
        createElement(DetailRail, {
          view: {
            kind: "focus",
            selectedRecordId: record.id,
            returnAnchor: { scrollTop: 0, cellId: record.id }
          } as LibraryView,
          record
        })
      );
      await Promise.resolve();
    });

    // Default pinned=true ⇒ pinned panel is rendered.
    expect(
      container.querySelector('[data-testid="psl-right-panel-pinned"]')
    ).not.toBeNull();

    // User clicks the active Info tab BEFORE settings:read resolves.
    // The rail demotes to hover-pop (unpinned).
    await act(async () => {
      container?.querySelector<HTMLButtonElement>(
        '[data-testid="psl-right-tab-info"]'
      )?.click();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="psl-right-panel-pinned"]')
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="psl-right-panel-hover"]')
    ).not.toBeNull();

    // Now settings:read resolves with the OPPOSITE saved value (pinned=true).
    // The race-guard must bail before re-applying the saved value.
    await act(async () => {
      resolveSettingsRead({
        ok: true,
        value: {
          library: {
            detailRail: { pinned: true, lastSelectedTab: "info" }
          }
        }
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    // User's click survives — the rail stays unpinned.
    expect(
      container.querySelector('[data-testid="psl-right-panel-pinned"]')
    ).toBeNull();
  });

  test("controlled mode: clicking active tab fires onPinChange(false), not local state", async () => {
    const onPinChange = vi.fn();
    installFakeApi(enrichment());
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(DetailRail, {
          view: {
            kind: "focus",
            selectedRecordId: record.id,
            returnAnchor: { scrollTop: 0, cellId: record.id }
          } as LibraryView,
          record,
          pinned: true,
          onPinChange,
          activeTab: "info",
          onActiveTabChange: vi.fn()
        })
      );
      await Promise.resolve();
    });
    await act(async () => {
      container?.querySelector<HTMLButtonElement>(
        '[data-testid="psl-right-tab-info"]'
      )?.click();
      await Promise.resolve();
    });
    expect(onPinChange).toHaveBeenLastCalledWith(false);
  });

  test("Chat tab opens the Library chat panel surface", async () => {
    const { el } = await renderDetailRail(enrichment());
    const chatTab = el.querySelector<HTMLButtonElement>(
      '[data-testid="psl-right-tab-chat"]'
    );
    expect(chatTab).not.toBeNull();
    await act(async () => {
      chatTab?.click();
      await Promise.resolve();
    });
    expect(el.querySelector('[data-testid="library-chat-panel"]')).not.toBeNull();
  });

  test("ARIA: active tab carries aria-selected + aria-controls pointing at the tabpanel id", async () => {
    const { el } = await renderDetailRail(enrichment({ ocrText: "some text" }));
    const infoTab = el.querySelector<HTMLButtonElement>(
      '[data-testid="psl-right-tab-info"]'
    );
    const ocrTab = el.querySelector<HTMLButtonElement>(
      '[data-testid="psl-right-tab-ocr"]'
    );
    // Default tab is Info — it should be the only one with
    // aria-selected="true". aria-pressed must be absent across the
    // board (toggle-button semantic is wrong for role=tab).
    expect(infoTab?.getAttribute("aria-selected")).toBe("true");
    expect(ocrTab?.getAttribute("aria-selected")).toBe("false");
    expect(infoTab?.getAttribute("aria-pressed")).toBeNull();

    // aria-controls links the tab to its tabpanel by DOM id. Both
    // tabs reference the SAME id (single panel rendered at a time).
    const panel = el.querySelector('[data-testid="psl-right-panel-pinned"]');
    const panelId = panel?.getAttribute("id") ?? "";
    expect(panelId.length).toBeGreaterThan(0);
    expect(infoTab?.getAttribute("aria-controls")).toBe(panelId);
    expect(ocrTab?.getAttribute("aria-controls")).toBe(panelId);
    // The panel itself must be a tabpanel and labelled by the active
    // tab's id (so screen readers announce "Info, tab panel").
    expect(panel?.getAttribute("role")).toBe("tabpanel");
    expect(panel?.getAttribute("aria-labelledby")).toBe(
      infoTab?.getAttribute("id")
    );
  });
});

describe("AiRunUsageStrip", () => {
  let stripContainer: HTMLDivElement | null = null;
  let stripRoot: Root | null = null;

  afterEach(async () => {
    await act(async () => {
      stripRoot?.unmount();
    });
    stripContainer?.remove();
    stripContainer = null;
    stripRoot = null;
  });

  async function renderStrip(detail: AiRunUsageDetail): Promise<HTMLElement> {
    stripContainer = document.createElement("div");
    document.body.appendChild(stripContainer);
    stripRoot = createRoot(stripContainer);
    await act(async () => {
      stripRoot?.render(createElement(AiRunUsageStrip, { detail }));
    });
    const span = stripContainer.querySelector<HTMLElement>(".psl__ai-usage-model");
    if (span === null) throw new Error("model span not rendered");
    return span;
  }

  test("prefers the friendly modelLabel over the raw id, with the full name on title", async () => {
    const detail = aiUsageDetail({ model: "grok-build", modelLabel: "Grok Build" });
    detail.run.selectedModel = "grok-build"; // honored → no override row
    const span = await renderStrip(detail);
    expect(span.textContent).toBe("Grok Build");
    expect(span.getAttribute("title")).toBe("Grok Build");
  });

  test("falls back to the raw id when no friendly label is known (Codex)", async () => {
    const span = await renderStrip(aiUsageDetail({ model: "gpt-5.4-mini", modelLabel: null }));
    expect(span.textContent).toBe("gpt-5.4-mini");
    expect(span.getAttribute("title")).toBe("gpt-5.4-mini");
  });

  test("shows 'model unavailable' when both label and id are missing", async () => {
    const span = await renderStrip(aiUsageDetail({ model: null, modelLabel: null }));
    expect(span.textContent).toBe("model unavailable");
  });

  test("shows the REQUESTED model while a run is in flight (effective unknown)", async () => {
    // Previously showed "model unavailable" mid-run; now falls back to the
    // selected model's label so it reads e.g. "GPT-5.4-Mini".
    const detail = aiUsageDetail({ model: null, modelLabel: null });
    detail.selectedModelLabel = "GPT-5.4-Mini";
    const span = await renderStrip(detail);
    expect(span.textContent).toBe("GPT-5.4-Mini");
  });

  test("surfaces an override note when the agent ran a different model than requested", async () => {
    const detail = aiUsageDetail({ model: "grok-build", modelLabel: "Grok Build" });
    detail.run.selectedModel = "grok-composer-2.5-fast"; // differs from effective
    detail.selectedModelLabel = "Composer 2.5";
    await renderStrip(detail);
    const override = stripContainer!.querySelector<HTMLElement>(".psl__ai-usage-override");
    expect(override).not.toBeNull();
    expect(override!.getAttribute("role")).toBe("note"); // accessible
    expect(override!.textContent).toContain("Composer 2.5");
    expect(override!.textContent).toContain("Grok Build");
  });

  test("no override note when the requested model was honored", async () => {
    const detail = aiUsageDetail({ model: "grok-build", modelLabel: "Grok Build" });
    detail.run.selectedModel = "grok-build"; // requested == effective
    detail.selectedModelLabel = "Grok Build";
    await renderStrip(detail);
    expect(stripContainer!.querySelector(".psl__ai-usage-override")).toBeNull();
  });

  test("no override note while the run is in flight (effective model unknown)", async () => {
    // The chicken-and-egg: a running enrichment has no effective model yet, so
    // the note must NOT render "agent ran model unavailable".
    const detail = aiUsageDetail({ model: null, modelLabel: null });
    detail.run.selectedModel = "grok-composer-2.5-fast";
    detail.selectedModelLabel = "Composer 2.5";
    await renderStrip(detail);
    expect(stripContainer!.querySelector(".psl__ai-usage-override")).toBeNull();
  });
});
