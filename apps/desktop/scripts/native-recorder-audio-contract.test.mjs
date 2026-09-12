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

  // An append COUNT cannot answer "did this source capture audio". A muted
  // input, or a system tap with nothing playing through it, delivers
  // buffers on schedule and appends every one — so counting appends
  // reported a healthy source for a track holding six seconds of digital
  // silence. That is what let a recording claim system audio it never had.
  test("reports audio tracks that carried SOUND, not merely samples", () => {
    expect(recorderSource).toContain('"hasSystemAudio": audioHeardSound');
    expect(recorderSource).toContain('"hasMicrophoneAudio": microphoneHeardSound');
    expect(recorderSource).not.toContain('"hasSystemAudio": audioSamplesAppended > 0');
  });

  test("both sources measure against the shared silence floor", () => {
    expect(recorderSource).toContain("peakAmplitude(of: buf, stopAt: audioSilenceFloor) >= audioSilenceFloor");
    expect(microphoneSource).toContain("peakAmplitude(of: sampleBuffer, stopAt: audioSilenceFloor) >= audioSilenceFloor");
  });
});
