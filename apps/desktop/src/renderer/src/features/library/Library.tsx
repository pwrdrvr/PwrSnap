import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import type {
  CaptureRecord,
  CaptureSearchResultRow,
  LibraryCursor,
  LibrarySidebarTab,
  PwrSnapError,
  Res,
  Result,
  ScrollProbeRequest,
  Settings,
  AcpAgentDiscovery,
  DesktopCodexDiscoverySnapshot
} from "@pwrsnap/shared";
import {
  EVENT_CHANNELS,
  resolveSizzleProjectCoverCaptureId,
  type SettingsChangedEvent,
  type SizzleProject
} from "@pwrsnap/shared";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { AppIcon, AppTag } from "../shared/AppIcons";
import { PwrSnapMark, PwrSnapWordmark } from "../shared/BrandMark";
import type { CopyPreset } from "../shared/CopyButton";
import type { Tool } from "../editor/editor-tools";
import { useEditorToolState } from "../editor/useEditorToolState";
import { DEFAULT_BLUR_STYLE, type BlurStyle } from "@pwrsnap/shared";
import { FixtureBackedRecords, mapBundleIdToAppId } from "./adapter";
import type { Capture } from "./captures";
import { APP_INFO, groupByDay } from "./captures";
import { DetailRail } from "./DetailRail";
import { resolveLibraryAiToggleAction } from "./library-ai-toggle";
import { mergeOpenedLiveRecords } from "./library-records";
import { initialLibraryView, libraryReducer, type LibraryAction, type LibraryView } from "./library-view";
import { Stage } from "./Stage";
import {
  cacheUrl,
  captureSrcUrl,
  dispatch,
  perfMark,
  sizzleOutputUrl,
  subscribe
} from "../../lib/pwrsnap";
import { useSizzleProjects } from "../../lib/useSizzleProjects";
import { useCart, useCartIsEmpty } from "./CartContext";
import { CartPanel } from "./CartPanel";
import { formatBytes } from "../../lib/format-bytes";
import { useLibrary } from "../../lib/useLibrary";
import { useStorageSnapshot } from "../../lib/useStorageSnapshot";
import { useHotkeys } from "../shared/useHotkeys";
import { LayoutToggleButtons } from "../shared/LayoutToggleButtons";
import "../shared/LayoutToggleButtons.css";
import { acceleratorToDisplayKeys } from "../../lib/format-hotkey";
import { AiConsentDialog } from "../shared/AiConsentDialog";
import { enrichmentBackendLabel } from "../shared/CodexStatusPill";
import { isEnrichmentProviderAvailable } from "../shared/enrichment-provider-availability";
// Thumb (synthetic per-app gradient) is the fallback for the empty
// state and for fixture rows in dev. Real captures render via
// <img src="pwrsnap-cache://"> through CellThumb below.
import { Thumb } from "./Thumb";

function codexAvailableInSnapshot(snapshot: DesktopCodexDiscoverySnapshot): boolean {
  if (snapshot.resolvedPath === null) return false;
  if (snapshot.auth?.status !== "authenticated") return false;
  return snapshot.candidates.some(
    (candidate) => candidate.available && candidate.path === snapshot.resolvedPath
  );
}

function copyPresetForShortcutKey(key: string): CopyPreset | null {
  if (key === "1") return "low";
  if (key === "2") return "med";
  if (key === "3") return "high";
  return null;
}

function sizzleProjectMatchesQuery(project: SizzleProject, query: string): boolean {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
  if (terms.length === 0) return true;
  const haystack = [
    project.name,
    project.createdAt,
    project.modifiedAt,
    ...project.scenes.flatMap((scene) => [
      scene.scriptLine,
      scene.kind === "sequence" ? scene.narration ?? "" : ""
    ])
  ]
    .join(" ")
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

type ProjectContextMenuState = {
  projectId: string;
  projectName: string;
  x: number;
  y: number;
};

const PROJECT_CONTEXT_MENU_WIDTH = 188;
const PROJECT_CONTEXT_MENU_HEIGHT = 70;

function clampContextMenuPosition(
  x: number,
  y: number,
  width: number,
  height: number
): { x: number; y: number } {
  return {
    x: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
    y: Math.max(8, Math.min(y, window.innerHeight - height - 8))
  };
}

const INITIAL_COPY_PULSES: Record<CopyPreset, number> = {
  low: 0,
  med: 0,
  high: 0
};

/**
 * Picks the right thumb representation: real cache-rendered image
 * when we have a record, synthetic per-app gradient otherwise. The
 * cache URL goes through main's protocol handler → render pipeline,
 * so the very first read of a freshly-captured snap composes its
 * 240w.webp on demand and caches it.
 */
/**
 * Per-cell cart checkbox. Self-subscribes to the cart via context so a
 * cart toggle re-renders ONLY the checkboxes, not the enclosing cells
 * (thumbnail, app tag, etc.) or the whole virtualized grid. Dispatches
 * `cart:toggle` directly. The hover-reveal + the collected-cell accent
 * ring are pure CSS (`.psl__cell:hover .psl__cell-cart`,
 * `.psl__cell:has(.psl__cell-cart.is-checked)`).
 */
function CartCellCheckbox({ captureId }: { captureId: string }): React.ReactElement {
  const cart = useCart();
  const inCart = cart.captureIds.includes(captureId);
  return (
    <button
      type="button"
      className={"psl__cell-cart" + (inCart ? " is-checked" : "")}
      role="checkbox"
      aria-checked={inCart}
      aria-label={inCart ? "Remove from project draft" : "Add to project draft"}
      title={inCart ? "Remove from project draft" : "Add to project draft"}
      onClick={(e) => {
        // Stop propagation so checking doesn't also fire the cell's
        // onSelectCell (which would open the capture in Focus mode).
        e.stopPropagation();
        void dispatch("cart:toggle", { captureId });
      }}
    >
      {inCart ? (
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="m5 12 5 5 9-11" />
        </svg>
      ) : null}
    </button>
  );
}

function CellThumb({
  capture,
  record,
  project,
  projectCoverRecord = null,
  width
}: {
  capture: Capture;
  record: CaptureRecord | null;
  project: SizzleProject | null;
  projectCoverRecord?: CaptureRecord | null;
  width: number;
}) {
  // Sizzle Reels project cell — saved cover thumbnail as the
  // background + a project-kind badge + a "N scenes · MM:SS" pill.
  // Click handling is in the parent's onSelectCell, which dispatches
  // sizzle:open instead of OPEN_FOCUS for project cells.
  if (capture.kind === "project" && project !== null) {
    const coverCaptureId = resolveSizzleProjectCoverCaptureId(project);
    const sceneCount = project.scenes.length;
    const totalSec = project.scenes.reduce((acc, s) => {
      const explicit = s.durationOverrideSec;
      if (typeof explicit === "number" && explicit > 0) return acc + explicit;
      const trim = s.mediaTrim;
      if (trim != null) return acc + (trim.endSec - trim.startSec);
      return acc + 3;
    }, 0);
    const durLabel =
      totalSec >= 60
        ? `${Math.floor(totalSec / 60)}:${Math.round(totalSec % 60)
            .toString()
            .padStart(2, "0")}`
        : `${Math.round(totalSec)}s`;
    const coverThumb =
      projectCoverRecord?.kind === "video" ? (
        <VideoCellThumb record={projectCoverRecord} showDuration={false} />
      ) : projectCoverRecord !== null ? (
        <img
          src={cacheUrl(projectCoverRecord.id, width, "webp", projectCoverRecord.edits_version)}
          alt=""
          loading="lazy"
          decoding="async"
          style={{
            width: "100%",
            height: "100%",
            objectFit: "contain",
            display: "block"
          }}
        />
      ) : coverCaptureId !== null ? (
        <img
          src={cacheUrl(coverCaptureId, width, "webp")}
          alt=""
          loading="lazy"
          decoding="async"
          style={{
            width: "100%",
            height: "100%",
            objectFit: "contain",
            display: "block"
          }}
        />
      ) : (
        <span className="psl__cell-project-empty" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="3" y="6" width="14" height="12" rx="2" />
            <path d="m17 10 4-2v8l-4-2z" fill="currentColor" />
          </svg>
        </span>
      );
    return (
      <div className="psl__cell-project">
        {typeof project.outputPath === "string" && project.outputPath.length > 0 ? (
          <ProjectMovieCellThumb project={project}>{coverThumb}</ProjectMovieCellThumb>
        ) : (
          coverThumb
        )}
        <span className="psl__cell-project-kind" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="6" width="14" height="12" rx="2" />
            <path d="m17 10 4-2v8l-4-2z" fill="currentColor" />
          </svg>
        </span>
        <span className="psl__cell-project-meta">
          {sceneCount === 0 ? "empty" : `${sceneCount} · ${durLabel}`}
        </span>
      </div>
    );
  }
  if (record !== null && record.kind === "video") {
    return <VideoCellThumb record={record} />;
  }
  if (record !== null) {
    return (
      <img
        src={cacheUrl(record.id, width, "webp", record.edits_version)}
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
 * Video Library card thumbnail. Renders a silent source preview on
 * hover and stops playback on mouseleave so the grid stays calm with
 * many videos in view.
 *
 * Duration badge in the bottom-right makes video cards instantly
 * recognizable from images at a glance.
 */
function VideoCellThumb({
  record,
  showDuration = true
}: {
  record: CaptureRecord;
  showDuration?: boolean;
}): React.ReactElement {
  return (
    <PreviewVideoThumb
      src={captureSrcUrl(record.id)}
      duration={record.video?.durationSec ?? 0}
      showDuration={showDuration}
    />
  );
}

function ProjectMovieCellThumb({
  project,
  children
}: {
  project: SizzleProject;
  children: ReactNode;
}): React.ReactElement {
  const src = sizzleOutputUrl(project.id, project.lastRenderedAt);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [src]);
  if (failed) {
    return <>{children}</>;
  }
  return (
    <PreviewVideoThumb
      src={src}
      duration={0}
      showDuration={false}
      onError={() => setFailed(true)}
    />
  );
}

function PreviewVideoThumb({
  src,
  duration,
  showDuration = true,
  onError
}: {
  src: string;
  duration: number;
  showDuration?: boolean;
  onError?: () => void;
}): React.ReactElement {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [hovering, setHovering] = useState(false);
  useEffect(() => {
    const el = videoRef.current;
    if (el === null) return;
    if (hovering) {
      el.currentTime = 0;
      void el.play().catch(() => undefined);
    } else {
      el.pause();
      el.currentTime = 0;
    }
  }, [hovering]);
  return (
    <div
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        background: "var(--bg)"
      }}
    >
      <video
        ref={videoRef}
        src={src}
        muted
        playsInline
        preload="metadata"
        onError={onError}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "contain",
          display: "block"
        }}
      />
      {showDuration ? (
        <span
          data-video-duration={duration.toFixed(1)}
          style={{
            position: "absolute",
            right: 6,
            bottom: 6,
            padding: "2px 6px",
            borderRadius: 4,
            background: "rgba(0, 0, 0, 0.7)",
            color: "#fff",
            font: "500 10px/1 var(--font-mono)",
            letterSpacing: "0.02em",
            pointerEvents: "none"
          }}
        >
          {formatDurationLabel(duration)}
        </span>
      ) : null}
    </div>
  );
}

function formatDurationLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (mins === 0) return `${secs}s`;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
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

type ActiveLibraryFilter =
  | { kind: "all" }
  | { kind: "today" }
  | { kind: "trash" }
  | { kind: "sourceApp"; appId: string };

type LibraryHistoryLocation = {
  readonly view: LibraryView;
  readonly activeFilter: ActiveLibraryFilter;
  readonly searchQuery: string;
};

type PendingOpenCapture = {
  readonly captureId: string;
  readonly from: LibraryHistoryLocation;
  readonly scrollTop: number;
};

function capturesChangedIds(payload: unknown): string[] | null {
  if (typeof payload !== "object" || payload === null) return null;
  const raw = (payload as { changedIds?: unknown }).changedIds;
  if (!Array.isArray(raw)) return null;
  const ids = raw.filter((id): id is string => typeof id === "string");
  return ids.length === 0 ? null : ids;
}

function sameActiveFilter(a: ActiveLibraryFilter, b: ActiveLibraryFilter): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind !== "sourceApp" || b.kind !== "sourceApp" || a.appId === b.appId;
}

function sameLibraryView(a: LibraryView, b: LibraryView): boolean {
  if (a.kind !== b.kind || a.selectedRecordId !== b.selectedRecordId) return false;
  if (a.kind === "focus" && b.kind === "focus") {
    return (
      a.returnAnchor.cellId === b.returnAnchor.cellId &&
      a.returnAnchor.scrollTop === b.returnAnchor.scrollTop
    );
  }
  return true;
}

function sameHistoryLocation(
  a: LibraryHistoryLocation,
  b: LibraryHistoryLocation
): boolean {
  return (
    sameLibraryView(a.view, b.view) &&
    sameActiveFilter(a.activeFilter, b.activeFilter) &&
    a.searchQuery === b.searchQuery
  );
}

function appendHistoryLocation(
  stack: LibraryHistoryLocation[],
  location: LibraryHistoryLocation
): LibraryHistoryLocation[] {
  const last = stack[stack.length - 1];
  if (last !== undefined && sameHistoryLocation(last, location)) return stack;
  return [...stack, location].slice(-50);
}

export function Library() {
  const [activeFilter, setActiveFilter] = useState<ActiveLibraryFilter>({ kind: "all" });
  const activeFilterRef = useRef(activeFilter);
  useEffect(() => {
    activeFilterRef.current = activeFilter;
  }, [activeFilter]);
  // Library full-text search — wired to `library:search` (bus verb landed
  // in PR #154). The input lives in the topbar at `.psl__search`. When
  // the trimmed query is non-empty the grid renders search results
  // instead of the keyset-paginated `library:list` snapshot; when empty
  // the normal pipeline resumes. Source-app + Today filters are
  // intentionally bypassed during search — the model is Spotify-style
  // "search across everything," matching the placeholder copy. Trash
  // search is unsupported because `library:search` only returns live
  // rows (captures-repo's WHERE clause); we disable the input in trash.
  const [searchQuery, setSearchQuery] = useState<string>("");
  const searchQueryRef = useRef(searchQuery);
  useEffect(() => {
    searchQueryRef.current = searchQuery;
  }, [searchQuery]);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [searchState, setSearchState] = useState<{
    /** Trimmed query the rows below reflect — guards against showing
     *  stale results while a newer debounced dispatch is in flight. */
    forQuery: string;
    rows: CaptureRecord[];
    /** True when the response returned exactly LIMIT rows, so callers
     *  can show a "refine your search" hint instead of pretending the
     *  hit count is the full match set. The bus has no cursor; LIMIT
     *  is the hard ceiling. */
    capped: boolean;
    loading: boolean;
    error: string | null;
  }>({ forQuery: "", rows: [], capped: false, loading: false, error: null });
  const [sourceAppRows, setSourceAppRows] = useState<Record<string, SourceAppRowsState>>(
    {}
  );
  const [openedRecords, setOpenedRecords] = useState<CaptureRecord[]>([]);
  const [projectContextMenu, setProjectContextMenu] =
    useState<ProjectContextMenuState | null>(null);
  const openedRecordsRef = useRef(openedRecords);
  useEffect(() => {
    openedRecordsRef.current = openedRecords;
  }, [openedRecords]);
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

  // Right-rail (DetailRail) pin + active-tab state. Lifted to the
  // Library level so the title-bar LayoutToggleButtons can drive the
  // rail without crossing component boundaries or routing through
  // Settings broadcasts. Seeded once from `settings:read`; each user
  // write also fires `settings:write` so the choice survives relaunch.
  //
  // `settingsHydrated` gates the data-right attribute below — without
  // it, a fresh launch paints with the in-memory default (pinned:
  // true) for the ~50ms before settings:read resolves, then snaps to
  // the user's saved choice. Worth a flag to avoid the visual stutter.
  //
  // `userTouchedRailRef` guards against a click-before-hydrate race:
  // settings:read is a real IPC round-trip and can take 10–50ms. If
  // the user presses ⌘⌥B (or clicks the toggle chip) within that
  // window, their click moves the state to the OPPOSITE of the saved
  // value. Without the gate, the settings:read resolution would then
  // overwrite the user's choice — surfacing as "I clicked the toggle
  // and nothing happened." The ref is mutated synchronously by every
  // user-driven setter so the in-flight settings read knows to bail.
  const [rightPinned, setRightPinnedState] = useState<boolean>(true);
  const [rightActiveTab, setRightActiveTabState] =
    useState<LibrarySidebarTab>("info");
  const [settingsHydrated, setSettingsHydrated] = useState<boolean>(false);
  const userTouchedRailRef = useRef<boolean>(false);
  // Mirror of `rightPinned` kept in a ref so `toggleRightPinned` can
  // compute `!current` without subscribing to the state and triggering
  // a callback-identity churn (which would make the
  // LayoutToggleButtons keydown listener re-attach on every toggle).
  // The companion effect updates the ref whenever React commits a new
  // value; reads from the ref are always one render fresh.
  const rightPinnedRef = useRef<boolean>(true);
  useEffect(() => {
    rightPinnedRef.current = rightPinned;
  }, [rightPinned]);

  const [aiEnabled, setAiEnabledState] = useState<boolean>(false);
  const [aiConsentAcceptedAt, setAiConsentAcceptedAtState] = useState<string | null>(null);
  const [aiToggleBusy, setAiToggleBusy] = useState<boolean>(false);
  const [aiConsentDialogOpen, setAiConsentDialogOpen] = useState<boolean>(false);
  const [codexAvailable, setCodexAvailable] = useState<boolean | undefined>(undefined);
  // Selected enrichment backend ("" / "codex" / "acp:<id>") + its short label
  // ("Codex", "Kimi", "Gemini", …) so the footer toggle names the actual
  // provider instead of always saying "Codex", and so its "Configure AI"
  // gating reflects the chosen backend's availability — not just Codex's.
  // Mirrors the float-over toast + detail rail, which derive the same label
  // from `enrichmentBackendLabel`.
  const [enrichmentProvider, setEnrichmentProvider] = useState<string>("");
  const [enrichmentProviderLabel, setEnrichmentProviderLabel] = useState<string>("Codex");
  // ACP-agent install status, so an enabled+installed ACP enrichment backend
  // (Kimi/Gemini/Grok/Qwen) counts as "available" even when Codex is absent.
  const [acpDiscovery, setAcpDiscovery] = useState<AcpAgentDiscovery | undefined>(undefined);
  const userTouchedAiRef = useRef<boolean>(false);

  const applyAiSettings = useCallback((settings: Settings): void => {
    setAiEnabledState(settings.ai.enabled);
    setAiConsentAcceptedAtState(settings.ai.consentAcceptedAt);
    setEnrichmentProvider(settings.ai.defaults.enrichment.provider ?? "");
    setEnrichmentProviderLabel(enrichmentBackendLabel(settings.ai.defaults.enrichment).providerLabel);
  }, []);

  const enrichmentProviderAvailable = useMemo(
    () =>
      isEnrichmentProviderAvailable({
        provider: enrichmentProvider,
        codexAvailable,
        acpDiscovery
      }),
    [enrichmentProvider, codexAvailable, acpDiscovery]
  );

  useEffect(() => {
    let cancelled = false;
    void dispatch("settings:read", {}).then((result) => {
      if (cancelled) return;
      if (result.ok && !userTouchedRailRef.current) {
        const rail = (result.value as Settings | undefined)?.library
          ?.detailRail;
        if (rail !== undefined) {
          setRightPinnedState(rail.pinned);
          setRightActiveTabState(rail.lastSelectedTab);
        }
      }
      if (result.ok && !userTouchedAiRef.current) {
        applyAiSettings(result.value);
      }
      // Always mark hydrated — even on read failure / user-touched
      // bail — so the rail doesn't stay in its pre-hydration phantom
      // state forever. Mirror of the same pattern in DetailRail's
      // uncontrolled-mode read.
      setSettingsHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, [applyAiSettings]);
  useEffect(() => {
    const unsubscribe = subscribe(EVENT_CHANNELS.settingsChanged, (payload) => {
      const evt = payload as SettingsChangedEvent;
      applyAiSettings(evt.settings);
      void dispatch("settings:refreshCodexDiscovery", { force: false }).then((result) => {
        if (result.ok) setCodexAvailable(codexAvailableInSnapshot(result.value));
      });
    });
    return unsubscribe;
  }, [applyAiSettings]);
  useEffect(() => {
    let cancelled = false;
    void dispatch("settings:refreshCodexDiscovery", { force: false }).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        const snapshot = result.value as DesktopCodexDiscoverySnapshot;
        setCodexAvailable(codexAvailableInSnapshot(snapshot));
      } else {
        setCodexAvailable(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);
  // Probe ACP install status ONLY when an ACP agent is the enrichment backend
  // — Codex availability needs no ACP discovery, and `acp:discover` spawns
  // real `--version` probes (no handler cache), so we don't want it firing on
  // every unrelated settings write. Re-runs when the selected provider
  // changes; install state otherwise only shifts across a relaunch.
  useEffect(() => {
    if (!enrichmentProvider.startsWith("acp:")) return;
    let cancelled = false;
    void dispatch("acp:discover", {}).then((result) => {
      if (!cancelled && result.ok) setAcpDiscovery(result.value);
    });
    return () => {
      cancelled = true;
    };
  }, [enrichmentProvider]);
  // All three setters mark `userTouchedRailRef` synchronously BEFORE
  // any state write. The settings:read resolution checks this flag
  // and bails — see the race-guard comment above. The setters use
  // direct value writes (not functional `setState((prev) => …)`)
  // because the dispatch must run OUTSIDE the React state-setter
  // callback; functional setters are meant to be pure and StrictMode
  // double-invokes them in dev, which would fire `settings:write`
  // twice per toggle.
  const setRightPinned = useCallback((next: boolean): void => {
    userTouchedRailRef.current = true;
    setRightPinnedState(next);
    void dispatch("settings:write", {
      library: { detailRail: { pinned: next } }
    });
  }, []);
  const setRightActiveTab = useCallback((next: LibrarySidebarTab): void => {
    userTouchedRailRef.current = true;
    setRightActiveTabState(next);
    void dispatch("settings:write", {
      library: { detailRail: { lastSelectedTab: next } }
    });
  }, []);
  const toggleLeftPinned = useCallback((): void => {
    setLeftPinned((v) => !v);
  }, []);
  // Reads `rightPinnedRef.current` (synced via the effect above) so
  // the toggle has stable identity — no `rightPinned` in deps. The
  // chord listener in LayoutToggleButtons attaches once on mount.
  const toggleRightPinned = useCallback((): void => {
    userTouchedRailRef.current = true;
    const next = !rightPinnedRef.current;
    setRightPinnedState(next);
    void dispatch("settings:write", {
      library: { detailRail: { pinned: next } }
    });
  }, []);

  const writeAiEnabled = useCallback((next: boolean, consentAcceptedAt: string | null): void => {
    const previousEnabled = aiEnabled;
    const previousConsentAcceptedAt = aiConsentAcceptedAt;

    userTouchedAiRef.current = true;
    setAiToggleBusy(true);
    setAiEnabledState(next);
    setAiConsentAcceptedAtState(consentAcceptedAt);
    void dispatch("settings:write", {
      ai: {
        enabled: next,
        consentAcceptedAt
      }
    }).then((result) => {
      setAiToggleBusy(false);
      if (result.ok) {
        applyAiSettings(result.value);
        return;
      }
      setAiEnabledState(previousEnabled);
      setAiConsentAcceptedAtState(previousConsentAcceptedAt);
    });
  }, [aiConsentAcceptedAt, aiEnabled, applyAiSettings]);

  const toggleAiEnabled = useCallback((): void => {
    const action = resolveLibraryAiToggleAction({
      aiEnabled,
      aiConsentAcceptedAt,
      providerAvailable: enrichmentProviderAvailable
    });
    switch (action) {
      case "disable":
        writeAiEnabled(false, aiConsentAcceptedAt);
        return;
      case "configure":
        void dispatch("settings:open", { page: "ai" });
        return;
      case "consent":
        userTouchedAiRef.current = true;
        setAiConsentDialogOpen(true);
        return;
      case "enable":
        userTouchedAiRef.current = true;
        writeAiEnabled(true, aiConsentAcceptedAt);
        return;
    }
  }, [aiConsentAcceptedAt, aiEnabled, enrichmentProviderAvailable, writeAiEnabled]);

  const acceptAiConsent = useCallback((): void => {
    setAiConsentDialogOpen(false);
    writeAiEnabled(true, new Date().toISOString());
  }, [writeAiEnabled]);

  // View-state reducer — single source of truth for {grid, focus, reel}
  // mode + selected record id. Discriminated-union shape encodes the
  // illegal-state guard at compile time (focus mode requires non-null
  // selectedRecordId). Plan: docs/plans/2026-05-05-001-feat-library-
  // three-state-view-model-plan.md, Phase A. Tests at
  // ./__tests__/library-view.test.ts.
  const [view, setView] = useState<LibraryView>(initialLibraryView);
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  const [navHistory, setNavHistory] = useState<{
    back: LibraryHistoryLocation[];
    forward: LibraryHistoryLocation[];
  }>({ back: [], forward: [] });
  const currentHistoryLocation = useCallback(
    (): LibraryHistoryLocation => ({
      view: viewRef.current,
      activeFilter: activeFilterRef.current,
      searchQuery: searchQueryRef.current
    }),
    []
  );
  const restoreHistoryLocation = useCallback((location: LibraryHistoryLocation): void => {
    activeFilterRef.current = location.activeFilter;
    searchQueryRef.current = location.searchQuery;
    viewRef.current = location.view;
    setActiveFilter(location.activeFilter);
    setSearchQuery(location.searchQuery);
    setView(location.view);
  }, []);
  const viewDispatch = useCallback(
    (action: LibraryAction, options?: { history?: "push" | "replace" }): void => {
      const current = currentHistoryLocation();
      const nextView = libraryReducer(current.view, action);
      if (sameLibraryView(current.view, nextView)) return;
      const historyMode = options?.history ?? "push";
      if (historyMode === "push") {
        setNavHistory((prev) => ({
          back: appendHistoryLocation(prev.back, current),
          forward: []
        }));
      }
      viewRef.current = nextView;
      setView(nextView);
    },
    [currentHistoryLocation]
  );
  const goBack = useCallback((): void => {
    const previous = navHistory.back[navHistory.back.length - 1];
    if (previous === undefined) return;
    const current = currentHistoryLocation();
    setNavHistory({
      back: navHistory.back.slice(0, -1),
      forward: sameHistoryLocation(current, previous)
        ? navHistory.forward
        : [current, ...navHistory.forward].slice(0, 50)
    });
    restoreHistoryLocation(previous);
  }, [currentHistoryLocation, navHistory, restoreHistoryLocation]);
  const goForward = useCallback((): void => {
    const next = navHistory.forward[0];
    if (next === undefined) return;
    const current = currentHistoryLocation();
    setNavHistory({
      back: sameHistoryLocation(current, next)
        ? navHistory.back
        : appendHistoryLocation(navHistory.back, current),
      forward: navHistory.forward.slice(1)
    });
    restoreHistoryLocation(next);
  }, [currentHistoryLocation, navHistory, restoreHistoryLocation]);
  const { projects: sizzleProjects } = useSizzleProjects();
  // The Project Asset Cart. Drives the cell checkboxes (which captures
  // are checked) AND the grid-mode standalone cart rail (which appears
  // when the cart is non-empty — the "right bar opens when you check"
  // flow). In focus/reel modes the cart is a DetailRail tab instead.
  // Library only needs the COARSE empty/non-empty signal (for the
  // grid-mode rail gate + the data-cart attribute). Consuming the
  // boolean context means a toggle WITHIN a non-empty cart doesn't
  // re-render Library (and therefore doesn't reflow the un-memoized
  // virtualized grid) — only the empty↔non-empty edge does. Per-cell
  // membership lives in <CartCellCheckbox>, which self-subscribes to
  // the full-cart context so only the checkboxes re-render on a toggle.
  const cartIsEmpty = useCartIsEmpty();
  const cartIsOpenInGrid = view.kind === "grid" && !cartIsEmpty;
  // Library "Types" multi-pick filter. All three on by default so the
  // library looks the same as before for users who don't touch it.
  // Right-click / shift-click on a row sets that row as "Only" (the
  // others get unchecked) — see onTypeRowClick below.
  const [visibleTypes, setVisibleTypes] = useState<{
    images: boolean;
    videos: boolean;
    projects: boolean;
  }>({ images: true, videos: true, projects: true });
  const toggleType = (key: "images" | "videos" | "projects"): void => {
    setVisibleTypes((prev) => ({ ...prev, [key]: !prev[key] }));
  };
  const onlyType = (key: "images" | "videos" | "projects"): void => {
    setVisibleTypes({
      images: key === "images",
      videos: key === "videos",
      projects: key === "projects"
    });
  };
  const ensureRecordTypeVisible = useCallback((record: CaptureRecord): void => {
    if (record.kind === "image") {
      setVisibleTypes((prev) => (prev.images ? prev : { ...prev, images: true }));
      return;
    }
    if (record.kind === "video") {
      setVisibleTypes((prev) => (prev.videos ? prev : { ...prev, videos: true }));
    }
  }, []);
  const [copyPulses, setCopyPulses] = useState(INITIAL_COPY_PULSES);
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
  const recordsRef = useRef(records);
  useEffect(() => {
    recordsRef.current = records;
  }, [records]);
  const storage = useStorageSnapshot();
  const storageLabel =
    storage.snapshot !== null
      ? `${formatBytes(storage.snapshot.totalBytes)} local`
      : storage.summary !== null
        ? `${formatBytes(storage.summary.sourceCaptures.bytes)} snaps`
        : "calculating storage";
  const [storagePanelOpen, setStoragePanelOpen] = useState(false);
  const storagePanelRef = useRef<HTMLDivElement | null>(null);
  const appCacheBytes =
    (storage.snapshot?.chromiumHttpCache.bytes ?? 0) +
    (storage.snapshot?.chromiumCodeCache.bytes ?? 0);
  const sourceSnapCount =
    storage.snapshot?.sourceCaptures.captureCount ??
    storage.summary?.sourceCaptures.captureCount ??
    0;
  const storageBusy = storage.workingAction !== null;
  const refreshStorage = storage.refresh;

  // Hotkeys subscription — drives the live "Quick Capture · <chord>"
  // hint in the top bar so it tracks whatever the user has bound in
  // Settings → Hotkeys. `useHotkeys` seeds with the EMPTY snapshot
  // (all chords `""`) until the first `settings:read` resolves, so
  // the button renders bare "Quick Capture" briefly on cold start and
  // identically when the user explicitly unbinds the chord.
  const hotkeys = useHotkeys();
  const quickCaptureChord = useMemo(
    () => acceleratorToDisplayKeys(hotkeys.quickCapture).join(""),
    [hotkeys.quickCapture]
  );

  // App version for the footer — mirrors AboutPage. One-shot read on
  // mount; the version doesn't change at runtime.
  const [appVersion, setAppVersion] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await dispatch("app:version", {});
      if (cancelled) return;
      if (result.ok) setAppVersion(result.value.version);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!storagePanelOpen) return;
    void refreshStorage({ force: true });
    function closeOnOutsidePointer(event: PointerEvent): void {
      const root = storagePanelRef.current;
      if (root !== null && event.target instanceof Node && root.contains(event.target)) return;
      setStoragePanelOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key === "Escape") setStoragePanelOpen(false);
    }
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsidePointer);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [refreshStorage, storagePanelOpen]);

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
  const liveRecords = useMemo(() => {
    return mergeOpenedLiveRecords(records, openedRecords);
  }, [openedRecords, records]);
  const trashRecords = useMemo(
    () => records.filter((r) => r.deleted_at !== null),
    [records]
  );

  const revalidateOpenedRecords = useCallback((changedIds: readonly string[] | null) => {
    const opened = openedRecordsRef.current;
    if (opened.length === 0) return;
    const changedSet = changedIds === null ? null : new Set(changedIds);
    const ids = opened
      .filter((record) => changedSet === null || changedSet.has(record.id))
      .map((record) => record.id);
    if (ids.length === 0) return;

    void (async () => {
      const refreshed = await Promise.all(
        ids.map(async (id) => {
          const result: Result<Res<"library:byId">, PwrSnapError> = await dispatch(
            "library:byId",
            { id }
          );
          return { id, result };
        })
      );
      const idSet = new Set(ids);
      const failedIds = new Set<string>();
      const liveById = new Map<string, CaptureRecord>();
      for (const { id, result } of refreshed) {
        if (!result.ok) {
          failedIds.add(id);
          continue;
        }
        if (result.value === null || result.value.deleted_at !== null) {
          continue;
        }
        liveById.set(result.value.id, result.value);
      }
      setOpenedRecords((prev) => {
        let changed = false;
        const next: CaptureRecord[] = [];
        for (const record of prev) {
          if (!idSet.has(record.id)) {
            next.push(record);
            continue;
          }
          if (failedIds.has(record.id)) {
            next.push(record);
            continue;
          }
          const replacement = liveById.get(record.id);
          if (replacement === undefined) {
            changed = true;
            continue;
          }
          next.push(replacement);
          if (replacement !== record) changed = true;
        }
        return changed ? next : prev;
      });
    })();
  }, []);

  useEffect(() => {
    return subscribe(EVENT_CHANNELS.capturesChanged, (payload) => {
      revalidateOpenedRecords(capturesChangedIds(payload));
    });
  }, [revalidateOpenedRecords]);

  const isTodayView = activeFilter.kind === "today";
  const isTrashView = activeFilter.kind === "trash";
  const activeSourceAppId = activeFilter.kind === "sourceApp" ? activeFilter.appId : null;
  const isSourceAppView = activeSourceAppId !== null;
  const sourceAppBundleIds = useMemo<Array<string | null>>(() => {
    if (activeSourceAppId === null) return [];
    const bundles: Array<string | null> = [];
    for (const stat of appStats) {
      if (mapBundleIdToAppId(stat.bundleId) === activeSourceAppId) {
        bundles.push(stat.bundleId);
      }
    }
    return bundles;
  }, [activeSourceAppId, appStats]);
  const sourceAppBundleKey = useMemo(() => {
    const sourceAppBundleCounts = sourceAppBundleIds.map((bundleId) => {
      const stat = appStats.find((candidate) => candidate.bundleId === bundleId);
      return [bundleId, stat?.count ?? 0] as const;
    });
    return JSON.stringify(sourceAppBundleCounts);
  }, [appStats, sourceAppBundleIds]);

  useEffect(() => {
    if (activeSourceAppId === null) return;
    if (sourceAppBundleIds.length === 0) return;
    const cached = sourceAppRowsRef.current[activeSourceAppId];
    // A same-key rerun cleans up the in-flight fetch first; restart if
    // the cached entry is still loading so the source view cannot stick empty.
    if (cached?.bundleKey === sourceAppBundleKey && !cached.loading) return;

    let cancelled = false;
    const appKey = activeSourceAppId;
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
    activeSourceAppId,
    sourceAppBundleIds,
    sourceAppBundleKey
  ]);

  // Search dispatch — debounced ~150ms so keystrokes coalesce into one
  // round-trip, with a monotonic seq guarding against stale resolutions
  // clobbering newer ones. Empty / whitespace-only queries short-circuit
  // back to a clean state without hitting the bus. The 500-row limit is
  // the repo-side max (SEARCH_MAX_LIMIT); we request it so the cap-hint
  // affordance below is meaningful for power users with huge libraries.
  const SEARCH_LIMIT = 500;
  const searchSeqRef = useRef(0);
  useEffect(() => {
    const trimmed = searchQuery.trim();
    const seq = ++searchSeqRef.current;
    if (trimmed.length === 0) {
      setSearchState({
        forQuery: "",
        rows: [],
        capped: false,
        loading: false,
        error: null
      });
      return;
    }
    setSearchState((prev) => ({
      ...prev,
      loading: true,
      error: null
    }));
    const timer = setTimeout(() => {
      void (async () => {
        const result: Result<Res<"library:search">, PwrSnapError> = await dispatch(
          "library:search",
          { query: trimmed, limit: SEARCH_LIMIT }
        );
        if (searchSeqRef.current !== seq) return;
        if (!result.ok) {
          setSearchState({
            forQuery: trimmed,
            rows: [],
            capped: false,
            loading: false,
            error: result.error.message
          });
          return;
        }
        const rows: CaptureRecord[] = result.value.rows.map(
          (r: CaptureSearchResultRow) => r.record
        );
        setSearchState({
          forQuery: trimmed,
          rows,
          capped: rows.length >= SEARCH_LIMIT,
          loading: false,
          error: null
        });
      })();
    }, 150);
    return () => {
      clearTimeout(timer);
    };
  }, [searchQuery]);

  // True whenever the user has a non-empty trimmed query — drives the
  // grid swap, the "Search results" hdr, and the cap-hint affordance.
  const isSearchActive = searchQuery.trim().length > 0;

  // Universe of records the current view operates on. Trash is a
  // top-level swap (not a per-app filter) so the per-app filter only
  // applies when viewing live captures. Search takes precedence over
  // everything — when the user is searching, the source-app sidebar +
  // Today/Trash filters are bypassed and the grid renders the search
  // result set directly. Bus-side `library:search` excludes soft-
  // deleted rows (see captures-repo:503), so search ∩ trash is empty
  // by construction; the input is disabled in trash to make that clear.
  const sourceAppState =
    activeSourceAppId === null ? undefined : sourceAppRows[activeSourceAppId];
  const universeRecordsRaw = isTrashView
    ? trashRecords
    : isSearchActive
    ? searchState.rows
    : sourceAppState?.bundleKey === sourceAppBundleKey
    ? sourceAppState.rows
    : liveRecords;
  // Apply the Types filter (Images / Videos) to the universe before
  // the fixtureBacking wraps it. This way every downstream consumer
  // (grouped, visible, gridHasMore, etc.) sees a coherent filtered
  // view without each having to learn about the type filter.
  // Trash view bypasses the type filter — trash is its own mode.
  const universeRecords = useMemo(() => {
    if (isTrashView) return universeRecordsRaw;
    if (visibleTypes.images && visibleTypes.videos) return universeRecordsRaw;
    return universeRecordsRaw.filter((r) => {
      if (r.kind === "image") return visibleTypes.images;
      if (r.kind === "video") return visibleTypes.videos;
      return true;
    });
  }, [universeRecordsRaw, visibleTypes.images, visibleTypes.videos, isTrashView]);
  // `library:search` has no cursor — the bus surface caps at
  // SEARCH_LIMIT and the caller renders a "refine your search" hint
  // if hit. Loading the next page would mean re-running the query,
  // which doesn't compose with FTS5 rank ordering.
  const gridHasMore = isSearchActive ? false : isSourceAppView ? false : hasMore;
  // Search never paginates (gridHasMore is false), so it must not drive
  // the grid's bottom "Loading more…" footer — that label would be a
  // lie (we're re-running a query, not fetching the next page). The
  // topbar count badge already shows "searching…" for search progress.
  const gridIsLoadingMore = isSearchActive
    ? false
    : isSourceAppView
      ? sourceAppState?.loading ?? false
      : isLoadingMore;

  // Project fixtures only fold into the grid when:
  //   • the Types filter has "Projects" on (UI control), AND
  //   • we're NOT in trash view (projects don't go to trash today), AND
  //   • we're NOT in a source-app filter (projects aren't FROM any
  //     app — surfacing them inside e.g. "Safari" would be incoherent).
  //
  // Note the deliberate asymmetry with the Images/Videos Types
  // filter below: those DO apply inside a source-app filter (a user
  // filtering to "Safari" can still narrow further to just images
  // from Safari). Projects can't compose that way because they have
  // no source-app dimension to begin with.
  const gridProjects = useMemo(
    () => {
      if (!visibleTypes.projects || isTrashView || activeSourceAppId !== null) return [];
      if (!isSearchActive) return sizzleProjects;
      return sizzleProjects.filter((project) =>
        sizzleProjectMatchesQuery(project, searchQuery)
      );
    },
    [
      visibleTypes.projects,
      isTrashView,
      activeSourceAppId,
      isSearchActive,
      sizzleProjects,
      searchQuery
    ]
  );
  const fixtureBacking = useMemo(
    () => new FixtureBackedRecords(universeRecords, gridProjects),
    // todayDateStr drives the day-bucket inside FixtureBackedRecords;
    // including it forces a rebuild when the local date crosses so the
    // grid's day-hdrs ("Today" / "Yesterday") update without a refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [universeRecords, gridProjects, todayDateStr]
  );
  const fixtureCaptures = useMemo(() => fixtureBacking.fixtures(), [fixtureBacking]);
  const searchResultCount = searchState.rows.length + (isSearchActive ? gridProjects.length : 0);
  const projectCoverIds = useMemo(
    () =>
      Array.from(
        new Set(
          gridProjects
            .map(resolveSizzleProjectCoverCaptureId)
            .filter((id): id is string => id !== null)
        )
      ),
    [gridProjects]
  );
  const projectCoverIdsKey = projectCoverIds.join(",");
  const [projectCoverRecordsById, setProjectCoverRecordsById] = useState<
    Map<string, CaptureRecord>
  >(new Map());
  useEffect(() => {
    if (projectCoverIds.length === 0) {
      setProjectCoverRecordsById((prev) => (prev.size === 0 ? prev : new Map()));
      return;
    }
    const wanted = new Set(projectCoverIds);
    setProjectCoverRecordsById((prev) => {
      let changed = false;
      const next = new Map<string, CaptureRecord>();
      for (const [id, record] of prev) {
        if (wanted.has(id)) next.set(id, record);
        else changed = true;
      }
      return changed ? next : prev;
    });
    const missing = projectCoverIds.filter((id) => !projectCoverRecordsById.has(id));
    if (missing.length === 0) return;
    let active = true;
    void dispatch("library:listByIds", { ids: missing }).then((result) => {
      if (!active || !result.ok) return;
      setProjectCoverRecordsById((prev) => {
        const next = new Map(prev);
        for (const record of result.value.rows) next.set(record.id, record);
        return next;
      });
    });
    return () => {
      active = false;
    };
    // projectCoverIdsKey is the membership fingerprint. The map is
    // intentionally not a dependency; including it would refetch on
    // every hydration write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectCoverIdsKey]);

  // Search bypasses every other filter — the user gets exactly the
  // result set from the bus, in rank/date order. Source-app + Today
  // composition is a follow-up (see PR-2 cart plan); v1 keeps the
  // grid swap unambiguous.
  const visible = isSearchActive
    ? fixtureCaptures
    : activeFilter.kind === "all" || isTrashView
      ? fixtureCaptures
      : isTodayView
      ? fixtureCaptures.filter((c) => c.day === "Today")
      : activeSourceAppId === null
      ? fixtureCaptures
      : fixtureCaptures.filter((c) => c.app === activeSourceAppId);
  const grouped = useMemo(() => groupByDay(visible), [visible]);

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
  // climb as keyset pages stream in. The app key is the lowercased
  // bundle id, so two stats rows that differ only in casing
  // (`com.hnc.Discord` / `com.hnc.discord`) fold into one group; we
  // aggregate after mapping.
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
  //   1. OS-supplied source_app_name from the stats payload wins
  //      (so jp.naver.line.mac → "LINE", com.tinyspeck.slackmacgap →
  //      whatever name macOS reports). This is the primary path.
  //   2. Otherwise, derive a Title-Case label from the bundle id's
  //      tail segment (so com.pwrsnap.synth.air-table → "Air Table").
  //   3. Loaded records only fill gaps for legacy/missing stats names.
  // (The APP_INFO lookup is a vestigial first check that no longer
  // matches real captures — real keys are lowercased bundle ids, not
  // curated short ids — so step 1 effectively leads.)
  const appLabels = useMemo<Record<string, string>>(() => {
    const labels: Record<string, string> = {};
    const capturedStatLabels = new Set<string>();
    // Pass 1: derive from app_stats bundle ids alone (stable on load).
    for (const stat of appStats) {
      const appId = mapBundleIdToAppId(stat.bundleId);
      if (labels[appId] !== undefined) continue;
      const curated = APP_INFO[appId]?.name;
      if (curated !== undefined) {
        labels[appId] = curated;
      } else if (stat.sourceAppName !== null && stat.sourceAppName.length > 0) {
        labels[appId] = stat.sourceAppName;
        capturedStatLabels.add(appId);
      } else if (stat.bundleId !== null) {
        labels[appId] = labelFromBundleId(stat.bundleId);
      } else {
        labels[appId] = "Unknown app";
      }
    }
    // Pass 2: fill with OS-supplied `source_app_name` only when the
    // stats payload did not already provide a captured name. Otherwise
    // labels can oscillate as different pages enter the loaded window.
    for (const c of liveFixturesForCounts) {
      if (APP_INFO[c.app]?.name !== undefined) continue; // curated already picked
      if (capturedStatLabels.has(c.app)) continue;
      if (c.appName === null) continue;
      labels[c.app] = c.appName;
    }
    return labels;
  }, [appStats, liveFixturesForCounts]);

  // Representative bundle id per app key — used by `<AppIcon>` to
  // resolve the full-color icon from the installed .app via the
  // `pwrsnap-app-icon://` protocol. The app key is the lowercased
  // bundle id, so each distinct app gets its own entry; when stats
  // rows differ only in casing we pick the highest-count
  // representative so the icon is most likely installed on the user's
  // machine. Bundle ids with no installed .app fall back to the
  // procedural two-letter initials glyph automatically.
  const appBundleIds = useMemo<Record<string, string>>(() => {
    const byApp = new Map<string, { bundleId: string; count: number }>();
    for (const stat of appStats) {
      if (stat.bundleId === null) continue;
      const appId = mapBundleIdToAppId(stat.bundleId);
      const current = byApp.get(appId);
      if (current === undefined || stat.count > current.count) {
        byApp.set(appId, { bundleId: stat.bundleId, count: stat.count });
      }
    }
    const out: Record<string, string> = {};
    for (const [appId, { bundleId }] of byApp) out[appId] = bundleId;
    return out;
  }, [appStats]);

  // Apps that should appear in the left rail: any app with ≥1 capture,
  // PLUS the currently-active filter (so a user who's filtered to
  // "Telegram" and just deleted their last Telegram capture doesn't
  // get teleported away from the empty filter). The list is open —
  // unknown apps (lowercased bundle ids that don't have a curated
  // glyph) appear here with their OS-supplied name and a procedural
  // initials icon. Sorted alphabetically by display name for stable
  // ordering across renders.
  const visibleApps = useMemo<Array<{ app: string; name: string; bundleId: string | undefined }>>(() => {
    const seen = new Set<string>();
    const out: Array<{ app: string; name: string; bundleId: string | undefined }> = [];
    for (const app of Object.keys(appCounts)) {
      if ((appCounts[app] ?? 0) === 0) continue;
      seen.add(app);
      out.push({
        app,
        name: appLabels[app] ?? "Unknown app",
        bundleId: appBundleIds[app]
      });
    }
    if (activeSourceAppId !== null && !seen.has(activeSourceAppId)) {
      out.push({
        app: activeSourceAppId,
        name: appLabels[activeSourceAppId] ?? APP_INFO[activeSourceAppId]?.name ?? "Unknown app",
        bundleId: appBundleIds[activeSourceAppId]
      });
    }
    out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    return out;
  }, [appCounts, appLabels, appBundleIds, activeSourceAppId]);

  // The CaptureRecord for the currently-selected id — passed to
  // <DetailRail> + <Stage> so they can render metadata + L/M/H copy
  // buttons in Focus + Reel modes (Phase C). Null = nothing selected.
  const selectedRecord: CaptureRecord | null = useMemo(() => {
    if (selectedRecordId === null) return null;
    const fallbackRecord = records.find((r) => r.id === selectedRecordId) ?? null;
    return (
      universeRecords.find((r) => r.id === selectedRecordId) ??
      (fallbackRecord !== null && (isTrashView || fallbackRecord.deleted_at === null)
        ? fallbackRecord
        : null)
    );
  }, [isTrashView, records, selectedRecordId, universeRecords]);

  // Records that match the current active filter, mapped from the
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

  // Lifted tool state — Phase 3.2: Library owns the single
  // `useEditorToolState` instance so the chromeless Editor (inside
  // <Stage>) and the floating <EditToolbar> share ONE hook. Pre-lift,
  // each component instantiated its own copy: EditToolbar's hook
  // owned the popover (where style picks landed), Editor's hook owned
  // the persistOverlay style reads, and the two never crossed — so
  // picking "red" in the popover never made the arrow red. Lifting
  // here flows the hook into both surfaces via Stage props.
  //
  // The hook depends on `captureId` for matching-text affordance
  // resets. Use the selected record id, sentinel-guarded so the hook
  // is stable when nothing is selected (grid mode).
  const liftedToolState = useEditorToolState({
    captureId: selectedRecordId ?? "__library_no_capture__"
  });
  const tool = liftedToolState.activeTool;
  const setTool = liftedToolState.setActiveTool;
  // Resets to "pointer" on every mode change so a user who pressed S
  // in Focus doesn't accidentally drag-shape on a filmstrip click
  // after Esc → Reel (julik concern #3, plan resolved decision:
  // option A — predictable beats clever).
  useEffect(() => {
    setTool("pointer");
  }, [view.kind, setTool]);
  // Lifted blur-style state — same shape as `tool`. Persists across
  // mode changes (Focus ↔ Reel) and across capture navigations so
  // the user doesn't have to re-pick their style every time. Doesn't
  // reset on view.kind change like `tool` does, because style is a
  // preference, not a transient drawing-tool selection.
  const [blurStyle, setBlurStyle] = useState<BlurStyle>(DEFAULT_BLUR_STYLE);

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
  const activeFilterKey =
    activeFilter.kind === "sourceApp" ? `sourceApp:${activeFilter.appId}` : activeFilter.kind;
  useLayoutEffect(() => {
    gridReturnScrollTopRef.current = 0;
    const el = gridScrollRef.current;
    if (el === null) return;
    el.scrollTop = 0;
  }, [activeFilterKey]);

  function selectFilter(next: ActiveLibraryFilter): void {
    gridReturnScrollTopRef.current = 0;
    viewDispatch({ type: "RESET_FOCUS_RETURN_SCROLL" }, { history: "replace" });
    const el = gridScrollRef.current;
    if (el !== null) el.scrollTop = 0;
    activeFilterRef.current = next;
    setActiveFilter(next);
  }

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
    viewDispatch(
      { type: "FILTER_CHANGED", visibleIds: universeRecords.map((r) => r.id) },
      { history: "replace" }
    );
  }, [selectedRecordId, selectedRecord, universeRecords, viewDispatch]);

  // External "open this capture in Focus" trigger. Fired by main when
  // the float-over toast's Edit button (or any future entry point)
  // calls `library:openInLibrary` — main brings the window forward
  // and broadcasts the captureId; we navigate.
  //
  // Two-stage effect so an event that lands BEFORE useLibrary has
  // fetched that capture still resolves cleanly:
  //   1. Subscribe handler stashes the captureId and the pre-open
  //      Library location for titlebar Back, resets activeFilter to
  //      "all", and asks `library:byId` for the row as a fallback.
  //   2. A separate effect watches for that captureId to appear in
  //      the live-record universe, then opens Focus once.
  const [pendingOpen, setPendingOpen] = useState<PendingOpenCapture | null>(null);
  useEffect(() => {
    return subscribe(EVENT_CHANNELS.libraryOpenCapture, (payload) => {
      if (typeof payload !== "object" || payload === null) return;
      const id = (payload as { captureId?: unknown }).captureId;
      if (typeof id !== "string") return;
      const allFilter: ActiveLibraryFilter = { kind: "all" };
      const knownRecord =
        recordsRef.current.find((record) => record.id === id) ??
        openedRecordsRef.current.find((record) => record.id === id) ??
        null;
      if (knownRecord !== null && knownRecord.deleted_at === null) {
        ensureRecordTypeVisible(knownRecord);
      }
      setPendingOpen({
        captureId: id,
        from: currentHistoryLocation(),
        scrollTop: gridScrollRef.current?.scrollTop ?? 0
      });
      activeFilterRef.current = allFilter;
      searchQueryRef.current = "";
      setActiveFilter({ kind: "all" });
      setSearchQuery("");
      void (async () => {
        const result: Result<Res<"library:byId">, PwrSnapError> = await dispatch(
          "library:byId",
          { id }
        );
        if (!result.ok || result.value === null || result.value.deleted_at !== null) return;
        const record = result.value;
        ensureRecordTypeVisible(record);
        setOpenedRecords((prev) => [
          record,
          ...prev.filter((existing) => existing.id !== record.id)
        ]);
      })();
    });
  }, [currentHistoryLocation, ensureRecordTypeVisible]);
  useEffect(() => {
    if (pendingOpen === null) return;
    const record = liveRecords.find((r) => r.id === pendingOpen.captureId);
    // Wait until the record lands in the live list or the byId
    // fallback above has supplemented the list.
    if (record === undefined) return;
    setPendingOpen(null);
    const nextView: LibraryView = {
      kind: "focus",
      selectedRecordId: record.id,
      returnAnchor: {
        scrollTop: pendingOpen.scrollTop,
        cellId: record.id
      }
    };
    const target: LibraryHistoryLocation = {
      view: nextView,
      activeFilter: { kind: "all" },
      searchQuery: ""
    };
    if (!sameHistoryLocation(pendingOpen.from, target)) {
      setNavHistory((prev) => ({
        back: appendHistoryLocation(prev.back, pendingOpen.from),
        forward: []
      }));
    }
    gridReturnScrollTopRef.current = pendingOpen.scrollTop;
    viewRef.current = nextView;
    setView(nextView);
  }, [liveRecords, pendingOpen]);

  // Filter-change-while-Focus bail: when the active filter changes and the
  // current selection is no longer in the visible set, the reducer
  // closes Focus and lands the user back in Grid (resolved decision
  // from the plan — filter is a query, query changed, show new
  // result set in Grid form).
  const prevActiveFilterKeyRef = useRef(activeFilterKey);
  useEffect(() => {
    const resetReturnScroll = prevActiveFilterKeyRef.current !== activeFilterKey;
    prevActiveFilterKeyRef.current = activeFilterKey;
    viewDispatch(
      {
        type: "FILTER_CHANGED",
        visibleIds: visibleRecords.map((r) => r.id),
        resetReturnScroll
      },
      { history: "replace" }
    );
  }, [activeFilterKey, visibleRecords, viewDispatch]);

  // Window keydown handler — Esc closes Focus, ←/→ navigate between
  // captures in Focus + Reel. Single listener for the lifetime of
  // Library mount; reads current state via refs so no stale-closure
  // bug after mode flips (julik concern #4a). Editor's own keydown
  // handler runs first for canvas-level concerns (V/A/S/H/T/B tool
  // hotkeys, Esc-to-cancel-draft).
  const prevRecordIdRef = useRef(prevRecordId);
  const nextRecordIdRef = useRef(nextRecordId);
  const selectedRecordRef = useRef(selectedRecord);
  useEffect(() => {
    prevRecordIdRef.current = prevRecordId;
  }, [prevRecordId]);
  useEffect(() => {
    nextRecordIdRef.current = nextRecordId;
  }, [nextRecordId]);
  useEffect(() => {
    selectedRecordRef.current = selectedRecord;
  }, [selectedRecord]);
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      // ⌘F — focus the library search input. Runs BEFORE the
      // text-field bail so the chord works even when focus is
      // already inside an input (matches every browser's Find).
      // Disabled in Trash view because the input is too (the bus
      // surface only returns live captures).
      if (event.metaKey && !event.ctrlKey && !event.altKey && event.key === "f") {
        const input = searchInputRef.current;
        if (input !== null && !input.disabled) {
          event.preventDefault();
          input.focus();
          input.select();
          return;
        }
      }

      const target = event.target as HTMLElement | null;
      // Skip when the user is typing in an input — single-letter
      // shortcuts and Esc must not steal focus from text fields.
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      if (target?.isContentEditable) return;

      const kind = viewRef.current.kind;
      const usingMeta = event.metaKey;
      const usingOtherMod = event.ctrlKey || event.altKey;

      // ⌘1 / ⌘2 / ⌘3 — copy Low / Med / High for the selected capture.
      // The labels live in DetailRail, so only honor them when the rail
      // is visible (Focus/Reel) and the Library window has focus.
      if (
        usingMeta &&
        !event.shiftKey &&
        !usingOtherMod &&
        (kind === "focus" || kind === "reel")
      ) {
        const preset = copyPresetForShortcutKey(event.key);
        const record = selectedRecordRef.current;
        if (preset !== null && record !== null) {
          event.preventDefault();
          void dispatch("clipboard:copy", { captureId: record.id, preset });
          setCopyPulses((current) => ({ ...current, [preset]: current[preset] + 1 }));
          return;
        }
      }

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
  }, [viewDispatch]);

  /**
   * Single-click handler for grid cells. Phase C: dispatches
   * `OPEN_FOCUS` with the captured grid scroll position + cell id
   * so the cell-pulse effect can highlight the right cell on
   * Focus → Grid return. Reel-mode filmstrip frames have their own
   * NAVIGATE-only click handler (no Focus open from filmstrip).
   */
  function onSelectCell(c: Capture): void {
    // Project cell → open the sizzle window for that project.
    // Click handler doesn't transition into focus/reel for projects;
    // projects are edited in the dedicated Sizzle Reels window.
    if (c.kind === "project" && c.projectId !== undefined) {
      openSizzleProject(c.projectId);
      return;
    }
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

  function duplicateSizzleProject(
    projectId: string,
    event?: ReactMouseEvent<HTMLElement>
  ): void {
    event?.preventDefault();
    event?.stopPropagation();
    void (async () => {
      const result = await dispatch("sizzle:duplicate", { id: projectId });
      if (result.ok) {
        void dispatch("sizzle:open", { projectId: result.value.id });
      }
    })();
  }

  function closeProjectContextMenu(): void {
    setProjectContextMenu(null);
  }

  function openProjectContextMenu(
    projectId: string,
    projectName: string,
    event: ReactMouseEvent<HTMLElement>
  ): void {
    event.preventDefault();
    event.stopPropagation();
    const position = clampContextMenuPosition(
      event.clientX,
      event.clientY,
      PROJECT_CONTEXT_MENU_WIDTH,
      PROJECT_CONTEXT_MENU_HEIGHT
    );
    setProjectContextMenu({
      projectId,
      projectName,
      ...position
    });
  }

  function openSizzleProject(projectId: string): void {
    void dispatch("sizzle:open", { projectId });
  }

  /**
   * Reel filmstrip frame click. Updates selectedRecordId without
   * opening Focus.
   */
  function onSelectFrame(c: Capture): void {
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
  const lastViewRef = useRef(view);
  const pulseAnchorRef = useRef<string | null>(null);
  if (lastViewRef.current.kind === "focus" && view.kind === "grid") {
    // Capture the cellId + scrollTop from the Focus view we just left.
    // We're reading mid-render, but only setting refs — no setState, so
    // React is happy. The new grid view's selectedRecordId matches the
    // Focus record and drives the pulse target.
    pulseAnchorRef.current = view.selectedRecordId;
    gridReturnScrollTopRef.current = lastViewRef.current.returnAnchor.scrollTop;
  }
  lastViewRef.current = view;

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
    if (wrap !== null) {
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
    <div
      className="psl"
      data-mode={view.kind}
      data-left={leftState}
      // `data-right` controls the right column width (38px collapsed
      // vs 360px pinned) AND the footer/overflow rules. In Grid mode
      // DetailRail returns null, so the column is 0 either way and
      // emitting the attribute would just confuse readers. Likewise,
      // skip it until settings:read resolves so the rail doesn't
      // paint at the wrong width for ~50ms on cold start.
      data-right={
        !settingsHydrated || view.kind === "grid"
          ? undefined
          : rightPinned
            ? "pinned"
            : "collapsed"
      }
      // `data-cart="open"` widens the right column in GRID mode so the
      // standalone cart rail has room. In focus/reel the cart lives in
      // the DetailRail tab strip and the column is already 360px, so
      // this only matters for grid. See `.psl[data-mode="grid"][data-cart="open"]`.
      data-cart={cartIsOpenInGrid ? "open" : undefined}
    >
      <header className="psl__topbar">
        <div className="psl__topbar-l">
          <div className="psl__title">
            <span className="psl__title-mark">
              <PwrSnapMark size={18} />
            </span>
            <PwrSnapWordmark />
          </div>
          <div className="psl__history" aria-label="Navigation history">
            <button
              type="button"
              className="psl__history-btn"
              aria-label="Back"
              title="Back"
              disabled={navHistory.back.length === 0}
              onClick={goBack}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m15 18-6-6 6-6" />
              </svg>
            </button>
            <button
              type="button"
              className="psl__history-btn"
              aria-label="Forward"
              title="Forward"
              disabled={navHistory.forward.length === 0}
              onClick={goForward}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m9 18 6-6-6-6" />
              </svg>
            </button>
          </div>
          <span className="psl__count">
            {isSearchActive
              ? searchState.loading && searchState.forQuery !== searchQuery.trim()
                ? "searching…"
                : searchState.error !== null
                  ? "search failed"
                  : searchState.capped
                    ? `${searchResultCount}+ matches`
                    : `${searchResultCount} ${searchResultCount === 1 ? "match" : "matches"}`
              : isTrashView
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
          {/* Library full-text search — `library:search` (FTS5 over
              title / description / OCR / source-app name). Disabled
              in Trash because the bus surface only returns live
              captures. Esc clears the query; ⌘F (handled in the
              capture-phase keydown listener) focuses the input. */}
          <div className="psl__search-wrap">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              ref={searchInputRef}
              className="psl__search"
              placeholder={
                isTrashView
                  ? "Search unavailable in Trash"
                  : "Search captures, tags, OCR…"
              }
              value={searchQuery}
              disabled={isTrashView}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && searchQuery.length > 0) {
                  e.preventDefault();
                  setSearchQuery("");
                }
              }}
              aria-label="Search captures"
            />
            {searchQuery.length > 0 && (
              <button
                type="button"
                className="psl__search-clear"
                aria-label="Clear search"
                title="Clear (Esc)"
                onClick={() => {
                  setSearchQuery("");
                  searchInputRef.current?.focus();
                }}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M6 6l12 12" />
                  <path d="M18 6L6 18" />
                </svg>
              </button>
            )}
          </div>
          {/* VS Code-style layout chips — toggle the primary (left)
              and secondary (right) side bars from the title bar. Same
              visual language as `Toggle Primary Side Bar (⌘B)` /
              `Toggle Secondary Side Bar (⌘⌥B)`. The component owns
              the keyboard chord; clicks flip the parent state which
              also persists to Settings via setRightPinned. */}
          <LayoutToggleButtons
            primaryOpen={leftPinned}
            secondaryOpen={rightPinned}
            onTogglePrimary={toggleLeftPinned}
            onToggleSecondary={toggleRightPinned}
            testIdPrefix="psl-layout-toggle"
          />
          {/* Settings gear — opens the Settings window. Sits just
              left of Quick Capture so the right side reads as
              "configure · capture". */}
          <button
            className="psl__icon-btn"
            type="button"
            title="Settings"
            aria-label="Open Settings"
            onClick={() => { void dispatch("settings:open", {}); }}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" />
            </svg>
          </button>
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
            {quickCaptureChord.length > 0
              ? `Quick Capture · ${quickCaptureChord}`
              : "Quick Capture"}
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
          {/* In-panel pin toggle removed — the title-bar
              LayoutToggleButtons chip is now the single, consistent
              control for both the left + right side bars (mirrors
              VS Code's primary / secondary side bar pattern). The
              spine button at `.psl__left-spine` still surfaces when
              the panel is collapsed entirely; both the chip and the
              spine route through `setLeftPinned` so all three entry
              points stay in sync. */}
        </div>
        <button
          className={"psl__nav" + (activeFilter.kind === "all" ? " is-active" : "")}
          onClick={() => selectFilter({ kind: "all" })}
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
          onClick={() => selectFilter({ kind: "today" })}
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
          onClick={() => selectFilter({ kind: "trash" })}
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

        <div className="psl__left-section">Types</div>
        {(
          [
            {
              key: "images" as const,
              label: "Images",
              icon: (
                <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <rect x="3" y="5" width="18" height="14" rx="2" />
                  <circle cx="9" cy="11" r="1.4" fill="currentColor" />
                  <path d="m21 17-5-5-7 7" />
                </svg>
              )
            },
            {
              key: "videos" as const,
              label: "Videos",
              icon: (
                <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <rect x="3" y="6" width="14" height="12" rx="1.5" />
                  <path d="m17 10 4-2v8l-4-2z" fill="currentColor" />
                </svg>
              )
            },
            {
              key: "projects" as const,
              label: "Projects",
              icon: (
                <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <rect x="3" y="6" width="14" height="12" rx="2" />
                  <path d="m17 10 4-2v8l-4-2z" fill="currentColor" />
                </svg>
              )
            }
          ] as const
        ).map(({ key, label, icon }) => (
          <button
            key={key}
            type="button"
            // aria-pressed mirrors visibleTypes[key] so screen readers
            // announce the row as a toggle (rather than a static link)
            // and report its current on/off state. The `.is-on`/`is-off`
            // class gives sighted users the same affordance via the
            // check column on the left edge.
            aria-pressed={visibleTypes[key]}
            aria-label={`${label} type filter (${
              visibleTypes[key] ? "showing" : "hidden"
            })`}
            className={
              "psl__nav psl__type-row" + (visibleTypes[key] ? " is-on" : " is-off")
            }
            onClick={(e) => {
              // shift-click → "Only this" (uncheck the other two).
              // Plain click → toggle this one.
              if (e.shiftKey) onlyType(key);
              else toggleType(key);
            }}
            title={
              visibleTypes[key]
                ? `Hide ${label.toLowerCase()} (Shift-click to show only ${label.toLowerCase()})`
                : `Show ${label.toLowerCase()} (Shift-click to show only ${label.toLowerCase()})`
            }
          >
            <span className="psl__type-check" aria-hidden="true">
              {visibleTypes[key] ? (
                <svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m5 12 5 5 9-11" />
                </svg>
              ) : null}
            </span>
            <span className="psl__nav-icon">{icon}</span>
            <span className="psl__nav-label">{label}</span>
          </button>
        ))}

        {/* "+ New Sizzle Reel" CTA — single sidebar affordance for
            creating a reel. The user explicitly rejected enumerating
            every project here ("we're not rebuilding the grid in the
            left bar") — projects appear inline in the day-grouped
            grid via FixtureBackedRecords. This button is the only
            project-related action that lives in the sidebar; it
            creates a project then opens it in the dedicated Sizzle
            Reels window (mirroring SizzleApp's onCreate flow). The
            sidebar subscribes to projects:changed broadcasts via
            useSizzleProjects, so the new project shows up as a cell
            in the grid as soon as the create returns — no manual
            re-fetch needed. */}
        <button
          type="button"
          className="psl__nav psl__nav--cta"
          onClick={() => {
            void (async () => {
              const r = await dispatch("sizzle:create", {
                name: "Untitled Sizzle"
              });
              if (r.ok) {
                // sizzle:open focuses the existing standalone Sizzle
                // window (or opens it if not yet shown) and selects
                // the project. The bus broadcast updates this
                // sidebar's project list as a side effect.
                void dispatch("sizzle:open", { projectId: r.value.id });
              }
            })();
          }}
          title="Create a new Sizzle Reel"
          aria-label="Create a new Sizzle Reel"
        >
          <span className="psl__nav-icon">
            <svg
              viewBox="0 0 24 24"
              width="11"
              height="11"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
          </span>
          <span className="psl__nav-label">New Sizzle Reel</span>
        </button>

        <div className="psl__left-section">Source App</div>
        {visibleApps.map(({ app, name, bundleId }) => (
          <button
            key={app}
            className={"psl__nav" + (activeSourceAppId === app ? " is-active" : "")}
            onClick={() => selectFilter({ kind: "sourceApp", appId: app })}
          >
            <span className="psl__nav-icon">
              <AppIcon app={app} size={11} name={name} bundleId={bundleId} />
            </span>
            <span className="psl__nav-label">{name}</span>
            <span className="psl__nav-count">{appCounts[app] ?? 0}</span>
          </button>
        ))}

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
          {isSearchActive &&
            !searchState.loading &&
            searchState.error === null &&
            searchResultCount === 0 && (
              <div className="psl__search-empty" role="status">
                No captures or Sizzle Reels match “{searchState.forQuery}”.
              </div>
            )}
          <VirtualizedGrid
            grouped={grouped}
            scrollElement={gridScrollRef}
            selectedRecordId={selectedRecordId}
            fixtureBacking={fixtureBacking}
            projectCoverRecordsById={projectCoverRecordsById}
            appLabels={appLabels}
            onSelectCell={onSelectCell}
            duplicateSizzleProject={duplicateSizzleProject}
            openProjectContextMenu={openProjectContextMenu}
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
        {projectContextMenu !== null ? (
          <LibraryProjectContextMenu
            menu={projectContextMenu}
            onClose={closeProjectContextMenu}
            onOpenProject={(projectId) => {
              closeProjectContextMenu();
              openSizzleProject(projectId);
            }}
            onDuplicateProject={(projectId) => {
              closeProjectContextMenu();
              duplicateSizzleProject(projectId);
            }}
          />
        ) : null}
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
            // Use the denormalized total-live count from app_stats —
            // same source as the top-bar's "N captures" indicator —
            // so the 1/N matches whether or not later pages are
            // loaded yet. `visibleRecords.length` only counts what
            // the keyset cursor has fetched so far.
            total: isTrashView ? visibleRecords.length : totalLive
          }}
          prevRecordId={prevRecordId}
          nextRecordId={nextRecordId}
          tool={tool}
          onToolChange={setTool}
          toolState={liftedToolState}
          blurStyle={blurStyle}
          onBlurStyleChange={setBlurStyle}
          {...(view.kind === "reel"
            ? {
                aboveStageSlot: (
                  <section className="psl__reel-wrap">
                    <div className="psl__reel-hdr">
                      <span className="psl__reel-title">
                        Timeline ·{" "}
                        {activeFilter.kind === "all"
                          ? "all sources"
                          : isTodayView
                          ? "today"
                          : isTrashView
                          ? "trash"
                          : activeSourceAppId === null
                          ? "all sources"
                          : appLabels[activeSourceAppId] ??
                            APP_INFO[activeSourceAppId]?.name ??
                            "Unknown app"}
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
                              const project = fixtureBacking.projectFor(c.id);
                              const coverCaptureId =
                                project === null
                                  ? null
                                  : resolveSizzleProjectCoverCaptureId(project);
                              const coverRecord =
                                coverCaptureId === null
                                  ? null
                                  : projectCoverRecordsById.get(coverCaptureId) ??
                                    fixtureBacking.recordById(coverCaptureId);
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
                                  <CellThumb
                                    capture={c}
                                    record={record}
                                    project={project}
                                    projectCoverRecord={coverRecord}
                                    width={140}
                                  />
                                  <span className="psl__frame-num">{c.time}</span>
                                  <span className="psl__frame-app">
                                    <AppIcon app={c.app} size={8} name={appLabels[c.app]} bundleId={c.bundleId ?? undefined} />
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
      <DetailRail
        view={view}
        record={selectedRecord}
        copyPulses={copyPulses}
        pinned={rightPinned}
        onPinChange={setRightPinned}
        activeTab={rightActiveTab}
        onActiveTabChange={setRightActiveTab}
      />

      {/* Grid-mode standalone cart rail. DetailRail returns null in
          grid mode (its tabs are all per-capture), so the cart — which
          is workspace-global — gets its own rail here that appears the
          moment the user checks their first capture. In focus/reel the
          cart is a DetailRail tab instead, so this is gated to grid. */}
      {cartIsOpenInGrid ? (
        // Render CartPanel DIRECTLY in the base `.psl__right` (which is
        // a flex column with `overflow: hidden`). Deliberately NOT
        // `.psl__right--vertical` / `.psl__right-content` /
        // `.psl__right-body` — those carry `overflow: visible` (a
        // DetailRail escape hatch so its collapsed hover-pop panel can
        // bleed leftward into the canvas) which let the cart's content
        // overflow past the rail's right edge. The cart wants a plain
        // clipped column; `.psl__cart` fills it and manages its own
        // scroll + padding.
        <aside
          className="psl__right psl__right--cart"
          aria-label="Project asset cart"
        >
          <CartPanel />
        </aside>
      ) : null}

      <footer className="psl__status">
        <div className="psl__status-l">
          <div className="psl__storage" ref={storagePanelRef}>
            <button
              className="psl__storage-trigger"
              type="button"
              aria-haspopup="dialog"
              aria-expanded={storagePanelOpen}
              onClick={() => setStoragePanelOpen((open) => !open)}
            >
              <span className="a" aria-hidden="true">●</span>
              <span>{storageLabel}</span>
            </button>
            {storagePanelOpen ? (
              <div className="psl__storage-popover" role="dialog" aria-label="Storage usage">
                {storage.error !== null ? (
                  <div className="psl__storage-error">{storage.error}</div>
                ) : null}
                <div className="psl__storage-row">
                  <div>
                    <span>App Cache</span>
                    <small>Chromium Cache + Code Cache</small>
                  </div>
                  <b>{formatBytes(appCacheBytes)}</b>
                  <button
                    type="button"
                    disabled={storageBusy}
                    onClick={() => void storage.clearAppCache()}
                  >
                    {storage.workingAction === "app-cache" ? "Clearing" : "Clear"}
                  </button>
                </div>
                <div className="psl__storage-row">
                  <div>
                    <span>Render Sizes Cache</span>
                    <small>Rebuilds as thumbnails are needed</small>
                  </div>
                  <b>{formatBytes(storage.snapshot?.renderCache.bytes ?? 0)}</b>
                  <span className="psl__storage-actions">
                    <button
                      type="button"
                      disabled={storageBusy}
                      onClick={() => void storage.maintainRenderCache("trim")}
                    >
                      {storage.workingAction === "render-trim" ? "Trimming" : "Trim"}
                    </button>
                    <button
                      type="button"
                      disabled={storageBusy}
                      onClick={() => void storage.maintainRenderCache("clear")}
                    >
                      {storage.workingAction === "render-clear" ? "Clearing" : "Clear"}
                    </button>
                  </span>
                </div>
                <div className="psl__storage-row">
                  <div>
                    <span>Documents/PwrSnap</span>
                    <small>{sourceSnapCount} snaps</small>
                  </div>
                  <b>
                    {formatBytes(
                      storage.snapshot?.sourceCaptures.documentsBytes ??
                        storage.summary?.sourceCaptures.bytes ??
                        0
                    )}
                  </b>
                </div>
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className={
              "psl__ai-toggle" +
              (aiEnabled ? " is-on" : "") +
              (enrichmentProviderAvailable === false ? " is-configure" : "")
            }
            role="switch"
            aria-checked={aiEnabled}
            disabled={aiToggleBusy}
            title={
              enrichmentProviderAvailable === false && !aiEnabled
                ? "Open AI Providers settings to configure Codex, Gemini, or another provider"
                : aiEnabled
                ? `Turn off automatic ${enrichmentProviderLabel} enrichment for new captures`
                : `Turn on automatic ${enrichmentProviderLabel} enrichment for new captures`
            }
            onClick={toggleAiEnabled}
          >
            <span className="psl__ai-toggle-track" aria-hidden="true">
              <span className="psl__ai-toggle-thumb" />
            </span>
            <span>
              {enrichmentProviderAvailable === false && !aiEnabled ? (
                <>
                  Configure <b>AI</b>
                </>
              ) : (
                <>
                  {enrichmentProviderLabel} enrich <b>{aiEnabled ? "on" : "off"}</b>
                </>
              )}
            </span>
          </button>
        </div>
        <div className="psl__status-r">
          <span>
            <b>{appVersion !== null ? `v${appVersion}` : "—"}</b>
          </span>
        </div>
      </footer>
      {aiConsentDialogOpen ? (
        <AiConsentDialog
          onCancel={() => setAiConsentDialogOpen(false)}
          onAccept={acceptAiConsent}
        />
      ) : null}
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
  selectedRecordId: string | null;
  fixtureBacking: FixtureBackedRecords;
  projectCoverRecordsById: Map<string, CaptureRecord>;
  appLabels: Record<string, string>;
  onSelectCell: (c: Capture) => void;
  duplicateSizzleProject: (projectId: string, event?: ReactMouseEvent<HTMLElement>) => void;
  openProjectContextMenu: (
    projectId: string,
    projectName: string,
    event: ReactMouseEvent<HTMLElement>
  ) => void;
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

function LibraryProjectContextMenu({
  menu,
  onClose,
  onOpenProject,
  onDuplicateProject
}: {
  menu: ProjectContextMenuState;
  onClose: () => void;
  onOpenProject: (projectId: string) => void;
  onDuplicateProject: (projectId: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onMouseDown(event: MouseEvent): void {
      const root = rootRef.current;
      if (root === null) return;
      if (event.target instanceof Node && root.contains(event.target)) return;
      onClose();
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  }, [onClose]);

  useEffect(() => {
    requestAnimationFrame(() => rootRef.current?.focus());
  }, []);

  return (
    <div
      ref={rootRef}
      className="psl__context-menu"
      role="menu"
      tabIndex={-1}
      style={{ left: `${menu.x}px`, top: `${menu.y}px` }}
      onContextMenu={(event) => event.preventDefault()}
      aria-label={`${menu.projectName} actions`}
    >
      <button
        type="button"
        role="menuitem"
        className="psl__context-menu-row"
        onClick={() => onOpenProject(menu.projectId)}
      >
        Open
      </button>
      <button
        type="button"
        role="menuitem"
        className="psl__context-menu-row"
        onClick={() => onDuplicateProject(menu.projectId)}
      >
        Duplicate
      </button>
    </div>
  );
}

function VirtualizedGrid({
  grouped,
  scrollElement,
  selectedRecordId,
  fixtureBacking,
  projectCoverRecordsById,
  appLabels,
  onSelectCell,
  duplicateSizzleProject,
  openProjectContextMenu,
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
                selectedRecordId={selectedRecordId}
                fixtureBacking={fixtureBacking}
                projectCoverRecordsById={projectCoverRecordsById}
                appLabels={appLabels}
                onSelectCell={onSelectCell}
                duplicateSizzleProject={duplicateSizzleProject}
                openProjectContextMenu={openProjectContextMenu}
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
  selectedRecordId,
  fixtureBacking,
  projectCoverRecordsById,
  appLabels,
  onSelectCell,
  duplicateSizzleProject,
  openProjectContextMenu,
  preloadFullRes,
  isTrashView,
  trashCapture,
  restoreCaptureAction,
  purgeCaptureAction
}: {
  cells: DayGroup["items"];
  gridTemplate: string;
  isLastInDay: boolean;
  selectedRecordId: string | null;
  fixtureBacking: FixtureBackedRecords;
  projectCoverRecordsById: Map<string, CaptureRecord>;
  appLabels: Record<string, string>;
  onSelectCell: (c: Capture) => void;
  duplicateSizzleProject: (projectId: string, event?: ReactMouseEvent<HTMLElement>) => void;
  openProjectContextMenu: (
    projectId: string,
    projectName: string,
    event: ReactMouseEvent<HTMLElement>
  ) => void;
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
        const project = fixtureBacking.projectFor(c.id);
        const projectCoverId =
          project === null ? null : resolveSizzleProjectCoverCaptureId(project);
        const projectCoverRecord =
          projectCoverId === null
            ? null
            : projectCoverRecordsById.get(projectCoverId) ??
              fixtureBacking.recordById(projectCoverId);
        const isProject = c.kind === "project";
        const projectId = isProject && c.projectId !== undefined ? c.projectId : null;
        // Cart checkbox shows for real (non-project) captures outside
        // trash. The checkbox SELF-SUBSCRIBES to the cart (see
        // <CartCellCheckbox>) so a cart toggle re-renders only the
        // checkbox, not this whole cell. The collected-cell accent
        // ring is applied via CSS `:has(.psl__cell-cart.is-checked)`
        // so the cell wrapper doesn't need React-level membership.
        const cartEligible = record !== null && !isProject && !isTrashView;
        return (
          <div
            key={c.id}
            className={
              "psl__cell" +
              (record?.id === selectedRecordId ? " is-selected" : "") +
              (isProject ? " psl__cell--project" : "")
            }
            data-cell-id={record?.id ?? ""}
            onClick={() => onSelectCell(c)}
            onContextMenu={(event) => {
              if (projectId !== null) {
                openProjectContextMenu(projectId, c.n, event);
              }
            }}
            onMouseEnter={() => preloadFullRes(record ?? null)}
          >
            <div className="psl__cell-thumb">
              <CellThumb
                capture={c}
                record={record}
                project={project}
                projectCoverRecord={projectCoverRecord}
                width={400}
              />
              {cartEligible && record !== null ? (
                <CartCellCheckbox captureId={record.id} />
              ) : null}
              <span className="psl__cell-time">{c.time}</span>
              <span className="psl__cell-app-overlay">
                {isProject ? (
                  // Project cells get the project name as the corner
                  // chip — there's no source app to attribute.
                  <span className="psl__cell-project-name">{c.n}</span>
                ) : (
                  <AppTag app={c.app} name={appLabels[c.app] ?? "Unknown app"} size="sm" bundleId={c.bundleId ?? undefined} />
                )}
              </span>
              {projectId !== null ? (
                <button
                  type="button"
                  className="psl__cell-trash psl__cell-duplicate"
                  title="Duplicate Sizzle Reel"
                  aria-label={`Duplicate ${c.n}`}
                  onClick={(event) => duplicateSizzleProject(projectId, event)}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="8" y="8" width="11" height="11" rx="2" />
                    <path d="M5 15H4a1 1 0 0 1-1-1V5a2 2 0 0 1 2-2h9a1 1 0 0 1 1 1v1" />
                  </svg>
                </button>
              ) : null}
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
          </div>
        );
      })}
    </div>
  );
}
