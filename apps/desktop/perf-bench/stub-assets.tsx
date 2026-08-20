// Bench stand-in for `useVideoTimelineAssets` — a fixed filmstrip
// descriptor, no audio, no IPC.
export type VideoTimelineAssets = {
  frames: { url: string; frameCount: number } | null;
  audioBlob: Blob | null | undefined;
};

const FRAMES = {
  url:
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="56"><rect width="1920" height="56" fill="#222"/></svg>`
    ),
  frameCount: 24
};

export function useVideoTimelineAssets(): VideoTimelineAssets {
  return { frames: FRAMES as never, audioBlob: null };
}
