import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement
} from "react";
import type { CaptureRecord, CaptureEnrichment } from "@pwrsnap/shared";
import { cacheUrl, captureSrcUrl, dispatch } from "../../lib/pwrsnap";
import { useCart } from "./CartContext";
import { useSizzleProjects } from "../../lib/useSizzleProjects";
import { DeleteConfirm } from "../shared/DeleteConfirm";

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
        for (const { record, enrichment } of r.value.rows) {
          next.set(record.id, { captureId: record.id, record, enrichment });
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
      </div>
    </div>
  );
}
