import { describe, expect, test } from "vitest";
import {
  planWindowsFfmpegCapture,
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
