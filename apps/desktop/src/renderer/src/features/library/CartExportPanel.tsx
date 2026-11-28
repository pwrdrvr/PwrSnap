// The cart's export block: a three-mode picker (Copy all / Zip / Contact
// sheet) over a strip, a row of three cards and a status line.
//
// No layout shift: every row has a fixed height in every mode (see
// `.psl__cart-export` in library.css), the status line is always rendered
// (blank at rest), and the contact sheet's Layout… popover floats over the
// cart list instead of growing the footer. Switching modes, a progress bar,
// a note or an error moves nothing above or below the block.
//
// Mockup: the "PwrSnap Cart Export" page in the PwrSnap design canvas.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  CONTACT_SHEET_SIZES,
  CONTACT_SHEET_WIDTHS,
  DEFAULT_CONTACT_SHEET_LAYOUT,
  EVENT_CHANNELS,
  planContactSheet,
  type CaptureRecord,
  type CartExportProgressEvent,
  type ContactSheetBackground,
  type ContactSheetColumns,
  type ContactSheetLayout,
  type ContactSheetSize,
  type ContactSheetSpacing,
  type RenderPreset
} from "@pwrsnap/shared";
import {
  cacheUrl,
  dispatch,
  startCartFilesDrag,
  startCartSheetDrag,
  startCartZipDrag,
  subscribe
} from "../../lib/pwrsnap";
import { formatBytes } from "../../lib/format-bytes";
import { useDismissable } from "../../lib/useDismissable";
import { useFocusReturn } from "../../lib/useFocusReturn";
import { FoIcon } from "../float-over/FoIcons";

export type CartExportMode = "copy" | "zip" | "sheet";

const MODES: ReadonlyArray<{ id: CartExportMode; label: string }> = [
  { id: "copy", label: "Copy all" },
  { id: "zip", label: "Zip" },
  { id: "sheet", label: "Contact sheet" }
];

const PRESETS: readonly RenderPreset[] = ["low", "med", "high"];
const PRESET_LABELS: Record<RenderPreset, string> = { low: "Low", med: "Med", high: "High" };
const SIZE_LABELS: Record<ContactSheetSize, string> = { s: "S", m: "M", l: "L" };

/** Copy all writes every image eagerly; main refuses more than this
 *  (MAX_COPY_ALL_IMAGES in cart-validators.ts), counting images after the
 *  skip rule exactly as this panel does. */
export const COPY_ALL_MAX = 100;
/** Main refuses a sheet past this (MAX_CONTACT_SHEET_IMAGES). */
export const CONTACT_SHEET_MAX = 200;

const COLUMN_CHOICES: readonly ContactSheetColumns[] = ["auto", 2, 3, 4, 5, 6];
const SPACING_LABELS: Record<ContactSheetSpacing, string> = {
  none: "None",
  tight: "Tight",
  roomy: "Roomy"
};
const BACKGROUND_LABELS: Record<ContactSheetBackground, string> = {
  clear: "Clear",
  hatch: "Hatch",
  black: "Black",
  white: "White"
};

// The picker and the sheet layout are remembered for the session (a fresh
// mount — the rail closing and reopening — keeps them). Not a setting.
let rememberedMode: CartExportMode = "copy";
let rememberedLayout: ContactSheetLayout = DEFAULT_CONTACT_SHEET_LAYOUT;

/** Rough per-image byte estimate at a preset — mirrors the legacy
 *  800/1440/source width mapping `presetMetrics` (CopyButton) uses, but
 *  returns the raw number so the cart can SUM across images. Approximate
 *  by design (a batch has no single pixel size to report). */
export function estimatePresetBytes(preset: RenderPreset, srcW: number, srcBytes: number): number {
  const targetW = preset === "low" ? 800 : preset === "med" ? 1440 : srcW;
  const scale = Math.min(1, targetW / Math.max(1, srcW));
  return Math.round(srcBytes * scale * scale);
}

type CardKey = `${CartExportMode}:${string}`;

type StatusLine =
  | { kind: "note"; text: string }
  | { kind: "error"; text: string };

export interface CartExportPanelProps {
  readonly captureIds: string[];
  /** Hydrated records for the cart's ids; null for a capture that is gone. */
  readonly records: ReadonlyMap<string, CaptureRecord | null>;
  /** True while some ids have not hydrated, so estimates are still climbing. */
  readonly settling: boolean;
  /** Default file name seed (the first item's title). */
  readonly suggestedName: string | undefined;
}

function plural(n: number, one: string, many: string = one + "s"): string {
  return `${n} ${n === 1 ? one : many}`;
}

function columnsLabel(columns: ContactSheetColumns): string {
  return columns === "auto" ? "Auto" : String(columns);
}

/** One CSS preview of the sheet: real thumbnails in the layout's grid, on the
 *  layout's background. Cells use the median aspect, like the bake. */
function SheetPreview({
  images,
  layout,
  className,
  maxWidth,
  maxHeight
}: {
  images: CaptureRecord[];
  layout: ContactSheetLayout;
  className: string;
  /** CSS length the preview may not exceed horizontally. */
  maxWidth: string;
  /** Pixels the preview may not exceed vertically. */
  maxHeight: number;
}): ReactElement {
  const plan = useMemo(
    () =>
      images.length === 0
        ? null
        : planContactSheet({
            images: images.map((r) => ({ width: r.width_px, height: r.height_px })),
            widthPx: CONTACT_SHEET_WIDTHS.m,
            columns: layout.columns,
            spacing: layout.spacing
          }),
    [images, layout.columns, layout.spacing]
  );
  if (plan === null) return <span className={className} aria-hidden="true" />;
  // Draw the plan to scale in percentages of the sheet, so the preview is
  // exactly the bake's geometry at any preview size.
  const pct = (v: number, of: number): string => `${(v / of) * 100}%`;
  return (
    <span
      className={`${className} psl__sheet-bg--${layout.background}`}
      // Fit inside maxWidth × maxHeight at the sheet's own aspect ratio:
      // the width is whichever bound binds first, and the height follows.
      style={{
        width: `min(${maxWidth}, ${Math.round((maxHeight * plan.width) / plan.height)}px)`,
        aspectRatio: `${plan.width} / ${plan.height}`
      }}
      aria-hidden="true"
    >
      {images.map((rec, index) => {
        const tile = plan.tiles[index]!;
        return (
          <img
            key={rec.id}
            src={cacheUrl(rec.id, 96, "webp", rec.edits_version)}
            alt=""
            loading="lazy"
            decoding="async"
            style={{
              left: pct(tile.x, plan.width),
              top: pct(tile.y, plan.height),
              width: pct(tile.width, plan.width),
              height: pct(tile.height, plan.height)
            }}
          />
        );
      })}
    </span>
  );
}

function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
  render
}: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (next: T) => void;
  render: (option: T) => ReactElement | string;
}): ReactElement {
  return (
    <div className="psl__sheet-field">
      <span className="psl__sheet-field-label">{label}</span>
      <div className="psl__sheet-seg" role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <button
            key={String(option)}
            type="button"
            role="radio"
            aria-checked={option === value}
            className={"psl__sheet-seg-btn" + (option === value ? " is-on" : "")}
            onClick={() => onChange(option)}
          >
            {render(option)}
          </button>
        ))}
      </div>
    </div>
  );
}

export function CartExportPanel({
  captureIds,
  records,
  settling,
  suggestedName
}: CartExportPanelProps): ReactElement {
  const [mode, setModeState] = useState<CartExportMode>(rememberedMode);
  const [layout, setLayoutState] = useState<ContactSheetLayout>(rememberedLayout);
  const setMode = useCallback((next: CartExportMode) => {
    rememberedMode = next;
    setModeState(next);
  }, []);
  const setLayout = useCallback((patch: Partial<ContactSheetLayout>) => {
    setLayoutState((prev) => {
      rememberedLayout = { ...prev, ...patch };
      return rememberedLayout;
    });
  }, []);

  const [busyKey, setBusyKey] = useState<CardKey | null>(null);
  const [copiedKey, setCopiedKey] = useState<CardKey | null>(null);
  const [status, setStatus] = useState<StatusLine | null>(null);
  const [progress, setProgress] = useState<{ phase: string; completed: number; total: number } | null>(
    null
  );
  const activeJobIdRef = useRef<string | null>(null);

  const [layoutOpen, setLayoutOpen] = useState(false);
  const layoutTriggerRef = useRef<HTMLButtonElement | null>(null);
  const layoutRef = useRef<HTMLDivElement | null>(null);
  useDismissable({
    open: layoutOpen,
    onDismiss: () => setLayoutOpen(false),
    surfaceRef: layoutRef,
    triggerRef: layoutTriggerRef,
    dismissOnFocusLeave: true
  });
  useFocusReturn({ open: layoutOpen, containerRef: layoutRef, returnFocusRef: layoutTriggerRef });
  // The popover belongs to the sheet mode only.
  useEffect(() => {
    if (mode !== "sheet") setLayoutOpen(false);
  }, [mode]);

  // The "Copied" flash on a card, as on a single copy.
  useEffect(() => {
    if (copiedKey === null) return;
    const timer = window.setTimeout(() => setCopiedKey(null), 1200);
    return () => window.clearTimeout(timer);
  }, [copiedKey]);

  useEffect(() => {
    const unsubscribe = subscribe(EVENT_CHANNELS.cartExportProgress, (payload) => {
      const ev = payload as CartExportProgressEvent | null;
      if (ev === null || typeof ev !== "object" || ev.jobId !== activeJobIdRef.current) return;
      if (ev.phase === "done") {
        setProgress(null);
        return;
      }
      setProgress({ phase: ev.phase, completed: ev.completed, total: ev.total });
    });
    return unsubscribe;
  }, []);

  // Images that survive the export skip rule — main's resolveExportableImages:
  // videos, trashed and gone captures are left out — plus how many were left
  // out, for the strip, the estimates and the caps.
  const { images, leftOut } = useMemo(() => {
    const out: CaptureRecord[] = [];
    let left = 0;
    for (const id of captureIds) {
      const rec = records.get(id);
      if (rec === undefined) continue; // still hydrating
      if (rec === null || rec.kind !== "image" || rec.deleted_at !== null) left += 1;
      else out.push(rec);
    }
    return { images: out, leftOut: left };
  }, [captureIds, records]);

  const presetEstimates = useMemo(() => {
    const totals: Record<RenderPreset, number> = { low: 0, med: 0, high: 0 };
    for (const rec of images) {
      for (const p of PRESETS) totals[p] += estimatePresetBytes(p, rec.width_px, rec.byte_size);
    }
    return totals;
  }, [images]);

  const sheetEstimates = useMemo(() => {
    if (images.length === 0) return null;
    const sizes = images.map((r) => ({ width: r.width_px, height: r.height_px }));
    return Object.fromEntries(
      CONTACT_SHEET_SIZES.map((size) => {
        const plan = planContactSheet({
          images: sizes,
          widthPx: CONTACT_SHEET_WIDTHS[size],
          columns: layout.columns,
          spacing: layout.spacing
        });
        // Each tile keeps its source's bytes per pixel; the background
        // compresses to almost nothing.
        let bytes = 0;
        for (const [index, rec] of images.entries()) {
          const tile = plan.tiles[index]!;
          const srcArea = Math.max(1, rec.width_px * rec.height_px);
          bytes += rec.byte_size * Math.min(1, (tile.width * tile.height) / srcArea);
        }
        return [size, { width: plan.width, height: plan.height, columns: plan.columns, bytes }];
      })
    ) as Record<ContactSheetSize, { width: number; height: number; columns: number; bytes: number }>;
  }, [images, layout.columns, layout.spacing]);

  const imageCount = images.length;
  const overCap =
    (mode === "copy" && imageCount > COPY_ALL_MAX) || (mode === "sheet" && imageCount > CONTACT_SHEET_MAX);
  const disabled = imageCount === 0 || busyKey !== null || overCap;

  const leftOutText = leftOut > 0 ? ` · ${leftOut} left out` : "";

  const beginJob = useCallback((key: CardKey): string => {
    setStatus(null);
    setProgress(null);
    setBusyKey(key);
    const jobId = crypto.randomUUID();
    activeJobIdRef.current = jobId;
    return jobId;
  }, []);
  const endJob = useCallback(() => {
    setBusyKey(null);
    setProgress(null);
    activeJobIdRef.current = null;
  }, []);

  const onCancel = useCallback(() => {
    const jobId = activeJobIdRef.current;
    if (jobId === null) return;
    void dispatch("cart:exportZip:cancel", { jobId });
  }, []);

  const onCopyAll = useCallback(
    (preset: RenderPreset) => {
      const key: CardKey = `copy:${preset}`;
      const jobId = beginJob(key);
      void dispatch("cart:copyAll", { captureIds, preset, jobId }).then((r) => {
        endJob();
        if (r.ok) {
          setCopiedKey(key);
          const left = r.value.skipped + r.value.failed;
          setStatus({
            kind: "note",
            text: `Copied ${plural(r.value.fileCount, "image")}${left > 0 ? ` · ${left} left out` : ""}`
          });
        } else if (r.error.code !== "cancelled") {
          setStatus({ kind: "error", text: r.error.message });
        }
      });
    },
    [beginJob, captureIds, endJob]
  );

  const onZip = useCallback(
    (preset: RenderPreset) => {
      const jobId = beginJob(`zip:${preset}`);
      void dispatch("cart:exportZip", {
        captureIds,
        preset,
        jobId,
        ...(suggestedName !== undefined ? { suggestedName } : {})
      }).then((r) => {
        endJob();
        if (r.ok) {
          const left = r.value.skipped + r.value.failed;
          setStatus({
            kind: "note",
            text: `Zipped ${plural(r.value.fileCount, "image")}${left > 0 ? ` · ${left} left out` : ""}`
          });
        } else if (r.error.code !== "cancelled") {
          // `cancelled` = the user dismissed the save dialog; not an error.
          setStatus({ kind: "error", text: r.error.message });
        }
      });
    },
    [beginJob, captureIds, endJob, suggestedName]
  );

  const onSheet = useCallback(
    (size: ContactSheetSize, action: "copy" | "save") => {
      const key: CardKey = `sheet:${size}`;
      const jobId = beginJob(key);
      void dispatch("cart:contactSheet", {
        captureIds,
        size,
        layout,
        action,
        jobId,
        ...(suggestedName !== undefined ? { suggestedName } : {})
      }).then((r) => {
        endJob();
        if (r.ok) {
          if (action === "copy") setCopiedKey(key);
          const left = r.value.skipped + r.value.failed;
          setStatus({
            kind: "note",
            text:
              `${action === "copy" ? "Copied" : "Saved"} a ${r.value.width} × ${r.value.height} sheet of ${r.value.imageCount}` +
              (r.value.scaledDown ? " · narrowed to fit" : "") +
              (left > 0 ? ` · ${left} left out` : "")
          });
        } else if (r.error.code !== "cancelled") {
          setStatus({ kind: "error", text: r.error.message });
        }
      });
    },
    [beginJob, captureIds, endJob, layout, suggestedName]
  );

  const estimateLabel = settling ? "estimating" : "estimated";

  const strip = ((): ReactElement => {
    if (overCap) {
      return (
        <div className="psl__cart-export-strip">
          <span className="psl__cart-export-strip-text">
            {mode === "copy"
              ? `Copy all takes up to ${COPY_ALL_MAX} images`
              : `A sheet takes up to ${CONTACT_SHEET_MAX} images`}
          </span>
        </div>
      );
    }
    if (mode === "sheet") {
      const cols = sheetEstimates?.m.columns;
      return (
        <div className="psl__cart-export-strip">
          <SheetPreview
            images={images}
            layout={layout}
            className="psl__sheet-mini"
            maxWidth="64px"
            maxHeight={22}
          />
          <span className="psl__cart-export-strip-text">
            <b>
              {layout.columns === "auto"
                ? `Auto${cols !== undefined ? ` · ${plural(cols, "col")}` : ""}`
                : plural(layout.columns, "col")}
            </b>
            {` · ${SPACING_LABELS[layout.spacing]} · ${BACKGROUND_LABELS[layout.background]}`}
          </span>
          <button
            ref={layoutTriggerRef}
            type="button"
            className={"psl__cart-export-strip-btn" + (layoutOpen ? " is-open" : "")}
            aria-haspopup="dialog"
            aria-expanded={layoutOpen}
            disabled={imageCount === 0}
            onClick={() => setLayoutOpen((open) => !open)}
          >
            Layout…
          </button>
          {layoutOpen ? (
            <div
              ref={layoutRef}
              className="psl__sheet-pop"
              role="dialog"
              aria-label="Contact sheet layout"
            >
              <SheetPreview
                images={images}
                layout={layout}
                className="psl__sheet-preview"
                maxWidth="100%"
                maxHeight={180}
              />
              <Segmented
                label="Columns"
                options={COLUMN_CHOICES}
                value={layout.columns}
                onChange={(columns) => setLayout({ columns })}
                render={columnsLabel}
              />
              <Segmented
                label="Spacing"
                options={["none", "tight", "roomy"] as const}
                value={layout.spacing}
                onChange={(spacing) => setLayout({ spacing })}
                render={(s) => SPACING_LABELS[s]}
              />
              <Segmented
                label="Background"
                options={["clear", "hatch", "black", "white"] as const}
                value={layout.background}
                onChange={(background) => setLayout({ background })}
                render={(b) => (
                  <>
                    <span className={`psl__sheet-swatch psl__sheet-bg--${b}`} aria-hidden="true" />
                    {BACKGROUND_LABELS[b]}
                  </>
                )}
              />
              <div className="psl__sheet-pop-foot">
                <span className="psl__sheet-pop-note">
                  Cart order, left to right. Videos are left out.
                </span>
                <span className="psl__sheet-pop-save">
                  <span className="psl__sheet-field-label">Save PNG</span>
                  {CONTACT_SHEET_SIZES.map((size) => (
                    <button
                      key={size}
                      type="button"
                      className="psl__sheet-pop-save-btn"
                      disabled={disabled}
                      data-tip={`Save the ${SIZE_LABELS[size]} sheet`}
                      data-tip-detail={`${CONTACT_SHEET_WIDTHS[size]} px wide`}
                      onClick={() => {
                        setLayoutOpen(false);
                        onSheet(size, "save");
                      }}
                    >
                      {SIZE_LABELS[size]}…
                    </button>
                  ))}
                </span>
              </div>
            </div>
          ) : null}
        </div>
      );
    }
    return (
      <div className="psl__cart-export-strip">
        <span className="psl__cart-export-strip-text">
          {mode === "copy" ? (
            <>
              <b>{plural(imageCount, "image")}</b> · paste as files{leftOutText}
            </>
          ) : (
            <>
              <b>{plural(imageCount, "PNG")}</b> · one flat .zip{leftOutText}
            </>
          )}
        </span>
        <span className="psl__copy-eyebrow-meta">{estimateLabel}</span>
      </div>
    );
  })();

  type Card = {
    key: CardKey;
    label: string;
    /** Sheet pixel size on one line (`2400×1622`); null for the presets. */
    dim: string | null;
    bytes: string;
    chip: string;
    chipTip: string;
    onClick: () => void;
    onDrag: () => void;
  };
  const settleMark = settling ? "…" : "";
  const cards: Card[] =
    mode === "sheet"
      ? CONTACT_SHEET_SIZES.map((size) => {
          const est = sheetEstimates?.[size];
          return {
            key: `sheet:${size}` as CardKey,
            label: SIZE_LABELS[size],
            dim: est !== undefined ? `${est.width}×${est.height}` : `${CONTACT_SHEET_WIDTHS[size]} wide`,
            bytes: est !== undefined ? `~${formatBytes(est.bytes)}${settleMark}` : "—",
            chip: "File",
            chipTip: `Drag the ${SIZE_LABELS[size]} sheet out`,
            onClick: () => onSheet(size, "copy"),
            onDrag: () => startCartSheetDrag(captureIds, size, layout, suggestedName)
          };
        })
      : PRESETS.map((preset) => ({
          key: `${mode}:${preset}` as CardKey,
          label: PRESET_LABELS[preset],
          dim: null,
          bytes: `~${formatBytes(presetEstimates[preset])}${settleMark}`,
          chip: mode === "copy" ? "Files" : "File",
          chipTip:
            mode === "copy"
              ? `Drag the ${PRESET_LABELS[preset]} images out`
              : `Drag the ${PRESET_LABELS[preset]} Zip out`,
          onClick: mode === "copy" ? () => onCopyAll(preset) : () => onZip(preset),
          onDrag:
            mode === "copy"
              ? () => startCartFilesDrag(captureIds, preset)
              : () => startCartZipDrag(captureIds, preset, suggestedName)
        }));

  const cardMeta = (card: Card): string => {
    if (busyKey !== card.key) return card.bytes;
    if (progress === null) return mode === "zip" ? "Saving…" : "Working…";
    if (progress.phase === "rendering") return `${progress.completed}/${progress.total}`;
    return progress.phase === "zipping" ? "Zipping…" : "Composing…";
  };

  const statusLine = ((): ReactElement => {
    if (busyKey !== null) {
      const pct =
        progress === null
          ? 8
          : progress.phase === "rendering"
            ? Math.round((progress.completed / Math.max(1, progress.total)) * 100)
            : 100;
      return (
        <div className="psl__cart-export-status">
          <div className="psl__cart-zip-bar" aria-hidden="true">
            <div className="psl__cart-zip-bar-fill" style={{ width: `${pct}%` }} />
          </div>
          <button type="button" className="psl__cart-zip-cancel" onClick={onCancel}>
            Cancel
          </button>
        </div>
      );
    }
    if (status === null) return <div className="psl__cart-export-status" />;
    return (
      <div
        className={`psl__cart-export-status is-${status.kind}`}
        role={status.kind === "error" ? "alert" : "status"}
        data-tip={status.text}
      >
        {status.text}
      </div>
    );
  })();

  return (
    <div className="psl__cart-export">
      <div className="psl__cart-export-modes" role="radiogroup" aria-label="Export the cart as">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={m.id === mode}
            className={"psl__cart-export-mode" + (m.id === mode ? " is-on" : "")}
            onClick={() => {
              if (m.id !== mode) {
                setMode(m.id);
                setStatus(null);
              }
            }}
          >
            {m.label}
          </button>
        ))}
      </div>
      {strip}
      <div className="psl__copy-row">
        {cards.map((card) => {
          const copied = copiedKey === card.key;
          return (
            <div className="fo__copy-card" key={card.key}>
              <button
                type="button"
                className={
                  "fo__copy-btn" +
                  (busyKey === card.key ? " is-running" : "") +
                  (copied ? " is-copied" : "")
                }
                disabled={disabled}
                onClick={card.onClick}
              >
                {card.dim === null ? (
                  <>
                    <div className="fo__copy-btn-row1">
                      <span className="fo__copy-label">{card.label}</span>
                    </div>
                    <div className="fo__copy-meta">
                      <span className="fo__copy-dim" />
                      <span className="fo__copy-bytes">
                        <span>{cardMeta(card)}</span>
                      </span>
                    </div>
                  </>
                ) : (
                  // A sheet card has a pixel size AND a byte estimate; the
                  // 3-up card is too narrow for both on one row, so the
                  // bytes ride beside the label and the size gets its own
                  // single line — the card keeps the presets' height.
                  <>
                    <div className="fo__copy-btn-row1">
                      <span className="fo__copy-label">{card.label}</span>
                      <span className="fo__copy-bytes">
                        <span>{cardMeta(card)}</span>
                      </span>
                    </div>
                    <div className="fo__copy-meta">
                      <span className="fo__copy-dim psl__cart-export-sheet-dim">{card.dim}</span>
                    </div>
                  </>
                )}
                <span className="fo__copy-overlay" aria-hidden="true">
                  Copied
                </span>
              </button>
              <a
                className="fo__copy-file"
                draggable={!disabled}
                href="#"
                data-tip={card.chipTip}
                aria-label={card.chipTip}
                role="button"
                onClick={(e) => e.preventDefault()}
                onDragStart={(e) => {
                  e.preventDefault();
                  if (disabled) return;
                  card.onDrag();
                }}
              >
                <FoIcon name="hand" size={10} />
                {card.chip}
              </a>
            </div>
          );
        })}
      </div>
      {statusLine}
    </div>
  );
}
