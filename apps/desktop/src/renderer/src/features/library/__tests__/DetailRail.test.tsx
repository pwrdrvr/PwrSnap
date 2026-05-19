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

function installFakeApi(initial: CaptureEnrichment): {
  dispatch: ReturnType<typeof vi.fn>;
} {
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
  const dispatch = vi.fn(async (name: string) => {
    if (name === "codex:enrichment") return { ok: true, value: initial };
    if (name === "codex:acceptDescription") return { ok: true, value: accepted };
    if (name === "codex:acceptTitle") return { ok: true, value: accepted };
    if (name === "codex:acceptFilenameStem") return { ok: true, value: accepted };
    if (name === "codex:acceptAllDrafts") return { ok: true, value: accepted };
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

  test("Export filename: renders Codex's draft as suggested input + Use promotes via codex:acceptFilenameStem", async () => {
    const { el, dispatch } = await renderDetailRail(
      enrichment({ suggestedFilenameStem: "telegram-aquarium-chat-thread" })
    );

    const monoInput = el.querySelector<HTMLInputElement>(".psl__field-input--mono");
    expect(monoInput?.value).toBe("telegram-aquarium-chat-thread");
    expect(monoInput?.classList.contains("is-suggested")).toBe(true);

    // Three Use buttons total — one per draft field (title +
    // description + filename). The filename one is the third.
    const useButtons = Array.from(
      el.querySelectorAll<HTMLButtonElement>(".psl__field-use")
    );
    expect(useButtons.length).toBeGreaterThanOrEqual(1);
    // Click the filename Use button — the field's label exposes it
    // next to "Export filename".
    const filenameLabel = Array.from(el.querySelectorAll(".psl__field-label")).find((node) =>
      node.textContent?.includes("Export filename")
    );
    const useButton = filenameLabel?.querySelector<HTMLButtonElement>(".psl__field-use");
    expect(useButton).not.toBeNull();
    await act(async () => {
      useButton?.click();
      await Promise.resolve();
    });

    const filenameCalls = dispatch.mock.calls.filter(
      ([name]) => name === "codex:acceptFilenameStem"
    );
    expect(filenameCalls[0]?.[1]).toEqual({
      captureId: "cap_1",
      filenameStem: "telegram-aquarium-chat-thread"
    });
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
      description: "Codex body",
      filenameStem: "codex-stem"
    });
    const tagCalls = dispatch.mock.calls.filter(([name]) => name === "codex:acceptTag");
    expect(tagCalls).toHaveLength(0);
  });

  test("Bulk Use draft also overrides mid-edit manual values in all three fields", async () => {
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
    expect(filenameInput?.value).toBe("codex-stem");
  });

  test("AI strip hides Use draft once all three text drafts are already accepted", async () => {
    const { el } = await renderDetailRail(
      enrichment({
        suggestedTitle: "Codex headline",
        acceptedTitle: "Codex headline",
        titleAcceptedAt: "2026-05-19T18:00:00.000Z",
        suggestedDescription: "Codex body",
        acceptedDescription: "Codex body",
        descriptionAcceptedAt: "2026-05-19T18:00:00.000Z",
        suggestedFilenameStem: "codex-stem",
        acceptedFilenameStem: "codex-stem",
        filenameAcceptedAt: "2026-05-19T18:00:00.000Z"
      })
    );

    expect(el.querySelector(".ps-codex-pill .psl__chip-btn--accent")).toBeNull();
    // Regenerate stays available.
    expect(el.querySelector(".ps-codex-pill .psl__chip-link")?.textContent).toBe("Regenerate");
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
