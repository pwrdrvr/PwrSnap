// Unit tests for `useEditorToolState` — the v2 editor's window-scoped
// state machine for sticky tool mode, per-tool style memory, shared
// COLOR slot across tools, and the matching-text affordance lifecycle.
//
// The hook does not own its Settings transport — it consumes the
// existing `useSettings` hook for reads and dispatches `settings:write`
// for persisted writes. Tests stub both surfaces so we exercise the
// state machine in isolation, without a main process or React Settings
// context.
//
// Mirrors `useUndoRedo.test.ts`'s `createRoot + act` pattern so the
// project doesn't need to take on `@testing-library/react` for a single
// hook test (no project precedent for it). Probe component snapshots
// the hook return on each render.

import { act, createElement, useEffect, useRef } from "react";
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
import type { Settings } from "@pwrsnap/shared";

// ---- Mocks ----------------------------------------------------------
//
// `useSettings` is mocked to a flexible factory so each test can drive
// the loaded snapshot — primarily for the matchingText.enabled=false
// scenario. `dispatch` is captured per-test so we can assert the
// coalescing window and the shape of `settings:write` payloads.

const dispatchMock = vi.fn();
vi.mock("../../../lib/pwrsnap", () => ({
  dispatch: (...args: unknown[]) => dispatchMock(...args)
}));

const useSettingsMock = vi.fn();
vi.mock("../../settings/useSettings", () => ({
  useSettings: () => useSettingsMock()
}));

import {
  useEditorToolState,
  type UseEditorToolStateReturn
} from "../useEditorToolState";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

// ---- Fixtures -------------------------------------------------------

function makeSettings(overrides?: {
  arrowColor?: string;
  arrowThickness?: Settings["editor"]["toolStyles"]["arrow"]["thickness"];
  textColor?: string;
  textFontSize?: Settings["editor"]["toolStyles"]["text"]["fontSize"];
  matchingTextEnabled?: boolean;
}): Settings {
  return {
    schemaVersion: 1,
    codex: { mode: "auto", pinnedPath: "", profile: "", captionModel: "gpt-5.4-mini" },
    ai: {
      enabled: false,
      consentAcceptedAt: null,
      budgetSafetyDisabledAt: null,
      autoAcceptSuggestions: false,
      chat: { userGuidance: "", sensitiveDataPatterns: [], defaultRedactionStyle: "blackout", firstLaunchBannerDismissed: false }
    },
    hotkeys: {
      quickCapture: "CommandOrControl+Shift+C",
      region: "",
      window: "",
      fullScreen: "",
      allScreens: "",
      timed: "",
      videoCapture: "CommandOrControl+Alt+C",
      reshowFloatOver: "CommandOrControl+Alt+Shift+F"
    },
    general: { developerMode: false },
    appearance: { theme: "system" },
    updates: { channel: "latest" },
    storage: { filenameTimestampZone: "local" },
    recording: {
      includeSystemAudio: false,
      includeMicrophone: false,
      lastRoutedPermissionFingerprint: ""
    },
    editor: {
      toolStyles: {
        arrow: {
          color: overrides?.arrowColor ?? "accent",
          thickness: overrides?.arrowThickness ?? "auto",
          endStyle: "filled-triangle",
          stemStyle: "solid",
          doubleEnded: false
        },
        text: {
          color: overrides?.textColor ?? "accent",
          fontSize: overrides?.textFontSize ?? "auto",
          weight: "regular"
        },
        shape: { color: "accent", thickness: "auto", filled: false, shape: "rect", skewDeg: 15 },
        blur: { mode: "gaussian", radius: { mode: "auto" } },
        highlight: { color: "yellow", opacity: 0.3, blend: "multiply" }
      },
      coachmarks: { stoplightSeen: false },
      matchingText: { enabled: overrides?.matchingTextEnabled ?? true },
      sidebar: { pinned: false, lastSelectedPanel: "toolConfig" }
    },
    library: { detailRail: { pinned: true, lastSelectedTab: "info" } }
  };
}

function installSettingsMock(settings: Settings | null): void {
  useSettingsMock.mockReturnValue({
    settings,
    secrets: null,
    loading: settings === null,
    error: null,
    patch: vi.fn(),
    refreshCodex: vi.fn(),
    testCodex: vi.fn(),
    replaceSecret: vi.fn(),
    clearSecret: vi.fn()
  });
}

// ---- Probe + render harness -----------------------------------------

type ProbeProps = {
  readonly captureId: string;
  readonly onSnapshot: (api: UseEditorToolStateReturn) => void;
};

function Probe(props: ProbeProps): null {
  const api = useEditorToolState({ captureId: props.captureId });
  // Stash latest snapshot for the test to read. We capture-by-ref so
  // every render fires (effects fire after commit).
  const onSnapshot = useRef(props.onSnapshot);
  onSnapshot.current = props.onSnapshot;
  useEffect(() => {
    onSnapshot.current(api);
  });
  return null;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(node: React.ReactElement): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(node);
  });
}

function rerender(node: React.ReactElement): void {
  act(() => {
    root!.render(node);
  });
}

beforeEach(() => {
  dispatchMock.mockReset();
  dispatchMock.mockResolvedValue({ ok: true, value: undefined });
  useSettingsMock.mockReset();
  installSettingsMock(makeSettings());
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
  vi.useRealTimers();
});

// ---- Tests ----------------------------------------------------------

describe("useEditorToolState", () => {
  test("1. initial state: pointer + idle + reads defaults from settings", () => {
    let api: UseEditorToolStateReturn | null = null;
    render(
      createElement(Probe, {
        captureId: "cap-1",
        onSnapshot: (a) => {
          api = a;
        }
      })
    );

    expect(api!.activeTool).toBe("pointer");
    expect(api!.matchingText.kind).toBe("idle");
    // activeStyle reflects settings defaults — pointer has no style
    // block (style discriminant is "none").
    expect(api!.activeStyle.tool).toBe("pointer");
  });

  test("2. sticky tool: after arrow placement, still in arrow mode", () => {
    let api: UseEditorToolStateReturn | null = null;
    render(
      createElement(Probe, {
        captureId: "cap-1",
        onSnapshot: (a) => {
          api = a;
        }
      })
    );

    act(() => {
      api!.setActiveTool("arrow");
    });
    expect(api!.activeTool).toBe("arrow");

    act(() => {
      api!.onAnnotationPlaced({
        tool: "arrow",
        anchorPoint: { x: 100, y: 50 }
      });
    });
    expect(api!.activeTool).toBe("arrow");
  });

  test("3. single-shot: ⌥-click sets singleShot; flips back to pointer after one placement", () => {
    let api: UseEditorToolStateReturn | null = null;
    render(
      createElement(Probe, {
        captureId: "cap-1",
        onSnapshot: (a) => {
          api = a;
        }
      })
    );

    act(() => {
      api!.setActiveTool("arrow", { singleShot: true });
    });
    expect(api!.activeTool).toBe("arrow");

    act(() => {
      api!.onAnnotationPlaced({
        tool: "arrow",
        anchorPoint: { x: 0, y: 0 }
      });
    });
    expect(api!.activeTool).toBe("pointer");
  });

  test("4. cross-tool COLOR slot: arrow color propagates to text/rect/highlight", () => {
    let api: UseEditorToolStateReturn | null = null;
    render(
      createElement(Probe, {
        captureId: "cap-1",
        onSnapshot: (a) => {
          api = a;
        }
      })
    );

    act(() => {
      api!.setStyleField("arrow", "color", "red");
    });

    // Switch to text — should reflect red (shared COLOR slot).
    act(() => {
      api!.setActiveTool("text");
    });
    expect(api!.activeStyle.tool).toBe("text");
    if (api!.activeStyle.tool === "text") {
      expect(api!.activeStyle.style.color).toBe("red");
    }

    // Same for rect.
    act(() => {
      api!.setActiveTool("shape");
    });
    if (api!.activeStyle.tool === "shape") {
      expect(api!.activeStyle.style.color).toBe("red");
    }

    // Same for highlight.
    act(() => {
      api!.setActiveTool("highlight");
    });
    if (api!.activeStyle.tool === "highlight") {
      expect(api!.activeStyle.style.color).toBe("red");
    }
  });

  test("5. per-tool thickness: arrow thickness change does not affect text fontSize", () => {
    let api: UseEditorToolStateReturn | null = null;
    render(
      createElement(Probe, {
        captureId: "cap-1",
        onSnapshot: (a) => {
          api = a;
        }
      })
    );

    act(() => {
      api!.setStyleField("arrow", "thickness", "small");
    });

    act(() => {
      api!.setActiveTool("text");
    });
    if (api!.activeStyle.tool === "text") {
      // text.fontSize remains the settings default (auto), NOT "small".
      expect(api!.activeStyle.style.fontSize).toBe("auto");
    }
  });

  test("6. matching-text appears after arrow placement", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-23T12:00:00.000Z"));

    let api: UseEditorToolStateReturn | null = null;
    render(
      createElement(Probe, {
        captureId: "cap-1",
        onSnapshot: (a) => {
          api = a;
        }
      })
    );

    act(() => {
      api!.setActiveTool("arrow");
    });
    act(() => {
      api!.onAnnotationPlaced({
        tool: "arrow",
        anchorPoint: { x: 100, y: 50 }
      });
    });

    expect(api!.matchingText.kind).toBe("available");
    if (api!.matchingText.kind === "available") {
      expect(api!.matchingText.anchorPoint).toEqual({ x: 100, y: 50 });
      expect(api!.matchingText.expiresAt).toBe(Date.now() + 8000);
    }
  });

  test("7. matching-text dismisses on tool change", () => {
    let api: UseEditorToolStateReturn | null = null;
    render(
      createElement(Probe, {
        captureId: "cap-1",
        onSnapshot: (a) => {
          api = a;
        }
      })
    );

    act(() => {
      api!.setActiveTool("arrow");
    });
    act(() => {
      api!.onAnnotationPlaced({
        tool: "arrow",
        anchorPoint: { x: 1, y: 1 }
      });
    });
    expect(api!.matchingText.kind).toBe("available");

    act(() => {
      api!.setActiveTool("text");
    });
    expect(api!.matchingText.kind).toBe("idle");
  });

  test("8. matching-text dismisses on capture change (re-render with new id)", () => {
    let api: UseEditorToolStateReturn | null = null;
    const onSnapshot = (a: UseEditorToolStateReturn): void => {
      api = a;
    };
    render(createElement(Probe, { captureId: "cap-1", onSnapshot }));

    act(() => {
      api!.setActiveTool("arrow");
    });
    act(() => {
      api!.onAnnotationPlaced({
        tool: "arrow",
        anchorPoint: { x: 1, y: 1 }
      });
    });
    expect(api!.matchingText.kind).toBe("available");

    rerender(createElement(Probe, { captureId: "cap-2", onSnapshot }));
    expect(api!.matchingText.kind).toBe("idle");
  });

  test("9. matching-text dismisses on explicit dismiss", () => {
    let api: UseEditorToolStateReturn | null = null;
    render(
      createElement(Probe, {
        captureId: "cap-1",
        onSnapshot: (a) => {
          api = a;
        }
      })
    );

    act(() => {
      api!.setActiveTool("arrow");
    });
    act(() => {
      api!.onAnnotationPlaced({
        tool: "arrow",
        anchorPoint: { x: 1, y: 1 }
      });
    });
    expect(api!.matchingText.kind).toBe("available");

    act(() => {
      api!.dismissMatchingTextAffordance();
    });
    expect(api!.matchingText.kind).toBe("idle");
  });

  test("10. matching-text auto-dismisses at 8s", () => {
    vi.useFakeTimers();
    let api: UseEditorToolStateReturn | null = null;
    render(
      createElement(Probe, {
        captureId: "cap-1",
        onSnapshot: (a) => {
          api = a;
        }
      })
    );

    act(() => {
      api!.setActiveTool("arrow");
    });
    act(() => {
      api!.onAnnotationPlaced({
        tool: "arrow",
        anchorPoint: { x: 1, y: 1 }
      });
    });
    expect(api!.matchingText.kind).toBe("available");

    act(() => {
      vi.advanceTimersByTime(8001);
    });
    expect(api!.matchingText.kind).toBe("idle");
  });

  test("11. clickMatchingTextAffordance: → text tool, color matches, kind=armed", () => {
    let api: UseEditorToolStateReturn | null = null;
    render(
      createElement(Probe, {
        captureId: "cap-1",
        onSnapshot: (a) => {
          api = a;
        }
      })
    );

    // Set arrow color to red first so we can verify color propagation.
    act(() => {
      api!.setStyleField("arrow", "color", "red");
    });
    act(() => {
      api!.setActiveTool("arrow");
    });
    act(() => {
      api!.onAnnotationPlaced({
        tool: "arrow",
        anchorPoint: { x: 1, y: 1 }
      });
    });
    expect(api!.matchingText.kind).toBe("available");

    act(() => {
      api!.clickMatchingTextAffordance();
    });

    expect(api!.activeTool).toBe("text");
    if (api!.activeStyle.tool === "text") {
      expect(api!.activeStyle.style.color).toBe("red");
    }
    expect(api!.matchingText.kind).toBe("armed");
  });

  test("12. armed text placement → return to arrow with style preserved", () => {
    let api: UseEditorToolStateReturn | null = null;
    render(
      createElement(Probe, {
        captureId: "cap-1",
        onSnapshot: (a) => {
          api = a;
        }
      })
    );

    act(() => {
      api!.setStyleField("arrow", "color", "red");
    });
    act(() => {
      api!.setActiveTool("arrow");
    });
    act(() => {
      api!.onAnnotationPlaced({
        tool: "arrow",
        anchorPoint: { x: 1, y: 1 }
      });
    });
    act(() => {
      api!.clickMatchingTextAffordance();
    });
    expect(api!.activeTool).toBe("text");

    // Place the text. The hook should now return to arrow tool.
    act(() => {
      api!.onAnnotationPlaced({ tool: "text" });
    });

    expect(api!.activeTool).toBe("arrow");
    if (api!.activeStyle.tool === "arrow") {
      expect(api!.activeStyle.style.color).toBe("red");
    }
    expect(api!.matchingText.kind).toBe("idle");
  });

  test("13. matching-text disabled in settings: arrow placement stays idle", () => {
    installSettingsMock(makeSettings({ matchingTextEnabled: false }));

    let api: UseEditorToolStateReturn | null = null;
    render(
      createElement(Probe, {
        captureId: "cap-1",
        onSnapshot: (a) => {
          api = a;
        }
      })
    );

    act(() => {
      api!.setActiveTool("arrow");
    });
    act(() => {
      api!.onAnnotationPlaced({
        tool: "arrow",
        anchorPoint: { x: 1, y: 1 }
      });
    });

    expect(api!.matchingText.kind).toBe("idle");
  });

  test("14. settings dispatch coalescing: 5 rapid color clicks → 1 dispatch after 500ms", () => {
    vi.useFakeTimers();

    let api: UseEditorToolStateReturn | null = null;
    render(
      createElement(Probe, {
        captureId: "cap-1",
        onSnapshot: (a) => {
          api = a;
        }
      })
    );

    // Five rapid clicks within 200ms.
    act(() => {
      api!.setStyleField("arrow", "color", "red");
    });
    act(() => {
      vi.advanceTimersByTime(40);
    });
    act(() => {
      api!.setStyleField("arrow", "color", "yellow");
    });
    act(() => {
      vi.advanceTimersByTime(40);
    });
    act(() => {
      api!.setStyleField("arrow", "color", "green");
    });
    act(() => {
      vi.advanceTimersByTime(40);
    });
    act(() => {
      api!.setStyleField("arrow", "color", "blue");
    });
    act(() => {
      vi.advanceTimersByTime(40);
    });
    act(() => {
      api!.setStyleField("arrow", "color", "gray");
    });

    // Before the 500ms debounce window elapses, no dispatch has fired.
    const writeCallsBefore = dispatchMock.mock.calls.filter(
      (c) => c[0] === "settings:write"
    ).length;
    expect(writeCallsBefore).toBe(0);

    // Advance past the 500ms window.
    act(() => {
      vi.advanceTimersByTime(501);
    });

    // Exactly one settings:write should have fired, with the final
    // value ("gray") — earlier writes coalesced into the last one.
    const writeCalls = dispatchMock.mock.calls.filter(
      (c) => c[0] === "settings:write"
    );
    expect(writeCalls.length).toBe(1);
    const payload = writeCalls[0]?.[1] as {
      editor?: { toolStyles?: { arrow?: { color?: string } } };
    };
    expect(payload.editor?.toolStyles?.arrow?.color).toBe("gray");
  });
});
