// The one control that takes a version out to its published release page.
// Four surfaces render it, so its three rules are pinned here rather than
// four times over: it opens through the bus, it never navigates this
// document, and it disappears rather than offering a dead link.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { releaseNotesUrl } from "@pwrsnap/shared";
import { ReleaseNotesLink } from "../ReleaseNotesLink";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function installFakeApi(): { calls: { name: string; req: unknown }[] } {
  const calls: { name: string; req: unknown }[] = [];
  Object.defineProperty(window, "pwrsnapApi", {
    configurable: true,
    value: {
      dispatch: async (name: string, req: unknown) => {
        calls.push({ name, req });
        return { ok: true, value: undefined };
      },
      on: () => () => undefined
    }
  });
  return { calls };
}

async function render(props: Parameters<typeof ReleaseNotesLink>[0]): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(ReleaseNotesLink, props));
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

describe("ReleaseNotesLink", () => {
  test("hands the URL to the bus rather than navigating", async () => {
    const api = installFakeApi();
    await render({ url: releaseNotesUrl("1.2.0"), className: "x" });

    const control = container?.querySelector("button");
    expect(control?.textContent).toBe("Release notes");
    await act(async () => {
      control?.click();
      await Promise.resolve();
    });

    expect(api.calls).toEqual([
      {
        name: "app:openExternal",
        req: { url: "https://github.com/pwrdrvr/PwrSnap/releases/tag/v1.2.0" }
      }
    ]);
  });

  test("is a button with no href, so no click can navigate a window", async () => {
    // PwrSnap installs no `will-navigate` / `setWindowOpenHandler` guard, so
    // a real anchor's middle-click or cmd-click is the one input that could
    // put a remote origin inside an app BrowserWindow. There is nothing to
    // middle-click here.
    installFakeApi();
    await render({ url: releaseNotesUrl("1.2.0"), className: "x" });

    expect(container?.querySelector("a")).toBeNull();
    const control = container?.querySelector("button");
    expect(control?.getAttribute("type")).toBe("button");
    expect(control?.getAttribute("href")).toBeNull();
  });

  test("renders nothing when the version has no published page", async () => {
    // A dev build, or an E2E version override. An offer to read notes that
    // land on a 404 is worse than no offer.
    installFakeApi();
    await render({ url: releaseNotesUrl("dev-build"), className: "x" });

    expect(container?.querySelector("button")).toBeNull();
    expect(container?.textContent).toBe("");
  });

  test("takes an accessible name for surfaces that render several at once", async () => {
    // Settings -> Updates draws one per published slot; four controls all
    // named "Release notes" is not a usable list.
    installFakeApi();
    await render({
      url: releaseNotesUrl("v1.1.0-beta.5"),
      className: "x",
      label: "Notes",
      ariaLabel: "Release notes for Beta Latest v1.1.0-beta.5"
    });

    const control = container?.querySelector("button");
    expect(control?.textContent).toBe("Notes");
    expect(control?.getAttribute("aria-label")).toBe(
      "Release notes for Beta Latest v1.1.0-beta.5"
    );
    // The URL is also the tooltip, so the destination is inspectable without
    // opening it — there is no status bar in a renderer window.
    expect(control?.getAttribute("title")).toBe(
      "https://github.com/pwrdrvr/PwrSnap/releases/tag/v1.1.0-beta.5"
    );
  });
});
