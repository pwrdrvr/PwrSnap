// Pure FFmpeg invocation planner for the Windows gdigrab recording backend.
// Kept free of Electron and process-platform checks so its input-option ordering
// and cursor-default contract can be exercised on every CI platform.

export type WindowsFfmpegCaptureRect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type WindowsFfmpegCapturePlan = {
  args: string[];
  effectiveCaptureCursor: boolean;
};

export const WINDOWS_FFMPEG_CAPTURE_CURSOR_DEFAULT = true;

export function planWindowsFfmpegCapture(input: {
  rect: WindowsFfmpegCaptureRect;
  outputPath: string;
  captureCursor?: boolean | undefined;
}): WindowsFfmpegCapturePlan {
  const effectiveCaptureCursor =
    input.captureCursor ?? WINDOWS_FFMPEG_CAPTURE_CURSOR_DEFAULT;

  return {
    effectiveCaptureCursor,
    args: [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-y",
      "-f",
      "gdigrab",
      "-framerate",
      "30",
      "-offset_x",
      String(input.rect.x),
      "-offset_y",
      String(input.rect.y),
      "-video_size",
      `${input.rect.w}x${input.rect.h}`,
      // `draw_mouse` is a gdigrab input option, so it must stay before `-i`.
      "-draw_mouse",
      effectiveCaptureCursor ? "1" : "0",
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
      input.outputPath
    ]
  };
}
