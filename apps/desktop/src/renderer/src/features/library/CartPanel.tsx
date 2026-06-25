import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement
} from "react";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import type {
  CaptureRecord,
  CaptureEnrichment,
  CartExportProgressEvent,
  RenderPreset
} from "@pwrsnap/shared";
import { cacheUrl, captureSrcUrl, dispatch, subscribe } from "../../lib/pwrsnap";
import { formatBytes } from "../../lib/format-bytes";
import { useCart } from "./CartContext";
import { useSizzleProjects } from "../../lib/useSizzleProjects";
import { DeleteConfirm } from "../shared/DeleteConfirm";

const ZIP_PRESETS: readonly RenderPreset[] = ["low", "med", "high"];
const ZIP_PRESET_LABELS: Record<RenderPreset, string> = {
  low: "Low",
  med: "Med",
  high: "High"
};

/** Rough per-image byte estimate at a preset — mirrors the legacy
 *  800/1440/source width mapping `presetMetrics` (CopyButton) uses, but
 *  returns the raw number so the cart can SUM across images. Approximate
 *  by design (a batch has no single pixel size to report). */
function estimatePresetBytes(preset: RenderPreset, srcW: number, srcBytes: number): number {
  const targetW = preset === "low" ? 800 : preset === "med" ? 1440 : srcW;
  const scale = Math.min(1, targetW / Math.max(1, srcW));
  return Math.round(srcBytes * scale * scale);
}

export interface CartPanelProps {
  /** Jump the grid to a collected capture (select it + scroll it into
   *  view, dropping the active filter if needed). Provided by Library;
   *  omitted in isolation. */
  readonly onJumpTo?: ((captureId: string) => void) | undefined;
  /** Bulk-trash the collected captures (soft-delete) and empty the cart.
   *  Provided by Library so it routes through the undo stack (toast + ⌘Z).
   *  When omitted, the Move-to-Trash button is hidden. */
  readonly onTrashAll?: ((captureIds: string[]) => void) | undefined;
}

// The Project Asset Cart panel. Renders the single global draft cart:
// an editable name, the ordered list of collected captures (thumbnail
// + title/script preview), drag-to-reorder, per-row remove, and the
// two terminal actions (Create new Sizzle Reel / Add to existing).
//
// Shared by two mount points:
//   • Grid mode — Library renders it as a standalone right rail that
//     appears when the cart is non-empty (the "right bar opens when
//     you check an item" flow the user described).
//   • Focus / Reel mode — DetailRail renders it as the 5th tab.
//
// All cart state lives in the main process (CartStore); this component
// reads via useDraftCart and mutates via cart:* dispatches. Optimistic
// rendering isn't needed — the broadcast round-trip is sub-frame and
// every mutation returns the new cart.

type CartRow = {
  captureId: string;
  record: CaptureRecord | null;
  enrichment: CaptureEnrichment | null;
};

/** Short preview text for a cart row — prefers the accepted title,
 *  then suggested title, then accepted/suggested description, then a
 *  fallback. Mirrors the precedence the sizzle composer uses to seed
 *  script lines. */
function previewText(row: CartRow): string {
  const e = row.enrichment;
  const candidates = [
    e?.acceptedTitle,
    e?.suggestedTitle,
    e?.acceptedDescription,
    e?.suggestedDescription
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) {
      return c.trim().length > 80 ? c.trim().slice(0, 77) + "…" : c.trim();
    }
  }
  const appName = row.record?.source_app_name;
  if (typeof appName === "string" && appName.length > 0) {
    return appName;
  }
  return "Untitled capture";
}

export function CartPanel({ onJumpTo, onTrashAll }: CartPanelProps = {}): ReactElement {
  const cart = useCart();
  const { projects } = useSizzleProjects();
  // Hydrated capture metadata for the cart's ids, keyed by captureId.
  // Grows incrementally — see the fetch effect below.
  const [rowsById, setRowsById] = useState<Map<string, CartRow>>(new Map());
  const [committing, setCommitting] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [zipping, setZipping] = useState<RenderPreset | null>(null);
  const [zipError, setZipError] = useState<string | null>(null);
  const [zipNote, setZipNote] = useState<string | null>(null);
  // Live progress for the in-flight export, fed by the main-side
  // `cartExportProgress` broadcasts (matched by jobId). null until the
  // first render beat arrives (the save dialog is still up before then).
  const [zipProgress, setZipProgress] = useState<{
    phase: "rendering" | "zipping";
    completed: number;
    total: number;
  } | null>(null);
  // The jobId of the export currently owned by THIS panel — gates which
  // progress broadcasts we react to and what `Cancel` aborts.
  const activeJobIdRef = useRef<string | null>(null);
  const listEndRef = useRef<HTMLLIElement | null>(null);
  const prevCountRef = useRef(cart.captureIds.length);

  // Incremental metadata fetch (L5): only fetch ids we don't already
  // have, and drop entries for ids no longer in the cart. Adding the
  // 6th item fetches metadata for just that one capture, not all six.
  // The `idSetKey` membership fingerprint gates the effect so reorder
  // (same set, different order) doesn't trigger any fetch at all.
  const idSetKey = [...cart.captureIds].sort().join(",");
  useEffect(() => {
    const ids = cart.captureIds;
    // Prune rows for ids that left the cart, and find ids we haven't
    // hydrated yet. Both derived from the CURRENT cart membership.
    setRowsById((prev) => {
      const idSet = new Set(ids);
      let changed = false;
      const pruned = new Map<string, CartRow>();
      for (const [id, row] of prev) {
        if (idSet.has(id)) pruned.set(id, row);
        else changed = true;
      }
      return changed ? pruned : prev;
    });
    const missing = ids.filter((id) => !rowsById.has(id));
    if (missing.length === 0) return;
    let mounted = true;
    void dispatch("library:listByIdsWithMetadata", { ids: missing }).then((r) => {
      if (!mounted || !r.ok) return;
      setRowsById((prev) => {
        const next = new Map(prev);
        const returned = new Set<string>();
        for (const { record, enrichment } of r.value.rows) {
          next.set(record.id, { captureId: record.id, record, enrichment });
          returned.add(record.id);
        }
        // Requested ids that came back empty (purged / trashed-and-gone)
        // get an explicit null row so they count as HYDRATED, not pending.
        // Without this the Zip estimate would read "still loading" forever
        // whenever the cart holds a since-deleted capture.
        for (const id of missing) {
          if (!returned.has(id) && !next.has(id)) {
            next.set(id, { captureId: id, record: null, enrichment: null });
          }
        }
        return next;
      });
    });
    return () => {
      mounted = false;
    };
    // idSetKey is the membership fingerprint. rowsById is read for the
    // missing-id diff but intentionally NOT a dep — including it would
    // re-run the effect on every fetch resolution (infinite-ish loop).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idSetKey]);

  // Auto-scroll the list to the newly-added item when the count grows.
  // Only on GROWTH — reorder / remove shouldn't yank the scroll.
  useEffect(() => {
    if (cart.captureIds.length > prevCountRef.current) {
      listEndRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
    }
    prevCountRef.current = cart.captureIds.length;
  }, [cart.captureIds.length]);


  // Listen for export progress. Only the broadcast matching our active
  // jobId moves the bar; a `done` beat (success / cancel / error) clears it.
  useEffect(() => {
    const unsubscribe = subscribe(EVENT_CHANNELS.cartExportProgress, (payload) => {
      const ev = payload as CartExportProgressEvent | null;
      if (ev === null || typeof ev !== "object" || ev.jobId !== activeJobIdRef.current) {
        return;
      }
      if (ev.phase === "done") {
        setZipProgress(null);
        return;
      }
      setZipProgress({ phase: ev.phase, completed: ev.completed, total: ev.total });
    });
    return unsubscribe;
  }, []);

  const onCancelZip = useCallback(() => {
    const jobId = activeJobIdRef.current;
    if (jobId === null) return;
    void dispatch("cart:exportZip:cancel", { jobId });
  }, []);

  const onRemove = useCallback((captureId: string) => {
    void dispatch("cart:remove", { captureId });
  }, []);

  const onReorder = useCallback((from: number, to: number) => {
    if (from === to) return;
    void dispatch("cart:reorder", { from, to });
  }, []);

  const onCreateProject = useCallback(() => {
    setCommitting(true);
    void dispatch("cart:commitToNewProject", {}).then((r) => {
      setCommitting(false);
      if (r.ok) {
        // Open the freshly-created reel in the sizzle composer so the
        // user lands in the editor with their assets ready.
        void dispatch("sizzle:open", { projectId: r.value.id });
      }
    });
  }, []);

  const onAddToExisting = useCallback((projectId: string) => {
    setPickerOpen(false);
    setCommitting(true);
    void dispatch("cart:commitToExisting", { projectId }).then((r) => {
      setCommitting(false);
      if (r.ok) {
        void dispatch("sizzle:open", { projectId: r.value.id });
      }
    });
  }, []);

  const onClear = useCallback(() => {
    void dispatch("cart:clear", {});
  }, []);

  // Aggregate byte estimate per preset across the collected IMAGES (videos
  // are skipped by the zip). Approximate + grows as metadata hydrates.
  const zipEstimates = useMemo(() => {
    const totals: Record<RenderPreset, number> = { low: 0, med: 0, high: 0 };
    let imageCount = 0;
    for (const id of cart.captureIds) {
      const rec = rowsById.get(id)?.record;
      if (rec == null || rec.kind !== "image") continue;
      imageCount += 1;
      for (const p of ZIP_PRESETS) {
        totals[p] += estimatePresetBytes(p, rec.width_px, rec.byte_size);
      }
    }
    return { totals, imageCount };
  }, [cart.captureIds, rowsById]);

  // True while some cart ids haven't hydrated their metadata yet — the
  // aggregate estimate only sums the rows it has, so it's still climbing.
  // We mark the shown size as provisional rather than print a confident
  // number that will jump up once the rest load. (The export itself
  // re-resolves every id main-side, so a provisional estimate never
  // affects what actually gets zipped.)
  const estimateSettling = useMemo(
    () => cart.captureIds.some((id) => !rowsById.has(id)),
    [cart.captureIds, rowsById]
  );

  const onExportZip = useCallback(
    (preset: RenderPreset) => {
      setZipError(null);
      setZipNote(null);
      setZipProgress(null);
      setZipping(preset);
      const jobId = crypto.randomUUID();
      activeJobIdRef.current = jobId;
      // Seed the save filename from the first item's title if we have it.
      const firstRow = rowsById.get(cart.captureIds[0] ?? "");
      const suggestedName = firstRow !== undefined ? previewText(firstRow) : undefined;
      void dispatch("cart:exportZip", {
        captureIds: cart.captureIds,
        preset,
        jobId,
        ...(suggestedName !== undefined ? { suggestedName } : {})
      }).then((r) => {
        setZipping(null);
        setZipProgress(null);
        activeJobIdRef.current = null;
        if (r.ok) {
          // Tell the user if some captures didn't make it into the zip.
          const leftOut = r.value.skipped + r.value.failed;
          setZipNote(
            leftOut > 0 ? `Zipped ${r.value.fileCount} · ${leftOut} left out` : null
          );
        } else if (r.error.code !== "cancelled") {
          // `cancelled` = the user dismissed the save dialog; not an error.
          setZipError(r.error.message);
        }
      });
    },
    [cart.captureIds, rowsById]
  );

  const isEmpty = cart.captureIds.length === 0;

  return (
    <div className="psl__cart">
      <div className="psl__cart-header">
        <span className="psl__cart-title">Cart</span>
        <span className="psl__cart-count" aria-label={`${cart.captureIds.length} items`}>
          {cart.captureIds.length}
        </span>
        <span className="psl__cart-header-spacer" />
        {isEmpty ? null : (
          <button
            type="button"
            className="psl__cart-clear"
            title="Empty the cart (does not delete the captures)"
            aria-label="Empty the cart"
            onClick={onClear}
          >
            Clear
          </button>
        )}
      </div>

      {isEmpty ? (
        <p className="psl__cart-empty">
          Hover a capture in the Library and click its checkbox to start
          collecting it here — then zip, delete, or build a Sizzle Reel.
        </p>
      ) : (
        <ol className="psl__cart-list">
          {cart.captureIds.map((captureId, idx) => {
            const row = rowsById.get(captureId) ?? {
              captureId,
              record: null,
              enrichment: null
            };
            const isVideo = row.record?.kind === "video";
            return (
              <li
                key={captureId}
                className={
                  "psl__cart-item" + (onJumpTo !== undefined ? " is-jumpable" : "")
                }
                draggable
                onClick={() => onJumpTo?.(captureId)}
                title={onJumpTo !== undefined ? "Show in the library" : undefined}
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/plain", String(idx));
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const from = Number.parseInt(
                    e.dataTransfer.getData("text/plain"),
                    10
                  );
                  if (Number.isInteger(from)) onReorder(from, idx);
                }}
              >
                <span className="psl__cart-order" aria-hidden="true">
                  {(idx + 1).toString().padStart(2, "0")}
                </span>
                <span className="psl__cart-thumb">
                  {row.record === null ? (
                    <span className="psl__cart-thumb-missing" aria-hidden="true">
                      ×
                    </span>
                  ) : isVideo ? (
                    <video
                      src={captureSrcUrl(row.record.id)}
                      preload="metadata"
                      muted
                      playsInline
                    />
                  ) : (
                    <img
                      src={cacheUrl(row.record.id, 96, "webp", row.record.edits_version)}
                      alt=""
                      loading="lazy"
                      decoding="async"
                    />
                  )}
                  {isVideo ? (
                    <span className="psl__cart-thumb-kind" aria-hidden="true">
                      ▶
                    </span>
                  ) : null}
                </span>
                <span className="psl__cart-body">
                  <span className="psl__cart-item-title">{previewText(row)}</span>
                </span>
                <button
                  type="button"
                  className="psl__cart-remove"
                  aria-label="Remove from cart"
                  title="Remove from cart"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(captureId);
                  }}
                >
                  ×
                </button>
              </li>
            );
          })}
          <li ref={listEndRef} aria-hidden="true" className="psl__cart-list-end" />
        </ol>
      )}

      <div className="psl__cart-footer">
        {/* Bulk delete — the cart is a working set you can act on, not just
            a Sizzle staging area. Confirmed; routes through Library's undo
            stack so the toast + ⌘Z restore the whole batch. */}
        {onTrashAll === undefined ? null : (
          <DeleteConfirm
            message={`Move ${cart.captureIds.length} ${
              cart.captureIds.length === 1 ? "capture" : "captures"
            } to Trash?`}
            detail="Recoverable from the Trash filter, the toast, or ⌘Z."
            confirmLabel="Move to Trash"
            placement="top"
            onConfirm={() => onTrashAll(cart.captureIds)}
          >
            {(trigger) => (
              <button
                type="button"
                className="psl__cart-btn psl__cart-btn--danger"
                disabled={isEmpty || committing}
                {...trigger}
              >
                Move to Trash
              </button>
            )}
          </DeleteConfirm>
        )}

        {/* Sizzle Reel — now one action among several, not the headline. */}
        <button
          type="button"
          className="psl__cart-btn"
          disabled={isEmpty || committing}
          onClick={onCreateProject}
        >
          Create New Sizzle Reel
        </button>
        <div className="psl__cart-add-existing">
          <button
            type="button"
            className="psl__cart-btn"
            disabled={isEmpty || committing || projects.length === 0}
            aria-haspopup="listbox"
            aria-expanded={pickerOpen}
            onClick={() => setPickerOpen((o) => !o)}
          >
            Add to Existing Sizzle…
          </button>
          {pickerOpen && projects.length > 0 ? (
            <ul className="psl__cart-picker" role="listbox">
              {projects.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={false}
                    className="psl__cart-picker-row"
                    onClick={() => onAddToExisting(p.id)}
                  >
                    <span className="psl__cart-picker-name">{p.name}</span>
                    <span className="psl__cart-picker-meta">
                      {p.scenes.length} scene{p.scenes.length === 1 ? "" : "s"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        {/* Export as Zip — same visual language as the per-capture Copy
            cards (shared eyebrow + `.fo__copy-btn` card grid), pinned to the
            bottom of the footer the way single-capture export sits at the
            bottom of the rail. The shown size is the aggregate estimate
            across the collected images (a batch has no single pixel
            dimension to report); one flat zip at the chosen size. */}
        <div className="psl__cart-zip">
          <div className="psl__copy-eyebrow">
            <span>Export as Zip</span>
            <span className="psl__copy-eyebrow-line" />
            <span className="psl__copy-eyebrow-meta">
              {estimateSettling ? "estimating" : "estimated"}
            </span>
          </div>
          <div className="psl__copy-row">
            {ZIP_PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                className="fo__copy-btn"
                disabled={isEmpty || zipping !== null || zipEstimates.imageCount === 0}
                onClick={() => onExportZip(p)}
              >
                <div className="fo__copy-btn-row1">
                  <span className="fo__copy-label">{ZIP_PRESET_LABELS[p]}</span>
                </div>
                <div className="fo__copy-meta">
                  <span className="fo__copy-dim">
                    {zipping !== p
                      ? `~${formatBytes(zipEstimates.totals[p])}${estimateSettling ? "…" : ""}`
                      : zipProgress !== null && zipProgress.phase === "rendering"
                        ? `${zipProgress.completed}/${zipProgress.total}`
                        : "Zipping…"}
                  </span>
                </div>
              </button>
            ))}
          </div>
          {zipping !== null ? (
            <div className="psl__cart-zip-progress">
              <div className="psl__cart-zip-bar" aria-hidden="true">
                <div
                  className="psl__cart-zip-bar-fill"
                  style={{
                    width:
                      zipProgress === null
                        ? "8%"
                        : zipProgress.phase === "zipping"
                          ? "100%"
                          : `${Math.round(
                              (zipProgress.completed / Math.max(1, zipProgress.total)) * 100
                            )}%`
                  }}
                />
              </div>
              <button type="button" className="psl__cart-zip-cancel" onClick={onCancelZip}>
                Cancel
              </button>
            </div>
          ) : null}
          {zipError !== null ? (
            <div className="psl__cart-zip-error" role="alert">
              {zipError}
            </div>
          ) : zipNote !== null ? (
            <div className="psl__cart-zip-note" role="status">
              {zipNote}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
