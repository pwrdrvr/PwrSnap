import { describe, expect, test } from "vitest";
import {
  AvatarStyleSchema,
  CameraTrackMetadataSchema,
  DEFAULT_AVATAR_STYLE,
  cameraTimeAt,
  recoverCameraTiming,
} from "../camera";

const camera = CameraTrackMetadataSchema.parse({
  version: 1,
  durationSec: 20,
  width: 1280,
  height: 720,
  offsetSec: -3,
  sha256: "a".repeat(64),
  mimeType: "video/mp4",
});

describe("independent camera source time", () => {
  test("recovers impossible old uptime offsets while preserving measured overlaps", () => {
    const old = { ...camera, durationSec: 13.2307, offsetSec: 36276.61846 };
    const recovered = recoverCameraTiming(old, 9.190416)!;
    expect(recovered.timing).toBe("estimated");
    expect(cameraTimeAt(0, recovered)).toBeCloseTo(4.040284);
    expect(cameraTimeAt(9, recovered)).not.toBeNull();
    expect(old.offsetSec).toBe(36276.61846);
    expect(recoverCameraTiming(camera, 10)).toBe(camera);
    expect(recoverCameraTiming({ ...camera, offsetSec: 2 }, 10)?.offsetSec).toBe(2);
    expect(recoverCameraTiming(null, 10)).toBeNull();
  });
  test("pre-roll, cuts and speed changes retain the source-time correspondence", () => {
    expect([0, 1, 8, 8.5, 9].map((time) => cameraTimeAt(time, camera))).toEqual(
      [3, 4, 11, 11.5, 12],
    );
    expect(cameraTimeAt(17, camera)).toBeNull();
    expect(cameraTimeAt(0, { ...camera, offsetSec: 2 })).toBeNull();
    expect(cameraTimeAt(2, { ...camera, offsetSec: 2 })).toBe(0);
    expect(cameraTimeAt(NaN, camera)).toBeNull();
  });
  test("rejects invalid geometry and independently validates placement and timing overrides", () => {
    expect(
      AvatarStyleSchema.safeParse({
        ...DEFAULT_AVATAR_STYLE,
        crop: { x: 0.8, y: 0, width: 0.5, height: 1 },
      }).success,
    ).toBe(false);
    expect(
      AvatarStyleSchema.safeParse({ ...DEFAULT_AVATAR_STYLE, x: Infinity })
        .success,
    ).toBe(false);
    expect(
      AvatarStyleSchema.parse({
        ...DEFAULT_AVATAR_STYLE,
        syncOffsetSec: -0.1,
        visible: false,
      }).visible,
    ).toBe(false);
  });
});
