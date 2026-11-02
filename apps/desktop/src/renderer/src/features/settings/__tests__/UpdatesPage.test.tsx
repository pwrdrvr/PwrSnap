// Settings -> Updates' release-notes wiring.
//
// Two things here are easy to get subtly wrong and impossible to see in a
// screenshot: WHICH release each of the four slot links points at, and which
// version the one beside the status sentence is scoped to. The second has a
// precedence rule — the live status wins over the settled check result, the
// same order the sentence itself uses — so a link that quietly disagreed with
// the text it sits next to would read as correct.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import {
  EVENT_CHANNELS,
  type AppUpdateCheckResult,
  type AppUpdateReleaseVersions,
  type AppUpdateStatus,
  type Settings
} from "@pwrsnap/shared";
import { SettingsContext } from "../SettingsContext";
import { UpdatesPage } from "../pages/UpdatesPage";
import { baseSettings } from "./settings-fixture";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const RELEASES: AppUpdateReleaseVersions = {
  fetchedAt: 0,
  stable: {
    latest: { version: "v1.1.0" },
    prerelease: { version: "v1.1.1" }
  },
  beta: {
    // A slot with nothing published, and a slot whose tag is not a version
    // this repo could have produced — neither may grow a link.
    latest: { unavailableReason: "No beta release found." },
    prerelease: { version: "nightly" }
  }
};

type Api = {
  calls: { name: string; req: unknown }[];
  pushStatus: (status: AppUpdateStatus) => Promise<void>;
};

function installFakeApi(options: { checkResult?: AppUpdateCheckResult } = {}): Api {
  const calls: { name: string; req: unknown }[] = [];
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  Object.defineProperty(window, "pwrsnapApi", {
    configurable: true,
    value: {
      dispatch: async (name: string, req: unknown) => {
        calls.push({ name, req });
        if (name === "app:update:releases") return { ok: true, value: RELEASES };
        if (name === "app:version") return { ok: true, value: { version: "1.1.0" } };
        if (name === "app:update:status") return { ok: true, value: { status: "idle" } };
        if (name === "app:update:check") {
          return { ok: true, value: options.checkResult ?? { status: "no-update", version: "1.1.0" } };
        }
        return { ok: true, value: undefined };
      },
      on: (channel: string, handler: (payload: unknown) => void): (() => void) => {
        const set = listeners.get(channel) ?? new Set();
        set.add(handler);
        listeners.set(channel, set);
        return () => set.delete(handler);
      }
    }
  });
  return {
    calls,
    pushStatus: async (status: AppUpdateStatus) => {
      await act(async () => {
        for (const listener of listeners.get(EVENT_CHANNELS.appUpdateStatus) ?? []) {
          listener(status);
        }
      });
    }
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mountPage(settings: Settings = baseSettings): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const value = {
    settings,
    secrets: null,
    loading: false,
    error: null,
    patch: async () => undefined,
    refreshCodex: async () => null,
    testCodex: async () => null,
    replaceSecret: async () => undefined,
    clearSecret: async () => undefined
  };
  await act(async () => {
    root?.render(
      createElement(SettingsContext.Provider, { value }, createElement(UpdatesPage))
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

/** Every release-notes control on the page, by its accessible name. */
function notesLabels(selector: string): (string | null)[] {
  return Array.from(container?.querySelectorAll(selector) ?? []).map((el) =>
    el.getAttribute("aria-label")
  );
}

/** Every release-notes control on the page, by its `href`. */
function notesHrefs(selector: string): (string | null)[] {
  return Array.from(container?.querySelectorAll(selector) ?? []).map((el) =>
    el.getAttribute("href")
  );
}

async function clickNotes(selector: string, index = 0): Promise<void> {
  const el = Array.from(container?.querySelectorAll(selector) ?? [])[index];
  await act(async () => {
    (el as HTMLElement | undefined)?.click();
    await Promise.resolve();
  });
}

describe("UpdatesPage release notes", () => {
  test("gives every published slot its own link, and the other two none", async () => {
    const api = installFakeApi();
    await mountPage();

    // Two published, so two links — and each names its own slot, because four
    // controls all called "Release notes" is not a usable list.
    expect(notesLabels(".pss__slot-notes")).toEqual([
      "Release notes for Stable Latest v1.1.0",
      "Release notes for Stable Prerelease v1.1.1"
    ]);

    // Each is a real `<a href>`, so its own release page is what a
    // cmd-click reaches — the path `onClick` never sees.
    expect(notesHrefs(".pss__slot-notes")).toEqual([
      "https://github.com/pwrdrvr/PwrSnap/releases/tag/v1.1.0",
      "https://github.com/pwrdrvr/PwrSnap/releases/tag/v1.1.1"
    ]);

    await clickNotes(".pss__slot-notes", 1);
    expect(api.calls).toContainEqual({
      name: "app:openExternal",
      req: { url: "https://github.com/pwrdrvr/PwrSnap/releases/tag/v1.1.1" }
    });
  });

  test("the status link follows the live status, not the settled result", async () => {
    // The sentence itself prefers the live status over the last check's
    // answer; a link beside it that preferred the other one would point at a
    // different release than the text it qualifies.
    const api = installFakeApi();
    await mountPage();
    await api.pushStatus({ status: "downloaded", version: "1.1.1" });

    expect(container?.textContent).toContain("Update ready: v1.1.1");
    expect(notesLabels(".pss__update-notes")).toEqual(["Release notes for v1.1.1"]);

    await clickNotes(".pss__update-notes");
    expect(api.calls).toContainEqual({
      name: "app:openExternal",
      req: { url: "https://github.com/pwrdrvr/PwrSnap/releases/tag/v1.1.1" }
    });
  });

  test("a status that names no version gets no link", async () => {
    const api = installFakeApi();
    await mountPage();

    await api.pushStatus({ status: "error", message: "network down" });
    expect(container?.textContent).toContain("Update check failed");
    expect(container?.querySelector(".pss__update-notes")).toBeNull();

    // Positive control on the same subscription: a status that DOES name one
    // still gets its link, so the assertion above cannot pass by inertia.
    await api.pushStatus({ status: "downloaded", version: "1.1.1" });
    expect(container?.querySelector(".pss__update-notes")).not.toBeNull();
  });

  test("the link hangs outside the tile, which is the radio", async () => {
    // A `role="radio"` cannot contain an interactive element — it would be
    // neither valid HTML nor reachable by keyboard.
    installFakeApi();
    await mountPage();

    for (const link of Array.from(container?.querySelectorAll(".pss__slot-notes") ?? [])) {
      expect(link.closest("[role='radio']")).toBeNull();
    }
    expect(container?.querySelectorAll("a.pss__slot-notes").length).toBe(2);
    expect(container?.querySelectorAll("[role='radio']").length).toBe(4);
  });
});
