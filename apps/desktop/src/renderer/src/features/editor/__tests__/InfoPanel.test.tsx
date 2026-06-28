// Unit tests for InfoPanel — capture-metadata panel in the editor's
// right sidebar. Mirrors `ToolStylePopover.test.tsx` / `useEditorToolState.test.ts`
// — bare-React + createRoot + act, no @testing-library/react.
//
// `dispatch` and `subscribe` are vi.mock'd at the module boundary so
// we drive the fetch responses + the captures-changed broadcast
// directly. The panel itself sees a synchronous IPC surface as long
// as our mocked promises resolve in the same microtask flush.

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi
} from "vitest";
import type { CaptureEnrichment, CaptureRecord } from "@pwrsnap/shared";

// ---- Mocks ----------------------------------------------------------

const dispatchMock = vi.fn();
type Listener = (payload: unknown) => void;
const subscribers: Map<string, Set<Listener>> = new Map();
const subscribeMock = vi.fn((channel: string, listener: Listener) => {
  if (!subscribers.has(channel)) subscribers.set(channel, new Set());
  subscribers.get(channel)!.add(listener);
  return (): void => {
    subscribers.get(channel)?.delete(listener);
  };
});

vi.mock("../../../lib/pwrsnap", () => ({
  dispatch: (...args: unknown[]) => dispatchMock(...args),
  subscribe: (...args: unknown[]) =>
    (subscribeMock as unknown as (...a: unknown[]) => () => void)(...args)
}));

import { InfoPanel } from "../panels/InfoPanel";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

// ---- Fixtures -------------------------------------------------------

function makeRecord(overrides: Partial<CaptureRecord> = {}): CaptureRecord {
  return {
    id: "cap_1",
    kind: "image",
    captured_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    legacy_src_path: null,
    bundle_path: "/tmp/cap_1.pwrsnap",
    flat_png_path: "/tmp/cap_1.png",
    bundle_modified_at: null,
    bundle_format_version: 1,
    bundle_edits_version: 0,
    width_px: 1920,
    height_px: 1080,
    device_pixel_ratio: 2,
    byte_size: 1_400_000,
    sha256: "deadbeef",
    source_app_bundle_id: "com.apple.Safari",
    source_app_name: "Safari",
    edits_version: 1,
    has_alpha: false,
    deleted_at: null,
    ...overrides
  };
}

function makeEnrichment(
  overrides: Partial<CaptureEnrichment> = {}
): CaptureEnrichment {
  return {
    captureId: "cap_1",
    latestRunId: null,
    status: null,
    error: null,
    ocrText: null,
    suggestedTitle: null,
    acceptedTitle: null,
    titleAcceptedAt: null,
    suggestedDescription: null,
    acceptedDescription: null,
    descriptionAcceptedAt: null,
    suggestedFilenameStem: null,
    acceptedFilenameStem: null,
    filenameAcceptedAt: null,
    suggestedTags: [],
    acceptedTags: [],
    ...overrides
  };
}

// ---- Render harness -------------------------------------------------

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(node: ReactElement): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(node);
  });
}

async function flush(): Promise<void> {
  // Two awaits + a microtask is enough for our chained dispatch
  // promises (record → enrichment) to settle and React to commit.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  dispatchMock.mockReset();
  subscribeMock.mockClear();
  subscribers.clear();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  if (host !== null) {
    document.body.removeChild(host);
    host = null;
  }
  root = null;
});

function q(selector: string): HTMLElement | null {
  return host?.querySelector<HTMLElement>(selector) ?? null;
}

function qAll(selector: string): HTMLElement[] {
  return Array.from(host?.querySelectorAll<HTMLElement>(selector) ?? []);
}

// ---- Tests ----------------------------------------------------------

describe("InfoPanel", () => {
  test("1. loading state → 'Loading…' rendered with role=status", () => {
    // Dispatch never resolves — the panel stays in its initial loading
    // state. Use a pending promise so neither setState ever fires.
    dispatchMock.mockReturnValue(new Promise(() => undefined));
    render(createElement(InfoPanel, { captureId: "cap_1" }));
    const loading = q('.pse-info-loading');
    expect(loading).not.toBeNull();
    expect(loading!.textContent).toContain("Loading");
    expect(loading!.getAttribute("role")).toBe("status");
  });

  test("2. successful fetch → all rows visible (source app, captured-at, dimensions, file size, kind)", async () => {
    dispatchMock.mockImplementation(async (name: string) => {
      if (name === "library:byId") return { ok: true, value: makeRecord() };
      if (name === "codex:enrichment") return { ok: true, value: null };
      return { ok: true, value: undefined };
    });
    render(createElement(InfoPanel, { captureId: "cap_1" }));
    await flush();
    expect(q('[data-testid="info-source-app"]')).not.toBeNull();
    expect(q('[data-testid="info-source-app"]')?.textContent).toContain(
      "Safari"
    );
    expect(q('[data-testid="info-captured-at"]')).not.toBeNull();
    expect(q('[data-testid="info-dimensions"]')?.textContent).toBe(
      "1920 × 1080"
    );
    expect(q('[data-testid="info-file-size"]')?.textContent).toBe("1.3 MB");
    expect(q('[data-testid="info-kind"]')?.textContent).toBe("Image");
  });

  test("3. no tags → tag row hidden", async () => {
    dispatchMock.mockImplementation(async (name: string) => {
      if (name === "library:byId") return { ok: true, value: makeRecord() };
      if (name === "codex:enrichment")
        return { ok: true, value: makeEnrichment({ acceptedTags: [] }) };
      return { ok: true, value: undefined };
    });
    render(createElement(InfoPanel, { captureId: "cap_1" }));
    await flush();
    expect(q('[data-testid="info-tags"]')).toBeNull();
  });

  test("4. no description → description row hidden", async () => {
    dispatchMock.mockImplementation(async (name: string) => {
      if (name === "library:byId") return { ok: true, value: makeRecord() };
      if (name === "codex:enrichment")
        return {
          ok: true,
          value: makeEnrichment({ acceptedDescription: null })
        };
      return { ok: true, value: undefined };
    });
    render(createElement(InfoPanel, { captureId: "cap_1" }));
    await flush();
    expect(q('[data-testid="info-description"]')).toBeNull();
  });

  test("5. tags present → each tag rendered as a chip", async () => {
    dispatchMock.mockImplementation(async (name: string) => {
      if (name === "library:byId") return { ok: true, value: makeRecord() };
      if (name === "codex:enrichment")
        return {
          ok: true,
          value: makeEnrichment({
            acceptedTags: ["screenshot", "github", "design"]
          })
        };
      return { ok: true, value: undefined };
    });
    render(createElement(InfoPanel, { captureId: "cap_1" }));
    await flush();
    const chips = qAll('[data-testid="info-tag-chip"]');
    expect(chips.length).toBe(3);
    expect(chips.map((c) => c.textContent)).toEqual([
      "screenshot",
      "github",
      "design"
    ]);
  });

  test("6. description present → multi-line render preserves whitespace", async () => {
    const desc = "line one\nline two\n  indented";
    dispatchMock.mockImplementation(async (name: string) => {
      if (name === "library:byId") return { ok: true, value: makeRecord() };
      if (name === "codex:enrichment")
        return {
          ok: true,
          value: makeEnrichment({ acceptedDescription: desc })
        };
      return { ok: true, value: undefined };
    });
    render(createElement(InfoPanel, { captureId: "cap_1" }));
    await flush();
    const node = q('[data-testid="info-description"]');
    expect(node).not.toBeNull();
    // pre-wrap whitespace handling on the CSS side; the underlying
    // text content carries the newlines through unchanged.
    expect(node!.textContent).toBe(desc);
  });

  test("7. error state → 'Couldn't load capture info.' rendered", async () => {
    dispatchMock.mockImplementation(async (name: string) => {
      if (name === "library:byId") {
        return {
          ok: false,
          error: { kind: "library", code: "not_found", message: "nope" }
        };
      }
      return { ok: true, value: undefined };
    });
    render(createElement(InfoPanel, { captureId: "cap_1" }));
    await flush();
    const err = q(".pse-info-error");
    expect(err).not.toBeNull();
    expect(err!.textContent).toContain("Couldn");
    expect(err!.getAttribute("role")).toBe("status");
  });

  test("8. captureId change → re-fetches", async () => {
    dispatchMock.mockImplementation(async (name: string, req: unknown) => {
      if (name === "library:byId") {
        const id = (req as { id: string }).id;
        return {
          ok: true,
          value: makeRecord({
            id,
            source_app_name: id === "cap_1" ? "Safari" : "Slack"
          })
        };
      }
      if (name === "codex:enrichment") return { ok: true, value: null };
      return { ok: true, value: undefined };
    });
    render(createElement(InfoPanel, { captureId: "cap_1" }));
    await flush();
    expect(q('[data-testid="info-source-app"]')?.textContent).toContain(
      "Safari"
    );
    // Re-render with a different captureId.
    act(() => {
      root!.render(createElement(InfoPanel, { captureId: "cap_2" }));
    });
    await flush();
    expect(q('[data-testid="info-source-app"]')?.textContent).toContain(
      "Slack"
    );
    // Both fetches went through: 1 for cap_1, 1 for cap_2 (each pair
    // is library:byId + codex:enrichment).
    const libraryCalls = dispatchMock.mock.calls.filter(
      (c) => c[0] === "library:byId"
    );
    expect(libraryCalls.length).toBe(2);
  });

  test("9. unmount during in-flight fetch → no React state-update warning", async () => {
    // Capture console.error so a setState-after-unmount warning would
    // bubble up and we can detect it.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let resolveFetch: ((v: unknown) => void) | null = null;
    dispatchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        })
    );
    render(createElement(InfoPanel, { captureId: "cap_1" }));
    // Unmount before the dispatch resolves.
    act(() => {
      root?.unmount();
    });
    root = null;
    // NOW resolve — the cancelled flag should suppress the setState.
    act(() => {
      resolveFetch?.({ ok: true, value: makeRecord() });
    });
    await flush();
    // No setState-on-unmounted-component warning surfaced.
    const warned = errorSpy.mock.calls.some((c) =>
      String(c[0]).includes("unmounted")
    );
    expect(warned).toBe(false);
    errorSpy.mockRestore();
  });

  test("10. captures:changed broadcast → re-fetches", async () => {
    let recordVersion = 1;
    dispatchMock.mockImplementation(async (name: string) => {
      if (name === "library:byId") {
        return {
          ok: true,
          value: makeRecord({ edits_version: recordVersion })
        };
      }
      if (name === "codex:enrichment") return { ok: true, value: null };
      return { ok: true, value: undefined };
    });
    render(createElement(InfoPanel, { captureId: "cap_1" }));
    await flush();
    const initialLibraryCalls = dispatchMock.mock.calls.filter(
      (c) => c[0] === "library:byId"
    ).length;
    // Fire the broadcast — the panel should re-fetch.
    recordVersion = 2;
    act(() => {
      subscribers.get("events:captures:changed")?.forEach((listener) => {
        listener({});
      });
    });
    await flush();
    const afterLibraryCalls = dispatchMock.mock.calls.filter(
      (c) => c[0] === "library:byId"
    ).length;
    expect(afterLibraryCalls).toBe(initialLibraryCalls + 1);
  });

  test("11. video kind renders 'Video' badge with is-video class", async () => {
    dispatchMock.mockImplementation(async (name: string) => {
      if (name === "library:byId")
        return { ok: true, value: makeRecord({ kind: "video" }) };
      if (name === "codex:enrichment") return { ok: true, value: null };
      return { ok: true, value: undefined };
    });
    render(createElement(InfoPanel, { captureId: "cap_1" }));
    await flush();
    const kind = q('[data-testid="info-kind"]');
    expect(kind?.textContent).toBe("Video");
    expect(kind?.className).toContain("is-video");
  });

  test("12. bundle_modified_at present → 'Last edited' row visible", async () => {
    dispatchMock.mockImplementation(async (name: string) => {
      if (name === "library:byId")
        return {
          ok: true,
          value: makeRecord({
            bundle_modified_at: new Date(
              Date.now() - 30 * 60 * 1000
            ).toISOString()
          })
        };
      if (name === "codex:enrichment") return { ok: true, value: null };
      return { ok: true, value: undefined };
    });
    render(createElement(InfoPanel, { captureId: "cap_1" }));
    await flush();
    expect(q('[data-testid="info-last-edited"]')).not.toBeNull();
  });

  test("13. unknown source app → renders 'Unknown app' + fallback icon", async () => {
    dispatchMock.mockImplementation(async (name: string) => {
      if (name === "library:byId")
        return {
          ok: true,
          value: makeRecord({
            source_app_name: null,
            source_app_bundle_id: null
          })
        };
      if (name === "codex:enrichment") return { ok: true, value: null };
      return { ok: true, value: undefined };
    });
    render(createElement(InfoPanel, { captureId: "cap_1" }));
    await flush();
    expect(q('[data-testid="info-source-app"]')?.textContent).toContain(
      "Unknown app"
    );
    expect(
      q('[data-testid="info-source-app-icon-fallback"]')
    ).not.toBeNull();
  });
});
