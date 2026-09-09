import { beforeEach, describe, expect, test } from "vitest";
import {
  acquireInteractiveCaptureSession,
  releaseInteractiveCaptureSession,
  resetInteractiveCaptureSessionForTests
} from "../capture/interactive-capture-session";

beforeEach(() => resetInteractiveCaptureSessionForTests());

describe("cross-mode interactive capture serialization", () => {
  test("a video caller cannot replace an active image picker", () => {
    const image = acquireInteractiveCaptureSession("image");
    expect(image.status).toBe("accepted");
    expect(acquireInteractiveCaptureSession("video")).toEqual({
      status: "busy",
      activeOwner: "image"
    });
  });

  test("an image caller cannot replace an active video picker", () => {
    const video = acquireInteractiveCaptureSession("video");
    expect(video.status).toBe("accepted");
    expect(acquireInteractiveCaptureSession("image")).toEqual({
      status: "busy",
      activeOwner: "video"
    });
  });

  test("only the owning token releases the shared slot", () => {
    const image = acquireInteractiveCaptureSession("image");
    if (image.status !== "accepted") throw new Error("expected image owner");
    expect(releaseInteractiveCaptureSession({ sequence: 1, owner: "image" })).toBe(false);
    expect(acquireInteractiveCaptureSession("video")).toMatchObject({ status: "busy" });
    expect(releaseInteractiveCaptureSession(image.token)).toBe(true);
    expect(acquireInteractiveCaptureSession("video")).toMatchObject({ status: "accepted" });
  });
});
