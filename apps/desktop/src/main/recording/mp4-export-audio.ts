// Which audio tracks an MP4 export keeps when the caller did not say.
//
// The export grids send an explicit `audio` choice, but not every path
// does: the tray's and the Library grid's ⌘4–⌘6 shortcuts dispatch
// `clipboard:copyVideoFile` with only (captureId, format, preset), and an
// HTTP/MCP caller may omit it too. Before the MP4 audio toggle, "omitted"
// meant "every recorded track", so a user who switched the mic off on
// the grid could still send it with a keystroke. Every verb that fills
// in a missing choice (`video:export`, `video:presetMetrics`, and the
// resolver behind copy-file, copy-path and drag) now asks this module,
// so omitted means "what the user keeps".
//
// If the preference cannot be read, the export is SILENT rather than
// "every track": this setting exists because audio leaked when nobody
// was looking, and a hiccup must not re-open that.

import type { Settings, VideoCaptureMetadata, VideoExportAudio } from "@pwrsnap/shared";
import { getMainLogger } from "../log";
import { getDesktopSettingsStore } from "../settings/desktop-settings-store";

const log = getMainLogger("pwrsnap:mp4-export-audio");

export const SILENT_EXPORT_AUDIO: VideoExportAudio = Object.freeze({
  includeSystemAudio: false,
  includeMicrophone: false
});

export type Mp4AudioPreference = Pick<
  Settings["recording"],
  "mp4IncludeMicrophone" | "mp4IncludeSystemAudio"
>;

type RecordedTracks = Pick<VideoCaptureMetadata, "hasSystemAudio" | "hasMicrophoneAudio">;

/** An audio choice narrowed to the tracks the take has. The result
 *  never names a missing track, so it always passes the
 *  `audio_track_missing` check. */
export function narrowAudioToRecorded(
  audio: VideoExportAudio,
  video: RecordedTracks
): VideoExportAudio {
  return {
    includeSystemAudio: video.hasSystemAudio && audio.includeSystemAudio,
    includeMicrophone: video.hasMicrophoneAudio && audio.includeMicrophone
  };
}

/** The tracks the take has, narrowed to the ones the user keeps. */
export function mp4AudioFromPreference(
  video: RecordedTracks,
  preference: Mp4AudioPreference
): VideoExportAudio {
  return narrowAudioToRecorded(
    {
      includeSystemAudio: preference.mp4IncludeSystemAudio,
      includeMicrophone: preference.mp4IncludeMicrophone
    },
    video
  );
}

export type ResolveExportAudioDependencies = {
  readRecordingSettings: () => Promise<Mp4AudioPreference>;
};

const productionDependencies: ResolveExportAudioDependencies = {
  readRecordingSettings: () => getDesktopSettingsStore().readDomain("recording")
};

/**
 * The audio an export encodes. GIF is always silent; an explicit MP4
 * choice is returned as given (the caller validates it against the
 * source); an omitted one comes from the user's preference.
 */
export async function resolveExportAudio(
  format: "gif" | "mp4",
  requested: VideoExportAudio | undefined,
  video: RecordedTracks,
  dependencies: ResolveExportAudioDependencies = productionDependencies
): Promise<VideoExportAudio> {
  if (format === "gif") return SILENT_EXPORT_AUDIO;
  if (requested !== undefined) return requested;
  // Nothing to keep: skip the settings read entirely.
  if (!video.hasSystemAudio && !video.hasMicrophoneAudio) return SILENT_EXPORT_AUDIO;
  try {
    return mp4AudioFromPreference(video, await dependencies.readRecordingSettings());
  } catch (cause) {
    log.warn("MP4 audio preference unreadable; exporting without audio", {
      message: cause instanceof Error ? cause.message : String(cause)
    });
    return SILENT_EXPORT_AUDIO;
  }
}
