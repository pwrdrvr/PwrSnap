// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { LOCAL_AGENT_BUILT_IN_ROLES } from "@pwrsnap/shared";
import { LocalAgentConsent } from "../LocalAgentConsent";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.restoreAllMocks();
});

describe("LocalAgentConsent", () => {
  test("approves an existing PwrSnap role without manufacturing permissions", async () => {
    const dispatch = installConsentApi();
    await renderConsent();

    const searchRole = labelContaining("Search Only");
    expect(searchRole).not.toBeNull();
    act(() => searchRole?.click());
    const allow = buttonNamed("Allow access");
    expect(allow?.disabled).toBe(false);
    await act(async () => allow?.click());

    expect(dispatch).toHaveBeenLastCalledWith("localAgents:consentDecide", {
      requestId: "consent_1",
      decision: "allow",
      sessionName: "PwrAgent",
      roleId: "builtin.search",
      capabilities: []
    });
  });

  test("builds a custom role only from requested permissions and history", async () => {
    const dispatch = installConsentApi();
    await renderConsent();

    act(() => labelContaining("Custom role")?.click());
    const selects = container?.querySelectorAll("select");
    const history = selects?.item(0) as HTMLSelectElement;
    act(() => {
      history.value = "365";
      history.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const composite = labelContaining("Edited composites");
    act(() => composite?.click());
    await act(async () => buttonNamed("Allow access")?.click());

    expect(container?.textContent).not.toContain("Move captures to Trash");
    expect(dispatch).toHaveBeenLastCalledWith("localAgents:consentDecide", {
      requestId: "consent_1",
      decision: "allow",
      sessionName: "PwrAgent",
      roleId: null,
      capabilities: ["library.read", "capture.composite.read"],
      maxCaptureAgeDays: 365
    });
  });
});

function installConsentApi(): ReturnType<typeof vi.fn> {
  const dispatch = vi.fn(async (name: string) => {
    if (name === "localAgents:consentRead") {
      return {
        ok: true,
        value: {
          requestId: "consent_1",
          clientId: "oauth_pwragent",
          clientName: "PwrAgent",
          suggestedSessionName: "PwrAgent",
          permissions: [
            {
              capability: "library.read",
              label: "Library search",
              detail: "Search capture metadata.",
              requested: true
            },
            {
              capability: "capture.composite.read",
              label: "Edited composites",
              detail: "Read edited image pixels.",
              requested: true
            },
            {
              capability: "trash.write",
              label: "Move captures to Trash",
              detail: "Delete captures.",
              requested: false
            }
          ],
          roles: LOCAL_AGENT_BUILT_IN_ROLES
            .filter((role) => ["builtin.search", "builtin.preview"].includes(role.id))
            .map((role) => ({
              ...role,
              permissions: [...role.permissions],
              budgets: {
                search: { ...role.budgets.search },
                "preview.read": { ...role.budgets["preview.read"] },
                "original.read": { ...role.budgets["original.read"] },
                edit: { ...role.budgets.edit },
                delete: { ...role.budgets.delete }
              }
            }))
        }
      };
    }
    return { ok: true, value: undefined };
  });
  window.pwrsnapApi = {
    dispatch,
    on: () => () => undefined,
    startCaptureDrag: () => undefined
  } as never;
  return dispatch;
}

async function renderConsent(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(<LocalAgentConsent />));
}

function labelContaining(text: string): HTMLLabelElement | null {
  return [...(container?.querySelectorAll("label") ?? [])]
    .find((label) => label.textContent?.includes(text)) ?? null;
}

function buttonNamed(text: string): HTMLButtonElement | null {
  return [...(container?.querySelectorAll("button") ?? [])]
    .find((button) => button.textContent?.includes(text)) ?? null;
}
