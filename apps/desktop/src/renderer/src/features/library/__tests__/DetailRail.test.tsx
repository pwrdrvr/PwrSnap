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
    if (name === "library:addTag") return { ok: true, value: accepted };
    if (name === "library:removeTag") return { ok: true, value: accepted };
    if (name === "clipboard:copyText") return { ok: true, value: undefined };
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

    const ocrTab = Array.from(el.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.startsWith("OCR")
    ) as HTMLButtonElement | undefined;
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

  test("OCR and Detail tabs are linked by aria-controls / aria-labelledby", async () => {
    const { el } = await renderDetailRail(enrichment());

    const detailTab = el.querySelector("#psl-tab-detail");
    const ocrTab = el.querySelector("#psl-tab-ocr");
    expect(detailTab?.getAttribute("aria-controls")).toBe("psl-tabpanel-detail");
    expect(ocrTab?.getAttribute("aria-controls")).toBe("psl-tabpanel-ocr");

    const panel = el.querySelector('[role="tabpanel"]');
    expect(panel?.getAttribute("id")).toBe("psl-tabpanel-detail");
    expect(panel?.getAttribute("aria-labelledby")).toBe("psl-tab-detail");
  });
});
