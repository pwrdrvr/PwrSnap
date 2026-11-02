// Pure-logic tests for the hash → route parser, plus the one piece of the
// hook that is not a thin wrapper over it: main's `settingsNavigate` deep
// link, which must carry `sub` through to the hash.

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { EVENT_CHANNELS, SETTINGS_PAGE_SUBS } from "@pwrsnap/shared";
import { AI_PROVIDER_SUBS } from "../ai-provider-status";
import {
  routeFromHash,
  setActivePage,
  useActiveRoute,
  type ActiveSettingsRoute
} from "../useActivePage";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

// The page half of the route. `routeFromHash(...).page` is what the
// Settings shell renders from.
const pageFromHash = (hash: string) => routeFromHash(hash).page;

describe("routeFromHash — page", () => {
  test("defaults to 'general' when no hash is set", () => {
    expect(pageFromHash("")).toBe("general");
    expect(pageFromHash("#")).toBe("general");
  });

  test("defaults to 'general' when 'page' param is missing", () => {
    expect(pageFromHash("#stage=settings")).toBe("general");
  });

  test("returns the page id when valid", () => {
    expect(pageFromHash("#stage=settings&page=hotkeys")).toBe("hotkeys");
    expect(pageFromHash("#page=about")).toBe("about");
    expect(pageFromHash("#stage=settings&page=ai")).toBe("ai");
  });

  test("falls back to 'general' on unknown page values", () => {
    expect(pageFromHash("#stage=settings&page=bogus")).toBe("general");
    expect(pageFromHash("#page=")).toBe("general");
    expect(pageFromHash("#page=__proto__")).toBe("general");
  });

  test("ignores other params in the hash", () => {
    expect(pageFromHash("#foo=bar&stage=settings&page=general&baz=qux")).toBe("general");
  });

  test("strips a leading '#' regardless of placement", () => {
    expect(pageFromHash("stage=settings&page=storage")).toBe("storage");
    expect(pageFromHash("#stage=settings&page=storage")).toBe("storage");
  });
});

describe("routeFromHash", () => {
  test("no sub means the page's hub", () => {
    expect(routeFromHash("#stage=settings&page=ai")).toEqual({ page: "ai", sub: null });
  });

  test("a provider sub on the AI page is honored", () => {
    expect(routeFromHash("#stage=settings&page=ai&sub=codex")).toEqual({
      page: "ai",
      sub: "codex"
    });
    expect(routeFromHash("#stage=settings&page=ai&sub=kimi")).toEqual({ page: "ai", sub: "kimi" });
    expect(routeFromHash("#stage=settings&page=ai&sub=openai")).toEqual({
      page: "ai",
      sub: "openai"
    });
  });

  test("an unknown sub drops to the hub instead of a blank screen", () => {
    expect(routeFromHash("#stage=settings&page=ai&sub=bogus")).toEqual({ page: "ai", sub: null });
    expect(routeFromHash("#stage=settings&page=ai&sub=")).toEqual({ page: "ai", sub: null });
  });

  test("an AI Features section is a sub of that page only", () => {
    expect(routeFromHash("#stage=settings&page=ai-features&sub=usage")).toEqual({
      page: "ai-features",
      sub: "usage"
    });
    expect(routeFromHash("#stage=settings&page=ai&sub=usage")).toEqual({ page: "ai", sub: null });
    expect(routeFromHash("#stage=settings&page=ai-features&sub=codex")).toEqual({
      page: "ai-features",
      sub: null
    });
  });

  test("a sub is only valid on the page that owns it", () => {
    expect(routeFromHash("#stage=settings&page=hotkeys&sub=codex")).toEqual({
      page: "hotkeys",
      sub: null
    });
    // Invalid page falls back to general, and general has no subs.
    expect(routeFromHash("#stage=settings&page=bogus&sub=codex")).toEqual({
      page: "general",
      sub: null
    });
  });
});

describe("AI Providers sub ids", () => {
  // The sidebar orders the screens; @pwrsnap/shared owns which exist, because
  // main validates `settings:open` against it. They must be the same SET, or a
  // sidebar child would open a screen main refuses to deep-link (or vice versa).
  test("the sidebar's order covers exactly the shared allowlist", () => {
    expect([...AI_PROVIDER_SUBS].sort()).toEqual([...SETTINGS_PAGE_SUBS.ai].sort());
  });
});

describe("useActiveRoute — main's settingsNavigate deep link", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let navigate: ((payload: unknown) => void) | null = null;
  let latest: ActiveSettingsRoute | null = null;

  function Probe(): ReactElement | null {
    latest = useActiveRoute();
    return null;
  }

  async function mount(): Promise<void> {
    window.location.hash = "stage=settings&page=general";
    Object.defineProperty(window, "pwrsnapApi", {
      configurable: true,
      value: {
        platform: "darwin",
        dispatch: async () => ({ ok: false, error: { kind: "unknown", code: "x", message: "x" } }),
        on: (channel: string, handler: (payload: unknown) => void) => {
          if (channel === EVENT_CHANNELS.settingsNavigate) navigate = handler;
          return () => undefined;
        }
      }
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(Probe));
    });
  }

  // jsdom queues `hashchange` as a task, so let it land before asserting.
  async function send(payload: unknown): Promise<void> {
    await act(async () => {
      navigate?.(payload);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    container?.remove();
    root = null;
    container = null;
    navigate = null;
    latest = null;
    window.location.hash = "";
    Reflect.deleteProperty(window, "pwrsnapApi");
  });

  test("a validated sub lands on that screen", async () => {
    await mount();
    await send({ page: "ai", sub: "codex" });
    expect(window.location.hash).toBe("#stage=settings&page=ai&sub=codex");
    expect(latest).toMatchObject({ page: "ai", sub: "codex" });
  });

  test("no sub lands on the hub, even from a sub screen", async () => {
    await mount();
    await send({ page: "ai", sub: "kimi" });
    await send({ page: "ai" });
    expect(latest).toMatchObject({ page: "ai", sub: null });
  });

  test("a sub the renderer does not know still navigates — to the hub", async () => {
    await mount();
    await send({ page: "ai", sub: "claude" });
    expect(window.location.hash).toBe("#stage=settings&page=ai");
    expect(latest).toMatchObject({ page: "ai", sub: null });

    await send({ page: "hotkeys", sub: "codex" });
    expect(latest).toMatchObject({ page: "hotkeys", sub: null });
  });

  test("an unknown page is still ignored", async () => {
    await mount();
    await send({ page: "bogus", sub: "codex" });
    expect(latest).toMatchObject({ page: "general", sub: null });
  });

  // A jump-to section scrolls on `request`. Assigning an unchanged hash
  // fires no `hashchange`, so without the re-request a second click on
  // "Usage" (after scrolling away) would do nothing.
  test("asking again for the route already shown bumps its request", async () => {
    await mount();
    await send({ page: "ai-features", sub: "usage" });
    const first = latest?.request ?? -1;
    expect(latest).toMatchObject({ page: "ai-features", sub: "usage" });

    await act(async () => {
      setActivePage("ai-features", "usage");
    });
    expect(latest).toMatchObject({ page: "ai-features", sub: "usage", request: first + 1 });

    // A deep link from main to the same place is a request too.
    await send({ page: "ai-features", sub: "usage" });
    expect(latest?.request).toBe(first + 2);
  });

  test("a hash write that moves nothing is not a request", async () => {
    await mount();
    await send({ page: "ai-features", sub: "usage" });
    const before = latest;
    await act(async () => {
      window.location.hash = "stage=settings&page=ai-features&sub=usage&unrelated=1";
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(latest).toBe(before);

    // …but asking for that route IS one, however the hash happens to spell it.
    const request = latest?.request ?? -1;
    await act(async () => {
      setActivePage("ai-features", "usage");
    });
    expect(latest?.request).toBe(request + 1);
  });
});
