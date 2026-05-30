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

function projects(count: number): SizzleProject[] {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    return project({
      id: `sz_${n}`,
      name: `Reel ${n}`,
      createdAt: new Date(Date.UTC(2026, 4, n, 12, 0, 0)).toISOString(),
      modifiedAt: new Date(Date.UTC(2026, 4, n, 13, 0, 0)).toISOString()
    });
  });
}

function installApi(projects: SizzleProject[]): {
  dispatch: ReturnType<typeof vi.fn>;
  emit: (channel: string, payload: unknown) => void;
} {
  const handlers = new Map<string, Set<Handler>>();
  const dispatch = vi.fn(async (name: string, req?: unknown) => {
    if (name === "sizzle:list") return { ok: true, value: { projects } };
    if (name === "library:list") return { ok: true, value: { rows: [] } };
    if (name === "sizzle:update") {
      const id = (req as { id?: string } | undefined)?.id;
      return { ok: true, value: projects.find((p) => p.id === id) ?? projects[0] };
    }
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

async function renderApp(initial: SizzleProject | SizzleProject[]): Promise<{
  el: HTMLDivElement;
  emit: (channel: string, payload: unknown) => void;
  dispatch: ReturnType<typeof vi.fn>;
}> {
  const { dispatch, emit } = installApi(Array.isArray(initial) ? initial : [initial]);
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
  return { el: container, emit, dispatch };
}

function titleValue(el: HTMLElement): string {
  return el.querySelector<HTMLInputElement>(".szl__editor-title")?.value ?? "";
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

function projectRowNames(list: Element | null): string[] {
  return Array.from(list?.querySelectorAll(".szl__row-name") ?? []).map(
    (el) => el.textContent ?? ""
  );
}

function clickProjectRow(list: Element | null, name: string): void {
  const button = Array.from(list?.querySelectorAll<HTMLButtonElement>(".szl__row") ?? [])
    .find((row) => row.textContent?.includes(name) === true);
  if (button === undefined) throw new Error(`project row not found: ${name}`);
  button.click();
}

function findButton(el: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(el.querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => candidate.textContent?.trim() === label);
  if (button === undefined) throw new Error(`button not found: ${label}`);
  return button;
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  // jsdom shares window across a file's tests — reset the nav hash so one
  // test's projectId seed can't leak into the next.
  window.location.hash = "";
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

describe("SizzleApp sequence authoring", () => {
  test("turns a simple scene into a visible grouped sequence", async () => {
    const { el } = await renderApp(
      project({ scenes: [scene({ scriptLine: "one narration block" })] })
    );

    expect(el.textContent).not.toContain("Sequence · one narration block");

    await act(async () => {
      findButton(el, "Sequence").click();
    });

    expect(el.textContent).toContain("Sequence · one narration block");
    expect(scriptBox(el).value).toBe("one narration block");
    expect(el.querySelectorAll(".szl__sequence-beat")).toHaveLength(1);
    expect(el.textContent).toContain("non-final beats end automatically");
  });
});

describe("SizzleApp open-to-project navigation", () => {
  const first = project({ id: "sz_1", name: "First reel" });
  const second = project({ id: "sz_2", name: "Second reel" });

  test("events:sizzle:nav switches to the clicked reel when already open", async () => {
    // The reported bug: clicking the 2nd Sizzle Reel in the Library opened
    // the composer on the 1st project. With the nav subscription the open
    // window jumps to the clicked one.
    const { el, emit } = await renderApp([first, second]);
    expect(titleValue(el)).toBe("First reel"); // defaults to projects[0]

    await act(async () => {
      emit(EVENT_CHANNELS.sizzleNav, { projectId: "sz_2" });
    });
    expect(titleValue(el)).toBe("Second reel");
  });

  test("a newly-opened window honors the projectId in the URL hash", async () => {
    window.location.hash = "#stage=sizzle&projectId=sz_2";
    const { el } = await renderApp([first, second]);
    // Seeded from the hash → lands on the 2nd reel, not projects[0].
    expect(titleValue(el)).toBe("Second reel");
  });
});

describe("SizzleApp project rail", () => {
  test("shows creation and update dates on project rows", async () => {
    const p = project({
      scenes: [scene(), scene({ id: "sc_b" })],
      createdAt: "2026-05-24T12:00:00.000Z",
      modifiedAt: "2026-05-28T12:00:00.000Z"
    });
    const { el } = await renderApp(p);
    const activeRow = el.querySelector(".szl__row.is-active");
    expect(activeRow?.textContent).toContain("Demo Reel");
    expect(activeRow?.textContent).toContain("Created");
    expect(activeRow?.textContent).toContain("2 clips");
    expect(activeRow?.textContent).toContain("Updated");
    expect(activeRow?.textContent).toContain("2026");
  });

  test("caps the scrollable projects list while keeping an opened project visible in Recents", async () => {
    window.location.hash = "#stage=sizzle&projectId=sz_105";
    const { el } = await renderApp(projects(106));

    const recents = el.querySelector('[data-testid="sizzle-recents-list"]');
    const projectList = el.querySelector('[data-testid="sizzle-projects-list"]');
    expect(projectList?.classList.contains("szl__list--projects")).toBe(true);
    expect(projectList?.querySelectorAll(".szl__row")).toHaveLength(100);
    expect(recents?.textContent).toContain("Reel 105");
    expect(recents?.querySelector(".szl__row.is-active")?.textContent).toContain("Reel 105");
  });

  test("clicking an existing recent project does not reorder Recents", async () => {
    const { el } = await renderApp(projects(3));
    const recents = el.querySelector('[data-testid="sizzle-recents-list"]');
    const projectList = el.querySelector('[data-testid="sizzle-projects-list"]');
    expect(projectRowNames(recents)).toEqual(["Reel 1"]);

    await act(async () => {
      clickProjectRow(projectList, "Reel 2");
    });
    expect(projectRowNames(recents)).toEqual(["Reel 2", "Reel 1"]);

    await act(async () => {
      clickProjectRow(recents, "Reel 1");
    });
    expect(projectRowNames(recents)).toEqual(["Reel 2", "Reel 1"]);
    expect(recents?.querySelector(".szl__row.is-active")?.textContent).toContain("Reel 1");
  });
});
