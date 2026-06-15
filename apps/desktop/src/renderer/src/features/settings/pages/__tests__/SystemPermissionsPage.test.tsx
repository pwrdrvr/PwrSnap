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
import type { PermissionReadinessReport, RecordingPermissionStatus } from "@pwrsnap/shared";
import { SystemPermissionsPage } from "../SystemPermissionsPage";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

type AnyResult = { ok: true; value: unknown } | { ok: false; error: { message: string } };

type FakeApiOpts = {
  // Status that `permissions:request` (the real screen-capture probe)
  // reports back. Defaults to the report's screen status (probe didn't
  // change anything); pass "granted" to simulate the user approving.
  requestStatus?: RecordingPermissionStatus;
  // Whether captures-folder access is denied (drives the Documents row).
  capturesDenied?: boolean;
};

function installFakeApi(
  report: PermissionReadinessReport,
  opts: FakeApiOpts = {}
): {
  calls: { name: string; req: unknown }[];
} {
  const calls: { name: string; req: unknown }[] = [];
  const health = {
    denied: opts.capturesDenied === true,
    deniedPathCount: opts.capturesDenied === true ? 2 : 0,
    samplePath: null,
    firstDeniedAt: null,
    lastDeniedAt: null
  };
  Object.defineProperty(window, "pwrsnapApi", {
    configurable: true,
    value: {
      platform: "darwin",
      on: () => () => undefined,
      dispatch: async (name: string, req: unknown): Promise<AnyResult> => {
        calls.push({ name, req });
        if (name === "permissions:readiness") return { ok: true, value: report };
        if (name === "permissions:request") {
          return { ok: true, value: { status: opts.requestStatus ?? report.screenRecording } };
        }
        if (name === "storage:capturesAccessHealth") return { ok: true, value: health };
        if (name === "storage:checkCapturesAccess") {
          return { ok: true, value: { granted: !health.denied } };
        }
        return { ok: true, value: undefined };
      }
    }
  });
  return { calls };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function render(
  report: PermissionReadinessReport,
  opts: FakeApiOpts = {}
): Promise<{
  calls: { name: string; req: unknown }[];
}> {
  const api = installFakeApi(report, opts);
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

  test("Request access (first ask) probes but does NOT open System Settings", async () => {
    const { calls } = await render({ ...baseReport, screenCapturePrompted: false });
    const button = rowByTag("screen").querySelector("button");
    await act(async () => {
      button?.click();
    });
    const names = calls.map((c) => c.name);
    // Always probe via the real screen-capture attempt…
    expect(
      calls.some(
        (c) =>
          c.name === "permissions:request" &&
          (c.req as { permission?: string }).permission === "screen"
      )
    ).toBe(true);
    // …but on the first ask the OS dialog is the UI — don't pile Settings on.
    expect(names).not.toContain("permissions:openSystemSettings");
  });

  test("Open System Settings (denied) probes FIRST, then opens System Settings", async () => {
    // The probe is what re-registers PwrSnap after a tccutil reset / new
    // build — clicking must never skip it.
    const { calls } = await render(
      { ...baseReport, screenCapturePrompted: true },
      { requestStatus: "denied" }
    );
    const button = rowByTag("screen").querySelector("button");
    expect(button?.textContent).toBe("Open System Settings");
    await act(async () => {
      button?.click();
    });
    const names = calls.map((c) => c.name);
    expect(names).toContain("permissions:request");
    expect(names).toContain("permissions:openSystemSettings");
    // Order: probe before the Settings fallback.
    expect(names.indexOf("permissions:request")).toBeLessThan(
      names.indexOf("permissions:openSystemSettings")
    );
  });

  test("denied screen where the probe grants in-session → no System Settings", async () => {
    const { calls } = await render(
      { ...baseReport, screenCapturePrompted: true },
      { requestStatus: "granted" }
    );
    const button = rowByTag("screen").querySelector("button");
    await act(async () => {
      button?.click();
    });
    const names = calls.map((c) => c.name);
    expect(names).toContain("permissions:request");
    expect(names).not.toContain("permissions:openSystemSettings");
  });

  test("captures folder: healthy → OK + Check access, no Open System Settings", async () => {
    await render(baseReport, { capturesDenied: false });
    const row = rowByTag("documents");
    expect(row.textContent).toContain("OK");
    const buttons = Array.from(row.querySelectorAll("button")).map((b) => b.textContent);
    expect(buttons).toContain("Check access");
    expect(buttons).not.toContain("Open System Settings");
  });

  test("captures folder: denied → Denied + Open System Settings + Check access", async () => {
    await render(baseReport, { capturesDenied: true });
    const row = rowByTag("documents");
    expect(row.textContent).toContain("Denied");
    const buttons = Array.from(row.querySelectorAll("button")).map((b) => b.textContent);
    expect(buttons).toContain("Open System Settings");
    expect(buttons).toContain("Check access");
  });

  test("Check access dispatches storage:checkCapturesAccess", async () => {
    const { calls } = await render(baseReport, { capturesDenied: false });
    const checkBtn = Array.from(rowByTag("documents").querySelectorAll("button")).find(
      (b) => b.textContent === "Check access"
    );
    await act(async () => {
      checkBtn?.click();
    });
    expect(calls.map((c) => c.name)).toContain("storage:checkCapturesAccess");
  });
});
