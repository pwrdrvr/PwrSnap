// The rail switches to the Cart tab when the user collects their FIRST
// item. It used to also fire when a saved cart merely loaded at launch, and
// from Grid it switched the persisted focus/reel tab, which Grid does not
// show, so the next capture opened in the editor on Cart instead of Info.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import type { CaptureRecord, DraftCart } from "@pwrsnap/shared";
import { CartProvider } from "../CartContext";
import { DetailRail } from "../DetailRail";
import type { LibraryView } from "../library-view";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

const record: CaptureRecord = {
  id: "cap_1",
  kind: "image",
  captured_at: "2026-05-15T18:24:00.000Z",
  legacy_src_path: "/tmp/cap_1.png",
  bundle_path: null,
  flat_png_path: null,
  bundle_modified_at: null,
  bundle_format_version: 2,
  bundle_edits_version: 0,
  width_px: 800,
  height_px: 600,
  device_pixel_ratio: 1,
  byte_size: 1000,
  sha256: "sha_cap_1",
  source_app_bundle_id: null,
  source_app_name: null,
  source_window_title: null,
  edits_version: 0,
  has_alpha: false,
  deleted_at: null
};

function cartOf(captureIds: string[]): DraftCart {
  return {
    name: "Untitled draft",
    captureIds,
    createdAt: "2026-05-15T18:00:00.000Z",
    modifiedAt: "2026-05-15T18:00:00.000Z"
  };
}

const focusView: LibraryView = {
  kind: "focus",
  selectedRecordId: record.id,
  returnAnchor: { scrollTop: 0, cellId: record.id }
};

const gridView: LibraryView = { kind: "grid", selectedRecordId: record.id };

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

async function renderRail(
  savedCart: DraftCart,
  view: LibraryView
): Promise<{
  onActiveTabChange: ReturnType<typeof vi.fn>;
  onGridActiveTabChange: ReturnType<typeof vi.fn>;
  pushCart: (cart: DraftCart) => Promise<void>;
}> {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  window.pwrsnapApi = {
    dispatch: vi.fn(async (name: string) => {
      if (name === "cart:get") return { ok: true, value: savedCart };
      if (name === "capture:presetMetrics") return { ok: true, value: { metrics: [] } };
      return { ok: true, value: undefined };
    }),
    on: (channel: string, handler: (payload: unknown) => void) => {
      const set = handlers.get(channel) ?? new Set<(payload: unknown) => void>();
      set.add(handler);
      handlers.set(channel, set);
      return () => {
        set.delete(handler);
      };
    },
    startCaptureDrag: () => undefined
  } as unknown as NonNullable<Window["pwrsnapApi"]>;
  const onActiveTabChange = vi.fn();
  const onGridActiveTabChange = vi.fn();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(
        CartProvider,
        null,
        createElement(DetailRail, {
          view,
          record,
          pinned: true,
          onPinChange: () => undefined,
          activeTab: "info",
          onActiveTabChange,
          gridActiveTab: "info",
          onGridActiveTabChange
        })
      )
    );
  });
  await flush();
  return {
    onActiveTabChange,
    onGridActiveTabChange,
    pushCart: async (cart) => {
      await act(async () => {
        for (const handler of handlers.get(EVENT_CHANNELS.cartChanged) ?? []) handler({ cart });
      });
      await flush();
    }
  };
}

describe("DetailRail cart auto-pop", () => {
  test("a saved cart loading at launch does not switch the tab", async () => {
    const { onActiveTabChange, onGridActiveTabChange } = await renderRail(
      cartOf(["cap_9"]),
      focusView
    );
    expect(onActiveTabChange).not.toHaveBeenCalledWith("cart");
    expect(onGridActiveTabChange).not.toHaveBeenCalledWith("cart");
  });

  test("collecting the first item in Focus switches to Cart", async () => {
    const { onActiveTabChange, pushCart } = await renderRail(cartOf([]), focusView);
    await pushCart(cartOf(["cap_1"]));
    expect(onActiveTabChange).toHaveBeenCalledWith("cart");
  });

  test("collecting the first item in Grid switches only the grid tab", async () => {
    const { onActiveTabChange, onGridActiveTabChange, pushCart } = await renderRail(
      cartOf([]),
      gridView
    );
    await pushCart(cartOf(["cap_1"]));
    expect(onGridActiveTabChange).toHaveBeenCalledWith("cart");
    expect(onActiveTabChange).not.toHaveBeenCalledWith("cart");
  });
});
