// `useEditorToolState` — the v2 editor's single state machine for the
// tool-UX layer. Owns four things, all window-scoped:
//
//   1. The currently-active tool (sticky after placement; legacy ⌥-
//      click single-shot mode flips back to pointer after one
//      annotation).
//   2. Per-tool style memory, layered ON TOP of `settings.editor.
//      toolStyles` defaults. Local edits override the Settings read;
//      writes coalesce per (tool, field) over a 500ms window before
//      dispatching `settings:write` once.
//   3. The shared COLOR slot — picking a color for ANY tool propagates
//      to all other tools' color fields (so the stoplight pattern
//      "red = bad" reads naturally across arrow/text/rect/highlight).
//      Other style fields stay per-tool.
//   4. The matching-text affordance lifecycle: after an arrow placement
//      (when `settings.editor.matchingText.enabled`), pop a small
//      "+ Add label" affordance anchored at the arrow's tail; clicking
//      it arms a one-shot text placement that returns to arrow mode
//      with the same style preserved.
//
// State changes are LOCAL to this hook instance — cross-window
// broadcasts are explicitly avoided. Each editor window owns its own
// active tool + per-session style overrides; opening a second editor
// reads the (possibly-updated) settings defaults but does NOT stomp
// the first window's in-progress work.
//
// Why a hook, not a context:
//   - Each editor instance is its own window; there is no parent shell
//     to host a provider across multiple editors.
//   - The hook depends on `captureId` so it can reset matching-text
//     state on capture switches without an effect chain through a
//     context — that's one of the five required cancel sites for the
//     8s matching-text auto-dismiss timer (the others: tool change,
//     editor unmount, explicit dismiss, 8s timeout).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ArrowToolStyle,
  BlurToolStyle,
  EditorToolStyles,
  HighlightToolStyle,
  ShapeToolStyle,
  Settings,
  SettingsPatch,
  TextToolStyle,
  ToolColor
} from "@pwrsnap/shared";
import { defaultEditorToolStyles } from "@pwrsnap/shared";
import { dispatch } from "../../lib/pwrsnap";
import { useSettings } from "../settings/useSettings";
import type { Tool } from "./editor-tools";

// ---- Public types ---------------------------------------------------

/** Tools that carry a persisted style block in
 *  `settings.editor.toolStyles`. Pointer + crop are control-flow tools
 *  with no style memory. */
export type StyledTool = "arrow" | "text" | "shape" | "blur" | "highlight";

/** Per-tool style lookup. Each tool's persisted block in
 *  `EditorToolStyles` is its own discriminated branch here so a single
 *  `activeStyle` consumer can switch over `tool` and get a fully-typed
 *  `style` field with no manual narrowing. */
export type StyleFor<T extends StyledTool> = T extends "arrow"
  ? ArrowToolStyle
  : T extends "text"
    ? TextToolStyle
    : T extends "shape"
      ? ShapeToolStyle
      : T extends "blur"
        ? BlurToolStyle
        : T extends "highlight"
          ? HighlightToolStyle
          : never;

/** Discriminated union over the active tool kind. The styled branches
 *  carry the relevant style block; pointer and crop carry no style. */
export type ActiveStyle =
  | { tool: "pointer" }
  | { tool: "crop" }
  | { tool: "arrow"; style: ArrowToolStyle }
  | { tool: "text"; style: TextToolStyle }
  | { tool: "shape"; style: ShapeToolStyle }
  | { tool: "blur"; style: BlurToolStyle }
  | { tool: "highlight"; style: HighlightToolStyle };

/** Matching-text affordance state machine.
 *
 *   idle      — no affordance; default.
 *   available — popped after an arrow placement; visible at
 *               `anchorPoint`; `expiresAt` is the deadline at which the
 *               8s auto-dismiss timer fires. `baseStyle` is the arrow
 *               style at placement time so the text we synthesize on
 *               click matches color + (later: weight derived from
 *               arrow thickness).
 *   armed     — user clicked the affordance; tool has flipped to text;
 *               next text placement will return us to arrow.
 */
export type MatchingTextState =
  | { kind: "idle" }
  | {
      kind: "available";
      anchorPoint: { x: number; y: number };
      baseStyle: ArrowToolStyle;
      expiresAt: number;
    }
  | { kind: "armed"; baseStyle: ArrowToolStyle };

export interface UseEditorToolStateOptions {
  /** Resetting this resets the in-flight matching-text state — opening
   *  a different capture is one of the five cancel sites. */
  captureId: string;
  /** Optional override; the toolbar may want to ship "pointer" as the
   *  baseline regardless of last-used. Defaults to "pointer". */
  initialTool?: Tool;
}

export interface UseEditorToolStateReturn {
  activeTool: Tool;
  activeStyle: ActiveStyle;
  setActiveTool(tool: Tool, options?: { singleShot?: boolean }): void;
  setStyleField<T extends StyledTool, K extends keyof StyleFor<T>>(
    tool: T,
    field: K,
    value: StyleFor<T>[K]
  ): void;
  onAnnotationPlaced(placement: {
    tool: Tool;
    anchorPoint?: { x: number; y: number };
  }): void;
  matchingText: MatchingTextState;
  clickMatchingTextAffordance(): void;
  dismissMatchingTextAffordance(): void;
  /** The merged tool styles for a PERSISTING commit, awaited so a
   *  draw racing `settings:read` stamps the user's configured styles
   *  rather than the pre-settle defaults (the toolbar is interactive
   *  before settings resolve). Resolves as soon as settings land —
   *  immediately when they already have — and after a bounded wait
   *  (with factory defaults) if the read never resolves. Always reads
   *  the LIVE styles at resolve time; never reuse a render-closure
   *  `activeStyle` after awaiting this. History:
   *  docs/solutions/2026-08-31-editor-border-outline-settings-race.md */
  settledToolStyles(): Promise<EditorToolStyles>;
}

// ---- Tunables -------------------------------------------------------

/** 8s matching-text affordance auto-dismiss. Lifted into a named
 *  constant so the test + any future tuning surface can read the same
 *  number. (The affordance's on/off switch lives on the EDITOR card on
 *  Settings → General; the DURATION is still hardcoded here.) Plan
 *  §"Hover timings": this matches the
 *  `--pse-affordance-auto-dismiss-ms` CSS var. */
const MATCHING_TEXT_AUTO_DISMISS_MS = 8000;

/** Per-(tool, field) coalescing window for `settings:write`. The
 *  Settings substrate already serializes writes — this debounce is a
 *  pure-performance batch, not a race-safety mechanism. */
const STYLE_WRITE_DEBOUNCE_MS = 500;

/** Bound on `settledToolStyles`. Settings resolve in one local IPC
 *  round-trip, so the settle normally fires in milliseconds; the
 *  bound only exists so a failed `settings:read` can't wedge a draft
 *  commit forever. On timeout callers get the factory defaults, and
 *  later calls short-circuit (no repeated 3s parks) until settings
 *  actually land. */
const TOOL_STYLES_SETTLE_WAIT_MS = 3000;

// ---- Internal helpers -----------------------------------------------

/** Per-tool override map: each tool's block is OPTIONAL and, when
 *  present, its fields are independently optional. Mirrors the shape
 *  of `SettingsPatch["editor"]["toolStyles"]` so `patchFromLocal` can
 *  forward it without translation. */
type LocalStyleOverrides = {
  arrow?: Partial<ArrowToolStyle>;
  text?: Partial<TextToolStyle>;
  shape?: Partial<ShapeToolStyle>;
  blur?: Partial<BlurToolStyle>;
  highlight?: Partial<HighlightToolStyle>;
};

/** Layered style read: prefer the per-tool override from `local`, fall
 *  back to settings defaults, and — while `settings:read` is still in
 *  flight — to the shared factory defaults. NEVER null: the toolbar is
 *  interactive before settings resolve, and a null here used to fan
 *  out as a lying pointer-placeholder `activeStyle` that made a fast
 *  draw commit with its whole style block dropped (see
 *  docs/solutions/2026-08-31-editor-border-outline-settings-race.md).
 *  Shape-only merge — does NOT deep-merge nested objects beyond one
 *  level (none of the tool styles have recursive shapes today). */
function readEffectiveStyles(
  fromSettings: EditorToolStyles | null,
  local: LocalStyleOverrides
): EditorToolStyles {
  const base = fromSettings ?? defaultEditorToolStyles();
  return {
    arrow: { ...base.arrow, ...(local.arrow ?? {}) },
    text: { ...base.text, ...(local.text ?? {}) },
    shape: { ...base.shape, ...(local.shape ?? {}) },
    blur: { ...base.blur, ...(local.blur ?? {}) },
    highlight: { ...base.highlight, ...(local.highlight ?? {}) }
  };
}

function isStyledTool(tool: Tool): tool is StyledTool {
  return (
    tool === "arrow" ||
    tool === "text" ||
    tool === "shape" ||
    tool === "blur" ||
    tool === "highlight"
  );
}

/** Build the discriminated `ActiveStyle` from the merged tool styles.
 *  Pointer + crop return their own no-style branches; styled tools
 *  read their per-tool block. `styles` is never null (factory-default
 *  fallback while settings load), so a styled tool always carries a
 *  real style — rendering reads (draft previews, popover targets) may
 *  briefly see defaults during the one settings round-trip; anything
 *  that PERSISTS style data awaits `settledToolStyles()` instead so
 *  it stamps the user's configured values. */
function selectActiveStyle(
  tool: Tool,
  styles: EditorToolStyles
): ActiveStyle {
  if (tool === "pointer") return { tool: "pointer" };
  if (tool === "crop") return { tool: "crop" };
  switch (tool) {
    case "arrow":
      return { tool: "arrow", style: styles.arrow };
    case "text":
      return { tool: "text", style: styles.text };
    case "shape":
      return { tool: "shape", style: styles.shape };
    case "blur":
      return { tool: "blur", style: styles.blur };
    case "highlight":
      return { tool: "highlight", style: styles.highlight };
  }
}

/** Build a SettingsPatch's `editor.toolStyles` branch from a partial
 *  override map. Skips empty branches so the wire payload only carries
 *  what changed. */
function patchFromLocal(local: LocalStyleOverrides): SettingsPatch {
  const toolStyles: NonNullable<
    NonNullable<SettingsPatch["editor"]>["toolStyles"]
  > = {};
  if (local.arrow !== undefined) toolStyles.arrow = local.arrow;
  if (local.text !== undefined) toolStyles.text = local.text;
  if (local.shape !== undefined) toolStyles.shape = local.shape;
  if (local.blur !== undefined) toolStyles.blur = local.blur;
  if (local.highlight !== undefined) toolStyles.highlight = local.highlight;
  return { editor: { toolStyles } };
}

// ---- Hook -----------------------------------------------------------

export function useEditorToolState(
  options: UseEditorToolStateOptions
): UseEditorToolStateReturn {
  const { captureId, initialTool = "pointer" } = options;

  const settingsValue = useSettings();
  const settings: Settings | null = settingsValue.settings;
  const settingsToolStyles: EditorToolStyles | null =
    settings === null ? null : settings.editor.toolStyles;
  const matchingTextEnabled =
    settings === null ? true : settings.editor.matchingText.enabled;

  // Active tool — window-scoped React state. No broadcast.
  const [activeTool, setActiveToolState] = useState<Tool>(initialTool);

  // Per-tool, per-field overrides on top of `settings.editor.toolStyles`.
  // Locked in until either the user changes them again (overwrites the
  // override) or the editor closes (the pending debounce flushes on
  // beforeunload). NOTE: this is intentionally NOT cleared on capture
  // change — style memory follows the user across captures within the
  // same window session.
  const [localStyles, setLocalStyles] = useState<LocalStyleOverrides>({});

  // Matching-text affordance state machine.
  const [matchingText, setMatchingText] = useState<MatchingTextState>({
    kind: "idle"
  });

  // Single-shot flag. Set by `setActiveTool(tool, { singleShot: true })`
  // (the ⌥-click affordance); consumed by `onAnnotationPlaced`, which
  // flips us back to "pointer" once and clears the flag. Stored in a
  // ref so back-to-back setActiveTool + onAnnotationPlaced inside the
  // same act() batch sees the latest value without React's state-
  // batching reordering it.
  const singleShotRef = useRef<boolean>(false);

  // Live mirrors for callbacks that outlive their render closure —
  // an async commit invokes `onAnnotationPlaced` (and reads styles)
  // AFTER awaiting `settledToolStyles`, by which point the closure's
  // `settingsToolStyles` / `matchingTextEnabled` may be a settings
  // round-trip stale. Written during render (see the Selectors
  // section); read at call time.
  const effectiveStylesRef = useRef<EditorToolStyles | null>(null);
  const matchingTextEnabledRef = useRef<boolean>(true);
  // Settle bookkeeping for `settledToolStyles` — one shared deferred
  // + one bounded-wait timer per unsettled window, and a latch that
  // stops repeat 3s parks once a timeout has fired.
  const settingsLoadedRef = useRef<boolean>(false);
  const settleTimedOutRef = useRef<boolean>(false);
  const pendingSettleRef = useRef<{
    promise: Promise<void>;
    resolve: () => void;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);

  // ---- Matching-text auto-dismiss timer (5 cancel sites) ---------
  //
  // Cancel sites:
  //   1. setActiveTool (any user-initiated tool change)
  //   2. captureId change (useEffect dependency)
  //   3. editor unmount (useEffect cleanup)
  //   4. dismissMatchingTextAffordance (explicit)
  //   5. 8s auto-fire (this timer)
  //
  // The timer ID is held in a ref so clearTimeout can run from any of
  // those sites synchronously without going through state.
  const autoDismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const clearAutoDismissTimer = useCallback((): void => {
    if (autoDismissTimerRef.current !== null) {
      clearTimeout(autoDismissTimerRef.current);
      autoDismissTimerRef.current = null;
    }
  }, []);

  // Cancel site #2 + #3: capture switch + unmount both go through this
  // effect's cleanup. Resetting via setMatchingText is React-safe
  // because the effect fires after a render commit.
  useEffect(() => {
    return () => {
      clearAutoDismissTimer();
      setMatchingText({ kind: "idle" });
    };
  }, [captureId, clearAutoDismissTimer]);

  // Cancel site #6: the user turned the affordance OFF in Settings while
  // it was live. `matchingTextEnabled` is otherwise consulted only when
  // an annotation is placed, so without this the chip stays on screen
  // for the rest of its 8s and — worse — an already-clicked "armed"
  // state survives indefinitely, leaving the tool swapped to text and
  // giving the NEXT text placement matching-text treatment from a
  // feature the user just disabled.
  //
  // This became reachable when the toggle got a UI: previously the flag
  // could only change by hand-editing pwrsnap-settings.json, which does
  // not broadcast, so a live transition never happened.
  useEffect(() => {
    if (matchingTextEnabled) return;
    clearAutoDismissTimer();
    setMatchingText((current) => (current.kind === "idle" ? current : { kind: "idle" }));
  }, [matchingTextEnabled, clearAutoDismissTimer]);

  // ---- Settings-write coalescer ----------------------------------
  //
  // Per-(tool, field) timers. Each setStyleField call resets ITS OWN
  // (tool, field) timer to the 500ms horizon. When the timer fires, we
  // collect every pending field in the queue for that tool and dispatch
  // ONE `settings:write` covering all of them.
  //
  // The queue is shaped as `Map<tool, Partial<style>>` so concurrent
  // edits to different fields in the same tool collapse into a single
  // patch on flush.
  const pendingRef = useRef<LocalStyleOverrides>({});
  const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushPendingWrites = useCallback((): void => {
    if (writeTimerRef.current !== null) {
      clearTimeout(writeTimerRef.current);
      writeTimerRef.current = null;
    }
    const pending = pendingRef.current;
    pendingRef.current = {};
    const hasPending =
      pending.arrow !== undefined ||
      pending.text !== undefined ||
      pending.shape !== undefined ||
      pending.blur !== undefined ||
      pending.highlight !== undefined;
    if (!hasPending) return;
    // Fire-and-forget; the substrate broadcasts the resolved write via
    // `events:settings:changed`, so `useSettings` will refresh on its
    // own. Errors surface via the substrate's broadcast — there's no
    // useful local recovery (the Settings page is the diagnostic
    // surface).
    void dispatch("settings:write", patchFromLocal(pending));
  }, []);

  const scheduleWriteFlush = useCallback((): void => {
    if (writeTimerRef.current !== null) {
      clearTimeout(writeTimerRef.current);
    }
    writeTimerRef.current = setTimeout(() => {
      flushPendingWrites();
    }, STYLE_WRITE_DEBOUNCE_MS);
  }, [flushPendingWrites]);

  // Flush on unmount AND on window beforeunload — both are catch-all
  // cancel sites for in-flight style edits. Pulled into its own effect
  // so the captureId effect above stays focused on matching-text
  // teardown.
  useEffect(() => {
    const onBeforeUnload = (): void => {
      flushPendingWrites();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      flushPendingWrites();
    };
  }, [flushPendingWrites]);

  // ---- Actions ----------------------------------------------------

  const setActiveTool = useCallback(
    (tool: Tool, opts?: { singleShot?: boolean }): void => {
      // Cancel site #1: any user-initiated tool change dismisses the
      // matching-text affordance. clickMatchingTextAffordance below
      // uses a separate internal setter that does NOT clear matching-
      // text (it transitions to "armed" instead).
      clearAutoDismissTimer();
      setMatchingText({ kind: "idle" });
      // Also flush any pending writes for the PREVIOUS tool — the
      // user has moved on; we don't want a stale debounce holding a
      // patch that a subsequent settings read would clobber.
      flushPendingWrites();
      singleShotRef.current = opts?.singleShot === true;
      setActiveToolState(tool);
    },
    [clearAutoDismissTimer, flushPendingWrites]
  );

  const setStyleField = useCallback(
    <T extends StyledTool, K extends keyof StyleFor<T>>(
      tool: T,
      field: K,
      value: StyleFor<T>[K]
    ): void => {
      // Two writes happen in parallel:
      //   1. local override map (consumed by the activeStyle selector
      //      on the next render — instant UX feedback).
      //   2. pending coalescing queue (debounced 500ms before
      //      `settings:write`).
      //
      // For `field === "color"`, the local map AND the queue both fan
      // out to every other styled tool so the shared COLOR slot
      // propagates without an extra dispatch round-trip.

      // Internal helper: write `field=value` into the per-tool block
      // of an override map. The double-cast through `unknown` is
      // required because TS can't prove that a `Partial<StyleFor<T>>`
      // is assignable to the index-signature-free union member at the
      // specific T; the runtime invariant (field is a known key of
      // T's style) is enforced by the public generic.
      const applyFieldUpdate = (target: LocalStyleOverrides): void => {
        if (field === "color") {
          // Shared COLOR slot: write to every styled tool that has a
          // color field (i.e. everything except blur).
          const color = value as ToolColor;
          target.arrow = { ...(target.arrow ?? {}), color };
          target.text = { ...(target.text ?? {}), color };
          target.shape = { ...(target.shape ?? {}), color };
          target.highlight = { ...(target.highlight ?? {}), color };
          // Blur has no color field — skip.
          return;
        }
        const existing = (target[tool] ?? {}) as Partial<StyleFor<T>>;
        const updated = { ...existing, [field]: value } as Partial<
          StyleFor<T>
        >;
        // The unknown-cast satisfies TS that we're writing a partial
        // of the correct tool variant; runtime is sound because
        // `tool` is the discriminant.
        (target as Record<StyledTool, unknown>)[tool] = updated;
      };

      setLocalStyles((prev) => {
        const next: LocalStyleOverrides = { ...prev };
        applyFieldUpdate(next);
        return next;
      });

      // Queue the wire write — same fan-out for color.
      applyFieldUpdate(pendingRef.current);
      scheduleWriteFlush();
    },
    [scheduleWriteFlush]
  );

  const dismissMatchingTextAffordance = useCallback((): void => {
    // Cancel site #4: explicit dismiss.
    clearAutoDismissTimer();
    setMatchingText({ kind: "idle" });
  }, [clearAutoDismissTimer]);

  const clickMatchingTextAffordance = useCallback((): void => {
    setMatchingText((prev) => {
      if (prev.kind !== "available") return prev;
      // Transition to armed; the next text placement will return us to
      // arrow tool with the baseStyle preserved.
      clearAutoDismissTimer();
      // Flip the active tool to text (without going through the public
      // setActiveTool — that would clear matching-text back to idle).
      setActiveToolState("text");
      // Note: the shared COLOR slot already covers the "text inherits
      // arrow color" semantics — when the user picked the arrow's
      // color, we propagated it to text. The affordance click does not
      // need to re-poke the text style. We assert the invariant in the
      // test.
      return { kind: "armed", baseStyle: prev.baseStyle };
    });
  }, [clearAutoDismissTimer]);

  const onAnnotationPlaced = useCallback(
    (placement: {
      tool: Tool;
      anchorPoint?: { x: number; y: number };
    }): void => {
      // First: armed-text branch. If the placement is a text
      // placement AND we're armed, return to arrow and clear armed.
      if (placement.tool === "text" && matchingText.kind === "armed") {
        setActiveToolState("arrow");
        setMatchingText({ kind: "idle" });
        return;
      }

      // Single-shot: a one-shot tool returns to pointer. Trumps the
      // matching-text spawn — if you ⌥-clicked arrow, you don't want a
      // sticky-arrow affordance to pop.
      if (singleShotRef.current) {
        singleShotRef.current = false;
        setActiveToolState("pointer");
        // Make sure no stale matching-text state lingers.
        clearAutoDismissTimer();
        setMatchingText({ kind: "idle" });
        return;
      }

      // Arrow placement with matching-text enabled → spawn the
      // affordance. Otherwise: clear any in-flight matching-text from
      // a prior arrow (defense-in-depth; setActiveTool already does
      // this on tool change). The enabled flag and the style are read
      // through refs, not the closure — a commit that awaited
      // `settledToolStyles` invokes a callback instance minted a
      // settings round-trip ago, and its closure would still say
      // "settings not loaded".
      if (
        placement.tool === "arrow" &&
        matchingTextEnabledRef.current &&
        placement.anchorPoint !== undefined
      ) {
        // Live effective arrow style (settings + local overrides) so
        // the affordance captures what the user is currently working
        // with; factory defaults during the brief pre-settle window.
        const baseStyle = (
          effectiveStylesRef.current ?? defaultEditorToolStyles()
        ).arrow;
        const expiresAt = Date.now() + MATCHING_TEXT_AUTO_DISMISS_MS;
        clearAutoDismissTimer();
        autoDismissTimerRef.current = setTimeout(() => {
          // Cancel site #5: 8s auto-fire.
          autoDismissTimerRef.current = null;
          setMatchingText({ kind: "idle" });
        }, MATCHING_TEXT_AUTO_DISMISS_MS);
        setMatchingText({
          kind: "available",
          anchorPoint: placement.anchorPoint,
          baseStyle,
          expiresAt
        });
        return;
      }

      // Non-arrow placement (or matching-text disabled): just clear
      // any prior in-flight state so we don't carry it across a tool
      // mix.
      if (matchingText.kind !== "idle") {
        clearAutoDismissTimer();
        setMatchingText({ kind: "idle" });
      }
    },
    [clearAutoDismissTimer, matchingText.kind]
  );

  // ---- Selectors --------------------------------------------------

  const effectiveStyles = useMemo(
    () => readEffectiveStyles(settingsToolStyles, localStyles),
    [settingsToolStyles, localStyles]
  );

  const activeStyle = useMemo(
    () => selectActiveStyle(activeTool, effectiveStyles),
    [activeTool, effectiveStyles]
  );

  // ---- Commit-time style access (see the interface docs) ----------
  //
  // Ref-mirrored so an async commit handler (and onAnnotationPlaced
  // above) reads the LIVE merged styles — a render closure captured
  // before an await still holds the pre-settle value. Written during
  // render on purpose: an event handler firing between a commit and
  // its passive effects must see this render's values, not the
  // previous one's.
  effectiveStylesRef.current = effectiveStyles;
  settingsLoadedRef.current = settingsToolStyles !== null;
  matchingTextEnabledRef.current = matchingTextEnabled;

  // One shared deferred for every settled-styles waiter, with one
  // bounded-wait timer, both torn down when settings land. Sequential
  // commits against a WEDGED settings read only park once: the first
  // timeout flips `settleTimedOutRef` and later calls short-circuit
  // to the factory defaults instead of re-parking 3s per draw. The
  // flag resets if settings ever do land.
  useEffect(() => {
    if (settingsToolStyles === null) return;
    settleTimedOutRef.current = false;
    const pending = pendingSettleRef.current;
    if (pending === null) return;
    pendingSettleRef.current = null;
    clearTimeout(pending.timer);
    pending.resolve();
  }, [settingsToolStyles]);

  const settledToolStyles = useCallback((): Promise<EditorToolStyles> => {
    const current = (): EditorToolStyles =>
      effectiveStylesRef.current ?? defaultEditorToolStyles();
    if (settingsLoadedRef.current || settleTimedOutRef.current) {
      return Promise.resolve(current());
    }
    if (pendingSettleRef.current === null) {
      let resolve: () => void = () => undefined;
      const promise = new Promise<void>((res) => {
        resolve = res;
      });
      const timer = setTimeout(() => {
        // Bounded degrade: settings never landed. Resolve everyone
        // with the factory defaults and stop future calls from
        // re-parking. Warn once so a chronically slow / failed
        // settings read is diagnosable from the log, not just from
        // default-styled annotations.
        settleTimedOutRef.current = true;
        pendingSettleRef.current = null;
        // eslint-disable-next-line no-console
        console.warn(
          "settledToolStyles: settings did not land within " +
            `${TOOL_STYLES_SETTLE_WAIT_MS}ms; committing factory defaults`
        );
        resolve();
      }, TOOL_STYLES_SETTLE_WAIT_MS);
      pendingSettleRef.current = { promise, resolve, timer };
    }
    return pendingSettleRef.current.promise.then(current);
  }, []);

  return {
    activeTool,
    activeStyle,
    setActiveTool,
    setStyleField,
    onAnnotationPlaced,
    matchingText,
    clickMatchingTextAffordance,
    dismissMatchingTextAffordance,
    settledToolStyles
  };
}

// Re-export so consumers can import the type without reaching into the
// shared protocol package — keeps the hook's public surface coherent.
export { isStyledTool };
