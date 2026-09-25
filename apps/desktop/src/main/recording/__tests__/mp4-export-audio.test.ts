// The omitted-audio default for MP4 exports. The ⌘4–⌘6 shortcuts and any
// HTTP/MCP caller that names no `audio` land here, so this is what stops
// a keystroke from shipping a microphone the grid shows as off.

import { describe, expect, test, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/pwrsnap-mp4-export-audio-test", getVersion: () => "1.0.0" },
  BrowserWindow: { getAllWindows: () => [] }
}));

import {
  mp4AudioFromPreference,
  resolveExportAudio,
  SILENT_EXPORT_AUDIO,
  type Mp4AudioPreference
} from "../mp4-export-audio";

const BOTH = { hasSystemAudio: true, hasMicrophoneAudio: true };
const KEEP_ALL: Mp4AudioPreference = { mp4IncludeMicrophone: true, mp4IncludeSystemAudio: true };

function reader(preference: Mp4AudioPreference) {
  return { readRecordingSettings: vi.fn(async () => preference) };
}

describe("mp4AudioFromPreference", () => {
  test("keeps a recorded track the user keeps and drops one they switched off", () => {
    expect(
      mp4AudioFromPreference(BOTH, { mp4IncludeMicrophone: false, mp4IncludeSystemAudio: true })
    ).toEqual({ includeSystemAudio: true, includeMicrophone: false });
  });

  test("never names a track the take did not record", () => {
    expect(
      mp4AudioFromPreference({ hasSystemAudio: false, hasMicrophoneAudio: true }, KEEP_ALL)
    ).toEqual({ includeSystemAudio: false, includeMicrophone: true });
  });
});

describe("resolveExportAudio", () => {
  test("GIF is silent whatever the caller asked for", async () => {
    const deps = reader(KEEP_ALL);
    await expect(
      resolveExportAudio("gif", { includeSystemAudio: true, includeMicrophone: true }, BOTH, deps)
    ).resolves.toEqual(SILENT_EXPORT_AUDIO);
    expect(deps.readRecordingSettings).not.toHaveBeenCalled();
  });

  test("an explicit MP4 choice wins over the saved preference", async () => {
    const deps = reader({ mp4IncludeMicrophone: false, mp4IncludeSystemAudio: false });
    await expect(
      resolveExportAudio("mp4", { includeSystemAudio: false, includeMicrophone: true }, BOTH, deps)
    ).resolves.toEqual({ includeSystemAudio: false, includeMicrophone: true });
    expect(deps.readRecordingSettings).not.toHaveBeenCalled();
  });

  test("an omitted MP4 choice is the saved preference, narrowed to recorded tracks", async () => {
    const deps = reader({ mp4IncludeMicrophone: false, mp4IncludeSystemAudio: true });
    await expect(resolveExportAudio("mp4", undefined, BOTH, deps)).resolves.toEqual({
      includeSystemAudio: true,
      includeMicrophone: false
    });
  });

  test("a take with no audio skips the settings read", async () => {
    const deps = reader(KEEP_ALL);
    await expect(
      resolveExportAudio("mp4", undefined, { hasSystemAudio: false, hasMicrophoneAudio: false }, deps)
    ).resolves.toEqual(SILENT_EXPORT_AUDIO);
    expect(deps.readRecordingSettings).not.toHaveBeenCalled();
  });

  test("an unreadable preference exports silently, never every track", async () => {
    const deps = {
      readRecordingSettings: vi.fn(async (): Promise<Mp4AudioPreference> => {
        throw new Error("settings unreadable");
      })
    };
    await expect(resolveExportAudio("mp4", undefined, BOTH, deps)).resolves.toEqual(
      SILENT_EXPORT_AUDIO
    );
  });
});
