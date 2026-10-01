// The inspector's Duplicate button while a background copy of the same
// recording runs: disabled, so it cannot start a second concurrent copy,
// and back as soon as the copy ends.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { CaptureDuplicateJob, CaptureRecord } from "@pwrsnap/shared";

const dispatchMock = vi.fn();
vi.mock("../../../lib/pwrsnap", () => ({
  dispatch: (...args: unknown[]) => dispatchMock(...args),
  subscribe: () => () => undefined
}));

const { DuplicateChooser } = await import("../DuplicateChooser");
const { DuplicateJobsContext } = await import("../DuplicateProgress");

const record = {
  id: "cap_waffles",
  kind: "video",
  video: null
} as unknown as CaptureRecord;

const job: CaptureDuplicateJob = {
  jobId: "job_waffles",
  sourceId: "cap_waffles",
  captureId: "cap_waffles_copy",
  withEdits: true,
  state: "copying",
  bytesCopied: 10,
  totalBytes: 100,
  error: null
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.pwrsnapApi = { platform: "darwin" } as unknown as NonNullable<Window["pwrsnapApi"]>;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  dispatchMock.mockReset();
});

function render(jobs: ReadonlyMap<string, CaptureDuplicateJob>): void {
  act(() => {
    root.render(
      createElement(
        DuplicateJobsContext.Provider,
        { value: jobs },
        createElement(DuplicateChooser, {
          record,
          prefs: { image: true, video: true },
          onDuplicate: vi.fn()
        })
      )
    );
  });
}

function button(): HTMLButtonElement {
  return container.querySelector("button") as HTMLButtonElement;
}

test("disabled while this recording is being copied, enabled again when the copy ends", () => {
  render(new Map([["cap_waffles", job]]));
  expect(button().disabled).toBe(true);
  expect(button().title).toBe("Copying this recording…");

  render(new Map());
  expect(button().disabled).toBe(false);
  expect(button().title).toMatch(/^Duplicate/);
});

test("a copy of a different recording leaves this one's button alone", () => {
  render(new Map([["cap_pancakes", { ...job, sourceId: "cap_pancakes" }]]));
  expect(button().disabled).toBe(false);
});
