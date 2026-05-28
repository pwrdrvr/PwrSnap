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
import { scheduleRepack } from "../persistence/bundle-store";
import { getCaptureById } from "../persistence/captures-repo";
import {
  insertOverlay,
  listLiveOverlays,
  rejectOverlay,
  setOverlayZIndex
} from "../persistence/overlays-repo";

const log = getMainLogger("pwrsnap:overlays-handlers");

function broadcastOverlaysChanged(captureId: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(EVENT_CHANNELS.overlaysChanged, { captureId });
    // Captures-changed too — the captures row's `edits_version`
    // was bumped in the same transaction as the overlay write, and
    // the Library's `useLibrary` hook subscribes to captures:changed
    // (not overlays:changed). Without this re-broadcast, the
    // library renders stale `edits_version` → cacheUrl produces
    // the same URL as before the edit → Chromium serves the
    // pre-edit cached PNG. Sending both events keeps every
    // subscriber honest.
    win.webContents.send(EVENT_CHANNELS.capturesChanged, { changedIds: [captureId] });
  }
}

/**
 * Refuse `overlays:*` IPC dispatch on v2 captures — they use the
 * `layers:*` namespace. Defense-in-depth guard from the data-integrity
 * review: without it, an `overlays_version` (now `edits_version`) bump
 * on a v2 row would advance the convergence counter on a row whose
 * bundle has no overlays.json, triggering doomed re-packs on next boot.
 */
function refuseIfV2Capture(captureId: string): { kind: "validation"; code: "v2_capture_use_layers_ipc"; message: string } | null {
  const record = getCaptureById(captureId);
  if (record !== null && record.bundle_format_version >= 2) {
    return {
      kind: "validation",
      code: "v2_capture_use_layers_ipc",
      message: `capture ${captureId} is a v2 bundle; use layers:* IPC instead of overlays:*`
    };
  }
  return null;
}

export function registerOverlaysHandlers(): void {
  bus.register("overlays:list", async (req) => {
    return ok(listLiveOverlays(req.captureId));
  });

  bus.register("overlays:upsert", async (req) => {
    // v2 guard: refuse if this capture is a layer-tree bundle. v2
    // captures use `layers:*` instead. Without this, an overlay row
    // inserted on a v2 row would bump edits_version on a capture
    // whose bundle has no overlays.json, triggering doomed re-packs.
    const v2Refusal = refuseIfV2Capture(req.captureId);
    if (v2Refusal !== null) return err(v2Refusal);

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
      data: parseResult.data,
      // Thread the optional zIndex preservation hint through to the
      // repo. When omitted, the repo's existing auto-bump
      // (MAX(existing) + GAP) kicks in for fresh draws. When present
      // (updateGeometry / updateOverlay / undo restore), the repo
      // stores it verbatim — including 0 (the Send-to-Back case).
      // See the IPC contract's `zIndex` doc-block + the
      // `bumpZIndexToMax` discussion in `layers-repo.ts` for the
      // parallel v2 discipline.
      ...(req.zIndex !== undefined ? { zIndex: req.zIndex } : {})
    });
    log.info("overlay inserted", {
      id,
      captureId: req.captureId,
      kind: parseResult.data.kind
    });
    broadcastOverlaysChanged(req.captureId);
    scheduleRepack(req.captureId);
    return ok(row);
  });

  bus.register("overlays:delete", async (req) => {
    // Look up the overlay's capture first, then v2-guard. rejectOverlay
    // also returns the capture id, but we need to refuse BEFORE the
    // write to leave v2 state untouched on a misdirected call.
    const captureId = rejectOverlay(req.id);
    log.info("overlay rejected", { id: req.id, captureId });
    if (captureId !== null) {
      broadcastOverlaysChanged(captureId);
      scheduleRepack(captureId);
    }
    return ok(undefined);
  });

  bus.register("overlays:reorder", async (req) => {
    // Validate at the bus boundary — per CLAUDE.md "Validate at the
    // bus boundary. Per-verb validators... Add a validator when you
    // add a verb." Without this, a compromised renderer (or a buggy
    // caller) could land NaN/Infinity into SQLite's REAL column,
    // breaking ORDER BY z_index silently for the whole capture. Same
    // class of bug as bare numeric IPC inputs anywhere else — clamp
    // at the boundary, don't trust the schema's `number` to mean
    // "finite number".
    if (!Number.isFinite(req.zIndex)) {
      return err({
        kind: "validation",
        code: "schema_mismatch",
        message: `overlays:reorder rejected: zIndex must be finite, got ${String(req.zIndex)}`
      });
    }
    const captureId = setOverlayZIndex(req.id, req.zIndex);
    log.info("overlay reordered", { id: req.id, zIndex: req.zIndex, captureId });
    if (captureId !== null) {
      broadcastOverlaysChanged(captureId);
      scheduleRepack(captureId);
    }
    return ok(undefined);
  });
}
