import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement
} from "react";
import type { CaptureRecord, CaptureEnrichment } from "@pwrsnap/shared";
import { cacheUrl, captureSrcUrl, dispatch } from "../../lib/pwrsnap";
import { useDraftCart } from "../../lib/useDraftCart";
import { useSizzleProjects } from "../../lib/useSizzleProjects";

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

export function CartPanel(): ReactElement {
  const { cart } = useDraftCart();
  const { projects } = useSizzleProjects();
  // Hydrated capture metadata for the cart's ids, keyed by captureId.
  // Re-fetched whenever the id SET changes (not on reorder — reorder
  // doesn't change which captures we need metadata for).
  const [rowsById, setRowsById] = useState<Map<string, CartRow>>(new Map());
  const [committing, setCommitting] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const listEndRef = useRef<HTMLLIElement | null>(null);
  const prevCountRef = useRef(cart.captureIds.length);

  // Sort the id set into a stable string so the effect only re-fetches
  // when membership changes, not on reorder.
  const idSetKey = [...cart.captureIds].sort().join(",");
  useEffect(() => {
    const ids = cart.captureIds;
    if (ids.length === 0) {
      setRowsById(new Map());
      return;
    }
    let mounted = true;
    void dispatch("library:listByIdsWithMetadata", { ids }).then((r) => {
      if (!mounted) return;
      if (!r.ok) {
        setRowsById(new Map());
        return;
      }
      const next = new Map<string, CartRow>();
      for (const { record, enrichment } of r.value.rows) {
        next.set(record.id, { captureId: record.id, record, enrichment });
      }
      setRowsById(next);
    });
    return () => {
      mounted = false;
    };
    // idSetKey is the membership fingerprint; ESLint can't see that
    // it's derived from cart.captureIds.
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

  const onRename = useCallback((name: string) => {
    void dispatch("cart:rename", { name });
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

  const isEmpty = cart.captureIds.length === 0;

  return (
    <div className="psl__cart">
      <div className="psl__cart-header">
        <input
          className="psl__cart-name"
          type="text"
          value={cart.name}
          aria-label="Project draft name"
          placeholder="Untitled draft"
          onChange={(e) => onRename(e.target.value)}
        />
        <span className="psl__cart-count" aria-label={`${cart.captureIds.length} items`}>
          {cart.captureIds.length}
        </span>
      </div>

      {isEmpty ? (
        <p className="psl__cart-empty">
          Hover a capture in the Library and click its checkbox to start
          collecting assets for a Sizzle Reel.
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
                className="psl__cart-item"
                draggable
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
                  aria-label="Remove from draft"
                  title="Remove from draft"
                  onClick={() => onRemove(captureId)}
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
        <button
          type="button"
          className="psl__cart-btn psl__cart-btn--primary"
          disabled={isEmpty || committing}
          onClick={onCreateProject}
        >
          Create Sizzle Reel
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
            Add to existing…
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
