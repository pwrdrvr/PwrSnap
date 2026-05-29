// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { EVENT_CHANNELS, type SizzleProject, type SizzleScene } from "@pwrsnap/shared";
import { SizzleApp } from "../SizzleApp";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom implements neither of these; the composer touches them.
  Element.prototype.scrollIntoView = vi.fn();
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

type Handler = (payload: unknown) => void;

function scene(patch: Partial<SizzleScene> = {}): SizzleScene {
  return {
    id: "sc_a",
    captureId: "cap_a",
    scriptLine: "",
    durationOverrideSec: null,
    mediaTrim: null,
    audioSource: "auto",
    transition: "crossfade",
    ...patch
  };
}

function project(patch: Partial<SizzleProject> = {}): SizzleProject {
  return {
    id: "sz_1",
    name: "Demo Reel",
    createdAt: "2026-05-28T00:00:00.000Z",
    modifiedAt: "2026-05-28T00:00:00.000Z",
    scenes: [scene()],
    voice: "onyx",
    ttsModel: "tts-1-hd",
    ttsProvider: "openai",
    resolution: "1080p",
    outputPath: null,
    lastRenderedAt: null,
    ...patch
  };
}

function installApi(initial: SizzleProject): {
  dispatch: ReturnType<typeof vi.fn>;
  emit: (channel: string, payload: unknown) => void;
} {
  const handlers = new Map<string, Set<Handler>>();
  const dispatch = vi.fn(async (name: string) => {
    if (name === "sizzle:list") return { ok: true, value: { projects: [initial] } };
    if (name === "library:list") return { ok: true, value: { rows: [] } };
    if (name === "sizzle:update") return { ok: true, value: initial };
    return { ok: true, value: undefined };
  });
  const on = (channel: string, handler: Handler): (() => void) => {
    const set = handlers.get(channel) ?? new Set<Handler>();
    set.add(handler);
    handlers.set(channel, set);
    return () => set.delete(handler);
  };
  const emit = (channel: string, payload: unknown): void => {
    for (const h of handlers.get(channel) ?? []) h(payload);
  };
  (globalThis as unknown as { window: Window }).window.pwrsnapApi = {
    dispatch,
    on,
    startCaptureDrag: () => undefined
  } as unknown as NonNullable<Window["pwrsnapApi"]>;
  return { dispatch, emit };
}

async function renderApp(initial: SizzleProject): Promise<{
  el: HTMLDivElement;
  emit: (channel: string, payload: unknown) => void;
}> {
  const { emit } = installApi(initial);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(SizzleApp));
  });
  // Drain the mount-time sizzle:list / library:list dispatches.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return { el: container, emit };
}

function scriptBox(el: HTMLElement): HTMLTextAreaElement {
  const box = el.querySelector<HTMLTextAreaElement>(".szl__scene-script");
  if (box === null) throw new Error("scene script textarea not found");
  return box;
}

/** Simulate a user keystroke into a React-controlled textarea. */
function typeInto(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value"
  )!.set!;
  setter.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

describe("SizzleApp live project sync", () => {
  test("renders the active project's scene script on mount", async () => {
    const { el } = await renderApp(project({ scenes: [scene({ scriptLine: "first line" })] }));
    expect(scriptBox(el).value).toBe("first line");
  });

  test("an external sizzle:projects:changed broadcast updates the editor live", async () => {
    // This is the agent-edit path: scene_set_script lands in the store,
    // main broadcasts, and the open composer must reflect it.
    const { el, emit } = await renderApp(project({ scenes: [scene({ scriptLine: "" })] }));
    expect(scriptBox(el).value).toBe("");

    await act(async () => {
      emit(EVENT_CHANNELS.sizzleProjectsChanged, {
        projects: [project({ scenes: [scene({ scriptLine: "agent-written narration" })] })]
      });
    });

    expect(scriptBox(el).value).toBe("agent-written narration");
  });

  test("a broadcast does NOT clobber the user's in-flight (debounced) edit", async () => {
    const { el, emit } = await renderApp(project({ scenes: [scene({ scriptLine: "" })] }));

    // User starts typing — optimistic local state + a pending debounced
    // patch for this project.
    await act(async () => {
      typeInto(scriptBox(el), "user is typing");
    });
    expect(scriptBox(el).value).toBe("user is typing");

    // An external broadcast for the SAME project arrives mid-edit.
    await act(async () => {
      emit(EVENT_CHANNELS.sizzleProjectsChanged, {
        projects: [project({ scenes: [scene({ scriptLine: "stale broadcast value" })] })]
      });
    });

    // The user's in-flight text is preserved, not clobbered.
    expect(scriptBox(el).value).toBe("user is typing");
  });

  test("ignores malformed broadcast payloads", async () => {
    const { el, emit } = await renderApp(project({ scenes: [scene({ scriptLine: "kept" })] }));
    await act(async () => {
      emit(EVENT_CHANNELS.sizzleProjectsChanged, { projects: "not-an-array" });
      emit(EVENT_CHANNELS.sizzleProjectsChanged, null);
    });
    expect(scriptBox(el).value).toBe("kept");
  });
});
