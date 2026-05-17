import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { AppDocumentWindow } from "../AppDocumentWindow";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

type AnyResult = { ok: true; value: unknown } | { ok: false; error: { message: string } };

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function installFakeApi(dispatch: (name: string, req: unknown) => Promise<AnyResult>): void {
  Object.defineProperty(window, "pwrsnapApi", {
    configurable: true,
    value: { dispatch }
  });
}

async function render(kind: "changelog" | "third-party-licenses" | null): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(AppDocumentWindow, { kind }));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

async function unmount(): Promise<void> {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
}

afterEach(async () => {
  await unmount();
});

describe("AppDocumentWindow", () => {
  test("dispatches app:readDocument and renders changelog content", async () => {
    const dispatch = vi.fn(async () => ({
      ok: true as const,
      value: { kind: "changelog", title: "Changelog", content: "# Changelog\n\n- One" }
    }));
    installFakeApi(dispatch);

    await render("changelog");

    expect(dispatch).toHaveBeenCalledWith("app:readDocument", { kind: "changelog" });
    expect(container?.textContent).toContain("# Changelog");
  });

  test("renders third-party license content with its document label", async () => {
    const dispatch = vi.fn(async () => ({
      ok: true as const,
      value: {
        kind: "third-party-licenses",
        title: "Third-Party Licenses",
        content: "PwrSnap Third-Party Licenses\n\n@fontsource/geist-sans"
      }
    }));
    installFakeApi(dispatch);

    await render("third-party-licenses");

    expect(dispatch).toHaveBeenCalledWith("app:readDocument", {
      kind: "third-party-licenses"
    });
    expect(container?.querySelector("[aria-label='Third-Party Licenses']")?.textContent).toContain(
      "@fontsource/geist-sans"
    );
  });

  test("renders an inline error when reading fails", async () => {
    installFakeApi(
      vi.fn(async () => ({
        ok: false as const,
        error: { message: "missing document" }
      }))
    );

    await render("changelog");

    expect(container?.textContent).toContain("Could not load document: missing document");
  });

  test("does not dispatch for an unknown document kind", async () => {
    const dispatch = vi.fn(async () => ({ ok: true as const, value: {} }));
    installFakeApi(dispatch);

    await render(null);

    expect(dispatch).not.toHaveBeenCalled();
    expect(container?.textContent).toContain("Could not load document: Unknown app document.");
  });
});
