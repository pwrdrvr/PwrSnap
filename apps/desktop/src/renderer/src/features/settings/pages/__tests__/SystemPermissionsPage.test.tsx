// SystemPermissionsPage — the screen-permission disambiguation that is
// the user-facing heart of the first-run fix:
//   • screen not granted + screenCapturePrompted=false → synthesized
//     "Not yet requested" + a "Request access" button (fires the prompt);
//   • screen not granted + screenCapturePrompted=true → "Denied" + an
//     "Open System Settings" button (macOS won't re-prompt).
// macOS itself can't tell these apart (getMediaAccessStatus('screen') is
// `denied` in both cases) — the page leans on `screenCapturePrompted`.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import type { PermissionReadinessReport } from "@pwrsnap/shared";
import { SystemPermissionsPage } from "../SystemPermissionsPage";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

type AnyResult = { ok: true; value: unknown } | { ok: false; error: { message: string } };

function installFakeApi(report: PermissionReadinessReport): {
  calls: { name: string; req: unknown }[];
} {
  const calls: { name: string; req: unknown }[] = [];
  Object.defineProperty(window, "pwrsnapApi", {
    configurable: true,
    value: {
      platform: "darwin",
      dispatch: async (name: string, req: unknown): Promise<AnyResult> => {
        calls.push({ name, req });
        if (name === "permissions:readiness") return { ok: true, value: report };
        return { ok: true, value: undefined };
      }
    }
  });
  return { calls };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function render(report: PermissionReadinessReport): Promise<{
  calls: { name: string; req: unknown }[];
}> {
  const api = installFakeApi(report);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(SystemPermissionsPage));
  });
  // Let the on-mount readiness fetch resolve + re-render.
  await act(async () => {
    await Promise.resolve();
  });
  return api;
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

function rowByTag(tag: string): HTMLElement {
  const row = Array.from(container!.querySelectorAll<HTMLElement>(".pss__row")).find(
    (el) => el.querySelector(".pss__row-tag")?.textContent === tag
  );
  if (!row) throw new Error(`no row with tag "${tag}"`);
  return row;
}

const baseReport: PermissionReadinessReport = {
  screenRecording: "denied",
  microphone: "not-determined",
  systemAudio: "denied",
  fingerprint: "0123456789abcdef",
  screenCapturePrompted: false
};

describe("SystemPermissionsPage — screen permission disambiguation", () => {
  test("never prompted: denied screen shows 'Not yet requested' + Request access", async () => {
    await render({ ...baseReport, screenCapturePrompted: false });
    const row = rowByTag("screen");
    const status = row.querySelector<HTMLElement>("[data-permission-status]");
    expect(status?.getAttribute("data-permission-status")).toBe("not-determined");
    expect(row.textContent).toContain("Not yet requested");
    const button = row.querySelector("button");
    expect(button?.textContent).toBe("Request access");
  });

  test("already prompted: denied screen shows 'Denied' + Open System Settings", async () => {
    await render({ ...baseReport, screenCapturePrompted: true });
    const row = rowByTag("screen");
    const status = row.querySelector<HTMLElement>("[data-permission-status]");
    expect(status?.getAttribute("data-permission-status")).toBe("denied");
    const button = row.querySelector("button");
    expect(button?.textContent).toBe("Open System Settings");
  });

  test("granted screen shows no action button", async () => {
    await render({ ...baseReport, screenRecording: "granted", screenCapturePrompted: true });
    const row = rowByTag("screen");
    expect(row.textContent).toContain("Granted");
    expect(row.querySelector("button")).toBeNull();
  });

  test("Request access dispatches permissions:request for screen", async () => {
    const { calls } = await render({ ...baseReport, screenCapturePrompted: false });
    const button = rowByTag("screen").querySelector("button");
    await act(async () => {
      button?.click();
    });
    expect(
      calls.some(
        (c) =>
          c.name === "permissions:request" &&
          (c.req as { permission?: string }).permission === "screen"
      )
    ).toBe(true);
  });
});
