import { describe, expect, test } from "vitest";
import type { RecordingState } from "@pwrsnap/shared";
import {
  canStartRecordingAttempt,
  canRunRecordingControl,
  recordingBackendCapabilities,
  videoHotkeyAction
} from "../recording-capabilities";

const rect = { x: 10, y: 20, w: 800, h: 600 };

describe("recording backend capabilities", () => {
  test("advertises only implemented ScreenCaptureKit controls and sources", () => {
    expect(recordingBackendCapabilities("darwin")).toEqual({
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
    });
  });

  test("advertises the Windows FFmpeg backend as screen-only", () => {
    expect(recordingBackendCapabilities("win32")).toEqual({
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
    });
  });

  test("does not advertise recording controls on unsupported platforms", () => {
    expect(recordingBackendCapabilities("linux")).toMatchObject({
      backend: "unsupported",
      controls: { stop: false, cancel: false, restart: false, pauseResume: false },
      sources: { screen: false }
    });
  });
});

describe("recording control policy", () => {
  const states: Array<[RecordingState, ReturnType<typeof videoHotkeyAction>]> = [
    [{ phase: "idle" }, "start"],
    [{ phase: "ready", sessionId: "rec-1", captureId: "cap-1" }, "start"],
    [
      {
        phase: "failed",
        sessionId: "rec-1",
        code: "recorder_exited",
        canRetry: true,
        displayId: 1
      },
      "wait"
    ],
    [{ phase: "preflight", sessionId: "rec-1", rect, displayId: 1 }, "cancel"],
    [
      {
        phase: "countdown",
        sessionId: "rec-1",
        secondsRemaining: 2,
        rect,
        displayId: 1
      },
      "cancel"
    ],
    [{ phase: "starting", sessionId: "rec-1", rect, displayId: 1 }, "cancel"],
    [
      {
        phase: "recording",
        sessionId: "rec-1",
        startedAt: new Date(0).toISOString(),
        rect,
        displayId: 1
      },
      "stop"
    ],
    [{ phase: "stopping", sessionId: "rec-1" }, "wait"],
    [{ phase: "processing", sessionId: "rec-1" }, "wait"]
  ];

  test.each(states)("maps $phase to the safe video hotkey action", (state, action) => {
    expect(videoHotkeyAction(state)).toBe(action);
  });

  test.each([
    [{ phase: "idle" }, true],
    [{ phase: "ready", sessionId: "rec-1", captureId: "cap-1" }, true],
    [
      {
        phase: "failed",
        sessionId: "rec-1",
        code: "recorder_exited",
        canRetry: true,
        displayId: 1
      },
      false
    ],
    [{ phase: "processing", sessionId: "rec-1" }, false]
  ] as const)("new recording availability for $phase is $1", (state, expected) => {
    expect(canStartRecordingAttempt(state)).toBe(expected);
  });

  test("permits destructive controls only during phases they can perform", () => {
    const backend = recordingBackendCapabilities("darwin");
    const recording = states[6]![0];
    const countdown = states[4]![0];
    const processing = states[8]![0];

    expect(canRunRecordingControl(recording, backend, "stop")).toBe(true);
    expect(canRunRecordingControl(recording, backend, "restart")).toBe(true);
    expect(canRunRecordingControl(recording, backend, "cancel")).toBe(true);
    expect(canRunRecordingControl(countdown, backend, "cancel")).toBe(true);
    expect(canRunRecordingControl(countdown, backend, "stop")).toBe(false);
    expect(canRunRecordingControl(processing, backend, "cancel")).toBe(false);
  });
});
