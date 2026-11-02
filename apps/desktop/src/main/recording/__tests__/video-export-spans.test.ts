import { expect, test } from "vitest";
import type { VideoCaptureMetadata } from "@pwrsnap/shared";
import { resolveVideoExportSpans } from "../video-export-spans";

const video = { durationSec: 10, segments: [{ start: 1, end: 8 }] } as VideoCaptureMetadata;
test.each([{ segments: [{ start: 100, end: 101 }] }, { segments: [{ start: 1, end: 1.01 }] }, { segments: [] }])("explicit empty normalized export rejects %j", ({ segments }) => {
  expect(resolveVideoExportSpans(video, { segments })).toMatchObject({ ok: false, error: { kind: "validation", code: "invalid_segments" } });
});
test("explicit partially overlapping segments clamp, while omitted segments use the saved edit", () => {
  expect(resolveVideoExportSpans(video, { segments: [{ start: 8, end: 12 }] })).toMatchObject({ ok: true, value: { spans: [{ start: 8, end: 10 }] } });
  expect(resolveVideoExportSpans(video, {})).toMatchObject({ ok: true, value: { spans: video.segments } });
});
