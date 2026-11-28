// The cart's export block. The headline rule is NO LAYOUT SHIFT: whatever
// the mode and whatever state a job is in, the block renders the same four
// fixed-height rows (picker, strip, card row, status line), always three
// cards, and the status line even when it is blank. jsdom has no layout, so
// this pins the structure the fixed CSS grid relies on; the heights are in
// library.css (`.psl__cart-export`).

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { CaptureRecord } from "@pwrsnap/shared";

const pw = vi.hoisted(() => ({
  dispatch: vi.fn(async (_name: string, _req: unknown): Promise<unknown> => ({ ok: true, value: {} })),
  startCartZipDrag: vi.fn(),
  startCartFilesDrag: vi.fn(),
  startCartSheetDrag: vi.fn()
}));

vi.mock("../../../lib/pwrsnap", () => ({
  cacheUrl: (id: string) => `pwrsnap-cache://${id}`,
  dispatch: pw.dispatch,
  startCartZipDrag: pw.startCartZipDrag,
  startCartFilesDrag: pw.startCartFilesDrag,
  startCartSheetDrag: pw.startCartSheetDrag,
  subscribe: vi.fn(() => () => undefined)
}));

import { CartExportPanel } from "../CartExportPanel";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

function rec(id: string, over: Partial<CaptureRecord> = {}): CaptureRecord {
  return {
    id,
    kind: "image",
    width_px: 1600,
    height_px: 1000,
    byte_size: 400_000,
    edits_version: 0,
    deleted_at: null,
    ...over
  } as unknown as CaptureRecord;
}

const ids = ["cereal_grid", "oat_checkout", "bran_banner", "flakes_clip"];
const records = new Map<string, CaptureRecord | null>([
  ["cereal_grid", rec("cereal_grid")],
  ["oat_checkout", rec("oat_checkout")],
  ["bran_banner", rec("bran_banner", { width_px: 2200, height_px: 1000 })],
  ["flakes_clip", rec("flakes_clip", { kind: "video" })]
]);

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  host = null;
  root = null;
  vi.clearAllMocks();
});

async function mount(): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <CartExportPanel captureIds={ids} records={records} settling={false} suggestedName="Cereal aisle" />
    )
  );
  return host.querySelector<HTMLElement>(".psl__cart-export")!;
}

function modeButton(label: string): HTMLButtonElement {
  return [...document.querySelectorAll<HTMLButtonElement>(".psl__cart-export-mode")].find(
    (b) => b.textContent === label
  )!;
}

function rowShape(block: HTMLElement): string[] {
  return [...block.children].map((child) => child.className.split(" ")[0]!);
}

const SHAPE = ["psl__cart-export-modes", "psl__cart-export-strip", "psl__copy-row", "psl__cart-export-status"];

describe("CartExportPanel", () => {
  test("every mode renders the same four rows and three cards, with the status line present at rest", async () => {
    const block = await mount();
    for (const label of ["Copy all", "Zip", "Contact sheet", "Copy all"]) {
      await act(async () => modeButton(label).click());
      expect(modeButton(label).getAttribute("aria-checked")).toBe("true");
      expect(rowShape(block)).toEqual(SHAPE);
      expect(block.querySelectorAll(".fo__copy-card")).toHaveLength(3);
    }
  });

  test("a running job and its result keep the same rows", async () => {
    let finish!: (value: unknown) => void;
    pw.dispatch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const block = await mount();
    await act(async () => modeButton("Copy all").click());
    const med = [...block.querySelectorAll<HTMLButtonElement>(".fo__copy-btn")][1]!;
    await act(async () => med.click());
    expect(pw.dispatch).toHaveBeenCalledWith(
      "cart:copyAll",
      expect.objectContaining({ captureIds: ids, preset: "med" })
    );
    expect(rowShape(block)).toEqual(SHAPE);
    expect(block.querySelector(".psl__cart-zip-cancel")).not.toBeNull();

    await act(async () => finish({ ok: true, value: { fileCount: 3, skipped: 1, failed: 0 } }));
    expect(rowShape(block)).toEqual(SHAPE);
    expect(block.querySelector(".psl__cart-export-status")?.textContent).toBe("Copied 3 images · 1 left out");
  });

  test("the strip counts images and says what was left out", async () => {
    const block = await mount();
    await act(async () => modeButton("Copy all").click());
    expect(block.querySelector(".psl__cart-export-strip-text")?.textContent).toBe(
      "3 images · paste as files · 1 left out"
    );
  });

  test("contact sheet cards are the three sheet widths and copy the sheet with the current layout", async () => {
    const block = await mount();
    await act(async () => modeButton("Contact sheet").click());
    const labels = [...block.querySelectorAll(".fo__copy-label")].map((n) => n.textContent);
    expect(labels).toEqual(["S", "M", "L"]);
    await act(async () => block.querySelectorAll<HTMLButtonElement>(".fo__copy-btn")[2]!.click());
    expect(pw.dispatch).toHaveBeenCalledWith(
      "cart:contactSheet",
      expect.objectContaining({
        size: "l",
        action: "copy",
        layout: { columns: "auto", spacing: "tight", background: "hatch" }
      })
    );
  });

  test("Layout… opens over the cart, Escape closes it and focus returns to Layout…", async () => {
    const block = await mount();
    await act(async () => modeButton("Contact sheet").click());
    const trigger = [...block.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "Layout…"
    )!;
    trigger.focus();
    await act(async () => trigger.click());
    const pop = block.querySelector<HTMLElement>(".psl__sheet-pop")!;
    expect(pop).not.toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    // The popover rides inside the strip, so the four rows are unchanged.
    expect(rowShape(block)).toEqual(SHAPE);

    const four = [...pop.querySelectorAll<HTMLButtonElement>(".psl__sheet-seg-btn")].find(
      (b) => b.textContent === "4"
    )!;
    four.focus();
    await act(async () => four.click());
    expect(block.querySelector(".psl__cart-export-strip-text")?.textContent).toContain("4 cols");

    await act(async () => {
      four.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(block.querySelector(".psl__sheet-pop")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  test("the chips drag what their mode makes", async () => {
    const block = await mount();
    const dragChip = async (index: number): Promise<void> => {
      const chip = block.querySelectorAll<HTMLAnchorElement>(".fo__copy-file")[index]!;
      await act(async () => {
        chip.dispatchEvent(new Event("dragstart", { bubbles: true, cancelable: true }));
      });
    };
    await act(async () => modeButton("Copy all").click());
    await dragChip(0);
    expect(pw.startCartFilesDrag).toHaveBeenCalledWith(ids, "low");
    await act(async () => modeButton("Zip").click());
    await dragChip(1);
    expect(pw.startCartZipDrag).toHaveBeenCalledWith(ids, "med", "Cereal aisle");
    await act(async () => modeButton("Contact sheet").click());
    await dragChip(2);
    expect(pw.startCartSheetDrag).toHaveBeenCalledWith(ids, "l", expect.any(Object), "Cereal aisle");
  });
});
