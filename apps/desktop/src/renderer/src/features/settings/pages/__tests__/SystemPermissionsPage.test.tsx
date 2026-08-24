// SystemPermissionsPage platform contract. macOS keeps the screen-permission
// disambiguation that is the user-facing heart of the first-run fix:
//   • screen not granted + screenCapturePrompted=false → synthesized
//     "Not yet requested" + a "Request access" button (fires the prompt);
//   • screen not granted + screenCapturePrompted=true → "Denied" + an
//     "Open System Settings" button (macOS won't re-prompt).
// macOS itself can't tell these apart (getMediaAccessStatus('screen') is
// `denied` in both cases) — the page leans on `screenCapturePrompted`.
// Windows instead consumes explicit permission evidence: screen is not
// inspectable, microphone is a global desktop-app control, and unsupported
// system audio never becomes a fictitious Granted row.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import type {
  CapturesLocation,
  PermissionReadinessReport,
  RecordingPermissionStatus
} from "@pwrsnap/shared";
import { SystemPermissionsPage } from "../SystemPermissionsPage";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

type AnyResult = { ok: true; value: unknown } | { ok: false; error: { message: string } };

type FakeApiOpts = {
  platform?: NodeJS.Platform;
  readinessReports?: readonly PermissionReadinessReport[];
  // Status that `permissions:request` (the real screen-capture probe)
  // reports back. Defaults to the report's screen status (probe didn't
  // change anything); pass "granted" to simulate the user approving.
  requestStatus?: RecordingPermissionStatus;
  // Whether captures-folder access is denied (drives the Documents row).
  capturesDenied?: boolean;
  capturesLocation?: CapturesLocation;
  documentsAccess?: "unknown" | "confirmed" | "denied";
  homeCaptureReferences?: number;
  homeDirectoryEntryCount?: number;
};

function installFakeApi(
  report: PermissionReadinessReport,
  opts: FakeApiOpts = {}
): {
  calls: { name: string; req: unknown }[];
} {
  const calls: { name: string; req: unknown }[] = [];
  let readinessReads = 0;
  const health = {
    denied: opts.capturesDenied === true,
    deniedPathCount: opts.capturesDenied === true ? 2 : 0,
    samplePath: null,
    firstDeniedAt: null,
    lastDeniedAt: null
  };
  const locationStatus = {
    location: opts.capturesLocation ?? "documents",
    documentsAccess: opts.documentsAccess ?? "unknown",
    homeCaptureReferences: opts.homeCaptureReferences ?? 0,
    homeDirectoryEntryCount: opts.homeDirectoryEntryCount ?? 0,
    canMoveToDocuments:
      opts.capturesLocation === "home" &&
      opts.documentsAccess === "confirmed" &&
      (opts.homeCaptureReferences ?? 0) === 0 &&
      (opts.homeDirectoryEntryCount ?? 0) === 0,
    overridden: false
  } as const;
  Object.defineProperty(window, "pwrsnapApi", {
    configurable: true,
    value: {
      platform: opts.platform ?? "darwin",
      on: () => () => undefined,
      dispatch: async (name: string, req: unknown): Promise<AnyResult> => {
        calls.push({ name, req });
        if (name === "permissions:readiness") {
          const reports = opts.readinessReports;
          const value =
            reports === undefined || reports.length === 0
              ? report
              : reports[Math.min(readinessReads, reports.length - 1)];
          readinessReads += 1;
          return { ok: true, value };
        }
        if (name === "permissions:request") {
          return { ok: true, value: { status: opts.requestStatus ?? report.screenRecording } };
        }
        if (name === "storage:capturesAccessHealth") return { ok: true, value: health };
        if (name === "storage:capturesLocationStatus") {
          return { ok: true, value: locationStatus };
        }
        if (name === "storage:checkCapturesAccess") {
          return { ok: true, value: { granted: !health.denied } };
        }
        if (name === "storage:moveCapturesToDocuments") {
          return {
            ok: true,
            value: { ...locationStatus, location: "documents", canMoveToDocuments: false }
          };
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
  screenCapturePrompted: false,
  permissionEvidence: {
    platform: "darwin",
    screen: { kind: "os-status", status: "denied" },
    microphone: { kind: "os-status", status: "not-determined" },
    systemAudio: { kind: "derived", status: "denied" }
  }
};

function windowsReport(
  microphone: RecordingPermissionStatus = "granted"
): PermissionReadinessReport {
  // Operational readiness remains permissive on Windows so capture can try
  // the real backend. The separate evidence is what the page may present.
  return {
    screenRecording: "granted",
    microphone: "granted",
    systemAudio: "granted",
    fingerprint: "fedcba9876543210",
    screenCapturePrompted: false,
    permissionEvidence: {
      platform: "win32",
      screen: { kind: "not-inspectable" },
      microphone: { kind: "os-status", status: microphone },
      systemAudio: { kind: "unsupported" }
    }
  };
}

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

  test("fingerprint diagnostics name the actual four inputs", async () => {
    await render(baseReport);
    const row = rowByTag("fingerprint");
    expect(row.textContent).toContain(
      "screen, microphone, system audio, recorder backend"
    );
    expect(row.textContent).not.toContain("app version");
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

  test("home fallback is sticky while captures remain", async () => {
    await render(baseReport, {
      capturesLocation: "home",
      documentsAccess: "confirmed",
      homeCaptureReferences: 3
    });
    const row = rowByTag("home");
    expect(row.textContent).toContain("Saving to ~/PwrSnap");
    expect(row.textContent).toContain("3 capture item(s)");
    expect(row.textContent).not.toContain("Use Documents for new captures");
  });

  test("empty home + confirmed Documents shows guarded move-back action", async () => {
    const { calls } = await render(baseReport, {
      capturesLocation: "home",
      documentsAccess: "confirmed"
    });
    const row = rowByTag("home");
    const move = Array.from(row.querySelectorAll("button")).find(
      (button) => button.textContent === "Use Documents for new captures"
    );
    expect(move).toBeDefined();
    await act(async () => {
      move?.click();
    });
    expect(calls.map((call) => call.name)).toContain(
      "storage:moveCapturesToDocuments"
    );
  });
});

describe("SystemPermissionsPage — Windows permission evidence", () => {
  test("does not present synthesized screen or system-audio grants", async () => {
    await render(windowsReport("granted"), { platform: "win32" });

    const screen = rowByTag("screen");
    expect(screen.textContent).toContain("Not reported");
    expect(screen.textContent).toContain("cannot verify a separate per-app setting");
    expect(screen.querySelector("[data-permission-status]")?.textContent).toBe(
      "Not reported"
    );

    const tags = Array.from(container!.querySelectorAll(".pss__row-tag")).map(
      (tag) => tag.textContent
    );
    expect(tags).not.toContain("systemAudio");
    expect(container!.textContent).not.toContain("Granted");
    expect(container!.textContent).not.toContain("Permission fingerprint");
  });

  test("surfaces the real global Windows microphone status without calling it a PwrSnap grant", async () => {
    await render(windowsReport("denied"), { platform: "win32" });

    const microphone = rowByTag("microphone");
    expect(microphone.textContent).toContain("Blocked by Windows");
    expect(microphone.textContent).toContain("global microphone control");
    expect(microphone.textContent).toContain("not a PwrSnap-specific grant");
    expect(microphone.textContent).toContain("screen-only");
  });

  test("refreshes the Windows microphone status when PwrSnap regains focus", async () => {
    await render(windowsReport("denied"), {
      platform: "win32",
      readinessReports: [windowsReport("denied"), windowsReport("granted")]
    });
    expect(rowByTag("microphone").textContent).toContain("Blocked by Windows");

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });

    expect(rowByTag("microphone").textContent).toContain("Allowed by Windows");
  });

  test("Windows privacy actions use only the guarded settings command", async () => {
    const { calls } = await render(windowsReport("denied"), { platform: "win32" });
    const screenButton = Array.from(rowByTag("screen").querySelectorAll("button")).find(
      (button) => button.textContent === "Review capture privacy"
    );
    const microphoneButton = Array.from(
      rowByTag("microphone").querySelectorAll("button")
    ).find((button) => button.textContent === "Open microphone privacy");

    await act(async () => {
      screenButton?.click();
      microphoneButton?.click();
    });

    const permissionCalls = calls.filter((call) => call.name.startsWith("permissions:"));
    expect(permissionCalls).toContainEqual({
      name: "permissions:openSystemSettings",
      req: { permission: "screen" }
    });
    expect(permissionCalls).toContainEqual({
      name: "permissions:openSystemSettings",
      req: { permission: "microphone" }
    });
    expect(permissionCalls.map((call) => call.name)).not.toContain(
      "permissions:request"
    );
  });

  test("unknown Windows folder access is Not checked until a real write probe", async () => {
    const { calls } = await render(windowsReport(), {
      platform: "win32",
      documentsAccess: "unknown"
    });
    const row = rowByTag("documents");
    expect(row.textContent).toContain("Not checked");
    expect(row.textContent).not.toContain("OK");

    const checkButton = Array.from(row.querySelectorAll("button")).find(
      (button) => button.textContent === "Check folder access"
    );
    await act(async () => {
      checkButton?.click();
    });
    expect(calls.map((call) => call.name)).toContain("storage:checkCapturesAccess");
  });

  test("Windows rendering contains no Mac, Finder, TCC, or Unix-home copy", async () => {
    await render(windowsReport("granted"), {
      platform: "win32",
      documentsAccess: "confirmed"
    });
    const text = container!.textContent ?? "";
    expect(text).toContain("Windows privacy controls");
    expect(text).toContain("File Explorer");
    expect(text).not.toMatch(
      /macOS|\bMac\b|Finder|TCC|System Settings|Privacy & Security|Files & Folders|macOS 13|~\//i
    );
  });
});
