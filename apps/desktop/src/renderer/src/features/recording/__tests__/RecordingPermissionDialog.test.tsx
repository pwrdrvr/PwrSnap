// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { RecordingPermissionPrompt } from "@pwrsnap/shared";
import { RecordingPermissionDialog } from "../RecordingPermissionDialog";

const dispatch = vi.hoisted(() => vi.fn(async () => ({ ok: true, value: undefined })));
vi.mock("../../../lib/pwrsnap", () => ({ dispatch }));

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  dispatch.mockClear();
});

const basePrompt: RecordingPermissionPrompt = {
  requestId: "permission-1",
  displayId: 1,
  platform: "darwin",
  capabilities: { microphone: true, systemAudio: false },
  missing: [{ permission: "microphone", status: "denied" }]
};

describe("RecordingPermissionDialog", () => {
  test("renders only the requested missing capabilities", () => {
    render(basePrompt);
    expect(container?.textContent).toContain("Microphone");
    expect(container?.textContent).not.toContain("System audio");
  });

  test("screen is required and has no degraded continuation", () => {
    render({
      ...basePrompt,
      capabilities: { microphone: false, systemAudio: false },
      missing: [{ permission: "screen", status: "denied" }]
    });
    expect(buttonNamed("Open System Settings")).not.toBeNull();
    expect(buttonNamed("Continue without screen")).toBeNull();
    expect(container?.textContent).toContain("cannot be skipped");
  });

  test("continues without an optional source for this request", async () => {
    render(basePrompt);
    await act(async () => buttonNamed("Continue without microphone")?.click());
    expect(dispatch).toHaveBeenCalledWith("recording:permissionAction", {
      requestId: "permission-1",
      action: "continueWithout",
      permission: "microphone"
    });
  });

  test("first-use microphone action requests access before promising Settings", async () => {
    render({
      ...basePrompt,
      missing: [{ permission: "microphone", status: "not-determined" }]
    });

    expect(buttonNamed("Open System Settings")).toBeNull();
    await act(async () => buttonNamed("Request microphone access")?.click());
    expect(dispatch).toHaveBeenCalledWith("recording:permissionAction", {
      requestId: "permission-1",
      action: "openSettings",
      permission: "microphone"
    });
  });

  test("restricted access shows managed-policy copy without a Settings promise", () => {
    render({
      ...basePrompt,
      missing: [{ permission: "microphone", status: "restricted" }]
    });
    expect(container?.textContent).toContain("managed by your device or organization");
    expect(buttonNamed("Open System Settings")).toBeNull();
    expect(buttonNamed("Continue without microphone")).not.toBeNull();
  });

  test("Windows video-only audio has truthful copy and no Settings action", () => {
    render({
      ...basePrompt,
      platform: "win32",
      missing: [{ permission: "microphone", status: "unavailable" }]
    });
    expect(container?.textContent).toContain("Windows recorder is video-only");
    expect(buttonNamed("Open System Settings")).toBeNull();
  });

  test("Escape cancels the active prompt", async () => {
    render(basePrompt);
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(dispatch).toHaveBeenCalledWith("recording:permissionAction", {
      requestId: "permission-1",
      action: "cancel"
    });
  });
});

function render(prompt: RecordingPermissionPrompt): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<RecordingPermissionDialog prompt={prompt} />));
}

function buttonNamed(name: string): HTMLButtonElement | null {
  return (
    [...(container?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent?.trim() === name
    ) ?? null
  );
}
