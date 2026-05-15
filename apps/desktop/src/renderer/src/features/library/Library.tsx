import type { MouseEvent as ReactMouseEvent } from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState
} from "react";
import type {
  CaptureRecord,
  LibraryCursor,
  PwrSnapError,
  Res,
  Result,
  ScrollProbeRequest
} from "@pwrsnap/shared";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { AppIcon, AppTag } from "../shared/AppIcons";
import { PwrSnapMark, PwrSnapWordmark } from "../shared/BrandMark";
import type { Tool } from "../editor/Editor";
import { FixtureBackedRecords, mapBundleIdToAppId } from "./adapter";
import type { Capture } from "./captures";
import { APP_INFO, groupByDay } from "./captures";
import { DetailRail } from "./DetailRail";
import { initialLibraryView, libraryReducer } from "./library-view";
import { Stage } from "./Stage";
import { cacheUrl, captureSrcUrl, dispatch, perfMark, subscribe } from "../../lib/pwrsnap";
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
 * Derive a display label from a bundle id when no curated name is
 * registered (`com.pwrsnap.synth.air-table` → "Air Table"). Takes the
 * last dotted segment, splits on hyphens, and Title-Cases each word.
 */
function labelFromBundleId(bundleId: string): string {
  const tail = bundleId.split(".").pop() ?? bundleId;
  return tail
    .split(/[-_]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
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

type SourceAppRowsState = {
  bundleKey: string;
  loading: boolean;
  rows: CaptureRecord[];
  error: string | null;
};

export function Library({ initialSelected = 1 }: { initialSelected?: number }) {
  const [selected, setSelected] = useState(initialSelected);
  const [activeApp, setActiveApp] = useState<string>("all");
  const [sourceAppRows, setSourceAppRows] = useState<Record<string, SourceAppRowsState>>(
    {}
  );
  const sourceAppRowsRef = useRef(sourceAppRows);
  useEffect(() => {
    sourceAppRowsRef.current = sourceAppRows;
  }, [sourceAppRows]);

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

  const {
    rows: records,
    error,
    hasMore,
    isLoadingMore,
    loadMore,
    totalLive,
    appStats
  } = useLibrary();

  // Phase 5 perf instrumentation. Fires once per Library mount when
  // the grid commits its first row of real data — the seeder reads
  // these marks to compute cold-load latency. Skipped in dev when
  // Library mounts with empty records (the dispatch arrives later).
  const firstPaintFired = useRef(false);
  useLayoutEffect(() => {
    if (firstPaintFired.current) return;
    if (records.length === 0) return;
    firstPaintFired.current = true;
    perfMark({
      kind: "library:firstPaint",
      rowsRendered: records.length,
      timeOriginMs: performance.timeOrigin
    });
  }, [records.length]);

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

  // Partition records into live + trash. useLibrary fetches with
  // `includeDeleted: true`, so the keyset-paginated snapshot contains
  // both; we partition here so the Trash sidebar entry swaps the
  // active universe without a second fetch.
  const liveRecords = useMemo(
    () => records.filter((r) => r.deleted_at === null),
    [records]
  );
  const trashRecords = useMemo(
    () => records.filter((r) => r.deleted_at !== null),
    [records]
  );

  const isTodayView = activeApp === "today";
  const isSourceAppView = activeApp !== "all" && activeApp !== "trash" && !isTodayView;
  const sourceAppBundleIds = useMemo<Array<string | null>>(() => {
    if (!isSourceAppView) return [];
    const bundles: Array<string | null> = [];
    for (const stat of appStats) {
      if (mapBundleIdToAppId(stat.bundleId) === activeApp) {
        bundles.push(stat.bundleId);
      }
    }
    return bundles;
  }, [activeApp, appStats, isSourceAppView]);
  const sourceAppBundleKey = useMemo(() => {
    const sourceAppBundleCounts = sourceAppBundleIds.map((bundleId) => {
      const stat = appStats.find((candidate) => candidate.bundleId === bundleId);
      return [bundleId, stat?.count ?? 0] as const;
    });
    return JSON.stringify(sourceAppBundleCounts);
  }, [appStats, sourceAppBundleIds]);

  useEffect(() => {
    if (!isSourceAppView) return;
    if (sourceAppBundleIds.length === 0) return;
    const cached = sourceAppRowsRef.current[activeApp];
    if (cached?.bundleKey === sourceAppBundleKey) return;

    let cancelled = false;
    const appKey = activeApp;
    const bundleIds = sourceAppBundleIds;
    const bundleKey = sourceAppBundleKey;
    setSourceAppRows((prev) => ({
      ...prev,
      [appKey]: {
        bundleKey,
        loading: true,
        rows: prev[appKey]?.rows ?? [],
        error: null
      }
    }));

    void (async () => {
      const fetched: CaptureRecord[] = [];
      let cursor: LibraryCursor | null = null;
      do {
        const bundleFilter =
          bundleIds.length === 1 && bundleIds[0] !== null
            ? { appBundleId: bundleIds[0] }
            : { appBundleIds: bundleIds };
        const result: Result<Res<"library:list">, PwrSnapError> = await dispatch("library:list", {
          limit: 200,
          includeDeleted: false,
          ...bundleFilter,
          ...(cursor === null ? {} : { cursor })
        });
        if (cancelled) return;
        if (!result.ok) {
          setSourceAppRows((prev) => ({
            ...prev,
            [appKey]: {
              bundleKey,
              loading: false,
              rows: prev[appKey]?.rows ?? [],
              error: result.error.message
            }
          }));
          return;
        }
        fetched.push(...result.value.rows);
        cursor = result.value.nextCursor;
      } while (cursor !== null);

      const seen = new Set<string>();
      const unique = fetched.filter((row) => {
        if (seen.has(row.id)) return false;
        seen.add(row.id);
        return true;
      });
      setSourceAppRows((prev) => ({
        ...prev,
        [appKey]: {
          bundleKey,
          loading: false,
          rows: unique,
          error: null
        }
      }));
    })();

    return () => {
      cancelled = true;
    };
  }, [
    activeApp,
    isSourceAppView,
    sourceAppBundleIds,
    sourceAppBundleKey
  ]);

  // Universe of records the current view operates on. Trash is a
  // top-level swap (not a per-app filter) so the per-app filter only
  // applies when viewing live captures.
  const isTrashView = activeApp === "trash";
  const sourceAppState = isSourceAppView ? sourceAppRows[activeApp] : undefined;
  const universeRecords = isTrashView
    ? trashRecords
    : sourceAppState?.bundleKey === sourceAppBundleKey
    ? sourceAppState.rows
    : liveRecords;
  const gridHasMore = isSourceAppView ? false : hasMore;
  const gridIsLoadingMore = isSourceAppView ? sourceAppState?.loading ?? false : isLoadingMore;

  const fixtureBacking = useMemo(
    () => new FixtureBackedRecords(universeRecords),
    // todayDateStr drives the day-bucket inside FixtureBackedRecords;
    // including it forces a rebuild when the local date crosses so the
    // grid's day-hdrs ("Today" / "Yesterday") update without a refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [universeRecords, todayDateStr]
  );
  const fixtureCaptures = useMemo(() => fixtureBacking.fixtures(), [fixtureBacking]);

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
  // Per-app counts come from the denormalized `app_stats` table via
  // useLibrary's head-page response — stable on first paint, doesn't
  // climb as keyset pages stream in. Multiple bundle ids can map to
  // the same fixture app key (e.g. `com.tinyspeck.slackmacgap` and
  // `slack` both fold into `slack`), so we aggregate after mapping.
  const appCounts = useMemo<Record<string, number>>(() => {
    const counts: Record<string, number> = {};
    for (const stat of appStats) {
      const appId = mapBundleIdToAppId(stat.bundleId);
      counts[appId] = (counts[appId] ?? 0) + stat.count;
    }
    return counts;
  }, [appStats]);

  // "Today" sidebar count — live records whose adapter-bucket landed
  // in the Today bucket (see adapter.ts:dayBucket). Live-only because
  // soft-deleted captures don't show up in the Today filter.
  const todayCount = useMemo(
    () => liveFixturesForCounts.filter((c) => c.day === "Today").length,
    [liveFixturesForCounts]
  );

  // Display name per app key. Like appCounts, derived from app_stats
  // so the sidebar is stable on first paint instead of filling in as
  // records stream. For each bundle id:
  //   1. Curated short id wins (so com.tinyspeck.slackmacgap → "Slack").
  //   2. Otherwise, derive a Title-Case label from the bundle id's
  //      tail segment (so com.pwrsnap.synth.air-table → "Air Table").
  //   3. Loaded records refine the label when an OS-supplied
  //      `source_app_name` is available — that takes precedence.
  const appLabels = useMemo<Record<string, string>>(() => {
    const labels: Record<string, string> = {};
    // Pass 1: derive from app_stats bundle ids alone (stable on load).
    for (const stat of appStats) {
      const appId = mapBundleIdToAppId(stat.bundleId);
      if (labels[appId] !== undefined) continue;
      const curated = APP_INFO[appId]?.name;
      if (curated !== undefined) {
        labels[appId] = curated;
      } else if (stat.bundleId !== null) {
        labels[appId] = labelFromBundleId(stat.bundleId);
      } else {
        labels[appId] = "Unknown app";
      }
    }
    // Pass 2: refine with OS-supplied `source_app_name` once records
    // stream in (real captures pick up nicer names than slug-derived).
    for (const c of liveFixturesForCounts) {
      if (APP_INFO[c.app]?.name !== undefined) continue; // curated already picked
      if (c.appName === null) continue;
      labels[c.app] = c.appName;
    }
    return labels;
  }, [appStats, liveFixturesForCounts]);

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
    return (
      universeRecords.find((r) => r.id === selectedRecordId) ??
      records.find((r) => r.id === selectedRecordId) ??
      null
    );
  }, [records, selectedRecordId, universeRecords]);

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
  //   • Stack-semantics restore on Focus → Grid (see
  //     `gridReturnScrollTopRef` below).
  const gridScrollRef = useRef<HTMLDivElement | null>(null);

  // Saved scrollTop captured the moment Focus opens. Restored on
  // Focus → Grid via the useLayoutEffect below.
  //
  // Why this can't ride on the browser's `display: none` preservation:
  // Chromium *does* normally restore scrollTop when an element
  // un-display:none's, BUT only if the element's scrollHeight is
  // still ≥ the saved scrollTop at restore time. Our virtualizer's
  // total height is computed from `flatRows.length × estimateSize`,
  // and during the focus-open round-trip several state changes (the
  // ResizeObserver firing on display:none with width=0, the
  // virtualizer's measureElement readings on now-hidden rows, the
  // measure-cache reset that some code paths trigger) can transiently
  // shrink the reported scrollHeight to a value below the saved
  // scrollTop. The browser then clamps scrollTop to 0 and there's no
  // signal we can listen for after the fact. Saving + restoring
  // explicitly is robust to all of those quirks: we own the value, we
  // know exactly when to put it back, and we don't depend on
  // virtualizer-internal timing.
  const gridReturnScrollTopRef = useRef<number>(0);

  // Scroll probe — Phase 5 of the perf plan. Subscribes to the
  // main-side trigger and runs a RAF dropped-frame counter while
  // programmatically scrolling the grid container at fixed velocity.
  // Result posts back via perfMark; the seeder's runScrollProbes
  // awaits it on the perfMark channel and writes a JSONL row.
  //
  // Idempotent: a probe arriving while another is already running
  // posts back an `already_running` error rather than starting a
  // second loop.
  const scrollProbeRunningRef = useRef(false);
  useEffect(() => {
    return subscribe(EVENT_CHANNELS.perfScrollProbeRequest, (rawPayload) => {
      const payload = rawPayload as ScrollProbeRequest;
      if (scrollProbeRunningRef.current) {
        perfMark({ kind: "perf:scrollProbe:error", reason: "already_running" });
        return;
      }
      const el = gridScrollRef.current;
      if (el === null) {
        perfMark({ kind: "perf:scrollProbe:error", reason: "no_scroll_container" });
        return;
      }
      scrollProbeRunningRef.current = true;
      const start = performance.now();
      const deadline = start + payload.durationMs;
      const startScrollTop = el.scrollTop;
      const frameDeltas: number[] = [];
      // 60Hz target frame budget = 1000/60 ≈ 16.67ms. Treat anything
      // longer than 1.5× that as a dropped frame.
      const dropThresholdMs = 1.5 * (1000 / 60);
      let lastTs = start;
      let droppedFrames = 0;

      const tick = (now: number): void => {
        const delta = now - lastTs;
        lastTs = now;
        // Skip the first delta — it's measured from probe-start to
        // the first RAF callback, which is uninformative.
        if (frameDeltas.length > 0 || now > start + 16) {
          frameDeltas.push(delta);
          if (delta > dropThresholdMs) droppedFrames += 1;
        } else {
          frameDeltas.push(delta);
        }

        // Advance the scroll position. When we hit the bottom, snap
        // back to start so the probe keeps measuring scroll-driven
        // layout work for the full duration.
        const next = el.scrollTop + payload.pxPerFrame;
        const max = el.scrollHeight - el.clientHeight;
        el.scrollTop = next > max ? startScrollTop : next;

        if (now < deadline) {
          window.requestAnimationFrame(tick);
        } else {
          scrollProbeRunningRef.current = false;
          // Drop the warm-up frame for stats (its delta is the
          // probe-start → first-RAF gap, not a real frame interval).
          const stats = frameDeltas.slice(1);
          stats.sort((a, b) => a - b);
          const p95 = stats.length === 0
            ? 0
            : (stats[Math.min(stats.length - 1, Math.floor(0.95 * stats.length))] ?? 0);
          perfMark({
            kind: "perf:scrollProbe:result",
            durationMs: now - start,
            frames: stats.length,
            droppedFrames,
            droppedPct: stats.length === 0 ? 0 : droppedFrames / stats.length,
            p95FrameMs: p95
          });
        }
      };
      window.requestAnimationFrame(tick);
    });
  }, []);

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
  // Also dispatches `loadMore` when the user scrolls within
  // REEL_LOADMORE_THRESHOLD_PX of the right edge — without this,
  // the filmstrip stops at whatever keyset page boundary has been
  // loaded (~800 captures with default 100/page × 8 fetches), and
  // the reel appears truncated to that horizon. Mirrors the grid
  // virtualizer's loadMore-on-near-tail trigger.
  //
  // Passive listener — we never preventDefault, so passive avoids
  // the per-frame compositor warning.
  useEffect(() => {
    if (view.kind !== "reel") return;
    const el = reelScrollerRef.current;
    if (el === null) return;
    const onScroll = (): void => {
      reelScrollLeftRef.current = el.scrollLeft;
      if (!hasMore || isLoadingMore) return;
      const remaining = el.scrollWidth - (el.scrollLeft + el.clientWidth);
      if (remaining < REEL_LOADMORE_THRESHOLD_PX) {
        void loadMore();
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [view.kind, hasMore, isLoadingMore, loadMore]);

  // Initial reel mount: if the filmstrip's content fits within the
  // viewport (so there's no scroll to trigger loadMore), but more
  // pages exist, fetch them up-front. Also re-checks after each
  // page lands so a fast loader walks all the way to the dataset
  // tail (or the user toggles away). Without this, a small initial
  // viewport on a large dataset never triggers the scroll path.
  useEffect(() => {
    if (view.kind !== "reel") return;
    const el = reelScrollerRef.current;
    if (el === null) return;
    if (!hasMore || isLoadingMore) return;
    if (el.scrollWidth <= el.clientWidth + REEL_LOADMORE_THRESHOLD_PX) {
      void loadMore();
    }
  }, [view.kind, hasMore, isLoadingMore, loadMore, records.length]);

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
    viewDispatch({ type: "FILTER_CHANGED", visibleIds: universeRecords.map((r) => r.id) });
  }, [selectedRecordId, selectedRecord, universeRecords]);

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
    const savedScrollTop = gridScrollRef.current?.scrollTop ?? 0;
    gridReturnScrollTopRef.current = savedScrollTop;
    viewDispatch({
      type: "OPEN_FOCUS",
      recordId: record.id,
      returnAnchor: {
        scrollTop: savedScrollTop,
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
    const savedScrollTop = gridScrollRef.current?.scrollTop ?? 0;
    gridReturnScrollTopRef.current = savedScrollTop;
    viewDispatch({
      type: "OPEN_FOCUS",
      recordId: record.id,
      returnAnchor: {
        scrollTop: savedScrollTop,
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

    // Stack semantics: restore the grid's scrollTop to where it was
    // when Focus opened. We can't rely on Chromium's display:none
    // scrollTop preservation here — at the moment .psl__grid-wrap
    // un-display:none's, several layout-driven scroll adjustments
    // converge in the next frame:
    //   • the virtualizer's measureElement passes re-fire as cells
    //     are forced back into layout
    //   • content-visibility:auto cells flip from intrinsic-size to
    //     measured size, shifting their parent rows by ~20px each
    //   • the browser's first scroll listener post-display:block
    //     re-syncs the virtualizer's scrollOffset cache
    // Empirically this drifts scrollTop by ~1500-2000px within the
    // first 2-3 frames. Even `overflow-anchor: none` on the wrap
    // and `shouldAdjustScrollPositionOnItemSizeChange: () => false`
    // on the virtualizer don't cover all of it — the residual
    // drift is layout-driven inside Chromium and there's no API
    // surface that prevents it.
    //
    // Cheapest robust answer: re-stamp scrollTop across the first
    // few rAFs. Each write is idempotent (no-op when scrollTop is
    // already savedTop), and 6 frames is more than enough for the
    // settle to complete in dev + production builds. The writes
    // stop after frame 6 regardless.
    const wrap = gridScrollRef.current;
    const savedTop = gridReturnScrollTopRef.current;
    if (wrap !== null && savedTop > 0) {
      wrap.scrollTop = savedTop;
      let frame = 0;
      const restamp = (): void => {
        const el = gridScrollRef.current;
        if (el === null) return;
        if (el.scrollTop !== savedTop) {
          el.scrollTop = savedTop;
        }
        frame += 1;
        if (frame < 6) {
          requestAnimationFrame(restamp);
        }
      };
      requestAnimationFrame(restamp);
    }

    // Cell-pulse highlight: querySelector runs against the now-
    // visible grid; if the cell is in the rendered range (very
    // likely, since it's where the user was looking when they
    // clicked), the animation plays.
    const cell = wrap?.querySelector<HTMLElement>(
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
              : `${totalLive} captures`}
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
          <span className="psl__nav-count">{totalLive}</span>
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
          <VirtualizedGrid
            grouped={grouped}
            scrollElement={gridScrollRef}
            selected={selected}
            fixtureBacking={fixtureBacking}
            appLabels={appLabels}
            onSelectCell={onSelectCell}
            preloadFullRes={preloadFullRes}
            hasMore={gridHasMore}
            isLoadingMore={gridIsLoadingMore}
            loadMore={loadMore}
            isTrashView={isTrashView}
            trashCapture={trashCapture}
            restoreCaptureAction={restoreCaptureAction}
            purgeCaptureAction={purgeCaptureAction}
          />
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
                            {g.date.length > 0 ? `${g.day} · ${g.date}` : g.day}
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

// ── Virtualized day-grouped grid (row-level) ─────────────────────
//
// Row-level virtualization: each virtual item is either a day-section
// header OR a single grid-row of cellsPerRow cells. DOM cell count is
// bounded by `(visibleRows + overscan) × cellsPerRow` regardless of
// how many captures live in any single day.
//
// We tried day-level virtualization first (one virtual item per
// day-group). At 10k captures with maxPerDay=200, a single heavy day
// entering the overscan would mount 200 cells at once, and the
// renderer choked on layout work even with content-visibility:auto.
// Row-level virt caps the per-frame mount count regardless of day
// shape.
//
// `cellsPerRow` is computed from container width via ResizeObserver
// — matches the original CSS `repeat(auto-fill, minmax(180px, 1fr))`
// behavior. The flat row list rebuilds when cellsPerRow changes.
//
// `measureElement` corrects estimateSize after first render so the
// scrollbar tracks correctly.

const HEADER_ESTIMATE_PX = 60;
const CELL_ROW_ESTIMATE_PX = 280; // one row of cells (cell aspect 16:10 + meta)
const CELL_MIN_WIDTH = 180; // matches CSS minmax(180px, 1fr)
const CELL_GAP = 12;
const CELL_GAP_DAY_END = 18; // .psl__grid padding-bottom in the original single-grid layout
const GRID_HORIZONTAL_PADDING = 18;
/** Horizontal pixels from the reel's right edge at which to fire
 *  `loadMore`. ~3 viewport-widths of frames at typical filmstrip
 *  scroll speeds buys enough lead time for the next keyset page to
 *  land before the user runs out of frames. */
const REEL_LOADMORE_THRESHOLD_PX = 3000;

type DayGroup = ReturnType<typeof groupByDay>[number];

type CellAction = (captureId: number, event: ReactMouseEvent) => void;

type LibraryRow =
  | { kind: "header"; day: string; date: string; count: number }
  | {
      kind: "cells";
      cells: DayGroup["items"];
      /** True when this is the last cell-row of its day-group. The
       *  renderer adds extra padding-bottom on these so the visual gap
       *  to the next day-header matches the original single-grid
       *  layout (12px between rows in same day, 18px after last row
       *  of day). Without this distinction, days look 6px tighter. */
      isLastInDay: boolean;
    };

type VirtualizedGridProps = {
  grouped: DayGroup[];
  scrollElement: React.RefObject<HTMLDivElement | null>;
  selected: number;
  fixtureBacking: FixtureBackedRecords;
  appLabels: Record<string, string>;
  onSelectCell: (c: Capture) => void;
  preloadFullRes: (record: CaptureRecord | null) => void;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => Promise<void>;
  isTrashView: boolean;
  trashCapture: CellAction;
  restoreCaptureAction: CellAction;
  purgeCaptureAction: CellAction;
};

/** Compute how many cells fit per row at the current container width.
 *  Defaults to 4 if the container hasn't measured yet.
 *
 *  Stickiness on display:none — when the grid is hidden during focus
 *  mode (`.psl[data-mode="focus"] .psl__grid-wrap { display: none }`),
 *  ResizeObserver fires with `clientWidth = 0` and naive math drops
 *  cellsPerRow to 1. flatRows then re-flattens to 10k cell-rows
 *  (one per cell), the virtualizer relayouts everything, and on
 *  focus close the user lands at a wildly different scroll position.
 *  Stack semantics — opening/closing focus shouldn't reflow the
 *  grid at all. Treat zero-width measurements as "no information"
 *  and keep the last computed value. */
function useCellsPerRow(scrollElement: React.RefObject<HTMLDivElement | null>): number {
  const [cellsPerRow, setCellsPerRow] = useState(4);
  useLayoutEffect(() => {
    const el = scrollElement.current;
    if (el === null) return;
    const compute = (): void => {
      const width = el.clientWidth;
      // Skip zero-width measurements (the grid is display:none).
      // The previous cellsPerRow stays in effect, so flatRows + the
      // virtualizer's offset cache don't churn while the user is in
      // focus mode.
      if (width <= 0) return;
      const inner = width - 2 * GRID_HORIZONTAL_PADDING;
      const next = Math.max(1, Math.floor((inner + CELL_GAP) / (CELL_MIN_WIDTH + CELL_GAP)));
      setCellsPerRow((prev) => (prev === next ? prev : next));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollElement]);
  return cellsPerRow;
}

function VirtualizedGrid({
  grouped,
  scrollElement,
  selected,
  fixtureBacking,
  appLabels,
  onSelectCell,
  preloadFullRes,
  hasMore,
  isLoadingMore,
  loadMore,
  isTrashView,
  trashCapture,
  restoreCaptureAction,
  purgeCaptureAction
}: VirtualizedGridProps) {
  const cellsPerRow = useCellsPerRow(scrollElement);

  // Flatten day-groups → 1-D row list. Each header gets one row;
  // each day's items are sliced into rows of cellsPerRow. Memoized
  // on (grouped, cellsPerRow); pure scroll doesn't recompute.
  // Track header indexes too so the sticky-header rangeExtractor
  // can pin the active header without re-walking flatRows on every
  // scroll event.
  const { flatRows, headerIndexes } = useMemo<{
    flatRows: LibraryRow[];
    headerIndexes: number[];
  }>(() => {
    const rows: LibraryRow[] = [];
    const headers: number[] = [];
    for (const g of grouped) {
      headers.push(rows.length);
      rows.push({ kind: "header", day: g.day, date: g.date, count: g.items.length });
      const cellRowCount = Math.ceil(g.items.length / cellsPerRow);
      for (let i = 0, k = 0; i < g.items.length; i += cellsPerRow, k++) {
        rows.push({
          kind: "cells",
          cells: g.items.slice(i, i + cellsPerRow),
          isLastInDay: k === cellRowCount - 1
        });
      }
    }
    return { flatRows: rows, headerIndexes: headers };
  }, [grouped, cellsPerRow]);

  // Sticky-header bookkeeping. The active sticky index = the topmost
  // header whose flat index is at or above the current scroll-window
  // start. We render the active one with `position: sticky; top: 0`
  // and ALL other items normally (absolute-positioned via translateY).
  // The rangeExtractor pins the active header into the rendered set
  // even when its natural position is scrolled above the viewport —
  // canonical TanStack Virtual sticky pattern, see the library's
  // sticky example. Without this, scrolling past the day boundary
  // would unmount the header and the sticky behavior would vanish.
  const activeStickyIndexRef = useRef(0);
  const isSticky = useCallback(
    (index: number) => headerIndexes.includes(index),
    [headerIndexes]
  );
  const isActiveSticky = useCallback(
    (index: number) => activeStickyIndexRef.current === index,
    []
  );
  const rangeExtractor = useCallback(
    (range: Range) => {
      // Find the topmost header that's at or above the scroll-window
      // start. Iterate descending so the first match is the topmost
      // one already-passed.
      const active =
        [...headerIndexes].reverse().find((idx) => range.startIndex >= idx) ?? 0;
      activeStickyIndexRef.current = active;
      // Always include the active sticky in the rendered range so it
      // stays in DOM and can paint via `position: sticky`.
      const next = new Set([active, ...defaultRangeExtractor(range)]);
      return [...next].sort((a, b) => a - b);
    },
    [headerIndexes]
  );

  const virtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => scrollElement.current,
    estimateSize: (i) =>
      flatRows[i]?.kind === "header" ? HEADER_ESTIMATE_PX : CELL_ROW_ESTIMATE_PX,
    overscan: 5,
    rangeExtractor
    // NOTE: do NOT set `useScrollendEvent: true`. That opts into the
    // browser's `scrollend` event, which fires only when scroll stops
    // — so `rangeExtractor` doesn't update the active sticky header
    // during scroll. Result: as the user scrolls through multiple
    // day-sections, the previous section's header un-mounts (it's
    // outside the rendered range) and the new section's header is
    // never marked active, so no CSS-sticky pinning happens until
    // scroll stops. Visible symptom: sticky headers vanish during
    // scroll. Default (scroll event, fires per frame) keeps the
    // active-sticky calculation in lockstep with browser scroll.
  });
  // Disable TanStack's auto-adjust-scrollOffset-on-measureElement
  // logic. By default, when measureElement reports an item-size delta
  // for a row above the current scrollOffset, the virtualizer self-
  // scrolls scrollTop by the delta to "keep visual position stable."
  // Correct for streams of variable-height items mid-scroll, but
  // contributes to the Focus → Grid scrollTop drift fixed by the
  // rAF re-stamp loop in the focus-pulse useLayoutEffect. Set after
  // construction because this is a class property on the Virtualizer
  // instance (not a constructor option in the TS surface).
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;


  // Infinite-scroll boundary: when the last visible virtual row is
  // within K rows of the loaded tail, dispatch loadMore(). K=10 is
  // generous enough that the next page lands before the user runs
  // out of rendered rows.
  const items = virtualizer.getVirtualItems();
  const lastItem = items[items.length - 1];
  useEffect(() => {
    if (!hasMore || isLoadingMore) return;
    if (lastItem === undefined) return;
    if (lastItem.index >= flatRows.length - 10) {
      void loadMore();
    }
  }, [lastItem, flatRows.length, hasMore, isLoadingMore, loadMore]);

  // Grid template — exactly cellsPerRow columns. Used by every
  // cell-row virtual item. Reused via inline style so all rows in a
  // resize tick render with the same template (no flicker).
  const gridTemplate = `repeat(${cellsPerRow}, 1fr)`;

  return (
    <div
      style={{
        height: `${virtualizer.getTotalSize()}px`,
        width: "100%",
        position: "relative"
      }}
    >
      {items.map((vi) => {
        const row = flatRows[vi.index];
        if (row === undefined) return null;
        // Sticky pinning: the active sticky index uses
        // `position: sticky` instead of absolute, so the browser
        // pins it at the top of the scroll viewport as the user
        // scrolls past its natural position. All other items
        // (including non-active headers further down) use the
        // standard absolute-positioned virtualizer translation.
        const sticky = isSticky(vi.index);
        const activeSticky = sticky && isActiveSticky(vi.index);
        const positionStyle: React.CSSProperties = activeSticky
          ? {
              position: "sticky",
              top: 0,
              zIndex: 2
            }
          : {
              position: "absolute",
              top: 0,
              transform: `translateY(${vi.start}px)`
            };
        return (
          <div
            key={vi.key}
            data-index={vi.index}
            // measureElement only on non-sticky rows: TanStack's
            // measureElement reads getBoundingClientRect, but a
            // sticky-pinned element's rect reports the pinned
            // position, not its natural offset. Letting it measure
            // would corrupt the offset cache and the row would jump.
            // Sticky rows keep their estimateSize until the user
            // scrolls past them and they unstick.
            ref={activeSticky ? undefined : virtualizer.measureElement}
            style={{
              ...positionStyle,
              left: 0,
              width: "100%"
            }}
          >
            {row.kind === "header" ? (
              <div className="psl__day-hdr">
                <span className="psl__day-hdr-label">{row.day}</span>
                <span className="psl__day-hdr-meta">
                  {row.date.length > 0 ? `${row.date} · ` : ""}
                  {row.count} captures
                </span>
                <span className="psl__day-hdr-line" />
              </div>
            ) : (
              <CellRow
                cells={row.cells}
                gridTemplate={gridTemplate}
                isLastInDay={row.isLastInDay}
                selected={selected}
                fixtureBacking={fixtureBacking}
                appLabels={appLabels}
                onSelectCell={onSelectCell}
                preloadFullRes={preloadFullRes}
                isTrashView={isTrashView}
                trashCapture={trashCapture}
                restoreCaptureAction={restoreCaptureAction}
                purgeCaptureAction={purgeCaptureAction}
              />
            )}
          </div>
        );
      })}
      {isLoadingMore && (
        <div
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            padding: "12px 18px",
            opacity: 0.6,
            fontSize: 12
          }}
        >
          Loading more…
        </div>
      )}
    </div>
  );
}

function CellRow({
  cells,
  gridTemplate,
  isLastInDay,
  selected,
  fixtureBacking,
  appLabels,
  onSelectCell,
  preloadFullRes,
  isTrashView,
  trashCapture,
  restoreCaptureAction,
  purgeCaptureAction
}: {
  cells: DayGroup["items"];
  gridTemplate: string;
  isLastInDay: boolean;
  selected: number;
  fixtureBacking: FixtureBackedRecords;
  appLabels: Record<string, string>;
  onSelectCell: (c: Capture) => void;
  preloadFullRes: (record: CaptureRecord | null) => void;
  isTrashView: boolean;
  trashCapture: CellAction;
  restoreCaptureAction: CellAction;
  purgeCaptureAction: CellAction;
}) {
  // Inline grid styling — `.psl__grid` from the CSS uses auto-fill;
  // we override with explicit columns matching the computed
  // cellsPerRow so every virtualized row has the same column count
  // and the visual matches the prior layout.
  //
  // Padding-bottom matches the original single-grid behavior:
  //   • Within a day (rows 1..N-1):  CELL_GAP (12px) between rows
  //   • Last row of a day:           CELL_GAP_DAY_END (18px) so the
  //     gap to the next day-header matches what the original single
  //     `.psl__grid` produced via its 18px `padding-bottom`.
  // Without the special-case, days were ~6px tighter than the
  // original layout.
  return (
    <div
      className="psl__grid"
      style={{
        gridTemplateColumns: gridTemplate,
        paddingBottom: isLastInDay ? CELL_GAP_DAY_END : CELL_GAP,
        paddingTop: 0
      }}
    >
      {cells.map((c) => {
        const record = fixtureBacking.recordFor(c.id);
        return (
          <div
            key={c.id}
            className={"psl__cell" + (c.id === selected ? " is-selected" : "")}
            data-cell-id={record?.id ?? ""}
            onClick={() => onSelectCell(c)}
            onMouseEnter={() => preloadFullRes(record ?? null)}
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
                <AppTag app={c.app} name={appLabels[c.app] ?? "Unknown app"} size="sm" />
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
  );
}
