import type { ReactElement } from "react";
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { ShortcutPlatform } from "@pwrsnap/shared";
import { VideoExportPresetGrid } from "../VideoExportPresetGrid";
import {
  useSurfaceCopyShortcuts,
  type SurfaceCopyAssetKind,
  type SurfaceCopyShortcut
} from "../useSurfaceCopyShortcuts";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.restoreAllMocks();
});

function Harness({
  assetKind,
  platform,
  onShortcut,
  onGridCopy
}: {
  assetKind: SurfaceCopyAssetKind;
  platform: ShortcutPlatform;
  onShortcut: (shortcut: SurfaceCopyShortcut) => void;
  onGridCopy: () => void;
}): ReactElement {
  useSurfaceCopyShortcuts({
    assetKind,
    enabled: true,
    platform,
    onShortcut
  });
  const gridProps = {
    metrics: {},
    states: {},
    onCopy: onGridCopy,
    onCopyPath: vi.fn(),
    onDrag: vi.fn(),
    shortcutPlatform: platform
  } as const;
  return createElement(
    Fragment,
    null,
    createElement(VideoExportPresetGrid, gridProps),
    createElement(VideoExportPresetGrid, gridProps)
  );
}

async function renderHarness(
  platform: ShortcutPlatform,
  assetKind: SurfaceCopyAssetKind,
  onShortcut: (shortcut: SurfaceCopyShortcut) => void,
  onGridCopy: () => void
): Promise<void> {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(Harness, { platform, assetKind, onShortcut, onGridCopy }));
  });
}

describe("useSurfaceCopyShortcuts", () => {
  test("one win32 surface owner dispatches one video export despite multiple grids", async () => {
    const addListener = vi.spyOn(window, "addEventListener");
    const onShortcut = vi.fn();
    const onGridCopy = vi.fn();
    await renderHarness("win32", "video", onShortcut, onGridCopy);

    expect(addListener.mock.calls.filter(([name]) => name === "keydown")).toHaveLength(1);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "5", metaKey: true }));
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "5", metaKey: true, ctrlKey: true })
      );
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "5", ctrlKey: true }));
    });

    expect(onShortcut).toHaveBeenCalledTimes(1);
    expect(onShortcut).toHaveBeenCalledWith({ kind: "video", format: "mp4", preset: "med" });
    expect(onGridCopy).not.toHaveBeenCalled();
  });

  test("darwin image ownership is exact and keeps Ctrl distinct from Command", async () => {
    const onShortcut = vi.fn();
    await renderHarness("darwin", "image", onShortcut, vi.fn());

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "2", ctrlKey: true }));
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "2", metaKey: true, ctrlKey: true })
      );
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "2", metaKey: true }));
    });

    expect(onShortcut).toHaveBeenCalledTimes(1);
    expect(onShortcut).toHaveBeenCalledWith({ kind: "image", preset: "med" });
  });
});
