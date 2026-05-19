// Defense-layer tests for ClipboardLayerFragmentV1 — the zod-validated
// wire format carried over the macOS pasteboard via the private UTI
// `com.pwrdrvr.pwrsnap.layer-fragment`. The clipboard is the most
// adversarial input surface in the v2 plan: any process on the user's
// box can write whatever bytes it wants under any UTI. The handler in
// apps/desktop layers five defenses (size cap, count cap, zod schema,
// sha256 verify, sharp probe). Defenses 2 and 3 (count caps + schema)
// live in THIS file's contract; the others are exercised in the
// handler's tests / E2E.
//
// Each test maps to the v2 plan's "Clipboard — private UTI with
// defense-in-depth" section.

import { describe, expect, test } from "vitest";

import {
  CLIPBOARD_FRAGMENT_MAX_BYTES,
  CLIPBOARD_FRAGMENT_MAX_LAYERS,
  CLIPBOARD_FRAGMENT_MAX_SOURCES,
  CLIPBOARD_LAYER_FRAGMENT_UTI,
  ClipboardLayerFragmentV1,
  ClipboardSourceRef
} from "../clipboard-layer-fragment";
import type { BundleLayerNode } from "../bundle-manifest-schema-v2";

// --------------------------------------------------------------------
// Constants — invariants the handler relies on
// --------------------------------------------------------------------

describe("clipboard-layer-fragment constants", () => {
  test("size cap is 64 MiB", () => {
    expect(CLIPBOARD_FRAGMENT_MAX_BYTES).toBe(64 * 1024 * 1024);
  });

  test("layer count cap matches BundleDocumentV2 (4096)", () => {
    expect(CLIPBOARD_FRAGMENT_MAX_LAYERS).toBe(4_096);
  });

  test("source count cap is bounded", () => {
    expect(CLIPBOARD_FRAGMENT_MAX_SOURCES).toBe(256);
  });

  test("UTI matches the bundle id reverse-DNS prefix", () => {
    expect(CLIPBOARD_LAYER_FRAGMENT_UTI).toBe("com.pwrdrvr.pwrsnap.layer-fragment");
  });
});

// --------------------------------------------------------------------
// ClipboardSourceRef — sha256 + base64 input shape
// --------------------------------------------------------------------

describe("ClipboardSourceRef", () => {
  const validRef = {
    sha256: "a".repeat(64),
    png_base64: "iVBORw0KGgo="
  };

  test("accepts a well-formed source ref", () => {
    expect(() => ClipboardSourceRef.parse(validRef)).not.toThrow();
  });

  test("rejects sha256 that isn't 64 lowercase hex chars", () => {
    expect(() => ClipboardSourceRef.parse({ ...validRef, sha256: "a".repeat(63) })).toThrow();
    expect(() => ClipboardSourceRef.parse({ ...validRef, sha256: "a".repeat(65) })).toThrow();
    expect(() => ClipboardSourceRef.parse({ ...validRef, sha256: "A".repeat(64) })).toThrow();
    expect(() => ClipboardSourceRef.parse({ ...validRef, sha256: "g".repeat(64) })).toThrow();
  });

  test("rejects non-base64 characters in png_base64", () => {
    expect(() => ClipboardSourceRef.parse({ ...validRef, png_base64: "not base64!" })).toThrow();
    expect(() => ClipboardSourceRef.parse({ ...validRef, png_base64: "abc\ndef" })).toThrow();
    expect(() => ClipboardSourceRef.parse({ ...validRef, png_base64: "ab cd" })).toThrow();
  });

  test("rejects empty png_base64", () => {
    expect(() => ClipboardSourceRef.parse({ ...validRef, png_base64: "" })).toThrow();
  });

  test("rejects png_base64 that exceeds 80 MiB", () => {
    // We can't easily synthesize an 80 MiB+ string in test; instead
    // assert the constraint exists on the schema definition by
    // crafting a string at the cap+1 boundary. JS string allocation
    // for this is the test's only cost.
    const overCap = "A".repeat(80 * 1024 * 1024 + 1);
    expect(() => ClipboardSourceRef.parse({ ...validRef, png_base64: overCap })).toThrow();
  });
});

// --------------------------------------------------------------------
// ClipboardLayerFragmentV1 — envelope + count caps + datetime
// --------------------------------------------------------------------

function makeLayer(id: string, parent: string | null = null): BundleLayerNode {
  const stamp = "2026-05-12T00:00:00.000Z";
  return {
    id,
    parent_id: parent,
    kind: "group",
    collapsed: false,
    name: "g",
    visible: true,
    locked: false,
    opacity: 1,
    blend_mode: "normal",
    transform: [1, 0, 0, 1, 0, 0],
    z_index: 0,
    source: "user",
    ai_run_id: null,
    applied_at: stamp,
    rejected_at: null,
    superseded_by: null,
    created_at: stamp
  } as BundleLayerNode;
}

const validFragment = {
  format_version: 1 as const,
  source_capture_id: "cap-abc123def",
  layers: [makeLayer("layerabcdef12345")],
  source_refs: [],
  copied_at: "2026-05-12T00:00:00.000Z"
};

describe("ClipboardLayerFragmentV1", () => {
  test("accepts a minimal well-formed fragment", () => {
    expect(() => ClipboardLayerFragmentV1.parse(validFragment)).not.toThrow();
  });

  test("rejects format_version other than literal 1", () => {
    expect(() =>
      ClipboardLayerFragmentV1.parse({ ...validFragment, format_version: 2 })
    ).toThrow();
    expect(() =>
      ClipboardLayerFragmentV1.parse({ ...validFragment, format_version: 0 })
    ).toThrow();
  });

  test("rejects source_capture_id shorter than 8 chars", () => {
    expect(() =>
      ClipboardLayerFragmentV1.parse({ ...validFragment, source_capture_id: "short" })
    ).toThrow();
  });

  test("rejects source_capture_id longer than 32 chars", () => {
    expect(() =>
      ClipboardLayerFragmentV1.parse({ ...validFragment, source_capture_id: "x".repeat(33) })
    ).toThrow();
  });

  test("rejects layers array exceeding CLIPBOARD_FRAGMENT_MAX_LAYERS (DoS guard)", () => {
    const layers = Array.from({ length: CLIPBOARD_FRAGMENT_MAX_LAYERS + 1 }, (_, i) =>
      makeLayer(`l${String(i).padStart(15, "0")}`)
    );
    expect(() => ClipboardLayerFragmentV1.parse({ ...validFragment, layers })).toThrow();
  });

  test("rejects source_refs array exceeding CLIPBOARD_FRAGMENT_MAX_SOURCES", () => {
    const source_refs = Array.from({ length: CLIPBOARD_FRAGMENT_MAX_SOURCES + 1 }, () => ({
      sha256: "a".repeat(64),
      png_base64: "iVBORw0KGgo="
    }));
    expect(() => ClipboardLayerFragmentV1.parse({ ...validFragment, source_refs })).toThrow();
  });

  test("rejects non-ISO copied_at", () => {
    expect(() =>
      ClipboardLayerFragmentV1.parse({ ...validFragment, copied_at: "yesterday" })
    ).toThrow();
    expect(() =>
      ClipboardLayerFragmentV1.parse({ ...validFragment, copied_at: "2026-05-12" })
    ).toThrow();
  });

  test("rejects missing top-level fields", () => {
    const { format_version: _fv, ...noVersion } = validFragment;
    void _fv;
    expect(() => ClipboardLayerFragmentV1.parse(noVersion)).toThrow();

    const { layers: _l, ...noLayers } = validFragment;
    void _l;
    expect(() => ClipboardLayerFragmentV1.parse(noLayers)).toThrow();

    const { source_refs: _s, ...noSources } = validFragment;
    void _s;
    expect(() => ClipboardLayerFragmentV1.parse(noSources)).toThrow();
  });

  test("rejects malformed nested layer (delegates to BundleLayerNode)", () => {
    const badLayer = { ...makeLayer("layerabcdef12345"), opacity: 5 };
    expect(() =>
      ClipboardLayerFragmentV1.parse({ ...validFragment, layers: [badLayer] })
    ).toThrow();
  });

  test("rejects malformed nested source_ref (delegates to ClipboardSourceRef)", () => {
    expect(() =>
      ClipboardLayerFragmentV1.parse({
        ...validFragment,
        source_refs: [{ sha256: "not-hex", png_base64: "iVBORw0KGgo=" }]
      })
    ).toThrow();
  });

  test("accepts the count caps at the boundary (max layers / max sources)", () => {
    const layers = Array.from({ length: CLIPBOARD_FRAGMENT_MAX_LAYERS }, (_, i) =>
      makeLayer(`l${String(i).padStart(15, "0")}`)
    );
    const source_refs = Array.from({ length: CLIPBOARD_FRAGMENT_MAX_SOURCES }, () => ({
      sha256: "a".repeat(64),
      png_base64: "iVBORw0KGgo="
    }));
    expect(() =>
      ClipboardLayerFragmentV1.parse({ ...validFragment, layers, source_refs })
    ).not.toThrow();
  });
});
