import { describe, expect, test } from "vitest";

import {
  emptyPortableBundleMetadata,
  parsePortableBundleMetadata,
  serializePortableBundleMetadata
} from "../portable-bundle-metadata";

describe("portable bundle metadata bounds", () => {
  test("rejects aggregate descriptors over the carrier byte cap", () => {
    const metadata = emptyPortableBundleMetadata();
    metadata.document = {
      portable_chunks: Array.from({ length: 9 }, () => "x".repeat(64 * 1024))
    };
    expect(() => serializePortableBundleMetadata(metadata)).toThrowError(
      expect.objectContaining({ name: "PortableBundleMetadataError" })
    );
  });

  test("rejects prototype-related keys inside persisted portable values", () => {
    const serialized = JSON.stringify(emptyPortableBundleMetadata()).replace(
      '"manifest":{}',
      '"manifest":{"portable_value":{"constructor":{"polluted":true}}}'
    );
    expect(() => parsePortableBundleMetadata(serialized)).toThrowError(
      expect.objectContaining({ name: "PortableBundleMetadataError" })
    );
  });

  test("rejects prototype-related AI identity map keys", () => {
    const serialized = JSON.stringify(emptyPortableBundleMetadata()).replace(
      '"aiRuns":{}',
      '"aiRuns":{"__proto__":{"portable_vendor":"value"}}'
    );
    expect(() => parsePortableBundleMetadata(serialized)).toThrowError(
      expect.objectContaining({ name: "PortableBundleMetadataError" })
    );
  });

  test("rejects non-object identity descriptors", () => {
    const serialized = JSON.stringify(emptyPortableBundleMetadata()).replace(
      '"layers":{}',
      '"layers":{"abcdefghijklmnop":"bad"}'
    );
    expect(() => parsePortableBundleMetadata(serialized)).toThrowError(
      expect.objectContaining({ name: "PortableBundleMetadataError" })
    );
  });
});
