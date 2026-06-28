import { describe, expect, test } from "vitest";
import type { CaptureRecord } from "@pwrsnap/shared";
import { mergeOpenedLiveRecords } from "../library-records";

function record(id: string, deletedAt: string | null = null): CaptureRecord {
  return {
    id,
    kind: "image",
    captured_at: "2026-05-30T00:00:00.000Z",
    legacy_src_path: null,
    bundle_path: `/tmp/${id}.pwrsnap`,
    flat_png_path: `/tmp/${id}.png`,
    bundle_modified_at: "2026-05-30T00:00:00.000Z",
    bundle_format_version: 2,
    bundle_edits_version: 0,
    width_px: 100,
    height_px: 100,
    device_pixel_ratio: 1,
    byte_size: 10,
    sha256: id.padEnd(64, "0").slice(0, 64),
    source_app_bundle_id: "com.test",
    source_app_name: "Test",
    edits_version: 0,
    has_alpha: false,
    deleted_at: deletedAt
  };
}

describe("mergeOpenedLiveRecords", () => {
  test("supplements live records with opened records missing from the current page", () => {
    expect(
      mergeOpenedLiveRecords([record("a")], [record("b")]).map((r) => r.id)
    ).toEqual(["a", "b"]);
  });

  test("does not resurrect an opened live copy when the fetched row is deleted", () => {
    const merged = mergeOpenedLiveRecords(
      [record("a", "2026-05-30T01:00:00.000Z")],
      [record("a")]
    );

    expect(merged).toEqual([]);
  });
});
