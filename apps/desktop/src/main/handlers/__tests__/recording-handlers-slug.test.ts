// Unit tests for `slugifyAppName` — the helper that turns the source
// app's display name into a filesystem-friendly drag-out filename
// (`<slug>__<preset>.<ext>`). The function is exported from
// recording-handlers.ts so the drag preparer can fall back to a
// sensible default when the name is missing or sanitizes to empty.
//
// Locks in Unicode handling: Korean, Chinese, emoji-bearing app
// names should retain their letters instead of collapsing to
// "PwrSnap" (which is what the original ASCII-only regex did).

import { describe, expect, test } from "vitest";

// Have to stub the bus + service imports before recording-handlers
// can be imported. Same pattern as recording-handlers-bus.test.ts.
import { vi } from "vitest";

vi.mock("electron", () => ({
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  shell: { openExternal: async () => undefined },
  BrowserWindow: { getAllWindows: () => [] }
}));

vi.mock("../../persistence/captures-repo", () => ({
  getCaptureById: () => null
}));

vi.mock("../../persistence/video-repo", () => ({
  getVideoMetadata: () => null,
  normalizeRange: (range: unknown) => range,
  setDefaultRange: () => undefined,
  lookupExport: () => null,
  recordExport: () => undefined
}));

vi.mock("../../recording/recording-exporter", () => ({
  exportVideoRange: async () => undefined,
  computeOutputDimensions: () => ({ widthPx: 720, heightPx: 480 }),
  GIF_PRESETS: {
    low: { width: 480, fps: 15 },
    med: { width: 540, fps: 24 },
    high: { width: 720, fps: 30 }
  },
  MP4_PRESETS: {
    low: { width: 720, crf: 28 },
    med: { width: 1080, crf: 23 },
    high: { width: null, crf: null }
  }
}));

vi.mock("../../recording/recording-service", () => ({
  getRecordingService: () => ({
    cancel: async () => undefined,
    restart: async () => undefined,
    start: vi.fn(),
    stop: vi.fn(),
    isActive: () => false
  })
}));

vi.mock("../../recording/recording-permissions", () => ({
  openSystemSettingsFor: () => undefined,
  readRecordingReadiness: () => ({ status: "granted", fingerprint: "x" }),
  requestPermission: async () => "granted"
}));

vi.mock("../../recording/recording-state", () => ({
  getRecordingState: () => ({ phase: "idle" })
}));

vi.mock("../../recording/video-export-resolver", () => ({
  resolveVideoExport: async () => ({ ok: false, error: { kind: "not_found" } }),
  mapVideoResolveError: () => ({
    kind: "validation",
    code: "not_found",
    message: "stub"
  })
}));

vi.mock("../../recording/video-poster", () => ({
  ensureVideoPoster: async () => "/tmp/poster.png"
}));

vi.mock("../../render/file-alias", () => ({
  prepareRenderedFileAlias: async (_p: string, name: string) => `/tmp/alias/${name}`
}));

const { slugifyAppName } = await import("../recording-handlers");

describe("slugifyAppName", () => {
  test("empty / null / undefined fall back to PwrSnap", () => {
    expect(slugifyAppName(null)).toBe("PwrSnap");
    expect(slugifyAppName(undefined)).toBe("PwrSnap");
    expect(slugifyAppName("")).toBe("PwrSnap");
    expect(slugifyAppName("   ")).toBe("PwrSnap");
  });

  test("simple ASCII names round-trip cleanly", () => {
    expect(slugifyAppName("Safari")).toBe("Safari");
    expect(slugifyAppName("Visual Studio Code")).toBe("Visual-Studio-Code");
  });

  test("Unicode letters survive — Korean, Chinese, Japanese", () => {
    expect(slugifyAppName("카카오톡")).toBe("카카오톡");
    expect(slugifyAppName("微信")).toBe("微信");
    expect(slugifyAppName("メッセージ")).toBe("メッセージ");
  });

  test("emoji + ASCII mix keeps the ASCII letters and drops the emoji", () => {
    // 🟢 isn't a letter, so it becomes a separator. The trailing
    // hyphen gets stripped.
    expect(slugifyAppName("WhatsApp 🟢")).toBe("WhatsApp");
    expect(slugifyAppName("⭐ Favorites")).toBe("Favorites");
  });

  test("punctuation collapses to a single hyphen separator", () => {
    expect(slugifyAppName("App / Helper (beta)")).toBe("App-Helper-beta");
    expect(slugifyAppName("File__Name")).toBe("File__Name");
  });

  test("very long names truncate to 32 chars", () => {
    const long = "AaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaBbbbbb";
    const slug = slugifyAppName(long);
    expect(slug.length).toBeLessThanOrEqual(32);
    expect(slug).toBe("Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  test("NFC normalization — decomposed Hangul produces same slug as precomposed", () => {
    // U+AC00 (가) precomposed vs decomposed form (U+1100 + U+1161).
    const precomposed = "가";
    const decomposed = "가";
    expect(slugifyAppName(precomposed)).toBe(slugifyAppName(decomposed));
  });

  test("name that sanitizes to empty falls back to PwrSnap", () => {
    // All punctuation/emoji — no letters or numbers.
    expect(slugifyAppName("---")).toBe("PwrSnap");
    expect(slugifyAppName("🟢⭐💎")).toBe("PwrSnap");
    expect(slugifyAppName("///")).toBe("PwrSnap");
  });
});
