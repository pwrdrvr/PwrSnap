import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import type { CaptureRecord } from "@pwrsnap/shared";
import { AppIcon, AppTag } from "../shared/AppIcons";
import { PwrSnapMark, PwrSnapWordmark } from "../shared/BrandMark";
import type { Tool } from "../editor/Editor";
import { FixtureBackedRecords } from "./adapter";
import type { Capture } from "./captures";
import { APP_INFO, groupByDay } from "./captures";
import { DetailRail } from "./DetailRail";
import { initialLibraryView, libraryReducer } from "./library-view";
import { Stage } from "./Stage";
import { cacheUrl, captureSrcUrl } from "../../lib/pwrsnap";
import { useLibrary } from "../../lib/useLibrary";
// Thumb (synthetic per-app gradient) is the fallback for the empty
// state and for fixture rows in dev. Real captures render via
// <img src="pwrsnap-cache://"> through CellThumb below.
import { Thumb } from "./Thumb";

/**
 * Picks the right thumb representation: real cache-rendered image
 * when we have a record, synthetic per-app gradient otherwise. The
 * cache URL goes through main's protocol handler → render pipeline,
 * so the very first read of a freshly-captured snap composes its
 * 240w.webp on demand and caches it.
 */
function CellThumb({
  capture,
  record,
  width
}: {
  capture: Capture;
  record: CaptureRecord | null;
  width: number;
}) {
  if (record !== null) {
    return (
      <img
        src={cacheUrl(record.id, width, "webp", record.overlays_version)}
        alt=""
        // loading=lazy + decoding=async let the browser skip decode
        // for offscreen cells. With content-visibility:auto on the
        // .psl__cell wrapper (library.css), this is sufficient
        // through ~1000 captures without a virtualization library.
        // Plan: B.9 perf hygiene.
        loading="lazy"
        decoding="async"
        style={{
          width: "100%",
          height: "100%",
          // `contain` preserves the capture's true aspect ratio.
          // Cells use `aspect-ratio: 16/10` for a uniform grid layout;
          // letterboxing inside the cell keeps the thumbnail honest
          // for any source aspect (a tiny region capture stays small;
          // a tall window capture stays tall).
          objectFit: "contain",
          display: "block"
        }}
      />
    );
  }
  return <Thumb c={capture} />;
}

export function Library({ initialSelected = 1 }: { initialSelected?: number }) {
  const [selected, setSelected] = useState(initialSelected);
  const [activeApp, setActiveApp] = useState<string>("all");

  // View-state reducer — single source of truth for {grid, focus, reel}
  // mode + selected record id. Discriminated-union shape encodes the
  // illegal-state guard at compile time (focus mode requires non-null
  // selectedRecordId). Plan: docs/plans/2026-05-05-001-feat-library-
  // three-state-view-model-plan.md, Phase A. Tests at
  // ./__tests__/library-view.test.ts.
  const [view, viewDispatch] = useReducer(libraryReducer, initialLibraryView);
  const selectedRecordId = view.selectedRecordId;

  const { records, error } = useLibrary();
  const fixtureBacking = useMemo(() => new FixtureBackedRecords(records), [records]);
  const fixtureCaptures = useMemo(() => fixtureBacking.fixtures(), [fixtureBacking]);

  const visible =
    activeApp === "all" ? fixtureCaptures : fixtureCaptures.filter((c) => c.app === activeApp);
  const grouped = useMemo(() => groupByDay(visible), [visible]);
  const current = fixtureCaptures.find((c) => c.id === selected) ?? fixtureCaptures[0];

  // Per-app capture counts — memoized so the per-render `filter().length`
  // cost (8 apps × N captures = 8N ops/render) doesn't accumulate. Used
  // to (a) drive the count badge in the left-rail Source App list and
  // (b) data-filter the list to only apps that have ≥1 capture (B.8).
  const appCounts = useMemo<Record<string, number>>(() => {
    const counts: Record<string, number> = {};
    for (const c of fixtureCaptures) {
      counts[c.app] = (counts[c.app] ?? 0) + 1;
    }
    return counts;
  }, [fixtureCaptures]);

  // Apps that should appear in the left rail: any app with ≥1 capture,
  // PLUS the currently-active filter (so a user who's filtered to
  // "Telegram" and just deleted their last Telegram capture doesn't
  // get teleported away from the empty filter).
  const visibleApps = useMemo(() => {
    return Object.entries(APP_INFO).filter(
      ([app]) => (appCounts[app] ?? 0) > 0 || activeApp === app
    );
  }, [appCounts, activeApp]);

  // The CaptureRecord for the currently-selected id — passed to
  // <DetailRail> + <Stage> so they can render metadata + L/M/H copy
  // buttons in Focus + Reel modes (Phase C). Null = nothing selected.
  const selectedRecord: CaptureRecord | null = useMemo(() => {
    if (selectedRecordId === null) return null;
    return records.find((r) => r.id === selectedRecordId) ?? null;
  }, [records, selectedRecordId]);

  // Records that match the current activeApp filter, mapped from the
  // (already-filtered) `visible` fixture list. Drives ←/→ navigation
  // in Focus + Reel — both modes cycle through this set with wrap-
  // around at the edges (per the plan's Phase C.8 contract).
  const visibleRecords: CaptureRecord[] = useMemo(() => {
    const out: CaptureRecord[] = [];
    for (const c of visible) {
      const r = fixtureBacking.recordFor(c.id);
      if (r !== null) out.push(r);
    }
    return out;
  }, [visible, fixtureBacking]);

  // Index of the selected record in the visible-records list. Drives
  // the position counter ("idx / total") and the prev/next neighbors.
  const selectedIdx = useMemo(() => {
    if (selectedRecordId === null) return -1;
    return visibleRecords.findIndex((r) => r.id === selectedRecordId);
  }, [visibleRecords, selectedRecordId]);

  // Previous/next record ids for ←/→ navigation, with wrap-around.
  // Both are null when the visible set has 0 or 1 records (no
  // navigation possible).
  const prevRecordId = useMemo(() => {
    if (visibleRecords.length <= 1 || selectedIdx < 0) return null;
    const i = (selectedIdx - 1 + visibleRecords.length) % visibleRecords.length;
    return visibleRecords[i]?.id ?? null;
  }, [visibleRecords, selectedIdx]);
  const nextRecordId = useMemo(() => {
    if (visibleRecords.length <= 1 || selectedIdx < 0) return null;
    const i = (selectedIdx + 1) % visibleRecords.length;
    return visibleRecords[i]?.id ?? null;
  }, [visibleRecords, selectedIdx]);

  // Lifted tool state — owned by Library so the chromeless Editor
  // (inside <Stage>) and the floating <EditToolbar> share a single
  // source of truth. Resets to "pointer" on every mode change so a
  // user who pressed R in Focus doesn't accidentally drag-rect on a
  // filmstrip click after Esc → Reel (julik concern #3, plan
  // resolved decision: option A — predictable beats clever).
  const [tool, setTool] = useState<Tool>("pointer");
  useEffect(() => {
    setTool("pointer");
  }, [view.kind]);

  // Ref to the scrollable grid container. Used by:
  //   • Cell click handler — captures scrollTop into the OPEN_FOCUS
  //     returnAnchor so the cell-pulse effect can find which cell
  //     to highlight on Focus → Grid return.
  //   • The Phase B keep-Grid-mounted decision means scrollTop
  //     persists natively across mode flips (the element is
  //     display:none'd, not unmounted).
  const gridScrollRef = useRef<HTMLDivElement | null>(null);

  // Stale-selection fallback: when the live list no longer contains
  // the selected record (e.g. a soft-delete races an open Focus),
  // bail to grid via the reducer's FILTER_CHANGED action.
  useEffect(() => {
    if (selectedRecordId === null) return;
    if (selectedRecord !== null) return;
    viewDispatch({ type: "FILTER_CHANGED", visibleIds: records.map((r) => r.id) });
  }, [selectedRecordId, selectedRecord, records]);

  // Filter-change-while-Focus bail: when activeApp changes and the
  // current selection is no longer in the visible set, the reducer
  // closes Focus and lands the user back in Grid (resolved decision
  // from the plan — filter is a query, query changed, show new
  // result set in Grid form).
  useEffect(() => {
    viewDispatch({
      type: "FILTER_CHANGED",
      visibleIds: visibleRecords.map((r) => r.id)
    });
  }, [visibleRecords]);

  // Window keydown handler — Esc closes Focus, ←/→ navigate between
  // captures in Focus + Reel. Single listener for the lifetime of
  // Library mount; reads current state via refs so no stale-closure
  // bug after mode flips (julik concern #4a). Editor's own keydown
  // handler runs first for canvas-level concerns (V/A/R/H/T/B tool
  // hotkeys, Esc-to-cancel-draft).
  const viewRef = useRef(view);
  const prevRecordIdRef = useRef(prevRecordId);
  const nextRecordIdRef = useRef(nextRecordId);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  useEffect(() => {
    prevRecordIdRef.current = prevRecordId;
  }, [prevRecordId]);
  useEffect(() => {
    nextRecordIdRef.current = nextRecordId;
  }, [nextRecordId]);
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      const target = event.target as HTMLElement | null;
      // Skip when the user is typing in an input — single-letter
      // shortcuts and Esc must not steal focus from text fields.
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      if (target?.isContentEditable) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const kind = viewRef.current.kind;
      if (event.key === "Escape" && kind === "focus") {
        event.preventDefault();
        viewDispatch({ type: "CLOSE_FOCUS" });
        return;
      }
      if (event.key === "ArrowLeft" && (kind === "focus" || kind === "reel")) {
        const id = prevRecordIdRef.current;
        if (id !== null) {
          event.preventDefault();
          viewDispatch({ type: "NAVIGATE", recordId: id });
        }
        return;
      }
      if (event.key === "ArrowRight" && (kind === "focus" || kind === "reel")) {
        const id = nextRecordIdRef.current;
        if (id !== null) {
          event.preventDefault();
          viewDispatch({ type: "NAVIGATE", recordId: id });
        }
        return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /**
   * Single-click handler for grid cells. Phase C: dispatches
   * `OPEN_FOCUS` with the captured grid scroll position + cell id
   * so the cell-pulse effect can highlight the right cell on
   * Focus → Grid return. Reel-mode filmstrip frames have their own
   * NAVIGATE-only click handler (no Focus open from filmstrip).
   */
  function onSelectCell(c: Capture): void {
    setSelected(c.id);
    const record = fixtureBacking.recordFor(c.id);
    if (record === null) {
      // Fixture-only cell (dev placeholder) — no real record to open.
      return;
    }
    viewDispatch({
      type: "OPEN_FOCUS",
      recordId: record.id,
      returnAnchor: {
        scrollTop: gridScrollRef.current?.scrollTop ?? 0,
        cellId: record.id
      }
    });
  }

  /**
   * Reel filmstrip frame click. Updates selectedRecordId without
   * opening Focus.
   */
  function onSelectFrame(c: Capture): void {
    setSelected(c.id);
    const record = fixtureBacking.recordFor(c.id);
    if (record === null) return;
    viewDispatch({ type: "NAVIGATE", recordId: record.id });
  }

  /**
   * Image preload on cell hover (Phase C.12). The grid thumbnail is
   * 400w; Focus needs the source-resolution image. Preloading on
   * mouseEnter starts the fetch in the user's reaction window so the
   * stage doesn't flash blank when Focus opens. ~5 lines of code, big
   * perceived-perf win. Cancelled if the user moves off the cell
   * before clicking — but the browser already has the bytes cached
   * for next time, so the cost is just the eager fetch. */
  function preloadFullRes(record: CaptureRecord | null): void {
    if (record === null) return;
    const img = new Image();
    img.src = captureSrcUrl(record.id);
  }

  /**
   * Cell-pulse effect (Phase C.7). When view.kind transitions from
   * "focus" back to "grid", briefly add `.is-was-open` to the cell
   * with id matching `view.returnAnchor.cellId` so the user's eye
   * can find the cell they came from. Pure CSS animation via
   * `@keyframes cell-pulse` in library.css; we only manage the class
   * lifecycle. animationend listener with { once: true } removes the
   * class self-cleaningly. Force-reflow on re-add so a rapid
   * open/close/open sequence restarts the animation instead of
   * no-oping.
   *
   * useLayoutEffect (not useEffect) so the class is added before the
   * browser paints the new Grid frame — eliminates a 1-frame gap
   * where the user sees Grid mounted with no pulse running.
   *
   * The trigger lives in a ref because we need to fire this animation
   * exactly once per Focus → Grid transition, not on every render.
   */
  const lastViewKindRef = useRef(view.kind);
  const pulseAnchorRef = useRef<string | null>(null);
  if (lastViewKindRef.current === "focus" && view.kind === "grid") {
    // Capture the cellId from the view we just left. (We're reading
    // mid-render, but only setting a ref — no setState, so React is
    // happy. The previous view's returnAnchor was on the focus state;
    // we don't have access here, so we use the new view's
    // selectedRecordId as a proxy — they're the same record.)
    pulseAnchorRef.current = view.selectedRecordId;
  }
  lastViewKindRef.current = view.kind;

  useLayoutEffect(() => {
    if (view.kind !== "grid") return;
    const cellId = pulseAnchorRef.current;
    if (cellId === null) return;
    pulseAnchorRef.current = null;
    const cell = gridScrollRef.current?.querySelector<HTMLElement>(
      `[data-cell-id="${cellId}"]`
    );
    if (cell === null || cell === undefined) return;
    // Force reflow so re-adding the class restarts the animation
    // (browsers no-op style changes that don't differ from the
    // current state otherwise).
    cell.classList.remove("is-was-open");
    void cell.offsetWidth;
    cell.classList.add("is-was-open");
    const onEnd = (): void => {
      cell.classList.remove("is-was-open");
    };
    cell.addEventListener("animationend", onEnd, { once: true });
    return () => {
      cell.removeEventListener("animationend", onEnd);
      cell.classList.remove("is-was-open");
    };
  }, [view.kind]);

  // The visible/grouped collections drive both the Grid and the Reel
  // mode, so the segmented toggle's fallback id (for "Reel toggle from
  // Grid with no selection") needs them in scope before the JSX block.
  const reelFallbackId = useMemo(() => {
    const firstVisibleFixture = visible[0];
    if (firstVisibleFixture === undefined) return null;
    const record = fixtureBacking.recordFor(firstVisibleFixture.id);
    return record?.id ?? null;
  }, [visible, fixtureBacking]);

  return (
    <div className="psl" data-mode={view.kind}>
      <header className="psl__topbar">
        <div className="psl__topbar-l">
          <div className="psl__title">
            <span className="psl__title-mark">
              <PwrSnapMark size={18} />
            </span>
            <PwrSnapWordmark />
          </div>
          <span className="psl__count">{records.length} captures</span>
        </div>
        <div className="psl__topbar-c">
          <div className="psl__view">
            <button
              className={"psl__view-btn" + (view.kind === "reel" ? " is-active" : "")}
              onClick={() =>
                viewDispatch({ type: "TOGGLE_VIEW", to: "reel", fallbackId: reelFallbackId })
              }
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="6" width="4" height="12" />
                <rect x="10" y="6" width="4" height="12" />
                <rect x="17" y="6" width="4" height="12" />
              </svg>
              Reel
            </button>
            <button
              className={"psl__view-btn" + (view.kind === "grid" ? " is-active" : "")}
              onClick={() =>
                viewDispatch({ type: "TOGGLE_VIEW", to: "grid", fallbackId: null })
              }
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="7" height="7" />
                <rect x="14" y="3" width="7" height="7" />
                <rect x="3" y="14" width="7" height="7" />
                <rect x="14" y="14" width="7" height="7" />
              </svg>
              Grid
            </button>
          </div>
        </div>
        <div className="psl__topbar-r">
          <div className="psl__search-wrap">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              className="psl__search"
              placeholder="Search captures, tags, OCR…"
              defaultValue=""
            />
          </div>
          <button className="psl__chip-btn psl__chip-btn--accent" style={{ height: 28 }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
              <path d="M5 12h14M12 5v14" />
            </svg>
            New snap · ⌘⇧P
          </button>
        </div>
      </header>

      <aside className="psl__left">
        <div className="psl__left-section">Library</div>
        <button
          className={"psl__nav" + (activeApp === "all" ? " is-active" : "")}
          onClick={() => setActiveApp("all")}
        >
          <span className="psl__nav-icon">
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8">
              <rect x="3" y="3" width="7" height="7" />
              <rect x="14" y="3" width="7" height="7" />
              <rect x="3" y="14" width="7" height="7" />
              <rect x="14" y="14" width="7" height="7" />
            </svg>
          </span>
          <span className="psl__nav-label">All Captures</span>
          <span className="psl__nav-count">{records.length}</span>
        </button>
        <button className="psl__nav">
          <span className="psl__nav-icon">
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
          </span>
          <span className="psl__nav-label">Today</span>
          <span className="psl__nav-count">8</span>
        </button>
        <button className="psl__nav">
          <span className="psl__nav-icon">
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M5 4l1 16h12l1-16" />
              <path d="M9 4V2h6v2" />
            </svg>
          </span>
          <span className="psl__nav-label">Trash</span>
          <span className="psl__nav-count">14</span>
        </button>

        <div className="psl__left-section">Source App</div>
        {visibleApps.map(([app, info]) => (
          <button
            key={app}
            className={"psl__nav" + (activeApp === app ? " is-active" : "")}
            onClick={() => setActiveApp(app)}
          >
            <span className="psl__nav-icon">
              <AppIcon app={app as never} size={11} />
            </span>
            <span className="psl__nav-label">{info.name}</span>
            <span className="psl__nav-count">{appCounts[app] ?? 0}</span>
          </button>
        ))}

        <div className="psl__left-section">Smart Filters</div>
        <button className="psl__nav">
          <span className="psl__nav-icon">
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M12 2 9 9l-7 1 5 5-1 7 6-3 6 3-1-7 5-5-7-1z" />
            </svg>
          </span>
          <span className="psl__nav-label">Pinned</span>
          <span className="psl__nav-count">6</span>
        </button>
        <button className="psl__nav">
          <span className="psl__nav-icon">
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0Z" />
              <path d="m9 12 2 2 4-4" />
            </svg>
          </span>
          <span className="psl__nav-label">Bug repros</span>
          <span className="psl__nav-count">5</span>
        </button>
        <button className="psl__nav">
          <span className="psl__nav-icon">
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M4 4h16v6H4zM4 14h16v6H4z" />
            </svg>
          </span>
          <span className="psl__nav-label">Has annotations</span>
          <span className="psl__nav-count">11</span>
        </button>
      </aside>

      <main className="psl__main">
        {/* Grid pane — visible in grid mode only via .psl[data-mode="grid"]
            CSS toggle. All day groups render (the prior .slice(0, 2)
            band-aid is removed per Phase B.10; perf hygiene of B.9 —
            loading="lazy" + content-visibility:auto on cells — carries
            us through ~1000 captures without virtualization).

            Note: the filmstrip used to render here in a `.psl__reel-wrap`
            section, but as of Phase C/D it's passed into <Stage> as the
            `aboveStageSlot` prop in Reel mode — see the filmstripSlot
            const below. The previous "filmstrip in main + Stage as
            sibling" layout had both elements landing in grid-column 2 /
            grid-row 2 which made Stage paint on top of the filmstrip. */}
        <div className="psl__grid-wrap" ref={gridScrollRef}>
          {grouped.map((g) => (
            <div key={g.day}>
              <div className="psl__day-hdr">
                <span className="psl__day-hdr-label">{g.day}</span>
                <span className="psl__day-hdr-meta">
                  {g.date} · {g.items.length} captures
                </span>
                <span className="psl__day-hdr-line" />
              </div>
              <div className="psl__grid">
                {g.items.map((c) => {
                  const record = fixtureBacking.recordFor(c.id);
                  return (
                    <div
                      key={c.id}
                      className={"psl__cell" + (c.id === selected ? " is-selected" : "")}
                      data-cell-id={record?.id ?? ""}
                      onClick={() => onSelectCell(c)}
                      onMouseEnter={() => preloadFullRes(record)}
                    >
                      <div className="psl__cell-thumb">
                        <CellThumb capture={c} record={record} width={400} />
                        <span className="psl__cell-time">{c.time}</span>
                        <span className="psl__cell-app">
                          <span className="psl__app-dot">
                            <AppIcon app={c.app} size={10} />
                          </span>
                        </span>
                      </div>
                      <div className="psl__cell-meta">
                        <div className="psl__cell-name">{c.n}</div>
                        <div className="psl__cell-tags">
                          <AppTag
                            app={c.app}
                            name={APP_INFO[c.app]?.name ?? "Unknown app"}
                            size="sm"
                          />
                          {c.tags.slice(0, 1).map((t) => (
                            <span key={t} className="ps-tag is-sm">
                              {t}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        {error !== null && (
          <div className="psl__error" role="alert">
            Failed to load library: {error}
          </div>
        )}
      </main>

      {/* Stage — Focus mode opens it inside a native <dialog> with
          showModal(); Reel mode renders it in-flow with the filmstrip
          on top via the `aboveStageSlot` prop. The discriminated
          union ensures selectedRecord is non-null at this point
          because focus + reel both require a non-null
          selectedRecordId in the type. */}
      {(view.kind === "focus" || view.kind === "reel") && selectedRecord !== null && (
        <Stage
          view={view}
          record={selectedRecord}
          dismissible={view.kind === "focus"}
          dispatch={viewDispatch}
          posLabel={{
            idx: selectedIdx + 1,
            total: visibleRecords.length
          }}
          prevRecordId={prevRecordId}
          nextRecordId={nextRecordId}
          tool={tool}
          onToolChange={setTool}
          {...(view.kind === "reel"
            ? {
                aboveStageSlot: (
                  <section className="psl__reel-wrap">
                    <div className="psl__reel-hdr">
                      <span className="psl__reel-title">
                        Timeline ·{" "}
                        {activeApp === "all" ? "all sources" : APP_INFO[activeApp]?.name}
                      </span>
                    </div>
                    <div className="psl__reel">
                      {grouped.map((g) => (
                        <div key={g.day} className="psl__reel-day">
                          <div className="psl__reel-day-label">
                            {g.day} · {g.date}
                          </div>
                          <div className="psl__reel-day-frames">
                            {g.items.map((c) => (
                              <button
                                key={c.id}
                                className={
                                  "psl__frame" +
                                  (c.id === selected ? " is-selected" : "")
                                }
                                onClick={() => onSelectFrame(c)}
                              >
                                <CellThumb
                                  capture={c}
                                  record={fixtureBacking.recordFor(c.id)}
                                  width={140}
                                />
                                <span className="psl__frame-num">{c.time}</span>
                                <span className="psl__frame-app">
                                  <AppIcon app={c.app} size={8} />
                                </span>
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                )
              }
            : {})}
        />
      )}

      {/* Detail rail. Renders null in grid mode (Phase B); Phase C
          populates it with metadata + Codex caption + L/M/H copy
          row + action row in focus + reel modes. */}
      <DetailRail view={view} record={selectedRecord} />

      <footer className="psl__status">
        <div className="psl__status-l">
          <span>
            <span className="a">●</span> 3.2 GB local · <b>iCloud sync</b>
          </span>
          <span>
            Codex auto-tag <b>on</b>
          </span>
        </div>
        <div className="psl__status-r">
          <span>⌘⇧P new · ⌘L library · ⌘K search</span>
          <span>
            <b>v0.0.1</b>
          </span>
        </div>
      </footer>
    </div>
  );
}

