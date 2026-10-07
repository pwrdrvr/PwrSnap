import { describe, expect, test } from "vitest";
import {
  planWindowsFfmpegCapture,
  windowsCaptureStartUtcMs,
  WINDOWS_FFMPEG_CAPTURE_CURSOR_DEFAULT
} from "../windows-ffmpeg-capture";

const RECT = { x: -320, y: 48, w: 1920, h: 1080 };
const OUTPUT_PATH = "C:\\Temp\\pwrsnap-recording.mp4";

function expectedArgs(drawMouse: "0" | "1"): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-y",
    "-f",
    "gdigrab",
    "-framerate",
    "30",
    "-offset_x",
    "-320",
    "-offset_y",
    "48",
    "-video_size",
    "1920x1080",
    "-draw_mouse",
    drawMouse,
    "-i",
    "desktop",
    "-an",
    "-c:v",
    "h264_mf",
    "-b:v",
    "8M",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    OUTPUT_PATH
  ];
}

describe("planWindowsFfmpegCapture", () => {
  test.each([
    { label: "explicit true", captureCursor: true, effective: true, drawMouse: "1" as const },
    { label: "explicit false", captureCursor: false, effective: false, drawMouse: "0" as const },
    {
      label: "omitted default",
      captureCursor: undefined,
      effective: WINDOWS_FFMPEG_CAPTURE_CURSOR_DEFAULT,
      drawMouse: "1" as const
    }
  ])(
    "plans the complete gdigrab invocation for $label",
    ({ captureCursor, effective, drawMouse }) => {
      const plan = planWindowsFfmpegCapture({
        rect: RECT,
        outputPath: OUTPUT_PATH,
        captureCursor
      });

      expect(plan.effectiveCaptureCursor).toBe(effective);
      expect(plan.args).toEqual(expectedArgs(drawMouse));
      expect(plan.args.indexOf("-draw_mouse")).toBeLessThan(plan.args.indexOf("-i"));
    }
  );
});

test("camera sync uses the input's first-frame UTC timestamp, independent of process startup", () => {
  expect(windowsCaptureStartUtcMs("[gdigrab] Capturing desktop\nInput #0, gdigrab, from 'desktop':\n  Duration: N/A, start: 1791150123.123456, bitrate: 500 kb/s")).toBeCloseTo(1791150123123.456, 2);
  expect(windowsCaptureStartUtcMs("Duration: N/A, start: 0.000000")).toBeNull();
  const plan = planWindowsFfmpegCapture({ rect: RECT, outputPath: OUTPUT_PATH, cameraSync: true });
  expect(plan.args).toContain("-nostats");
  expect(plan.args[plan.args.indexOf("-loglevel") + 1]).toBe("info");
});
