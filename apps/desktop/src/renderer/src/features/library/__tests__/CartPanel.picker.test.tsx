// The cart's "Add to Existing Sizzle…" picker. Before: it closed only by
// picking or re-clicking. Escape fell through to the Library's own handler
// (which unpinned the inspector rail the cart lives in), focus dropped to
// <body>, and Tab walked off the list with the picker still open.

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { DraftCart, SizzleProject } from "@pwrsnap/shared";

vi.mock("../../../lib/pwrsnap", () => ({
  cacheUrl: (id: string) => `pwrsnap-cache://${id}`,
  captureSrcUrl: (id: string) => `pwrsnap-capture://${id}`,
  dispatch: vi.fn(async () => ({ ok: true, value: { rows: [] } })),
  startCartZipDrag: vi.fn(),
  subscribe: vi.fn(() => () => undefined)
}));

const cart: DraftCart = {
  name: "Untitled draft",
  captureIds: ["cap_waffle"],
  createdAt: "2026-05-15T18:00:00.000Z",
  modifiedAt: "2026-05-15T18:00:00.000Z"
};
vi.mock("../CartContext", () => ({ useCart: () => cart }));

const projects = [
  { id: "p_pancakes", name: "Pancake stack reel", scenes: [] },
  { id: "p_granola", name: "Granola crunch reel", scenes: [] }
] as unknown as SizzleProject[];
vi.mock("../../../lib/useSizzleProjects", () => ({
  useSizzleProjects: () => ({ projects, loading: false })
}));

import { CartPanel } from "../CartPanel";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

function Harness(): ReactElement {
  return (
    <div>
      <CartPanel />
      <button id="after">next control</button>
    </div>
  );
}

async function openPicker(): Promise<HTMLButtonElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(<Harness />));
  const trigger = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === "Add to Existing Sizzle…"
  )!;
  expect(trigger.disabled).toBe(false);
  trigger.focus();
  await act(async () => trigger.click());
  return trigger;
}

function picker(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".psl__cart-picker");
}

describe("CartPanel — Add to Existing Sizzle… picker", () => {
  test("Escape from an option closes the picker only, and focus goes back to its button", async () => {
    // The Library's Escape: a window listener that collapses the rail and
    // does not check defaultPrevented.
    const library = vi.fn();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") library();
    };
    window.addEventListener("keydown", onKey);
    try {
      const trigger = await openPicker();
      expect(picker()).not.toBeNull();
      picker()!.querySelector<HTMLButtonElement>('[role="option"]')!.focus();
      await act(async () => {
        document.activeElement!.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
        );
      });
      expect(picker()).toBeNull();
      expect(library).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(trigger);
    } finally {
      window.removeEventListener("keydown", onKey);
    }
  });

  test("Tab out past the list closes it", async () => {
    await openPicker();
    const options = picker()!.querySelectorAll<HTMLButtonElement>('[role="option"]');
    options[options.length - 1]!.focus();
    await act(async () => {
      document.getElementById("after")!.focus();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(picker()).toBeNull();
    expect(document.activeElement).toBe(document.getElementById("after"));
  });
});
