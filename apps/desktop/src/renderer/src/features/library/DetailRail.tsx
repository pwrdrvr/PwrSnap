// DetailRail — right-side panel showing capture metadata, the Codex
// title + description editor, suggested tags + free-form tag input,
// and the L/M/H copy row. Visible in Focus + Reel modes; returns null
// in Grid (mode-conditional lives INSIDE the component per
// architecture-strategist's recommendation D6).
//
// Issue #85 redesign: title and description are now independent fields,
// both editable in the sidebar, matching the float-over toast's
// affordances. The Codex status surfaces through the shared
// CodexStatusPill so "thinking" looks identical on both surfaces.
//
// Tabs are now vertical (VS-Code-style activity bar on the right edge)
// with three surfaces: Info (the prior "Detail" panel), OCR, and Chat
// (placeholder for the upcoming Codex dynamic-tools wiring). The bar
// can be pinned open or auto-hidden — same hover-pop pattern the
// editor's chrome uses. The L/M/H copy row + secondary action row sit
// in a persistent footer beneath the bar so a tab switch (or a hover-
// pop closing) never strands the user without copy/file/trash access.
//
// Pinned + last-selected state is per-window local state — settings
// persistence can land later if cross-window memory becomes desirable.

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
  AiEnrichmentBudgetStatus,
  AiRunUsageDetail,
  CaptureEnrichment,
  CaptureRecord,
  LibrarySidebarTab,
  SettingsChangedEvent,
  Settings,
  SuggestedTag
} from "@pwrsnap/shared";
import { CopyButton, presetMetrics, type CopyPreset } from "../shared/CopyButton";
import { CodexStatusPill, enrichmentBackendLabel } from "../shared/CodexStatusPill";
import { useFieldEditor } from "../shared/useFieldEditor";
import { usePresetRenderMetrics } from "../shared/usePresetRenderMetrics";
import { useVideoExportPresets } from "../shared/useVideoExportPresets";
import { useVideoPresetMetrics } from "../shared/useVideoPresetMetrics";
import { VideoExportPresetGrid } from "../shared/VideoExportPresetGrid";
import { AppTag } from "../shared/AppIcons";
import { DeleteConfirm } from "../shared/DeleteConfirm";
import {
  RightActivityBar,
  type RightActivityTab
} from "../shared/RightActivityBar";
import "../shared/RightActivityBar.css";
import { LibraryChatPanel } from "./chat/LibraryChatPanel";
import { cacheUrl, captureSrcUrl, dispatch, startCaptureDrag, subscribe } from "../../lib/pwrsnap";
import { useSizzleProjects } from "../../lib/useSizzleProjects";
import { useCart } from "./CartContext";
import { CartPanel } from "./CartPanel";
import { mapBundleIdToAppId } from "./adapter";
import type { LibraryView } from "./library-view";

const COPY_PRESETS = ["low", "med", "high"] as const;
const COPY_LABELS: Record<(typeof COPY_PRESETS)[number], string> = {
  low: "Low",
  med: "Med",
  high: "High"
};

type SidebarTab = LibrarySidebarTab;

export type DetailRailProps = {
  readonly view: LibraryView;
  readonly record: CaptureRecord | null;
  readonly copyPulses?: Readonly<Record<CopyPreset, number>>;
  /** Controlled pin state — when both `pinned` and `onPinChange` are
   *  provided the rail is "controlled" by the parent (Library top-bar
   *  layout toggle owns the truth + settings persistence). When
   *  omitted, the rail falls back to its own local state seeded from
   *  Settings on mount. Symmetric prop pattern to the Editor's
   *  controlled mode. */
  readonly pinned?: boolean;
  readonly onPinChange?: (next: boolean) => void;
  /** Controlled active-tab — same shape as `pinned`. */
  readonly activeTab?: LibrarySidebarTab;
  readonly onActiveTabChange?: (next: LibrarySidebarTab) => void;
  /** Soft-delete handler. Library routes this through its delete
   *  coordinator (advance-to-next in Focus, arm the Undo toast + ⌘Z
   *  restore). When omitted, the rail falls back to a bare `library:delete`
   *  dispatch so it stays usable in isolation. */
  readonly onTrash?: (id: string) => void;
};

export function DetailRail({
  view,
  record,
  copyPulses,
  pinned: pinnedProp,
  onPinChange,
  activeTab: activeTabProp,
  onActiveTabChange,
  onTrash
}: DetailRailProps): ReactElement | null {
  // Skip the image render-metrics IPC for video captures — the
  // sharp-based preset pipeline is image-only and the video branch
  // below renders GIF / MP4 export cards instead of Low / Med / High
  // clipboard cards. Mirrors TrayMenu.tsx + FloatOverHost.tsx.
  const renderMetrics = usePresetRenderMetrics(
    record?.kind === "image" ? record.id : null,
    record?.kind === "image" ? record.edits_version : null
  );
  const [enrichment, setEnrichment] = useState<CaptureEnrichment | null>(null);
  // Per-(format, preset) export machinery for the 6-card grid.
  // Owns six button states + the four bus verbs the cards drive:
  //   click body → clipboard:copyVideoFile
  //   click FILE chip → clipboard:copyVideoPath
  //   drag FILE chip → startVideoDrag (fire-and-forget IPC)
  // Input goes null when the selection isn't a video so the hook
  // stays idle and the trigger fns no-op.
  const videoCaptureId =
    record?.kind === "video" && record.video !== null && record.video !== undefined
      ? record.id
      : null;
  const {
    states: videoExportStates,
    triggerCopy: triggerVideoCopy,
    triggerCopyPath: triggerVideoCopyPath,
    triggerDrag: triggerVideoDrag
  } = useVideoExportPresets(videoCaptureId === null ? null : { captureId: videoCaptureId });
  // Per-(format, preset) dimensions + byte estimates for the grid
  // cards. Estimated until the user clicks a card and the cache
  // row lands; exact thereafter. Mirrors `usePresetRenderMetrics`
  // for images.
  const videoPresetMetrics = useVideoPresetMetrics(videoCaptureId);
  // Active tab + pin state. The pin pair and the tab pair are
  // controlled INDEPENDENTLY — a caller can control just the pin
  // (e.g. drive it from a title-bar toggle) while letting the rail
  // own which tab is active, or vice versa. The previous
  // all-or-nothing `isControlled` check silently degraded a partial
  // pass to fully-uncontrolled, which was a footgun: passing
  // `pinned` without `onPinChange` made the prop a no-op. Independent
  // pairs match React's standard controlled-input idiom (`value` +
  // `onChange` per input).
  //
  // Pair coherence is checked at dev-time: passing one half of a
  // pair without the other emits a console.warn so a caller that
  // intended to control sees the bug instead of silent fallback.
  const [localActiveTab, setLocalActiveTab] = useState<SidebarTab>("info");
  const [localPinned, setLocalPinned] = useState<boolean>(true);
  const [budgetStatus, setBudgetStatus] = useState<AiEnrichmentBudgetStatus | null>(null);
  // Which backend runs enrichment — so the status pill + OCR copy say "Grok" /
  // "Gemini" instead of always "Codex". Derived from the enrichment Settings
  // default; refreshed on settings changes.
  const [enrichmentLabel, setEnrichmentLabel] = useState<{
    providerLabel: string;
    modelLabel: string | undefined;
  }>({ providerLabel: "Codex", modelLabel: undefined });

  const refreshBudgetStatus = useCallback(async (): Promise<void> => {
    const result = await dispatch("codex:budgetStatus", {});
    if (result.ok) setBudgetStatus(result.value);
  }, []);
  const initialReadDoneRef = useRef<boolean>(false);
  // Subscribe to the canonical sizzle project list so the Project
  // tab can appear/disappear without a relaunch. The hook fetches
  // once on mount + subscribes to events:sizzle:projects:changed.
  const { projects: sizzleProjects } = useSizzleProjects();
  // Projects this capture is a scene of. The Project tab only
  // appears when projects.length > 0 (any project exists) — when
  // the capture isn't in any project the panel renders an empty
  // state with a "Add to a Sizzle Reel…" picker.
  const containingProjects = useMemo(
    () =>
      record === null
        ? []
        : sizzleProjects.filter((p) =>
            p.scenes.some((s) => s.captureId === record.id)
          ),
    [sizzleProjects, record]
  );
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  // Keep activeProjectId valid as the containingProjects set changes
  // (e.g. user removed the capture from this project elsewhere).
  useEffect(() => {
    if (
      activeProjectId !== null &&
      !containingProjects.some((p) => p.id === activeProjectId)
    ) {
      setActiveProjectId(containingProjects[0]?.id ?? null);
    } else if (activeProjectId === null && containingProjects.length > 0) {
      setActiveProjectId(containingProjects[0]!.id);
    }
  }, [containingProjects, activeProjectId]);

  // The Project Asset Cart. The Cart tab appears whenever the cart is
  // non-empty (in any mode where the rail renders). cartCount drives
  // the tab badge + the auto-pop effect below.
  const cart = useCart();
  const cartCount = cart.captureIds.length;

  const isPinControlled =
    pinnedProp !== undefined && onPinChange !== undefined;
  const isTabControlled =
    activeTabProp !== undefined && onActiveTabChange !== undefined;
  const pinned = isPinControlled ? pinnedProp : localPinned;
  const activeTab = isTabControlled ? activeTabProp : localActiveTab;

  // Skip the settings read entirely when BOTH pairs are controlled —
  // the parent owns the truth and handles its own hydration. When
  // either pair is uncontrolled the rail still owns that half's
  // state and reads it from Settings on mount.
  const fullyControlled = isPinControlled && isTabControlled;
  useEffect(() => {
    if (fullyControlled) return undefined;
    let cancelled = false;
    void dispatch("settings:read", {}).then((result) => {
      if (cancelled) return;
      if (initialReadDoneRef.current) return; // user already touched it
      if (!result.ok) return;
      // settings:read returns a fully-shaped Settings at runtime
      // (parseV1 fills any missing nested fields with defaults), but
      // renderer test mocks frequently return `{ ok: true, value:
      // undefined }` for verbs they don't explicitly stub. Keep an
      // optional chain on `result.value` itself so a mock that
      // forgets to wire settings:read doesn't crash the panel.
      const rail = (result.value as Settings | undefined)?.library
        ?.detailRail;
      if (rail === undefined) return;
      // Only hydrate the halves we still own.
      if (!isPinControlled) setLocalPinned(rail.pinned);
      if (!isTabControlled) setLocalActiveTab(rail.lastSelectedTab);
      initialReadDoneRef.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, [fullyControlled, isPinControlled, isTabControlled]);

  // Track the enrichment backend label (provider + model) so the status pill +
  // OCR copy name the actual agent. Read once + refresh on settings changes.
  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      void dispatch("settings:read", {}).then((result) => {
        if (cancelled || !result.ok) return;
        const enrichment = (result.value as Settings | undefined)?.ai?.defaults?.enrichment;
        setEnrichmentLabel(enrichmentBackendLabel(enrichment));
      });
    };
    load();
    const off = subscribe(EVENT_CHANNELS.settingsChanged, () => load());
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  // Dev-only coherence warning. We catch:
  //   • `pinned` without `onPinChange` (or vice versa)
  //   • `activeTab` without `onActiveTabChange` (or vice versa)
  // Each is a likely bug — the caller probably intended to control
  // that pair and forgot the handler half. Gated on
  // `import.meta.env.DEV` so the entire block tree-shakes out of
  // production bundles AND so React StrictMode's double-invoke
  // doesn't produce duplicate console output during dev.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const pinHalf = pinnedProp !== undefined;
    const pinHandler = onPinChange !== undefined;
    if (pinHalf !== pinHandler) {
      // eslint-disable-next-line no-console
      console.warn(
        "[DetailRail] partial pin control — pass both `pinned` and `onPinChange` together (or neither)"
      );
    }
    const tabHalf = activeTabProp !== undefined;
    const tabHandler = onActiveTabChange !== undefined;
    if (tabHalf !== tabHandler) {
      // eslint-disable-next-line no-console
      console.warn(
        "[DetailRail] partial tab control — pass both `activeTab` and `onActiveTabChange` together (or neither)"
      );
    }
  }, [pinnedProp, onPinChange, activeTabProp, onActiveTabChange]);

  // Inside the branches below TypeScript can't narrow `onPinChange`
  // through the separately-computed `isPinControlled`, so we check
  // the handler directly. The READ path above uses `isPinControlled`
  // (both halves must agree to USE pinnedProp); the WRITE path here
  // routes through the handler whenever it's defined — even if the
  // controlled half is missing the value, the user's click should
  // still surface to the parent rather than silently dropping. The
  // partial-control warning above fires first to surface the bug.
  const writePinned = useCallback(
    (next: boolean): void => {
      if (onPinChange !== undefined) {
        onPinChange(next);
        return;
      }
      initialReadDoneRef.current = true;
      setLocalPinned(next);
      void dispatch("settings:write", {
        library: { detailRail: { pinned: next } }
      });
    },
    [onPinChange]
  );

  const writeActiveTab = useCallback(
    (next: SidebarTab): void => {
      if (onActiveTabChange !== undefined) {
        onActiveTabChange(next);
        return;
      }
      initialReadDoneRef.current = true;
      setLocalActiveTab(next);
      void dispatch("settings:write", {
        library: { detailRail: { lastSelectedTab: next } }
      });
    },
    [onActiveTabChange]
  );

  // Auto-pop the Cart tab when the user checks their FIRST item (cart
  // count transitions 0 → 1). Subsequent additions don't re-pop, so
  // the user can switch to the Info tab while collecting without the
  // cart yanking focus back on every check. Tracks the previous count
  // in a ref so we only fire on the rising 0→1 edge.
  const prevCartCountRef = useRef(cartCount);
  useEffect(() => {
    if (prevCartCountRef.current === 0 && cartCount > 0) {
      writeActiveTab("cart");
    }
    prevCartCountRef.current = cartCount;
  }, [cartCount, writeActiveTab]);

  useEffect(() => {
    if (record === null) {
      setEnrichment(null);
      return undefined;
    }
    // Clear synchronously so child `useFieldEditor` instances snapshot
    // EMPTY accepted/suggested for the new capture instead of the
    // previous capture's stale values. The dispatch below repopulates
    // within ms. Without this clear, navigating between captures in
    // Reel mode briefly leaked the prior capture's text into the new
    // capture's inputs.
    setEnrichment(null);
    let cancelled = false;
    void dispatch("codex:enrichment", { captureId: record.id }).then((result) => {
      if (!cancelled) {
        setEnrichment(result.ok ? result.value : null);
      }
    });
    const unsubscribe = window.pwrsnapApi?.on(EVENT_CHANNELS.aiRunUpdated, (payload) => {
      const next = (payload as { enrichment?: CaptureEnrichment | null }).enrichment;
      if (next === undefined || next === null || next.captureId !== record.id) return;
      setEnrichment(next);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [record?.id]);

  useEffect(() => {
    void refreshBudgetStatus();
    const unsubscribeBudget = window.pwrsnapApi?.on(EVENT_CHANNELS.aiBudgetUpdated, (payload) => {
      setBudgetStatus(payload as AiEnrichmentBudgetStatus);
    });
    const unsubscribeSettings = window.pwrsnapApi?.on(EVENT_CHANNELS.settingsChanged, (payload) => {
      const { settings } = payload as SettingsChangedEvent;
      if (settings.ai.budgetSafetyDisabledAt === null) {
        void refreshBudgetStatus();
      }
    });
    return () => {
      unsubscribeBudget?.();
      unsubscribeSettings?.();
    };
  }, [refreshBudgetStatus]);

  // Tabs are memo'd UNCONDITIONALLY (Rules of Hooks: every render
  // must call the same hooks in the same order). The original
  // implementation kept `useMemo` BELOW the `view.kind === "grid"`
  // / `record === null` early returns, which silently broke React's
  // hook-count invariant the moment the component transitioned from
  // grid (returns null after fewer hooks) to focus (continues past
  // the early returns and reaches the useMemo). React detects the
  // mismatch and bails the render — the parent commit never
  // applies, the outer `.psl[data-mode]` stays at "grid", and any
  // E2E that exercises the cell-click → focus transition hangs on
  // the data-mode assertion (caught via library-source-filter.spec
  // L373 on CI). Compute tabs up front; the early returns below
  // just gate rendering, not hook-count.
  const hasOcrText = (enrichment?.ocrText ?? "").length > 0;
  const tabs: ReadonlyArray<RightActivityTab<SidebarTab>> = useMemo(
    () => [
      {
        id: "info",
        label: "Info",
        title: "Info",
        icon: INFO_ICON
      },
      {
        id: "ocr",
        label: "OCR",
        title: hasOcrText ? "OCR — extracted text ready" : "OCR",
        badge: hasOcrText,
        icon: OCR_ICON
      },
      {
        id: "chat",
        label: "Chat",
        title: "Chat with Codex",
        icon: CHAT_ICON
      },
      // Project tab appears only when any sizzle project exists in
      // the workspace. The panel itself handles the "this capture
      // isn't in any project yet" case so the tab itself is a
      // workspace-level affordance, not a per-capture one.
      ...(sizzleProjects.length > 0
        ? [
            {
              id: "project" as const,
              label: "Project",
              title:
                containingProjects.length > 0
                  ? `In ${containingProjects.length} Sizzle Reel${containingProjects.length === 1 ? "" : "s"}`
                  : "Not yet in a Sizzle Reel",
              badge: containingProjects.length > 0,
              icon: PROJECT_ICON
            }
          ]
        : []),
      // Cart tab appears whenever the draft cart is non-empty. It's a
      // workspace-global affordance (not per-capture), so unlike the
      // Project tab it doesn't depend on the selected record. The
      // count rides in the label so the user sees how many assets
      // they've collected at a glance.
      ...(cartCount > 0
        ? [
            {
              id: "cart" as const,
              label: `Cart ${cartCount}`,
              title: `${cartCount} asset${cartCount === 1 ? "" : "s"} collected for a Sizzle Reel`,
              badge: true,
              icon: CART_ICON
            }
          ]
        : [])
    ],
    [hasOcrText, sizzleProjects.length, containingProjects.length, cartCount]
  );

  // If the active tab no longer exists in the tab set — e.g. the user
  // was on the Cart tab and then committed/cleared the cart (the Cart
  // tab is gated on cartCount > 0), or the only sizzle project got
  // deleted while on the Project tab — fall back to Info. Without this
  // the RightActivityBar would render a panel for a tab with no
  // corresponding chip in the strip (an orphaned/headless panel).
  useEffect(() => {
    if (!tabs.some((t) => t.id === activeTab)) {
      writeActiveTab("info");
    }
  }, [tabs, activeTab, writeActiveTab]);

  // Grid mode: rail not rendered. Future surfaces that want a rail
  // in Grid (bulk-select, etc.) only change one component.
  if (view.kind === "grid") return null;
  if (record === null) return null;

  const capturedAt = formatTimestamp(record.captured_at);
  const sourceName = record.source_app_name ?? "Unknown app";
  const appId = mapBundleIdToAppId(record.source_app_bundle_id);
  const hasExactRenderMetrics = renderMetrics.high?.exact === true;
  // `record.video` is `VideoCaptureMetadata | null | undefined` even
  // for video-kind records (older recordings persisted before the
  // metadata column was backfilled). Carry both checks into the
  // boolean so the video-branch JSX can assume `videoMeta` is present.
  const videoMeta =
    record.kind === "video" && record.video !== null && record.video !== undefined
      ? record.video
      : null;
  const isVideo = videoMeta !== null;
  const codexStatus = enrichment?.status ?? null;
  const draftAvailable =
    (enrichment?.suggestedTitle ?? "").trim().length > 0 ||
    (enrichment?.suggestedDescription ?? "").trim().length > 0;
  const titleAccepted =
    enrichment?.acceptedTitle !== null &&
    enrichment?.acceptedTitle !== undefined &&
    enrichment.acceptedTitle === enrichment.suggestedTitle;
  const descriptionAccepted =
    enrichment?.acceptedDescription !== null &&
    enrichment?.acceptedDescription !== undefined &&
    enrichment.acceptedDescription === enrichment.suggestedDescription;
  const allDraftsAccepted =
    (enrichment?.suggestedTitle ?? "") !== "" &&
    (enrichment?.suggestedDescription ?? "") !== "" &&
    titleAccepted &&
    descriptionAccepted;
  const aiSafetyDisabled = budgetStatus?.mode === "safety_disabled";

  // renderPanel returns the panel BODY only — the outer role="tabpanel"
  // wrapper (with id + aria-labelledby) is supplied by RightActivityBar
  // so the tab→panel aria-controls link is single-source-of-truth. Two
  // nested role="tabpanel" elements would confuse assistive tech about
  // which container is the "real" panel.
  const renderPanel = (id: SidebarTab): ReactElement => {
    if (id === "info") {
      return (
        <div className="psl__right-body">
          <DetailTab
            record={record}
            enrichment={enrichment}
            sourceName={sourceName}
            appId={appId}
            capturedAt={capturedAt}
            codexStatus={codexStatus}
            draftAvailable={draftAvailable}
            allDraftsAccepted={allDraftsAccepted}
            aiSafetyDisabled={aiSafetyDisabled}
            providerLabel={enrichmentLabel.providerLabel}
            modelLabel={enrichmentLabel.modelLabel}
            onEnrichmentUpdate={setEnrichment}
          />
        </div>
      );
    }
    if (id === "ocr") {
      return (
        <div className="psl__right-body">
          <OcrTab
            record={record}
            enrichment={enrichment}
            aiSafetyDisabled={aiSafetyDisabled}
            providerLabel={enrichmentLabel.providerLabel}
            modelLabel={enrichmentLabel.modelLabel}
          />
        </div>
      );
    }
    if (id === "project") {
      return (
        <div className="psl__right-body">
          <ProjectTab
            record={record}
            allProjects={sizzleProjects}
            containingProjects={containingProjects}
            activeProjectId={activeProjectId}
            onSelectProject={setActiveProjectId}
          />
        </div>
      );
    }
    if (id === "cart") {
      // CartPanel is workspace-global — it reads the cart itself via
      // useDraftCart and doesn't need the selected record.
      return (
        <div className="psl__right-body">
          <CartPanel />
        </div>
      );
    }
    return (
      <div className="psl__right-body psl__right-body--chat">
        <LibraryChatPanel anchorCaptureId={record.id} />
      </div>
    );
  };

  return (
    <aside className="psl__right psl__right--vertical" aria-label="Capture details">
      <div className="psl__right-content">
        <RightActivityBar
          tabs={tabs}
          activeTab={activeTab}
          pinned={pinned}
          onTabChange={writeActiveTab}
          onPinChange={writePinned}
          renderPanel={renderPanel}
          testIdPrefix="psl-right"
          pinnedWidthPx={320}
        />
      </div>

      <div className="psl__right-footer" data-testid="psl-right-footer">
        <div>
          <div className="psl__copy-eyebrow">
            <span>{isVideo ? "Export" : "Copy to clipboard"}</span>
            <span className="psl__copy-eyebrow-line" />
            {isVideo ? null : (
              <span className="psl__copy-eyebrow-meta">
                {hasExactRenderMetrics ? "actual files" : "rendering files"}
              </span>
            )}
          </div>
          {isVideo && videoMeta !== null ? (
            // 6-card grid (2 rows × 3 cards) — GIF L/M/H on top,
            // MP4 L/M/H below. Each card supports click-copy +
            // FILE-chip copy-path + FILE-chip drag-out, mirroring
            // the image L/M/H affordances. State + metrics live in
            // the two hooks above; the grid is purely presentational.
            <div data-testid="psl-copy-row-video">
              <VideoExportPresetGrid
                metrics={videoPresetMetrics}
                states={videoExportStates}
                onCopy={triggerVideoCopy}
                onCopyPath={triggerVideoCopyPath}
                onDrag={triggerVideoDrag}
              />
            </div>
          ) : (
            <div className="psl__copy-row">
              {COPY_PRESETS.map((p) => {
                const m =
                  renderMetrics[p] ??
                  presetMetrics(p, record.width_px, record.height_px, record.byte_size);
                return (
                  <CopyButton
                    key={p}
                    preset={p}
                    label={COPY_LABELS[p]}
                    dim={m.dim}
                    bytes={m.bytes}
                    onCopy={(preset) => {
                      void dispatch("clipboard:copy-file", { captureId: record.id, preset });
                    }}
                    onCopyPath={(preset) => {
                      void dispatch("clipboard:copy-path", { captureId: record.id, preset });
                    }}
                    onDrag={(preset) => startCaptureDrag(record.id, preset)}
                    copyPulse={copyPulses?.[p] ?? 0}
                  />
                );
              })}
            </div>
          )}
        </div>

        <div className="psl__action-row">
          {record.deleted_at !== null ? (
            <>
              <button
                type="button"
                title="Restore from Trash"
                onClick={() => {
                  void dispatch("library:restore", { id: record.id });
                }}
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M3 12a9 9 0 1 0 3-6.7" />
                  <path d="M3 4v5h5" />
                </svg>
                Restore
              </button>
              <button
                type="button"
                className="is-danger"
                title="Delete permanently"
                onClick={() => {
                  const ok = window.confirm(
                    "Permanently delete this capture? This cannot be undone."
                  );
                  if (!ok) return;
                  void dispatch("library:purge", { id: record.id });
                }}
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M3 7h18M8 7V4h8v3M6 7l1 14h10l1-14" />
                </svg>
                Delete
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                title={
                  isVideo
                    ? "Click to reveal in Finder"
                    : "Drag PNG file or click to reveal in Finder"
                }
                // Image: this is the only drag affordance in the
                // rail, so it carries `draggable` + HIGH preset.
                // Video: drag-out lives in the 6-card grid above
                // (each card drags its own format/preset combo via
                // `startVideoDrag`). The action-row button stays a
                // simple "click to reveal in Finder" affordance —
                // no drag for video, no encoding triggered here.
                draggable={!isVideo}
                onClick={() => {
                  void dispatch("capture:reveal", { captureId: record.id });
                }}
                onDragStart={(event) => {
                  event.preventDefault();
                  startCaptureDrag(record.id, "high");
                }}
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <path d="M14 2v6h6" />
                </svg>
                File
              </button>
              {view.kind !== "focus" && view.kind !== "reel" && (
                <button
                  type="button"
                  title="Open in editor"
                  onClick={() => {
                    void dispatch("editor:open", { captureId: record.id });
                  }}
                >
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7" />
                  </svg>
                  Editor
                </button>
              )}
              <DeleteConfirm
                message="Move to Trash?"
                detail="You can undo this."
                placement="top"
                onConfirm={() => {
                  if (onTrash !== undefined) onTrash(record.id);
                  else void dispatch("library:delete", { id: record.id });
                }}
              >
                {(trigger) => (
                  <button
                    type="button"
                    className="is-danger"
                    title="Move to Trash"
                    {...trigger}
                  >
                    <svg
                      width="11"
                      height="11"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M3 7h18M8 7V4h8v3M6 7l1 14h10l1-14" />
                    </svg>
                  </button>
                )}
              </DeleteConfirm>
            </>
          )}
        </div>
      </div>
    </aside>
  );
}

const INFO_ICON: ReactElement = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8h0M11 12h1v5h1" />
  </svg>
);

const OCR_ICON: ReactElement = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M4 7V5h4M20 7V5h-4M4 17v2h4M20 17v2h-4" />
    <path d="M7 9h10M7 13h10M7 17h6" />
  </svg>
);

const CHAT_ICON: ReactElement = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M4 5h16v11H8l-4 4z" />
  </svg>
);

/** Stacked-film icon for the Project tab. Same "play strip"
 *  language used by the sidebar Sizzle Reels rows, to keep the
 *  Library/Right-Rail/Sidebar visual triad consistent. */
const PROJECT_ICON: ReactElement = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="3" y="6" width="14" height="12" rx="2" />
    <path d="m17 10 4-2v8l-4-2z" fill="currentColor" />
  </svg>
);

/** Checklist / collected-items icon for the Cart tab. */
const CART_ICON: ReactElement = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M3 5h2l1.6 9.5a1 1 0 0 0 1 .8h8.8a1 1 0 0 0 1-.8L20 8H6" />
    <circle cx="9" cy="19" r="1.2" fill="currentColor" />
    <circle cx="17" cy="19" r="1.2" fill="currentColor" />
  </svg>
);

type DetailTabProps = {
  readonly record: CaptureRecord;
  readonly enrichment: CaptureEnrichment | null;
  readonly sourceName: string;
  readonly appId: ReturnType<typeof mapBundleIdToAppId>;
  readonly capturedAt: string;
  readonly codexStatus: CaptureEnrichment["status"] | null;
  readonly draftAvailable: boolean;
  readonly allDraftsAccepted: boolean;
  readonly aiSafetyDisabled: boolean;
  /** Enrichment backend label (e.g. "Grok") + optional model for the pill. */
  readonly providerLabel: string;
  readonly modelLabel: string | undefined;
  readonly onEnrichmentUpdate: (next: CaptureEnrichment) => void;
};

function DetailTab({
  record,
  enrichment,
  sourceName,
  appId,
  capturedAt,
  codexStatus,
  draftAvailable,
  allDraftsAccepted,
  aiSafetyDisabled,
  providerLabel,
  modelLabel,
  onEnrichmentUpdate
}: DetailTabProps): ReactElement {
  const acceptedTitle = enrichment?.acceptedTitle ?? "";
  const suggestedTitle = enrichment?.suggestedTitle ?? "";
  const acceptedDescription = enrichment?.acceptedDescription ?? "";
  const suggestedDescription = enrichment?.suggestedDescription ?? "";
  const acceptedFilenameStem = enrichment?.acceptedFilenameStem ?? "";
  const suggestedFilenameStem = enrichment?.suggestedFilenameStem ?? "";
  const effectiveFilenameStem = acceptedFilenameStem || suggestedFilenameStem;
  const [usageDetail, setUsageDetail] = useState<AiRunUsageDetail | null>(null);

  useEffect(() => {
    const runId = enrichment?.latestRunId ?? null;
    if (runId === null) {
      setUsageDetail(null);
      return;
    }
    let cancelled = false;
    void dispatch("codex:usageRunDetail", { runId }).then((result) => {
      if (!cancelled) {
        setUsageDetail(result.ok && isAiRunUsageDetail(result.value) ? result.value : null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [enrichment?.latestRunId, enrichment?.status]);

  const [titleValue, titleOrigin, setTitleEdit, commitTitle] = useFieldEditor({
    captureId: record.id,
    accepted: acceptedTitle,
    suggested: suggestedTitle
  });
  const [descriptionValue, descriptionOrigin, setDescriptionEdit, commitDescription] =
    useFieldEditor({
      captureId: record.id,
      accepted: acceptedDescription,
      suggested: suggestedDescription
    });
  const [filenameValue, filenameOrigin, setFilenameEdit] = useFieldEditor({
    captureId: record.id,
    accepted: effectiveFilenameStem,
    suggested: ""
  });

  const pendingTags =
    enrichment?.suggestedTags.filter(
      (tag) => tag.id !== undefined && tag.accepted_at === null && tag.rejected_at === null
    ) ?? [];
  const acceptedTags = enrichment?.acceptedTags ?? [];

  const acceptTitleIfNeeded = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) return;
      if (trimmed === acceptedTitle) return;
      const result = await dispatch("codex:acceptTitle", {
        captureId: record.id,
        title: trimmed
      });
      if (result.ok) onEnrichmentUpdate(result.value);
    },
    [acceptedTitle, onEnrichmentUpdate, record.id]
  );

  const acceptDescriptionIfNeeded = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) return;
      if (trimmed === acceptedDescription) return;
      const result = await dispatch("codex:acceptDescription", {
        captureId: record.id,
        description: trimmed
      });
      if (result.ok) onEnrichmentUpdate(result.value);
    },
    [acceptedDescription, onEnrichmentUpdate, record.id]
  );

  const acceptFilenameIfNeeded = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) return;
      if (trimmed === effectiveFilenameStem) return;
      const result = await dispatch("codex:acceptFilenameStem", {
        captureId: record.id,
        filenameStem: trimmed
      });
      if (result.ok) onEnrichmentUpdate(result.value);
    },
    [effectiveFilenameStem, onEnrichmentUpdate, record.id]
  );

  // Per-field draft acceptance — the prior bulk "Use draft" button
  // accepted title + description + every pending tag in one click,
  // which surprised users in two ways:
  //   1. Pending tags they'd ignored on the float-over (e.g., `github`)
  //      got applied along with the text drafts.
  //   2. The accepted title/description got overwritten with no
  //      preview of what they were about to lose.
  // Now: each field's drafted text is previewed below the input with
  // an inline "Use" button. Tags continue to live in <TagEditor/>
  // with their own +/× per-suggestion controls.
  // Per-field Use callbacks both commit() locally AND dispatch the
  // accept verb. Without the commit, a user mid-edit (origin=manual)
  // would click Use and only see their typed text — the sync effect
  // deliberately leaves manual edits alone, so the broadcast that
  // lands back from the server wouldn't replace the textarea value.
  // Commit forces a local override so the click feels instant; the
  // server broadcast that lands moments later is a no-op (same
  // value + origin).
  // Per-field Use callbacks: commit() locally (instant feedback even
  // when origin=manual), dispatch the accept verb, roll back the
  // commit on failure so the UI doesn't lie about what's persisted.
  // "Roll back" means setting the field back to the prior server-side
  // state — if there was an accepted value before, it returns to
  // "accepted" with that value; otherwise it falls back to the
  // suggested italic preview. Mid-typing manual text is lost on
  // failure, but a Use-button dispatch failure is a rare edge case.
  const useTitleDraft = useCallback(async () => {
    if (suggestedTitle.trim().length === 0) return;
    commitTitle(suggestedTitle, "accepted");
    const result = await dispatch("codex:acceptTitle", {
      captureId: record.id,
      title: suggestedTitle
    });
    if (result.ok) {
      onEnrichmentUpdate(result.value);
    } else {
      commitTitle(acceptedTitle, acceptedTitle.length > 0 ? "accepted" : "suggested");
    }
  }, [acceptedTitle, commitTitle, onEnrichmentUpdate, record.id, suggestedTitle]);

  const useDescriptionDraft = useCallback(async () => {
    if (suggestedDescription.trim().length === 0) return;
    commitDescription(suggestedDescription, "accepted");
    const result = await dispatch("codex:acceptDescription", {
      captureId: record.id,
      description: suggestedDescription
    });
    if (result.ok) {
      onEnrichmentUpdate(result.value);
    } else {
      commitDescription(
        acceptedDescription,
        acceptedDescription.length > 0 ? "accepted" : "suggested"
      );
    }
  }, [
    acceptedDescription,
    commitDescription,
    onEnrichmentUpdate,
    record.id,
    suggestedDescription
  ]);

  const titleDraftDiverged =
    suggestedTitle.trim().length > 0 && suggestedTitle !== acceptedTitle;
  const descriptionDraftDiverged =
    suggestedDescription.trim().length > 0 && suggestedDescription !== acceptedDescription;

  const regenerate = useCallback(() => {
    void dispatch("codex:enrich", {
      captureId: record.id,
      triggerSource: "library-regenerate"
    });
  }, [record.id]);

  // Bulk "Use draft" — applies title + description atomically
  // in one server transaction via `codex:acceptAllDrafts`. Optimistic
  // local commits for instant feedback; the server broadcast that
  // lands moments later is a no-op. Filename suggestions are already
  // the effective filename while accepted_filename_stem remains a
  // user override, so the bulk action deliberately leaves filename
  // alone. Tags stay user-driven (their own +/× chip controls) to
  // avoid surprise-accepts.
  const useAllTextDrafts = useCallback(async () => {
    const wantTitle = titleDraftDiverged;
    const wantDescription = descriptionDraftDiverged;
    if (!wantTitle && !wantDescription) return;

    if (wantTitle) commitTitle(suggestedTitle, "accepted");
    if (wantDescription) commitDescription(suggestedDescription, "accepted");

    const payload: {
      captureId: string;
      title?: string;
      description?: string;
    } = { captureId: record.id };
    if (wantTitle) payload.title = suggestedTitle;
    if (wantDescription) payload.description = suggestedDescription;

    const result = await dispatch("codex:acceptAllDrafts", payload);
    if (result.ok) {
      onEnrichmentUpdate(result.value);
    } else {
      // Roll back the optimistic commits so the UI doesn't lie about
      // what the server accepted. Re-derive origin from the
      // server-side state we last had.
      if (wantTitle) commitTitle(acceptedTitle, acceptedTitle.length > 0 ? "accepted" : "suggested");
      if (wantDescription)
        commitDescription(
          acceptedDescription,
          acceptedDescription.length > 0 ? "accepted" : "suggested"
        );
    }
  }, [
    acceptedDescription,
    acceptedTitle,
    commitDescription,
    commitTitle,
    descriptionDraftDiverged,
    onEnrichmentUpdate,
    record.id,
    suggestedDescription,
    suggestedTitle,
    titleDraftDiverged
  ]);

  const hasAnyDraft = titleDraftDiverged || descriptionDraftDiverged;
  const codexBusy = codexStatus === "queued" || codexStatus === "running";
  return (
    <>
      <div className="psl__detail-meta">
        <div className="psl__detail-name">{sourceName} snap</div>
        <div className="psl__detail-row">
          <span>
            <b>
              {record.width_px}×{record.height_px}
            </b>
          </span>
          <span>{formatBytes(record.byte_size)}</span>
          <span>{record.kind === "image" ? "PNG" : record.kind.toUpperCase()}</span>
          <span>{capturedAt}</span>
        </div>
        {/* Header only carries the source-app chip — accepted content
            tags render below in <TagEditor/> so they aren't duplicated.
            Used to also mirror `acceptedTags` here, which produced two
            "live" tag rows in the sidebar (the user-reported goof). */}
        <div className="psl__detail-tags">
          <AppTag
            app={appId}
            name={sourceName}
            bundleId={record.source_app_bundle_id ?? undefined}
          />
        </div>
      </div>

      <CodexStatusPill
        status={codexStatus}
        draftAvailable={draftAvailable}
        accepted={allDraftsAccepted}
        safetyDisabled={aiSafetyDisabled}
        providerLabel={providerLabel}
        modelLabel={modelLabel}
        action={
          <>
            {/* Prominent bulk Use — the common case. Covers title +
                description + filename in one click. Tags stay separate
                (per-chip +/× controls in the TagEditor) so suggestions
                a user ignored don't sneak in. */}
            {hasAnyDraft && !codexBusy ? (
              <button
                type="button"
                className="psl__chip-btn psl__chip-btn--accent"
                onClick={() => void useAllTextDrafts()}
              >
                Use draft
              </button>
            ) : null}
            {/* Regenerate de-emphasized — text-link weight. Hidden
                while Codex is mid-run; the per-pill status already
                communicates "reading…". */}
            {!codexBusy && !aiSafetyDisabled ? (
              <button
                type="button"
                className="psl__chip-link"
                onClick={regenerate}
                title={`Ask ${providerLabel} for a fresh draft`}
              >
                Regenerate
              </button>
            ) : null}
          </>
        }
      />

      {usageDetail !== null ? <AiRunUsageStrip detail={usageDetail} /> : null}

      <div className="psl__detail-fields">
        <label className="psl__field">
          <span className="psl__field-label">
            <span>Title</span>
            {titleOrigin === "suggested" ? (
              <>
                <span className="psl__field-origin">draft from {providerLabel}</span>
                <button
                  type="button"
                  className="psl__field-use"
                  onClick={() => void useTitleDraft()}
                  title={`Save this ${providerLabel} draft as your title`}
                >
                  Use
                </button>
              </>
            ) : null}
          </span>
          <input
            className={"psl__field-input" + (titleOrigin === "suggested" ? " is-suggested" : "")}
            type="text"
            value={titleValue}
            placeholder="Short headline (will appear above the snap)"
            maxLength={120}
            onChange={(event) => setTitleEdit(event.target.value)}
            onBlur={() => void acceptTitleIfNeeded(titleValue)}
          />
          {titleDraftDiverged && titleOrigin !== "suggested" ? (
            <DraftPreview
              label={`${providerLabel} draft`}
              text={suggestedTitle}
              onUse={() => void useTitleDraft()}
            />
          ) : null}
        </label>

        <label className="psl__field">
          <span className="psl__field-label">
            <span>Description</span>
            {descriptionOrigin === "suggested" ? (
              <>
                <span className="psl__field-origin">draft from {providerLabel}</span>
                <button
                  type="button"
                  className="psl__field-use"
                  onClick={() => void useDescriptionDraft()}
                  title={`Save this ${providerLabel} draft as your description`}
                >
                  Use
                </button>
              </>
            ) : null}
          </span>
          <textarea
            className={
              "psl__field-textarea" + (descriptionOrigin === "suggested" ? " is-suggested" : "")
            }
            value={descriptionValue}
            placeholder="What is this? Why might you come back to it?"
            maxLength={2000}
            rows={4}
            onChange={(event) => setDescriptionEdit(event.target.value)}
            onBlur={() => void acceptDescriptionIfNeeded(descriptionValue)}
          />
          {descriptionDraftDiverged && descriptionOrigin !== "suggested" ? (
            <DraftPreview
              label={`${providerLabel} draft`}
              text={suggestedDescription}
              onUse={() => void useDescriptionDraft()}
            />
          ) : null}
        </label>

        <label className="psl__field">
          <span className="psl__field-label">
            <span>Export filename</span>
            {filenameValue.length > 0 ? (
              <button
                type="button"
                className="psl__field-use"
                onClick={() => {
                  void dispatch("clipboard:copyText", { text: filenameValue });
                }}
                title="Copy the export filename stem to the clipboard"
              >
                Copy
              </button>
            ) : null}
          </span>
          <input
            className={
              "psl__field-input psl__field-input--mono" +
              (filenameOrigin === "suggested" ? " is-suggested" : "")
            }
            type="text"
            value={filenameValue}
            placeholder="kebab-case stem for File / drag-out exports"
            maxLength={120}
            onChange={(event) => setFilenameEdit(event.target.value)}
            onBlur={() => void acceptFilenameIfNeeded(filenameValue)}
          />
        </label>
      </div>

      <TagEditor
        captureId={record.id}
        acceptedTags={acceptedTags}
        pendingTags={pendingTags}
        onEnrichmentUpdate={onEnrichmentUpdate}
      />
    </>
  );
}

function isAiRunUsageDetail(value: unknown): value is AiRunUsageDetail {
  return typeof value === "object" && value !== null && "cost" in value && "mediaInputs" in value;
}

export function AiRunUsageStrip({ detail }: { detail: AiRunUsageDetail }): ReactElement {
  const cost =
    detail.cost.status === "available"
      ? formatCostMicros(detail.cost.totalCostMicros)
      : "Price unavailable";
  const tokens =
    detail.tokens === null
      ? "Usage unavailable"
      : formatUsageTokenBreakdown(detail.tokens);
  const media = detail.mediaInputs[0] ?? null;
  const mediaText =
    media === null
      ? "Media unavailable"
      : detail.mediaInputs.length === 1
        ? `${media.sentWidthPx}×${media.sentHeightPx} ${media.format.toUpperCase()} · ${formatBytes(media.sentByteSize)}${media.quality === null ? "" : ` · q${media.quality}`}`
        : `${detail.mediaInputs.length} frames · ${media.sentWidthPx}×${media.sentHeightPx} ${media.format.toUpperCase()}`;

  // Headline model name: prefer the effective model's friendly label / id; while
  // a run is in flight (effective `model` not yet recorded) fall back to the
  // REQUESTED model so it reads e.g. "GPT-5.4-Mini" instead of "model
  // unavailable". Long names clip with a CSS ellipsis (full name on hover).
  const requestedName = detail.selectedModelLabel ?? null;
  const modelName = detail.modelLabel ?? detail.model ?? requestedName ?? "model unavailable";
  // Override note: shown only once the effective model is KNOWN and it differs
  // from the requested one (the agent ran a different model than picked — e.g.
  // Grok rejecting set_model for Composer 2.5 and using its own default).
  const effectiveKnown = detail.model !== null && detail.model.length > 0;
  const selectedId = detail.run.selectedModel;
  const overrode =
    effectiveKnown &&
    typeof selectedId === "string" &&
    selectedId.length > 0 &&
    selectedId !== detail.model;

  return (
    <div className="psl__ai-usage" aria-label="AI usage">
      <div className="psl__ai-usage-row">
        <span className="psl__ai-usage-model" title={modelName}>
          {modelName}
        </span>
        <b>{cost}</b>
      </div>
      <div className="psl__ai-usage-row is-muted">
        <span>{tokens}</span>
        <span>{mediaText}</span>
      </div>
      {overrode ? (
        <div className="psl__ai-usage-row is-muted psl__ai-usage-override" role="note">
          <span
            title={`The agent doesn't support switching to "${requestedName ?? selectedId}", so it ran ${modelName} instead.`}
          >
            ⚠ you picked {requestedName ?? selectedId} — agent ran {modelName}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function formatCostMicros(micros: number): string {
  const dollars = micros / 1_000_000;
  if (dollars > 0 && dollars < 0.001) return "<$0.001";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: dollars > 0 && dollars < 0.1 ? 3 : dollars < 10 ? 2 : 0,
    maximumFractionDigits: dollars > 0 && dollars < 0.1 ? 3 : dollars < 10 ? 2 : 0
  }).format(dollars);
}

function formatTokenCount(tokens: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(tokens);
}

function formatUsageTokenBreakdown(tokens: {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}): string {
  const uncachedInput = Math.max(0, tokens.inputTokens - tokens.cachedInputTokens);
  const output = tokens.reasoningOutputTokens > 0
    ? `${formatTokenCount(tokens.outputTokens)} out (${formatTokenCount(tokens.reasoningOutputTokens)} reasoning)`
    : `${formatTokenCount(tokens.outputTokens)} out`;
  return `${formatTokenCount(uncachedInput)} uncached in · ${formatTokenCount(tokens.cachedInputTokens)} cached · ${output}`;
}

type TagEditorProps = {
  readonly captureId: string;
  readonly acceptedTags: readonly string[];
  readonly pendingTags: readonly SuggestedTag[];
  readonly onEnrichmentUpdate: (next: CaptureEnrichment) => void;
};

function TagEditor({
  captureId,
  acceptedTags,
  pendingTags,
  onEnrichmentUpdate
}: TagEditorProps): ReactElement {
  const [draft, setDraft] = useState("");

  const acceptTag = useCallback(
    async (tagId: string) => {
      const result = await dispatch("codex:acceptTag", { captureId, tagId });
      if (result.ok) onEnrichmentUpdate(result.value);
    },
    [captureId, onEnrichmentUpdate]
  );

  const rejectTag = useCallback(
    async (tagId: string) => {
      const result = await dispatch("codex:rejectTag", { captureId, tagId });
      if (result.ok) onEnrichmentUpdate(result.value);
    },
    [captureId, onEnrichmentUpdate]
  );

  // Remove an already-accepted tag. Server normalizes the label, so
  // there's no need to track tag ids on the client.
  const removeTag = useCallback(
    async (label: string) => {
      const result = await dispatch("library:removeTag", { captureId, label });
      if (result.ok) onEnrichmentUpdate(result.value);
    },
    [captureId, onEnrichmentUpdate]
  );

  // Free-form tag input — Enter commits via `library:addTag`. The
  // verb normalizes the label, reuses an existing tag row when one
  // matches, and inserts a `capture_tags` row with `source = 'user'`.
  // Idempotent on the server side, so a double-Enter doesn't create
  // duplicates.
  const submitDraft = (): void => {
    const label = draft.trim();
    if (label.length === 0) return;
    setDraft("");
    void dispatch("library:addTag", { captureId, label }).then((result) => {
      if (result.ok) onEnrichmentUpdate(result.value);
    });
  };

  return (
    <div className="psl__tag-editor">
      <div className="psl__tag-editor-eyebrow">
        Tags
        {pendingTags.length > 0 ? (
          <span className="psl__tag-editor-suggest-count">
            {pendingTags.length} suggested
          </span>
        ) : null}
      </div>
      <div className="psl__tag-row">
        {acceptedTags.map((tag) => (
          <span key={`accepted-${tag}`} className="ps-tag is-sm psl__tag-accepted">
            <span>{tag}</span>
            <button
              type="button"
              className="psl__tag-remove"
              onClick={() => void removeTag(tag)}
              aria-label={`remove ${tag}`}
              title="Remove tag"
            >
              ×
            </button>
          </span>
        ))}
        {pendingTags.map((tag) => {
          const tagId = tag.id;
          if (tagId === undefined) return null;
          return (
            <span key={`suggest-${tagId}`} className="ps-tag is-suggest">
              <button
                type="button"
                className="psl__tag-suggest-label"
                onClick={() => void acceptTag(tagId)}
                title={`Use ${tag.label}`}
              >
                + {tag.label}
              </button>
              <button
                type="button"
                className="psl__tag-suggest-x"
                onClick={() => void rejectTag(tagId)}
                aria-label={`reject ${tag.label}`}
              >
                ×
              </button>
            </span>
          );
        })}
        <input
          className="psl__tag-input"
          type="text"
          value={draft}
          placeholder={acceptedTags.length === 0 ? "add a tag…" : ""}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submitDraft();
            }
          }}
        />
      </div>
    </div>
  );
}

type OcrTabProps = {
  readonly record: CaptureRecord;
  readonly enrichment: CaptureEnrichment | null;
  readonly aiSafetyDisabled: boolean;
  /** The enrichment backend's display name (e.g. "Grok") + optional model, so
   *  the OCR copy names the actual agent instead of always saying "Codex". */
  readonly providerLabel: string;
  readonly modelLabel: string | undefined;
};

function OcrTab({
  record,
  enrichment,
  aiSafetyDisabled,
  providerLabel,
  modelLabel
}: OcrTabProps): ReactElement {
  const ocrText = enrichment?.ocrText ?? "";
  const status = enrichment?.status ?? null;
  const refreshing = status === "queued" || status === "running";

  const copyOcrText = (): void => {
    if (ocrText.length === 0) return;
    void dispatch("clipboard:copyText", { text: ocrText });
  };

  return (
    <div className="psl__ocr-tab">
      <div className="psl__ocr-tab-hdr">
        <CodexStatusPill
          variant="inline"
          status={status}
          draftAvailable={ocrText.length > 0}
          accepted={ocrText.length > 0 && status === "completed"}
          safetyDisabled={aiSafetyDisabled}
          providerLabel={providerLabel}
          modelLabel={modelLabel}
        />
        <div className="psl__ocr-tab-actions">
          <button
            type="button"
            className="psl__chip-btn"
            onClick={() =>
              void dispatch("codex:enrich", {
                captureId: record.id,
                triggerSource: "library-regenerate"
              })
            }
            disabled={refreshing || aiSafetyDisabled}
          >
            {refreshing ? "Reading…" : "Refresh OCR"}
          </button>
          <button
            type="button"
            className="psl__chip-btn"
            onClick={copyOcrText}
            disabled={ocrText.length === 0}
          >
            Copy text
          </button>
        </div>
      </div>
      {ocrText.length > 0 ? (
        <pre className="psl__ocr-tab-body">{ocrText}</pre>
      ) : (
        <div className="psl__ocr-tab-empty">
          {refreshing
            ? `${providerLabel} is reading the snap…`
            : status === "failed"
            ? `${providerLabel} could not extract text from this snap.`
            : `No OCR text yet. Hit Refresh to ask ${providerLabel} to read the snap.`}
        </div>
      )}
    </div>
  );
}

type DraftPreviewProps = {
  readonly label: string;
  readonly text: string;
  readonly onUse: () => void;
};

// DraftPreview — small banner shown under a field when Codex has a
// suggestion that diverges from the value the user has accepted. The
// prior bulk-overwrite button gave the user no visibility into what
// they were about to lose; this surfaces the alternative text so the
// "Use" click is informed, not a leap of faith.
function DraftPreview({ label, text, onUse }: DraftPreviewProps): ReactElement {
  return (
    <div className="psl__draft-preview" role="group" aria-label={label}>
      <div className="psl__draft-preview-hdr">
        <span className="psl__draft-preview-label">{label}</span>
        <button
          type="button"
          className="psl__draft-preview-use"
          onClick={onUse}
          title="Replace current text with this draft"
        >
          Use this
        </button>
      </div>
      <p className="psl__draft-preview-text">{text}</p>
    </div>
  );
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

type ProjectTabProps = {
  readonly record: CaptureRecord;
  readonly allProjects: ReadonlyArray<import("@pwrsnap/shared").SizzleProject>;
  readonly containingProjects: ReadonlyArray<import("@pwrsnap/shared").SizzleProject>;
  readonly activeProjectId: string | null;
  readonly onSelectProject: (id: string | null) => void;
};

/**
 * Project Assets right-rail tab. Shows which sizzle reels the
 * current capture belongs to, an ordered scene list, and a button
 * that opens the project in the sizzle editor window. When the
 * capture isn't in any project, surfaces an "Add to Sizzle Reel"
 * picker drawn from the project list.
 *
 * Notes:
 *   - Drag-to-reorder is deliberately out of scope; ordering is
 *     edited in the sizzle window. The list here is read-only with
 *     order badges + a kind chip per scene.
 *   - The picker uses sizzle:toggleScene which appends or removes a
 *     scene; this matches the in-library +/✓ flow.
 */
function ProjectTab({
  record,
  allProjects,
  containingProjects,
  activeProjectId,
  onSelectProject
}: ProjectTabProps): ReactElement {
  const active =
    activeProjectId === null
      ? null
      : containingProjects.find((p) => p.id === activeProjectId) ?? null;

  // Captures referenced by the active project's scenes — for the
  // body list we render each scene's thumbnail + scriptLine snippet.
  // Pulled in one round via library:listByIds, fall-through is the
  // capture for THIS row (already known) so the very common
  // "single-scene project" case doesn't pay a fetch.
  type SceneCapture = { sceneIdx: number; record: CaptureRecord | null };
  const [sceneCaptures, setSceneCaptures] = useState<SceneCapture[]>([]);
  useEffect(() => {
    if (active === null) {
      setSceneCaptures([]);
      return;
    }
    let mounted = true;
    const ids = active.scenes.map((s) => s.captureId);
    void dispatch("library:listByIds", { ids }).then((r) => {
      if (!mounted) return;
      if (!r.ok) {
        setSceneCaptures([]);
        return;
      }
      const byId = new Map(r.value.rows.map((c) => [c.id, c]));
      setSceneCaptures(
        active.scenes.map((s, i) => ({
          sceneIdx: i,
          record: byId.get(s.captureId) ?? null
        }))
      );
    });
    return () => {
      mounted = false;
    };
  }, [active]);

  if (containingProjects.length === 0) {
    // Empty state: this capture isn't in any project. Show every
    // existing project as a +chip so adding is one click away.
    return (
      <div className="psl__proj-tab">
        <p className="psl__proj-empty">
          This capture isn't in any Sizzle Reel yet.
        </p>
        {allProjects.length === 0 ? (
          <p className="psl__proj-hint">
            Create your first Sizzle Reel from the Library sidebar or the
            File menu.
          </p>
        ) : (
          <>
            <p className="psl__proj-hint">Add to:</p>
            <ul className="psl__proj-picker">
              {allProjects.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className="psl__proj-picker-row"
                    onClick={() => {
                      void dispatch("sizzle:toggleScene", {
                        projectId: p.id,
                        captureId: record.id
                      });
                    }}
                  >
                    <span className="psl__proj-picker-name">{p.name}</span>
                    <span className="psl__proj-picker-meta">
                      {p.scenes.length} scene{p.scenes.length === 1 ? "" : "s"}
                    </span>
                    <span className="psl__proj-picker-add" aria-hidden="true">+</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="psl__proj-tab">
      {containingProjects.length > 1 ? (
        <label className="psl__proj-pick">
          <span>Project</span>
          <select
            value={active?.id ?? ""}
            onChange={(e) => onSelectProject(e.target.value)}
          >
            {containingProjects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <div className="psl__proj-header">
          <span className="psl__proj-name">{active?.name}</span>
        </div>
      )}

      <ul className="psl__proj-scenes">
        {sceneCaptures.length === 0 ? (
          <li className="psl__proj-hint">Loading scenes…</li>
        ) : (
          sceneCaptures.map(({ sceneIdx, record: r }) => {
            const scene = active!.scenes[sceneIdx]!;
            const isCurrent = r?.id === record.id;
            return (
              <li
                key={scene.id}
                className={"psl__proj-scene" + (isCurrent ? " is-current" : "")}
              >
                <span className="psl__proj-scene-order">
                  {(sceneIdx + 1).toString().padStart(2, "0")}
                </span>
                <span className="psl__proj-scene-thumb">
                  {r === null ? (
                    <span className="psl__proj-scene-missing">×</span>
                  ) : r.kind === "video" ? (
                    <video
                      src={captureSrcUrl(r.id)}
                      preload="metadata"
                      muted
                      playsInline
                    />
                  ) : (
                    <img
                      src={cacheUrl(r.id, 96, "webp", r.edits_version)}
                      alt=""
                      loading="lazy"
                      decoding="async"
                    />
                  )}
                  {r?.kind === "video" ? (
                    <span className="psl__proj-scene-kind" aria-hidden="true">▶</span>
                  ) : null}
                </span>
                <span className="psl__proj-scene-body">
                  <span className="psl__proj-scene-app">
                    {r?.source_app_name ?? "—"}
                  </span>
                  <span className="psl__proj-scene-script">
                    {scene.scriptLine.trim().length === 0
                      ? "— no script —"
                      : scene.scriptLine.length > 60
                        ? scene.scriptLine.slice(0, 57) + "…"
                        : scene.scriptLine}
                  </span>
                </span>
              </li>
            );
          })
        )}
      </ul>

      <div className="psl__proj-actions">
        <button
          type="button"
          className="psl__proj-btn"
          onClick={() => {
            void dispatch("sizzle:toggleScene", {
              projectId: active!.id,
              captureId: record.id
            });
          }}
          title="Remove this capture from the project"
        >
          Remove from project
        </button>
        <button
          type="button"
          className="psl__proj-btn psl__proj-btn--primary"
          onClick={() => {
            void dispatch("sizzle:open", { projectId: active!.id });
          }}
        >
          Open editor
        </button>
      </div>
    </div>
  );
}
