import { describe, expect, test } from "vitest";
import {
  planWindowsFfmpegCapture,
  WINDOWS_FFMPEG_CAPTURE_CURSOR_DEFAULT
} from "../windows-ffmpeg-capture";

const RECT = { x: -320, y: 48, w: 1920, h: 1080 };
const OUTPUT_PATH = "C:\\Temp\\pwrsnap-recording.mp4";

describe("planWindowsFfmpegCapture", () => {
  test.each([
    { captureCursor: true, effective: true, drawMouse: "1" },
    { captureCursor: false, effective: false, drawMouse: "0" },
    {
      captureCursor: undefined,
      effective: WINDOWS_FFMPEG_CAPTURE_CURSOR_DEFAULT,
      drawMouse: "1"
    }
  ])(
    "maps captureCursor=$captureCursor to gdigrab draw_mouse=$drawMouse",
    ({ captureCursor, effective, drawMouse }) => {
      const plan = planWindowsFfmpegCapture({
        rect: RECT,
        outputPath: OUTPUT_PATH,
        captureCursor
      });

      expect(plan.effectiveCaptureCursor).toBe(effective);
      expect(plan.args[plan.args.indexOf("-draw_mouse") + 1]).toBe(drawMouse);
      expect(plan.args.indexOf("-draw_mouse")).toBeLessThan(plan.args.indexOf("-i"));
      expect(plan.args.at(-1)).toBe(OUTPUT_PATH);
    }
  );
});
