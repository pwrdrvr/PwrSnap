import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const recorderSource = readFileSync(
  resolve(import.meta.dirname, "..", "native", "recorder", "main.swift"),
  "utf8"
);
const microphoneSource = readFileSync(
  resolve(import.meta.dirname, "..", "native", "recorder", "microphone.swift"),
  "utf8"
);

describe("native recorder audio contract", () => {
  test("retains the AVCapture microphone delegate for the recording lifetime", () => {
    expect(recorderSource).toContain("private var micForwarder: MicForwarder?");
    expect(recorderSource).toContain("micForwarder = forwarder");
    expect(recorderSource).toContain("setSampleBufferDelegate(forwarder, queue: writeQueue)");
    expect(microphoneSource).toContain("writer.status == .writing");
  });

  test("requested microphone setup cannot silently skip an unavailable device", () => {
    expect(recorderSource).toContain("guard setUpMicrophoneCapture(into: mi, writer: writer) else { return }");
    expect(recorderSource).toContain("guard session.canAddInput(micInputDevice) else");
    expect(recorderSource).toContain("guard session.canAddOutput(micOutput) else");
    expect(recorderSource).toContain("guard session.isRunning else");
    expect(recorderSource).toContain('emitError("microphone_unavailable"');
  });

  test("reports only audio tracks that appended at least one sample", () => {
    expect(recorderSource).toContain('"hasSystemAudio": audioSamplesAppended > 0');
    expect(recorderSource).toContain('"hasMicrophoneAudio": microphoneSamplesAppended > 0');
  });
});
