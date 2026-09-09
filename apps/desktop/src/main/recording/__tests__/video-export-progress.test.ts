import { beforeEach, describe, expect, test, vi } from "vitest";
import { EVENT_CHANNELS, type VideoExportRequest } from "@pwrsnap/shared";

const mocks = vi.hoisted(() => ({
  broadcastLocal: vi.fn(),
  relayPeer: vi.fn()
}));

vi.mock("../../events", () => ({
  broadcastRendererEventToLocalWindows: mocks.broadcastLocal
}));

vi.mock("../../process-split/event-relay", () => ({
  relayRendererEventToPeer: mocks.relayPeer
}));

const { createVideoExportProgressObserver } = await import("../video-export-progress");

beforeEach(() => {
  mocks.broadcastLocal.mockReset();
  mocks.relayPeer.mockReset();
});

describe("createVideoExportProgressObserver", () => {
  test("broadcasts one identical run-scoped event locally and across the peer relay", () => {
    const request: VideoExportRequest = {
      captureId: "cap-progress",
      format: "gif",
      preset: "high",
      runId: "run-progress"
    };
    const observer = createVideoExportProgressObserver(request);
    expect(observer?.runId).toBe("run-progress");

    observer?.emit({ phase: "encoding", ratio: 0.625 });

    const expected = {
      runId: "run-progress",
      captureId: "cap-progress",
      format: "gif",
      preset: "high",
      phase: "encoding",
      ratio: 0.625
    };
    expect(mocks.broadcastLocal).toHaveBeenCalledOnce();
    expect(mocks.broadcastLocal).toHaveBeenCalledWith(
      EVENT_CHANNELS.renderProgress,
      expected
    );
    expect(mocks.relayPeer).toHaveBeenCalledOnce();
    expect(mocks.relayPeer).toHaveBeenCalledWith(
      EVENT_CHANNELS.renderProgress,
      expected
    );
    expect(mocks.broadcastLocal.mock.calls[0]?.[1]).toBe(
      mocks.relayPeer.mock.calls[0]?.[1]
    );
  });

  test("keeps non-UI callers silent when they omit runId", () => {
    const request: VideoExportRequest = {
      captureId: "cap-headless",
      format: "mp4",
      preset: "low"
    };

    expect(createVideoExportProgressObserver(request)).toBeUndefined();
    expect(mocks.broadcastLocal).not.toHaveBeenCalled();
    expect(mocks.relayPeer).not.toHaveBeenCalled();
  });
});
