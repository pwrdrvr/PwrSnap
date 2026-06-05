// Command-bus handlers for the `app:*` namespace.
//
// Exposes:
//   - app:version             — build/runtime metadata for Settings → About
//   - app:readDocument        — read a bundled app document (changelog,
//                               third-party licenses) for in-app viewing
//   - app:openDocumentWindow  — open the document-viewer BrowserWindow
//   - app:openExternal        — open an allowlisted https URL in the
//                               default browser (About page links)
//   - app:update:check        — force a fresh electron-updater check
//   - app:update:status       — snapshot of the current updater state
//   - app:update:install      — restart-into-the-downloaded-update
//   - app:update:releases     — GitHub Releases list (independent of the
//                               updater channel; used by the Updates page)

import { app, screen, shell } from "electron";
import { err, ok } from "@pwrsnap/shared";
import { bus } from "../command-bus";
import { isAppDocumentKind, readAppDocument } from "../app-documents";
import { showAppDocumentWindow } from "../window";
import {
  checkForAppUpdatesNow,
  installDownloadedAppUpdate,
  readAppUpdateReleaseVersions,
  readAppUpdateStatus
} from "../auto-updater";

/** URLs the renderer is allowed to open via `app:openExternal`. Keeps
 *  `shell.openExternal` from becoming an arbitrary-navigation gadget: a
 *  compromised/buggy renderer can only reach the product site, the docs
 *  site, and PwrDrvr's own GitHub org. https-only. GitHub is scoped to
 *  the `/pwrdrvr/*` path so an attacker can't bounce the user to an
 *  arbitrary repo/gist/profile under the (trusted) github.com host. */
function isAllowedExternalUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (host === "pwrsnap.com" || host.endsWith(".pwrsnap.com")) return true;
  if (host === "github.com") {
    // `/pwrdrvr` (org page) or `/pwrdrvr/<repo>...`; reject `/pwrdrvrx`.
    return url.pathname === "/pwrdrvr" || url.pathname.startsWith("/pwrdrvr/");
  }
  return false;
}

export function registerAppHandlers(): void {
  bus.register("app:version", async () => {
    return ok({
      version: app.getVersion(),
      electronVersion: process.versions.electron ?? "",
      nodeVersion: process.versions.node ?? "",
      chromeVersion: process.versions.chrome ?? ""
    });
  });
  bus.register("system:listDisplays", async () => {
    const primaryId = screen.getPrimaryDisplay().id;
    return ok({
      displays: screen.getAllDisplays().map((d) => ({
        id: d.id,
        bounds: { x: d.bounds.x, y: d.bounds.y, w: d.bounds.width, h: d.bounds.height },
        scaleFactor: d.scaleFactor,
        isPrimary: d.id === primaryId
      }))
    });
  });
  bus.register("app:readDocument", async (req) => {
    const kind = typeof req === "object" && req !== null ? req.kind : undefined;
    if (!isAppDocumentKind(kind)) {
      return err({
        kind: "validation",
        code: "invalid_document_kind",
        message: `unknown app document: ${String(kind)}`
      });
    }
    try {
      return ok(await readAppDocument(kind));
    } catch (cause) {
      return err({
        kind: "unknown",
        code: "document_read_failed",
        message: cause instanceof Error ? cause.message : String(cause),
        cause
      });
    }
  });
  bus.register("app:openDocumentWindow", async (req, ctx) => {
    const kind = typeof req === "object" && req !== null ? req.kind : undefined;
    if (!isAppDocumentKind(kind)) {
      return err({
        kind: "validation",
        code: "invalid_document_kind",
        message: `unknown app document: ${String(kind)}`
      });
    }
    const options: { sourceWindowId?: number | undefined } = {};
    if (ctx.sourceWindowId !== undefined) {
      options.sourceWindowId = ctx.sourceWindowId;
    }
    showAppDocumentWindow(kind, options);
    return ok(undefined);
  });
  bus.register("app:openExternal", async (req) => {
    const url = typeof req === "object" && req !== null ? req.url : undefined;
    if (typeof url !== "string" || !isAllowedExternalUrl(url)) {
      return err({
        kind: "validation",
        code: "url_not_allowed",
        message: `app:openExternal: refused to open ${String(url)} (must be an https PwrSnap or GitHub URL)`
      });
    }
    await shell.openExternal(url);
    return ok(undefined);
  });
  bus.register("app:update:check", async () => {
    return ok(await checkForAppUpdatesNow("manual"));
  });
  bus.register("app:update:status", async () => {
    return ok(readAppUpdateStatus());
  });
  bus.register("app:update:install", async () => {
    return ok(installDownloadedAppUpdate());
  });
  bus.register("app:update:releases", async () => {
    return ok(await readAppUpdateReleaseVersions());
  });
}
