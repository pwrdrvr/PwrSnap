import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { AboutPage } from "../AboutPage";

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

async function renderAbout(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(AboutPage));
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

describe("AboutPage", () => {
  test("renders version metadata and proprietary license row", async () => {
    installFakeApi(
      vi.fn(async (name) => {
        if (name === "app:version") {
          return {
            ok: true as const,
            value: {
              version: "1.0.0-alpha.3",
              electronVersion: "41.2.1",
              nodeVersion: "24.0.0",
              chromeVersion: "142.0.0.0"
            }
          };
        }
        return { ok: true as const, value: undefined };
      })
    );

    await renderAbout();

    expect(container?.textContent).toContain("1.0.0-alpha.3");
    expect(container?.textContent).toContain("UNLICENSED · © 2026 PwrDrvr LLC");
  });

  test("opens third-party licenses from About", async () => {
    const dispatch = vi.fn(async (name) => {
      if (name === "app:version") {
        return {
          ok: true as const,
          value: {
            version: "1.0.0-alpha.3",
            electronVersion: "41.2.1",
            nodeVersion: "24.0.0",
            chromeVersion: "142.0.0.0"
          }
        };
      }
      return { ok: true as const, value: undefined };
    });
    installFakeApi(dispatch);

    await renderAbout();

    const button = Array.from(container!.querySelectorAll("button")).find(
      (el) => el.textContent === "Open licenses"
    )!;
    await act(async () => {
      button.click();
    });

    expect(dispatch).toHaveBeenCalledWith("app:openDocumentWindow", {
      kind: "third-party-licenses"
    });
  });

  test("opens changelog from About", async () => {
    const dispatch = vi.fn(async (name) => {
      if (name === "app:version") {
        return {
          ok: true as const,
          value: {
            version: "1.0.0-alpha.3",
            electronVersion: "41.2.1",
            nodeVersion: "24.0.0",
            chromeVersion: "142.0.0.0"
          }
        };
      }
      return { ok: true as const, value: undefined };
    });
    installFakeApi(dispatch);

    await renderAbout();

    const button = Array.from(container!.querySelectorAll("button")).find(
      (el) => el.textContent === "Open changelog"
    )!;
    await act(async () => {
      button.click();
    });

    expect(dispatch).toHaveBeenCalledWith("app:openDocumentWindow", {
      kind: "changelog"
    });
  });

  test("surfaces document open failures without breaking version display", async () => {
    installFakeApi(
      vi.fn(async (name) => {
        if (name === "app:version") {
          return {
            ok: true as const,
            value: {
              version: "1.0.0-alpha.3",
              electronVersion: "41.2.1",
              nodeVersion: "24.0.0",
              chromeVersion: "142.0.0.0"
            }
          };
        }
        return { ok: false as const, error: { message: "window failed" } };
      })
    );

    await renderAbout();

    const button = Array.from(container!.querySelectorAll("button")).find(
      (el) => el.textContent === "Open changelog"
    )!;
    await act(async () => {
      button.click();
    });

    expect(container?.textContent).toContain("1.0.0-alpha.3");
    expect(container?.textContent).toContain("Failed to open document: window failed");
  });
});
