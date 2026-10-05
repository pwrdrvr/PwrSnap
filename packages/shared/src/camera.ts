import { z } from "zod";

/** Coordinates are fractions of the source (crop) or output canvas (placement). */
export const AvatarStyleSchema = z
  .object({
    visible: z.boolean(),
    background: z.enum(["remove", "original"]),
    x: z.number().finite().min(0).max(1),
    y: z.number().finite().min(0).max(1),
    width: z.number().finite().min(0.05).max(1),
    mirror: z.boolean(),
    /** Additional camera delay; positive values show earlier camera frames. */
    syncOffsetSec: z.number().finite().min(-10).max(10).optional(),
    crop: z
      .object({
        x: z.number().finite().min(0).max(0.95),
        y: z.number().finite().min(0).max(0.95),
        width: z.number().finite().min(0.05).max(1),
        height: z.number().finite().min(0.05).max(1),
      })
      .strict()
      .refine((c) => c.x + c.width <= 1.000001 && c.y + c.height <= 1.000001),
  })
  .strict();

export type AvatarStyle = z.infer<typeof AvatarStyleSchema>;
export const DEFAULT_AVATAR_STYLE: AvatarStyle = {
  visible: true,
  background: "remove",
  x: 0.72,
  y: 0.72,
  width: 0.26,
  mirror: true,
  crop: { x: 0, y: 0, width: 1, height: 1 },
};

export const RecordingCameraSchema = z
  .object({
    deviceId: z.string().min(1).max(512),
  })
  .strict();
export type RecordingCamera = z.infer<typeof RecordingCameraSchema>;

/** The source and manifest live in <capture-id>.camera beside the screen file. */
export const CameraTrackMetadataSchema = z
  .object({
    version: z.literal(1),
    durationSec: z.number().finite().positive().max(86400),
    width: z.number().int().min(2).max(8192),
    height: z.number().int().min(2).max(8192),
    offsetSec: z.number().finite().min(-86400).max(86400),
    /** Older recordings with incompatible clock epochs use end-aligned timing. */
    timing: z.literal("estimated").optional(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    mimeType: z.enum(["video/mp4", "video/webm"]),
  })
  .strict();
export type CameraTrackMetadata = z.infer<typeof CameraTrackMetadataSchema>;

/** Repair the old macOS clock-domain bug on read, without rewriting the source
 * or its manifest. Only impossible, widely separated timelines qualify; normal
 * preroll and partially overlapping tracks keep their measured offset. */
export function recoverCameraTiming(
  camera: CameraTrackMetadata | null,
  screenDurationSec: number,
): CameraTrackMetadata | null {
  if (!camera || (camera.offsetSec < screenDurationSec + 60 &&
    camera.offsetSec + camera.durationSec > -60)) return camera;
  return { ...camera, offsetSec: screenDurationSec - camera.durationSec, timing: "estimated" };
}

export function cameraTimeAt(
  screenTime: number,
  camera: CameraTrackMetadata,
): number | null {
  const time = screenTime - camera.offsetSec;
  return Number.isFinite(time) && time >= 0 && time < camera.durationSec
    ? time
    : null;
}
