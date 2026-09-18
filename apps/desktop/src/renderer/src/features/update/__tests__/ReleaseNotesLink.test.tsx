// The one control that takes a version out to its published release page.
// Four surfaces render it, so its rules are pinned here rather than four
// times over: it is a real `<a href>`, a plain click opens through the bus
// rather than navigating this document, and it disappears rather than
// offering a dead link.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
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
    await render({ version: "1.2.0", className: "x" });

    const control = container?.querySelector("a");
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

  test("composes the URL itself, so a caller cannot pass one in", async () => {
    // The whole reason the prop is a version: the "is this a published
    // release?" decision is made here, once, and not re-decided by each of
    // the copy modules that produce the surrounding wording.
    const api = installFakeApi();
    await render({ version: "v1.1.0-beta.5", className: "x" });
    await act(async () => {
      container?.querySelector("a")?.click();
      await Promise.resolve();
    });
    expect(api.calls[0]?.req).toEqual({
      url: "https://github.com/pwrdrvr/PwrSnap/releases/tag/v1.1.0-beta.5"
    });
  });

  test("goes quiet with its siblings while their shared action is in flight", async () => {
    // An anchor has no `disabled`, and `aria-disabled` alone would leave the
    // `href` — the one thing a cmd-click reaches without `onClick` — live on
    // a control that has been greyed out. So the href goes too.
    const api = installFakeApi();
    await render({ version: "1.2.0", className: "x", disabled: true });

    const control = container?.querySelector("a");
    expect(control?.getAttribute("aria-disabled")).toBe("true");
    expect(control?.getAttribute("href")).toBeNull();
    expect(control?.getAttribute("tabindex")).toBe("-1");

    await act(async () => {
      control?.click();
      await Promise.resolve();
    });
    expect(api.calls).toEqual([]);
  });

  test("does not put the URL in the accessible description", async () => {
    // `title` is only used for the accessible NAME as a last resort; with a
    // name already present it becomes the description, and a screen reader
    // reads the whole URL aloud after every announcement of the link.
    installFakeApi();
    await render({ version: "1.2.0", className: "x" });
    expect(container?.querySelector("a")?.getAttribute("title")).toBeNull();
  });

  test("carries the href a modifier-click reaches, and cancels the plain one", async () => {
    // `onClick` is NOT consulted for a middle-click or a cmd-click —
    // Chromium turns those into a `window.open` — so the href is the only
    // thing those inputs can follow, and the navigation guard
    // (main/navigation-guard.ts) is what turns the window it would have
    // opened into a browser tab. A plain click must still be cancelled:
    // an in-app navigation to github.com is what the guard exists to refuse.
    installFakeApi();
    await render({ version: "1.2.0", className: "x" });

    expect(container?.querySelector("button")).toBeNull();
    const control = container?.querySelector("a");
    expect(control?.getAttribute("href")).toBe(
      "https://github.com/pwrdrvr/PwrSnap/releases/tag/v1.2.0"
    );

    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => {
      control?.dispatchEvent(event);
      await Promise.resolve();
    });
    expect(event.defaultPrevented).toBe(true);
  });

  test("renders nothing when the version has no published page", async () => {
    // A dev build, or an E2E version override. An offer to read notes that
    // land on a 404 is worse than no offer.
    installFakeApi();
    await render({ version: "dev-build", className: "x" });

    expect(container?.querySelector("a")).toBeNull();
    expect(container?.textContent).toBe("");
  });

  test("takes an accessible name for surfaces that render several at once", async () => {
    // Settings -> Updates draws one per published slot; four controls all
    // named "Release notes" is not a usable list.
    installFakeApi();
    await render({
      version: "v1.1.0-beta.5",
      className: "x",
      label: "Notes",
      ariaLabel: "Release notes for Beta Latest v1.1.0-beta.5"
    });

    const control = container?.querySelector("a");
    expect(control?.textContent).toBe("Notes");
    expect(control?.getAttribute("aria-label")).toBe(
      "Release notes for Beta Latest v1.1.0-beta.5"
    );
  });
});
