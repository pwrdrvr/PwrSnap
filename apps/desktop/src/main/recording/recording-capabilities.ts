import type {
  RecordingBackendCapabilities,
  RecordingState
} from "@pwrsnap/shared";
import { canStartRecordingAttempt } from "@pwrsnap/shared";

export { canStartRecordingAttempt };

export type RecordingControlAction = "start" | "stop" | "cancel" | "restart" | "wait";

/**
 * Describe only operations implemented end-to-end by the selected recorder.
 * Keep this pure so platform behavior is testable from any CI host.
 */
export function recordingBackendCapabilities(
  platform: NodeJS.Platform = process.platform
): RecordingBackendCapabilities {
  if (platform === "darwin") {
    return {
      backend: "macos-native",
      controls: { stop: true, cancel: true, restart: true, pauseResume: false },
      sources: {
        screen: true,
        systemAudio: true,
        microphone: true,
        webcam: false,
        liveAudioLevels: false,
        liveDisconnectDetection: false,
        midRecordingToggles: false
      },
      controllerExcludedFromCapture: true
    };
  }

  if (platform === "win32") {
    return {
      backend: "windows-ffmpeg",
      controls: { stop: true, cancel: true, restart: true, pauseResume: false },
      sources: {
        screen: true,
        systemAudio: false,
        microphone: false,
        webcam: false,
        liveAudioLevels: false,
        liveDisconnectDetection: false,
        midRecordingToggles: false
      },
      controllerExcludedFromCapture: false
    };
  }

  return {
    backend: "unsupported",
    controls: { stop: false, cancel: false, restart: false, pauseResume: false },
    sources: {
      screen: false,
      systemAudio: false,
      microphone: false,
      webcam: false,
      liveAudioLevels: false,
      liveDisconnectDetection: false,
      midRecordingToggles: false
    },
    controllerExcludedFromCapture: false
  };
}

/**
 * Action performed when the user presses the video-capture hotkey. A second
 * press is a real toggle only while recording; during lead-in it cancels, and
 * during finalization it is ignored so concurrent transitions cannot corrupt
 * the output.
 */
export function videoHotkeyAction(state: RecordingState): RecordingControlAction {
  switch (state.phase) {
    case "idle":
    case "ready":
      return "start";
    case "failed":
      // Failure UX owns retry/dismissal and may retain a private restart
      // snapshot. A generic hotkey start must not bypass that recovery state.
      return "wait";
    case "preflight":
    case "countdown":
    case "starting":
      return "cancel";
    case "recording":
      return "stop";
    case "stopping":
    case "processing":
      return "wait";
  }
}

export function canRunRecordingControl(
  state: RecordingState,
  capabilities: RecordingBackendCapabilities,
  action: Exclude<RecordingControlAction, "start" | "wait">
): boolean {
  switch (action) {
    case "stop":
      return state.phase === "recording" && capabilities.controls.stop;
    case "restart":
      return state.phase === "recording" && capabilities.controls.restart;
    case "cancel":
      return (
        capabilities.controls.cancel &&
        (state.phase === "preflight" ||
          state.phase === "countdown" ||
          state.phase === "starting" ||
          state.phase === "recording")
      );
  }
}
