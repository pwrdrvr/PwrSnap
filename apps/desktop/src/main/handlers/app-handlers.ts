// Command-bus handlers for the `app:*` namespace.
//
// Currently exposes one verb (`app:version`) used by the Settings →
// About page. Kept in its own module so any future app-level reads
// (build channel, signing info, locale) have an obvious home.

import { app } from "electron";
import { err, ok } from "@pwrsnap/shared";
import { bus } from "../command-bus";
import { isAppDocumentKind, readAppDocument } from "../app-documents";
import { showAppDocumentWindow } from "../window";

export function registerAppHandlers(): void {
  bus.register("app:version", async () => {
    return ok({
      version: app.getVersion(),
      electronVersion: process.versions.electron ?? "",
      nodeVersion: process.versions.node ?? "",
      chromeVersion: process.versions.chrome ?? ""
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
  bus.register("app:openDocumentWindow", async (req) => {
    const kind = typeof req === "object" && req !== null ? req.kind : undefined;
    if (!isAppDocumentKind(kind)) {
      return err({
        kind: "validation",
        code: "invalid_document_kind",
        message: `unknown app document: ${String(kind)}`
      });
    }
    showAppDocumentWindow(kind);
    return ok(undefined);
  });
}
