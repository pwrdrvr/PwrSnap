import type { usePreparedVideoPlayback } from "./usePreparedVideoPlayback";

export function VideoPlaybackStatus({ playback }: { playback: ReturnType<typeof usePreparedVideoPlayback> }) {
  if (!playback.audioUnavailable) return null;
  return (
    <div className="video-playback-status" role="status">
      <span>{playback.phase === "error" ? "Audio preview unavailable" : "Preparing audio..."}</span>
      {playback.phase === "error" && <button type="button" onClick={playback.retry}>Retry audio</button>}
    </div>
  );
}
