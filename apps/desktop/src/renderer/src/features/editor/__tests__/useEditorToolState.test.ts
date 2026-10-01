// Unit tests for `useEditorToolState` — the v2 editor's window-scoped
// state machine for sticky tool mode, per-tool style memory, and the
// armed tool-bag slot.
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
import type { EditorToolStyles, Settings } from "@pwrsnap/shared";

// ---- Mocks ----------------------------------------------------------
//
// `useSettings` is mocked to a flexible factory so each test can drive
// the loaded snapshot. `dispatch` is captured per-test so we can assert the
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
import { defaultEditorToolBag } from "@pwrsnap/shared";

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
}): Settings {
  return {
    schemaVersion: 1,
    codex: { mode: "auto", pinnedPath: "", profile: "", captionModel: "gpt-5.4-mini" },
    ai: {
      enabled: false,
      consentAcceptedAt: null,
      budgetSafetyDisabledAt: null,
      autoAcceptSuggestions: false,
      chat: { userGuidance: "", sensitiveDataPatterns: [], defaultRedactionStyle: "blackout", firstLaunchBannerDismissed: false },
      defaults: { libraryChat: {}, sizzleChat: {}, enrichment: {} },
      acp: { enabledAgentIds: [] }
    },
    hotkeys: {
      quickCapture: "CommandOrControl+Shift+C",
      region: "",
      window: "",
      fullScreen: "",
      allScreens: "",
      timed: "",
      videoCapture: "CommandOrControl+Alt+C",
      reshowFloatOver: "CommandOrControl+Alt+Shift+F",
      openLibrary: ""
    },
    general: {
    developerMode: false,
    hotCpuProfilingEnabled: false,
    hotCpuProfilingStartDelayMs: 0,
    hotCpuProfilingTriggerMode: "sustained",
    hotCpuProfilingSlowburnThresholdPercent: 15,
    hotCpuProfilingCaptureHeapSnapshot: false,
    hotCpuProfilingHeapSnapshotLimit: 2,
    launchAtLogin: false
  },
    experimental: { processSplit: true, dpiAwareExport: false, allowRetinaExport: true },
    appearance: { theme: "system" },
    updates: { channel: "latest", train: "stable", selectionSource: "inferred" },
    storage: { filenameTimestampZone: "local", capturesLocation: "documents" },
    recording: {
      quickCaptureAction: "ask",
      includeSystemAudio: false,
      includeMicrophone: false,
      mp4IncludeMicrophone: true,
      mp4IncludeSystemAudio: true,
      videoCaptureCursor: true,
      showRegionFrame: true,
      imageCaptureCursor: true,
      lastRoutedPermissionFingerprint: "",
      screenCapturePrompted: false
    },
    editor: {
      toolStyles: {
        arrow: {
          color: overrides?.arrowColor ?? "accent",
          thickness: overrides?.arrowThickness ?? "auto",
          endStyle: "filled-triangle",
          stemStyle: "solid",
          doubleEnded: false,
          outline: "auto"
        },
        text: {
          color: overrides?.textColor ?? "accent",
          fontSize: overrides?.textFontSize ?? "auto",
          weight: "regular",
          outline: "auto"
        },
        shape: { color: "accent", thickness: "auto", filled: false, shape: "rect", skewDeg: 15, outline: "auto" },
        blur: { mode: "gaussian", radius: { mode: "auto" } },
        highlight: { color: "yellow", opacity: 0.3, blend: "multiply" }
      },
      toolBag: defaultEditorToolBag(),
      coachmarks: { stoplightSeen: false },
      sidebar: { pinned: false, lastSelectedPanel: "toolConfig" }
    },
    library: { detailRail: { pinned: true, lastSelectedTab: "info" }, gridCopyPalette: { anchor: "follow" }, confirmBeforeTrash: true, gridZoom: 180, duplicateWithEdits: { image: true, video: true } },
  localAgents: { enabled: false, grants: [], roles: [], audit: [] }
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
  test("1. initial state: pointer, nothing armed, the settings bag", () => {
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
    expect(api!.armedSlot).toBeNull();
    expect(api!.bag.slots).toHaveLength(9);
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
      api!.onAnnotationPlaced({ tool: "arrow" });
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
      api!.onAnnotationPlaced({ tool: "arrow" });
    });
    expect(api!.activeTool).toBe("pointer");
  });

  test("4. colors are per tool: an arrow color does not recolor text or shapes", () => {
    // The shared COLOR slot used to fan every pick out to every tool,
    // which made "a red arrow and a green arrow" a two-step chore and
    // recolored the next box too. The bag replaced it.
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
      api!.setActiveTool("text");
    });
    expect(api!.activeStyle).toMatchObject({ tool: "text", style: { color: "accent" } });
    act(() => {
      api!.setActiveTool("shape");
    });
    expect(api!.activeStyle).toMatchObject({ tool: "shape", style: { color: "accent" } });
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

  test("6. armSlot: activates the slot's tool with its WHOLE style", () => {
    let api: UseEditorToolStateReturn | null = null;
    render(
      createElement(Probe, {
        captureId: "cap-1",
        onSnapshot: (a) => {
          api = a;
        }
      })
    );
    // A stray working-style field must not leak into the armed slot.
    act(() => {
      api!.setStyleField("arrow", "doubleEnded", true);
    });

    let armed = false;
    act(() => {
      armed = api!.armSlot(3);
    });
    expect(armed).toBe(true);
    expect(api!.activeTool).toBe("arrow");
    expect(api!.armedSlot).toBe(3);
    expect(api!.armedSlotModified).toBe(false);
    // Slot 4 of the factory bag is the yellow range.
    expect(api!.activeStyle).toMatchObject({
      tool: "arrow",
      style: { color: "yellow", endStyle: "bar", doubleEnded: true, thickness: "small" }
    });

    act(() => {
      api!.armSlot(4);
    });
    expect(api!.activeTool).toBe("highlight");
    expect(api!.armedSlot).toBe(4);
  });

  test("7. editing the working style marks the armed slot modified; editing it back clears that", () => {
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
      api!.armSlot(0);
    });
    act(() => {
      api!.setStyleField("arrow", "color", "blue");
    });
    expect(api!.armedSlot).toBe(0);
    expect(api!.armedSlotModified).toBe(true);
    act(() => {
      api!.setStyleField("arrow", "color", "red");
    });
    expect(api!.armedSlotModified).toBe(false);
  });

  test("8. picking a family directly, or switching captures, disarms the slot", () => {
    let api: UseEditorToolStateReturn | null = null;
    const onSnapshot = (a: UseEditorToolStateReturn): void => {
      api = a;
    };
    render(createElement(Probe, { captureId: "cap-1", onSnapshot }));

    act(() => {
      api!.armSlot(1);
    });
    act(() => {
      api!.setActiveTool("arrow");
    });
    expect(api!.activeTool).toBe("arrow");
    expect(api!.armedSlot).toBeNull();

    act(() => {
      api!.armSlot(1);
    });
    rerender(createElement(Probe, { captureId: "cap-2", onSnapshot }));
    expect(api!.armedSlot).toBeNull();
    // The tool and its working style carry over.
    expect(api!.activeStyle).toMatchObject({ tool: "arrow", style: { color: "green" } });
  });

  test("9. arming an empty slot does nothing", () => {
    let api: UseEditorToolStateReturn | null = null;
    render(
      createElement(Probe, {
        captureId: "cap-1",
        onSnapshot: (a) => {
          api = a;
        }
      })
    );
    let armed = true;
    act(() => {
      armed = api!.armSlot(8);
    });
    expect(armed).toBe(false);
    expect(api!.activeTool).toBe("pointer");
    expect(api!.armedSlot).toBeNull();
  });

  test("10. setBagSlot writes the whole bag and shows it before the settings broadcast lands", async () => {
    let api: UseEditorToolStateReturn | null = null;
    render(
      createElement(Probe, {
        captureId: "cap-1",
        onSnapshot: (a) => {
          api = a;
        }
      })
    );
    // Hold the write open so the optimistic bag is observable.
    let finishWrite: () => void = () => undefined;
    dispatchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishWrite = () => resolve({ ok: true, value: undefined });
        })
    );
    const saved = {
      tool: "text" as const,
      style: { color: "blue", fontSize: "large" as const, weight: "bold" as const, outline: "none" as const }
    };
    act(() => {
      api!.setBagSlot(8, saved);
    });
    expect(api!.bag.slots[8]).toEqual(saved);
    const write = dispatchMock.mock.calls.find((c) => c[0] === "settings:write");
    const slots = (write?.[1] as { editor: { toolBag: { slots: unknown[] } } }).editor.toolBag
      .slots;
    expect(slots).toHaveLength(9);
    expect(slots[8]).toEqual(saved);
    expect(slots[0]).toMatchObject({ tool: "arrow", style: { color: "red" } });

    // Once the write resolves the bag reads from settings again (which
    // the real substrate has broadcast by then).
    await act(async () => {
      finishWrite();
      await Promise.resolve();
    });
    expect(api!.bag.slots[8]).toBeNull();
  });

  test("10b. a save before settings land is dropped, so the factory bag never overwrites the saved one", () => {
    installSettingsMock(null);
    let api: UseEditorToolStateReturn | null = null;
    render(
      createElement(Probe, {
        captureId: "cap-10b",
        onSnapshot: (a) => {
          api = a;
        }
      })
    );
    act(() => {
      api!.setBagSlot(8, { tool: "blur", style: { mode: "pixelate", radius: { mode: "auto" } } });
    });
    expect(dispatchMock.mock.calls.some((c) => c[0] === "settings:write")).toBe(false);
    expect(api!.bag.slots[8]).toBeNull();
  });

  test("11. clearing the armed slot disarms it", () => {
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
      api!.armSlot(2);
    });
    act(() => {
      api!.setBagSlot(2, null);
    });
    expect(api!.armedSlot).toBeNull();
    expect(api!.bag.slots[2]).toBeNull();
  });

  test("12. arming a slot remembers its style as the tool's default", () => {
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
      api!.armSlot(1);
    });
    act(() => {
      vi.advanceTimersByTime(501);
    });
    const write = dispatchMock.mock.calls.find(
      (c) =>
        c[0] === "settings:write" &&
        (c[1] as { editor?: { toolStyles?: unknown } }).editor?.toolStyles !== undefined
    );
    expect(
      (write?.[1] as { editor: { toolStyles: { arrow: unknown } } }).editor.toolStyles.arrow
    ).toMatchObject({ color: "green", endStyle: "filled-triangle" });
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

  // Tests 15–17: the commit-time settle surface. Draft commits await
  // `settledToolStyles()` so a draw racing the settings load stamps
  // the user's configured styles, degrading to factory defaults only
  // when settings never land (the editor-border-outline flake).

  test("15. settledToolStyles resolves immediately once settings are loaded", async () => {
    installSettingsMock(makeSettings({ arrowColor: "red" }));
    let api: UseEditorToolStateReturn | null = null;
    render(
      createElement(Probe, {
        captureId: "cap-15",
        onSnapshot: (a) => {
          api = a;
        }
      })
    );

    const styles = await api!.settledToolStyles();
    // User-configured settings, not the factory defaults.
    expect(styles.arrow.color).toBe("red");
  });

  test("16. settledToolStyles: pending while settings load, resolves promptly when they land", async () => {
    installSettingsMock(null);
    let api: UseEditorToolStateReturn | null = null;
    const probe = (): React.ReactElement =>
      createElement(Probe, {
        captureId: "cap-16",
        onSnapshot: (a) => {
          api = a;
        }
      });
    render(probe());

    let styles: EditorToolStyles | null = null;
    const wait = api!.settledToolStyles().then((s) => {
      styles = s;
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(styles).toBeNull();

    // Settings land (broadcast/read resolution → hook re-render). The
    // promise must resolve off the settle EFFECT, promptly — this test
    // runs on REAL timers, so if it only resolved via the 3s bounded
    // backstop the microtask flush below would still see null and fail.
    installSettingsMock(makeSettings({ arrowColor: "gray" }));
    rerender(probe());
    await act(async () => {
      await wait;
    });
    expect(styles).not.toBeNull();
    // The resolved value is the USER's settings, not factory defaults —
    // even though the caller's render closure predates the settle.
    expect(styles!.arrow.color).toBe("gray");
  });

  test("17. settledToolStyles is bounded: factory defaults ~3s in if settings never land, then short-circuits", async () => {
    vi.useFakeTimers();
    installSettingsMock(null);
    let api: UseEditorToolStateReturn | null = null;
    render(
      createElement(Probe, {
        captureId: "cap-17",
        onSnapshot: (a) => {
          api = a;
        }
      })
    );

    let styles: EditorToolStyles | null = null;
    void api!.settledToolStyles().then((s) => {
      styles = s;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2999);
    });
    expect(styles).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    // Timed-out settle degrades to the factory defaults (never a
    // style-less null) so the commit persists a sane overlay.
    expect(styles).not.toBeNull();
    expect(styles!.arrow.color).toBe("accent");
    expect(styles!.arrow.outline).toBe("auto");

    // Later commits against the still-wedged settings read must NOT
    // re-park 3s each — the timeout latches and subsequent calls
    // resolve immediately.
    let second: EditorToolStyles | null = null;
    void api!.settledToolStyles().then((s) => {
      second = s;
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(second).not.toBeNull();
  });
});
