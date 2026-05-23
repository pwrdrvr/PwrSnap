// Unit tests for V1ToV2DoctorBanner — the small banner UI component
// for the Phase 3 v1 → v2 lazy doctor.
//
// Rendering rules:
//   • status === "upgrading"  → "Upgrading capture to v2…" + spinner
//   • status === "view_only"  → warning text + Retry button
//   • status === "irrelevant" → null
//   • status === "ready"      → null
//
// Bare-React + createRoot + act harness; no @testing-library/react.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi
} from "vitest";

import { V1ToV2DoctorBanner } from "../V1ToV2DoctorBanner";
import type { EnsureV2State } from "../useEnsureV2";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(state: EnsureV2State, onRetry: () => void = (): void => {}): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(createElement(V1ToV2DoctorBanner, { state, onRetry }));
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  if (host !== null) {
    document.body.removeChild(host);
    host = null;
  }
  root = null;
});

describe("V1ToV2DoctorBanner", () => {
  test("upgrading: shows 'Upgrading capture to v2…' text; no retry button", () => {
    render({ status: "upgrading" });
    const banner = host!.querySelector('[data-testid="v1v2-doctor-banner"]');
    expect(banner).not.toBeNull();
    expect(banner!.getAttribute("data-state")).toBe("upgrading");
    expect(banner!.textContent).toContain("Upgrading capture to v2");
    const retry = host!.querySelector('[data-testid="v1v2-doctor-retry"]');
    expect(retry).toBeNull();
  });

  test("view_only: shows read-only message + Retry button + errorCode", () => {
    render({
      status: "view_only",
      errorCode: "manifest_invalid",
      attempts: 5
    });
    const banner = host!.querySelector('[data-testid="v1v2-doctor-banner"]');
    expect(banner).not.toBeNull();
    expect(banner!.getAttribute("data-state")).toBe("view_only");
    expect(banner!.textContent).toContain("Couldn");
    expect(banner!.textContent).toContain("read-only view");
    expect(banner!.textContent).toContain("manifest_invalid");
    const retry = host!.querySelector('[data-testid="v1v2-doctor-retry"]');
    expect(retry).not.toBeNull();
  });

  test("view_only: clicking Retry calls onRetry", () => {
    const onRetry = vi.fn();
    render(
      { status: "view_only", errorCode: "disk_full", attempts: 5 },
      onRetry
    );
    const retry = host!.querySelector<HTMLButtonElement>(
      '[data-testid="v1v2-doctor-retry"]'
    );
    expect(retry).not.toBeNull();
    act(() => {
      retry!.click();
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test("irrelevant: renders null", () => {
    render({ status: "irrelevant" });
    const banner = host!.querySelector('[data-testid="v1v2-doctor-banner"]');
    expect(banner).toBeNull();
    // Container should also be empty.
    expect(host!.children.length).toBe(0);
  });

  test("ready: renders null", () => {
    render({ status: "ready" });
    const banner = host!.querySelector('[data-testid="v1v2-doctor-banner"]');
    expect(banner).toBeNull();
    expect(host!.children.length).toBe(0);
  });
});
