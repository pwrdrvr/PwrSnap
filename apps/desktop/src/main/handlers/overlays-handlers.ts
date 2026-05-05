// Command-bus handlers for the `overlays:*` namespace.
//
// Validates the user-/Codex-supplied overlay blob through zod at
// every entry point, then defers to overlays-repo.ts for storage.
// Broadcasts an `overlaysChanged` event so any open Edit windows can
// re-fetch in real-time (Phase 2: useSyncExternalStore in Edit.tsx).
//
// Phase 2 starter scope:
//   • overlays:list  → read-only; returns live overlays for a capture
//   • overlays:upsert → INSERT (no UPDATE — drag-resize models as
//                       new INSERT + supersede in Phase 2 main).
//   • overlays:delete → soft-delete (rejected_at = now)

import { BrowserWindow } from "electron";
import { ok, err, EVENT_CHANNELS, Overlay as OverlaySchema } from "@pwrsnap/shared";
import { nanoid } from "nanoid";
import { bus } from "../command-bus";
import { getMainLogger } from "../log";
import {
  insertOverlay,
  listLiveOverlays,
  rejectOverlay
} from "../persistence/overlays-repo";

const log = getMainLogger("pwrsnap:overlays-handlers");

function broadcastOverlaysChanged(captureId: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(EVENT_CHANNELS.overlaysChanged, { captureId });
    // Captures-changed too — the captures row's `overlays_version`
    // was bumped in the same transaction as the overlay write, and
    // the Library's `useLibrary` hook subscribes to captures:changed
    // (not overlays:changed). Without this re-broadcast, the
    // library renders stale `overlays_version` → cacheUrl produces
    // the same URL as before the edit → Chromium serves the
    // pre-edit cached PNG. Sending both events keeps every
    // subscriber honest.
    win.webContents.send(EVENT_CHANNELS.capturesChanged, { changedIds: [captureId] });
  }
}

export function registerOverlaysHandlers(): void {
  bus.register("overlays:list", async (req) => {
    return ok(listLiveOverlays(req.captureId));
  });

  bus.register("overlays:upsert", async (req) => {
    // Validate the blob before it touches the DB. The IPC envelope
    // already typechecks the request shape, but the `Overlay` field
    // is `unknown`-equivalent over the wire — re-parse here so a
    // bad client (or a Phase 4 LLM) can't poison the table.
    const parseResult = OverlaySchema.safeParse(req.overlay);
    if (!parseResult.success) {
      return err({
        kind: "validation",
        code: "schema_mismatch",
        message: `overlay payload failed schema validation: ${parseResult.error.message}`
      });
    }
    const id = nanoid(16);
    const row = insertOverlay({
      id,
      captureId: req.captureId,
      data: parseResult.data
    });
    log.info("overlay inserted", {
      id,
      captureId: req.captureId,
      kind: parseResult.data.kind
    });
    broadcastOverlaysChanged(req.captureId);
    return ok(row);
  });

  bus.register("overlays:delete", async (req) => {
    const captureId = rejectOverlay(req.id);
    log.info("overlay rejected", { id: req.id, captureId });
    if (captureId !== null) {
      broadcastOverlaysChanged(captureId);
    }
    return ok(undefined);
  });
}
