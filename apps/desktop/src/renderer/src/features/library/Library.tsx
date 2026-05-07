import type { MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import type { CaptureRecord } from "@pwrsnap/shared";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import { AppIcon, AppTag } from "../shared/AppIcons";
import { PwrSnapMark, PwrSnapWordmark } from "../shared/BrandMark";
import type { Tool } from "../editor/Editor";
import { FixtureBackedRecords } from "./adapter";
import type { Capture } from "./captures";
import { APP_INFO, groupByDay } from "./captures";
import { DetailRail } from "./DetailRail";
import { initialLibraryView, libraryReducer } from "./library-view";
import { Stage } from "./Stage";
import { cacheUrl, captureSrcUrl, dispatch, subscribe } from "../../lib/pwrsnap";
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

/**
 * Local-date stamp as YYYY-MM-DD. Used as a memo key so date-derived
 * UI (the "Today" filter, day-bucket headers) rebuilds when the local
 * date changes — including across midnight while the app stays open.
 * Date-only on purpose; intra-day re-renders shouldn't invalidate
 * fixture caches.
 */
function formatLocalDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function Library({ initialSelected = 1 }: { initialSelected?: number }) {
  const [selected, setSelected] = useState(initialSelected);
  const [activeApp, setActiveApp] = useState<string>("all");

  // Left-bar pin / collapse / hover-peek (PwrAgnt's HoverRevealPanel
  // pattern, mirrored for the left side). Default = pinned. State is
  // intentionally per-window for now; a future settings entry can lift
  // it once we decide where view-prefs live (see CLAUDE.md preference
  // notes).
  //   • leftPinned — sticky: occupies its grid column, always visible.
  //   • leftRevealed — transient: hover-peek when not pinned.
  // Both effective when (pinned || revealed).
  const [leftPinned, setLeftPinned] = useState(true);
  const [leftRevealed, setLeftRevealed] = useState(false);
  const leftHideTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const revealLeft = useCallback(() => {
    if (leftHideTimerRef.current !== undefined) {
      clearTimeout(leftHideTimerRef.current);
      leftHideTimerRef.current = undefined;
    }
    setLeftRevealed(true);
  }, []);
  const hideLeft = useCallback(() => {
    if (leftHideTimerRef.current !== undefined) clearTimeout(leftHideTimerRef.current);
    // 200ms debounce — matches HoverRevealPanel. Without it, the slide
    // transition under the cursor causes flicker (mouseleave fires as
    // the panel moves out from under the pointer mid-animation).
    leftHideTimerRef.current = setTimeout(() => {
      setLeftRevealed(false);
      leftHideTimerRef.current = undefined;
    }, 200);
  }, []);

  // View-state reducer — single source of truth for {grid, focus, reel}
  // mode + selected record id. Discriminated-union shape encodes the
  // illegal-state guard at compile time (focus mode requires non-null
  // selectedRecordId). Plan: docs/plans/2026-05-05-001-feat-library-
  // three-state-view-model-plan.md, Phase A. Tests at
  // ./__tests__/library-view.test.ts.
  const [view, viewDispatch] = useReducer(libraryReducer, initialLibraryView);
  const selectedRecordId = view.selectedRecordId;

  const { records, error } = useLibrary();

  // Local-date watcher. The fixture day-bucket ("Today" / "Yesterday"
  // / "Earlier") is computed against `new Date()` when the snapshot is
  // built, then frozen on the fixture object. If the user keeps the
  // app open across midnight, yesterday's captures still claim
  // `day: "Today"` until the next records refetch, which can be hours
  // away. This watcher tracks the local date as a YYYY-MM-DD string;
  // when it changes, the fixture-backing memos below take it as a dep
  // and rebuild against a fresh `now`, so day-hdrs, the Today badge,
  // and the Today filter all re-flow at the same moment.
  //
  // Two trigger sources, both needed:
  //   • setTimeout scheduled for ~5s past the next midnight — handles
  //     the "app sat open all night" case while the machine stays
  //     awake.
  //   • window 'focus' event — setTimeout pauses while the machine is
  //     asleep, so a wake-from-sleep doesn't fire the midnight timer
  //     on time. Refocusing PwrSnap re-checks; if the date moved, we
  //     update.
  const [todayDateStr, setTodayDateStr] = useState(() => formatLocalDate(new Date()));
  useEffect(() => {
    let nextTimer: ReturnType<typeof setTimeout> | undefined;
    function checkDate(): void {
      const next = formatLocalDate(new Date());
      setTodayDateStr((prev) => (prev === next ? prev : next));
    }
    function scheduleMidnight(): void {
      const now = new Date();
      const m = new Date(now);
      m.setHours(24, 0, 5, 0); // 5s past midnight; small buffer for clock drift
      nextTimer = setTimeout(() => {
        checkDate();
        scheduleMidnight();
      }, m.getTime() - now.getTime());
    }
    scheduleMidnight();
    window.addEventListener("focus", checkDate);
    return () => {
      if (nextTimer !== undefined) clearTimeout(nextTimer);
      window.removeEventListener("focus", checkDate);
    };
  }, []);

  // Partition records into live + trash. The renderer asks
  // `library:list` for `includeDeleted: true` (single round-trip) and
  // splits here so the Trash sidebar entry just swaps the active
  // universe without a second fetch.
  const liveRecords = useMemo(
    () => records.filter((r) => r.deleted_at === null),
    [records]
  );
  const trashRecords = useMemo(
    () => records.filter((r) => r.deleted_at !== null),
    [records]
  );

  // Universe of records the current view operates on. Trash is a
  // top-level swap (not a per-app filter) so the per-app filter only
  // applies when viewing live captures.
  const isTrashView = activeApp === "trash";
  const universeRecords = isTrashView ? trashRecords : liveRecords;

  const fixtureBacking = useMemo(
    () => new FixtureBackedRecords(universeRecords),
    // todayDateStr drives the day-bucket inside FixtureBackedRecords;
    // including it forces a rebuild when the local date crosses so the
    // grid's day-hdrs ("Today" / "Yesterday") update without a refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [universeRecords, todayDateStr]
  );
  const fixtureCaptures = useMemo(() => fixtureBacking.fixtures(), [fixtureBacking]);

  const isTodayView = activeApp === "today";
  const visible =
    activeApp === "all" || isTrashView
      ? fixtureCaptures
      : isTodayView
      ? fixtureCaptures.filter((c) => c.day === "Today")
      : fixtureCaptures.filter((c) => c.app === activeApp);
  const grouped = useMemo(() => groupByDay(visible), [visible]);
  const current = fixtureCaptures.find((c) => c.id === selected) ?? fixtureCaptures[0];

  // Per-app capture counts — memoized so the per-render `filter().length`
  // cost (N apps × M captures = NM ops/render) doesn't accumulate. Used
  // to (a) drive the count badge in the left-rail Source App list and
  // (b) data-filter the list to only apps that have ≥1 capture (B.8).
  // Always sourced from LIVE records: trash is a separate surface, not
  // a slice of the per-app counts.
  const liveFixturesForCounts = useMemo(() => {
    const backing = new FixtureBackedRecords(liveRecords);
    return backing.fixtures();
    // todayDateStr — see comment on `fixtureBacking` above. Same
    // reason: rebuilds the day-bucket against the new local date so
    // the Today badge resets to 0 at midnight without a refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveRecords, todayDateStr]);
  const appCounts = useMemo<Record<string, number>>(() => {
    const counts: Record<string, number> = {};
    for (const c of liveFixturesForCounts) {
      counts[c.app] = (counts[c.app] ?? 0) + 1;
    }
    return counts;
  }, [liveFixturesForCounts]);

  // "Today" sidebar count — live records whose adapter-bucket landed
  // in the Today bucket (see adapter.ts:dayBucket). Live-only because
  // soft-deleted captures don't show up in the Today filter.
  const todayCount = useMemo(
    () => liveFixturesForCounts.filter((c) => c.day === "Today").length,
    [liveFixturesForCounts]
  );

  // Display name per app key — curated short id wins (so "vscode"
  // stays "VS Code"), else first non-null `appName` we observed for
  // that key (the OS-supplied user-facing name from
  // `record.source_app_name`). Falls back to "Unknown app" only when
  // neither is available (record missing both bundle id and name).
  const appLabels = useMemo<Record<string, string>>(() => {
    const labels: Record<string, string> = {};
    for (const c of liveFixturesForCounts) {
      if (labels[c.app] !== undefined) continue;
      const known = APP_INFO[c.app]?.name;
      if (known !== undefined) labels[c.app] = known;
      else if (c.appName !== null) labels[c.app] = c.appName;
      else labels[c.app] = "Unknown app";
    }
    return labels;
  }, [liveFixturesForCounts]);

  // Apps that should appear in the left rail: any app with ≥1 capture,
  // PLUS the currently-active filter (so a user who's filtered to
  // "Telegram" and just deleted their last Telegram capture doesn't
  // get teleported away from the empty filter). The list is open —
  // unknown apps (lowercased bundle ids that don't have a curated
  // glyph) appear here with their OS-supplied name and a procedural
  // initials icon. Sorted alphabetically by display name for stable
  // ordering across renders.
  const visibleApps = useMemo<Array<{ app: string; name: string }>>(() => {
    const seen = new Set<string>();
    const out: Array<{ app: string; name: string }> = [];
    for (const app of Object.keys(appCounts)) {
      if ((appCounts[app] ?? 0) === 0) continue;
      seen.add(app);
      out.push({ app, name: appLabels[app] ?? "Unknown app" });
    }
    if (activeApp !== "all" && !seen.has(activeApp)) {
      out.push({
        app: activeApp,
        name: appLabels[activeApp] ?? APP_INFO[activeApp]?.name ?? "Unknown app"
      });
    }
    out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    return out;
  }, [appCounts, appLabels, activeApp]);

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

  // Reel filmstrip scroll preservation (plan D.2 + D.4). The
  // filmstrip is rendered inside Stage's `aboveStageSlot`, which
  // mounts/unmounts as the user toggles Reel ↔ Grid (Stage is
  // gated by `view.kind === "reel"` at the JSX level). Native
  // scrollLeft therefore does NOT persist across mode flips the
  // way the grid's scrollTop does (grid is kept mounted under
  // display:none). We mirror the value into a ref on every scroll
  // and restore it on Reel re-entry.
  //
  // Two refs:
  //   • reelScrollerRef — live element handle, set when the
  //     `.psl__reel` div mounts. null while not in Reel mode.
  //   • reelScrollLeftRef — persistent saved value across mounts.
  const reelScrollerRef = useRef<HTMLDivElement | null>(null);
  const reelScrollLeftRef = useRef<number>(0);

  // Restore filmstrip scrollLeft when Reel mounts. Layout effect
  // (not regular effect) so the restore lands before the browser
  // paints — no visual flash of the filmstrip scrolled to 0.
  useLayoutEffect(() => {
    if (view.kind !== "reel") return;
    const el = reelScrollerRef.current;
    if (el === null) return;
    el.scrollLeft = reelScrollLeftRef.current;
  }, [view.kind]);

  // Mirror scrollLeft into the ref so it survives Reel unmount.
  // Passive listener — we never preventDefault, so passive avoids
  // the per-frame compositor warning.
  useEffect(() => {
    if (view.kind !== "reel") return;
    const el = reelScrollerRef.current;
    if (el === null) return;
    const onScroll = (): void => {
      reelScrollLeftRef.current = el.scrollLeft;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [view.kind]);

  // D.4 — pull the selected frame into view whenever:
  //   • Reel mounts (Grid → Reel toggle, with a selection inherited
  //     from Grid or fallback'd by the reducer)
  //   • selection changes within Reel (←/→ keyboard nav, or click
  //     on an offscreen frame)
  //
  // `inline: "nearest"` only scrolls if the frame is genuinely out
  // of view. If the layout-effect's scrollLeft restore already put
  // the selected frame on-screen, this is a no-op — the two
  // effects cooperate cleanly without a skip-flag.
  //
  // Layout effect (not regular effect) so the scroll lands before
  // the browser paints — otherwise the filmstrip flashes at the
  // restored scrollLeft for one frame before snapping to bring
  // the selection in.
  //
  // Note: `data-frame-id` carries the CaptureRecord's UUID (the
  // same identity in `view.selectedRecordId`). An earlier version
  // used the fixture's numeric sequence id and the selector never
  // matched — the scrollIntoView silently no-op'd on every nav.
  const reelSelectedId = view.kind === "reel" ? view.selectedRecordId : null;
  useLayoutEffect(() => {
    if (view.kind !== "reel" || reelSelectedId === null) return;
    const scroller = reelScrollerRef.current;
    if (scroller === null) return;
    const frame = scroller.querySelector<HTMLElement>(
      `[data-frame-id="${reelSelectedId}"]`
    );
    frame?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [view.kind, reelSelectedId]);

  // Stale-selection fallback: when the live list no longer contains
  // the selected record (e.g. a soft-delete races an open Focus),
  // bail to grid via the reducer's FILTER_CHANGED action.
  useEffect(() => {
    if (selectedRecordId === null) return;
    if (selectedRecord !== null) return;
    viewDispatch({ type: "FILTER_CHANGED", visibleIds: records.map((r) => r.id) });
  }, [selectedRecordId, selectedRecord, records]);

  // External "open this capture in Focus" trigger. Fired by main when
  // the float-over toast's Edit button (or any future entry point)
  // calls `library:openInLibrary` — main brings the window forward
  // and broadcasts the captureId; we navigate.
  //
  // Two-stage effect so an event that lands BEFORE useLibrary has
  // refetched the new capture still resolves cleanly:
  //   1. Subscribe handler stashes the captureId in `pendingOpenId`
  //      and resets activeApp to "all" so the capture isn't filtered
  //      out by the current Trash / Today / app-source view.
  //   2. A separate effect watches for that captureId to appear in
  //      records, then dispatches OPEN_FOCUS once. Self-clearing.
  const [pendingOpenId, setPendingOpenId] = useState<string | null>(null);
  useEffect(() => {
    return subscribe(EVENT_CHANNELS.libraryOpenCapture, (payload) => {
      if (typeof payload !== "object" || payload === null) return;
      const id = (payload as { captureId?: unknown }).captureId;
      if (typeof id !== "string") return;
      setPendingOpenId(id);
      setActiveApp("all");
    });
  }, []);
  useEffect(() => {
    if (pendingOpenId === null) return;
    const record = records.find((r) => r.id === pendingOpenId);
    // Wait until the record lands in the live list (capture commit
    // races: the broadcast may arrive before useLibrary's refetch).
    if (record === undefined) return;
    setPendingOpenId(null);
    if (record.deleted_at !== null) return; // user trashed it mid-flight; bail.
    viewDispatch({
      type: "OPEN_FOCUS",
      recordId: record.id,
      returnAnchor: {
        scrollTop: gridScrollRef.current?.scrollTop ?? 0,
        cellId: record.id
      }
    });
  }, [pendingOpenId, records]);

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

      const kind = viewRef.current.kind;
      const usingMeta = event.metaKey;
      const usingOtherMod = event.ctrlKey || event.altKey;

      // ⌘[ / ⌘] — Reel-mode scrub aliases for ←/→. Same dispatch,
      // just a second binding so the on-screen "scrub ⌘[ / ⌘]"
      // hint is honest. Skip in Focus (Focus uses ←/→ only;
      // ⌘[/⌘] is "navigate window history" elsewhere in macOS,
      // and we don't want to override it outside Reel).
      if (usingMeta && !usingOtherMod && kind === "reel") {
        if (event.key === "[") {
          const id = prevRecordIdRef.current;
          if (id !== null) {
            event.preventDefault();
            viewDispatch({ type: "NAVIGATE", recordId: id });
          }
          return;
        }
        if (event.key === "]") {
          const id = nextRecordIdRef.current;
          if (id !== null) {
            event.preventDefault();
            viewDispatch({ type: "NAVIGATE", recordId: id });
          }
          return;
        }
      }

      // Single-key shortcuts must not have any modifier set.
      if (usingMeta || usingOtherMod) return;

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
   * Soft-delete a capture from the grid/reel hover affordance. The
   * trash icon sits on top of the cell; without stopPropagation the
   * cell's click handler would also fire and open Focus on a record
   * that's about to disappear from the visible set.
   */
  function trashCapture(captureId: number, event: ReactMouseEvent): void {
    event.stopPropagation();
    const record = fixtureBacking.recordFor(captureId);
    if (record === null) return;
    void dispatch("library:delete", { id: record.id });
  }

  /** Restore a soft-deleted capture from the in-trash hover affordance. */
  function restoreCaptureAction(captureId: number, event: ReactMouseEvent): void {
    event.stopPropagation();
    const record = fixtureBacking.recordFor(captureId);
    if (record === null) return;
    void dispatch("library:restore", { id: record.id });
  }

  /**
   * Permanently delete a single trashed capture. Confirms first —
   * library:purge is irreversible and the user shouldn't lose a
   * capture to a stray click.
   */
  function purgeCaptureAction(captureId: number, event: ReactMouseEvent): void {
    event.stopPropagation();
    const record = fixtureBacking.recordFor(captureId);
    if (record === null) return;
    const ok = window.confirm("Permanently delete this capture? This cannot be undone.");
    if (!ok) return;
    void dispatch("library:purge", { id: record.id });
  }

  /**
   * Empty trash. Confirmation lives in the renderer (no native dialog
   * needed) — `library:purgeAll` is irreversible so a single yes/no
   * prompt is the right friction.
   */
  function emptyTrash(): void {
    if (trashRecords.length === 0) return;
    const ok = window.confirm(
      `Permanently delete ${trashRecords.length} capture${
        trashRecords.length === 1 ? "" : "s"
      }? This cannot be undone.`
    );
    if (!ok) return;
    void dispatch("library:purgeAll", {});
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

  const leftState = leftPinned ? "pinned" : leftRevealed ? "peek" : "collapsed";

  return (
    <div className="psl" data-mode={view.kind} data-left={leftState}>
      <header className="psl__topbar">
        <div className="psl__topbar-l">
          <div className="psl__title">
            <span className="psl__title-mark">
              <PwrSnapMark size={18} />
            </span>
            <PwrSnapWordmark />
          </div>
          <span className="psl__count">
            {isTrashView
              ? `${trashRecords.length} in trash`
              : `${liveRecords.length} captures`}
          </span>
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
          {/* Search not yet implemented — hidden until the index lands. */}
          <div className="psl__search-wrap" style={{ display: "none" }}>
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
          {/* Mirrors the tray's Quick Capture button — same wording,
              same action, same hotkey. Routes through `capture:interactive`
              with `auto` mode (smart pick: region / window / full screen
              based on what the cursor is pointing at). */}
          <button
            className="psl__chip-btn psl__chip-btn--accent"
            style={{ height: 28 }}
            type="button"
            title="Smart auto-mode · picks region, window, or full screen"
            onClick={() => {
              void dispatch("capture:interactive", { mode: "auto" });
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
              <path d="M5 12h14M12 5v14" />
            </svg>
            Quick Capture · ⌘⇧P
          </button>
        </div>
      </header>

      {/* Spine — visible only when the left bar is collapsed (not
          pinned). Mirrors PwrAgnt's HoverRevealPanel pattern but for
          the left side. Click pins; hovering the spine OR the panel
          triggers a peek. The aside.psl__left below carries the same
          mouse handlers, so the panel stays revealed while the cursor
          is anywhere over it. */}
      {!leftPinned && (
        <div
          className="psl__left-spine"
          onMouseEnter={revealLeft}
          onMouseLeave={hideLeft}
        >
          <button
            type="button"
            className="psl__left-spine-btn"
            aria-label="Pin sidebar"
            title="Pin sidebar"
            onClick={() => setLeftPinned(true)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 6h18M3 12h18M3 18h18" />
            </svg>
          </button>
        </div>
      )}

      <aside
        className="psl__left"
        onMouseEnter={() => {
          if (!leftPinned) revealLeft();
        }}
        onMouseLeave={() => {
          if (!leftPinned) hideLeft();
        }}
      >
        <div className="psl__left-section psl__left-section--top">
          <span>Library</span>
          {/* In-panel pin toggle. Visible whenever the panel is on
              screen (pinned OR peeking) so the user can pin from
              either state. Hidden in `collapsed` because the panel
              itself is offscreen and the spine button takes over. */}
          {(leftPinned || leftRevealed) && (
            <button
              type="button"
              className="psl__left-pin"
              aria-label={leftPinned ? "Unpin sidebar" : "Pin sidebar"}
              title={leftPinned ? "Unpin sidebar (collapse to spine)" : "Pin sidebar"}
              onClick={() => setLeftPinned((v) => !v)}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d={leftPinned ? "M15 6l-6 6 6 6" : "M9 6l6 6-6 6"} />
              </svg>
            </button>
          )}
        </div>
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
          <span className="psl__nav-count">{liveRecords.length}</span>
        </button>
        <button
          className={"psl__nav" + (isTodayView ? " is-active" : "")}
          onClick={() => setActiveApp("today")}
        >
          <span className="psl__nav-icon">
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
          </span>
          <span className="psl__nav-label">Today</span>
          <span className="psl__nav-count">{todayCount}</span>
        </button>
        <button
          className={"psl__nav" + (isTrashView ? " is-active" : "")}
          onClick={() => setActiveApp("trash")}
        >
          <span className="psl__nav-icon">
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M5 4l1 16h12l1-16" />
              <path d="M9 4V2h6v2" />
            </svg>
          </span>
          <span className="psl__nav-label">Trash</span>
          <span className="psl__nav-count">{trashRecords.length}</span>
        </button>

        <div className="psl__left-section">Source App</div>
        {visibleApps.map(({ app, name }) => (
          <button
            key={app}
            className={"psl__nav" + (activeApp === app ? " is-active" : "")}
            onClick={() => setActiveApp(app)}
          >
            <span className="psl__nav-icon">
              <AppIcon app={app} size={11} name={name} />
            </span>
            <span className="psl__nav-label">{name}</span>
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
          {isTrashView && (
            <div className="psl__trash-banner">
              <span className="psl__trash-banner-text">
                {trashRecords.length === 0
                  ? "Trash is empty."
                  : `${trashRecords.length} item${
                      trashRecords.length === 1 ? "" : "s"
                    } in trash. Items are permanently removed after 14 days.`}
              </span>
              {trashRecords.length > 0 && (
                <button
                  type="button"
                  className="psl__trash-banner-btn"
                  onClick={emptyTrash}
                >
                  Empty Trash
                </button>
              )}
            </div>
          )}
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
                            <AppIcon app={c.app} size={10} name={appLabels[c.app]} />
                          </span>
                        </span>
                        {record !== null &&
                          (isTrashView ? (
                            <span className="psl__cell-actions">
                              <button
                                type="button"
                                className="psl__cell-trash psl__cell-trash--restore"
                                title="Restore"
                                aria-label="Restore from Trash"
                                onClick={(e) => restoreCaptureAction(c.id, e)}
                              >
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <path d="M3 12a9 9 0 1 0 3-6.7" />
                                  <path d="M3 4v5h5" />
                                </svg>
                              </button>
                              <button
                                type="button"
                                className="psl__cell-trash psl__cell-trash--purge"
                                title="Delete permanently"
                                aria-label="Delete permanently"
                                onClick={(e) => purgeCaptureAction(c.id, e)}
                              >
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <path d="M3 7h18M8 7V4h8v3M6 7l1 14h10l1-14" />
                                </svg>
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="psl__cell-trash"
                              title="Move to Trash"
                              aria-label="Move to Trash"
                              onClick={(e) => trashCapture(c.id, e)}
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M3 7h18M8 7V4h8v3M6 7l1 14h10l1-14" />
                              </svg>
                            </button>
                          ))}
                      </div>
                      <div className="psl__cell-meta">
                        <div className="psl__cell-name">{c.n}</div>
                        <div className="psl__cell-tags">
                          <AppTag
                            app={c.app}
                            name={appLabels[c.app] ?? "Unknown app"}
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
                        {activeApp === "all"
                          ? "all sources"
                          : isTodayView
                          ? "today"
                          : isTrashView
                          ? "trash"
                          : appLabels[activeApp] ?? APP_INFO[activeApp]?.name ?? "Unknown app"}
                      </span>
                      <span className="psl__reel-hint" aria-hidden="true">
                        scrub <b>⌘[ / ⌘]</b>
                      </span>
                    </div>
                    <div className="psl__reel" ref={reelScrollerRef}>
                      {grouped.map((g) => (
                        <div key={g.day} className="psl__reel-day">
                          <div className="psl__reel-day-label">
                            {g.day} · {g.date}
                          </div>
                          <div className="psl__reel-day-frames">
                            {g.items.map((c) => {
                              // Resolve the underlying CaptureRecord so the
                              // `data-frame-id` and `is-selected` checks
                              // both pivot on the record UUID — the same
                              // identity that `view.selectedRecordId`
                              // carries. Using `c.id` (numeric fixture
                              // sequence) here would break the
                              // `[data-frame-id="${selectedRecordId}"]`
                              // selector in the scrollIntoView effect AND
                              // the visual `is-selected` highlight on
                              // ←/→ navigation (which dispatches NAVIGATE
                              // against the record id, not the fixture).
                              const record = fixtureBacking.recordFor(c.id);
                              const recordId = record?.id ?? null;
                              const isSelected = recordId === selectedRecordId;
                              return (
                                <button
                                  key={c.id}
                                  data-frame-id={recordId ?? ""}
                                  className={
                                    "psl__frame" + (isSelected ? " is-selected" : "")
                                  }
                                  onClick={() => onSelectFrame(c)}
                                >
                                  <CellThumb capture={c} record={record} width={140} />
                                  <span className="psl__frame-num">{c.time}</span>
                                  <span className="psl__frame-app">
                                    <AppIcon app={c.app} size={8} name={appLabels[c.app]} />
                                  </span>
                                  {record !== null &&
                                    (isTrashView ? (
                                      <span className="psl__frame-actions">
                                        <span
                                          role="button"
                                          tabIndex={-1}
                                          className="psl__frame-trash psl__frame-trash--restore"
                                          title="Restore"
                                          aria-label="Restore from Trash"
                                          onClick={(e) => restoreCaptureAction(c.id, e)}
                                        >
                                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                            <path d="M3 12a9 9 0 1 0 3-6.7" />
                                            <path d="M3 4v5h5" />
                                          </svg>
                                        </span>
                                        <span
                                          role="button"
                                          tabIndex={-1}
                                          className="psl__frame-trash psl__frame-trash--purge"
                                          title="Delete permanently"
                                          aria-label="Delete permanently"
                                          onClick={(e) => purgeCaptureAction(c.id, e)}
                                        >
                                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                            <path d="M3 7h18M8 7V4h8v3M6 7l1 14h10l1-14" />
                                          </svg>
                                        </span>
                                      </span>
                                    ) : (
                                      <span
                                        role="button"
                                        tabIndex={-1}
                                        className="psl__frame-trash"
                                        title="Move to Trash"
                                        aria-label="Move to Trash"
                                        onClick={(e) => trashCapture(c.id, e)}
                                      >
                                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                          <path d="M3 7h18M8 7V4h8v3M6 7l1 14h10l1-14" />
                                        </svg>
                                      </span>
                                    ))}
                                </button>
                              );
                            })}
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

      {/* Detail rail. Renders null in grid mode (Phase B); shows
          metadata + Codex caption + L/M/H copy row + action row in
          focus + reel modes. Lives in the third grid column
          (`grid-template-columns: 220px 1fr 360px` when
          data-mode is focus/reel, collapsed to 0 in grid mode). */}
      <DetailRail view={view} record={selectedRecord} />

      <footer className="psl__status">
        <div className="psl__status-l">
          <span>
            <span className="a">●</span> 3.2 GB local
          </span>
          <span>
            Codex auto-tag <b>on</b>
          </span>
        </div>
        <div className="psl__status-r">
          <span>⌘⇧P new · ⌘L library</span>
          <span>
            <b>v0.0.1</b>
          </span>
        </div>
      </footer>
    </div>
  );
}

