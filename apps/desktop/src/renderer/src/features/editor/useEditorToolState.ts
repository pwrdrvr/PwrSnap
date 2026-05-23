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
  RectToolStyle,
  Settings,
  SettingsPatch,
  TextToolStyle,
  ToolColor
} from "@pwrsnap/shared";
import { dispatch } from "../../lib/pwrsnap";
import { useSettings } from "../settings/useSettings";
import type { Tool } from "./editor-tools";

// ---- Public types ---------------------------------------------------

/** Tools that carry a persisted style block in
 *  `settings.editor.toolStyles`. Pointer + crop are control-flow tools
 *  with no style memory. */
export type StyledTool = "arrow" | "text" | "rect" | "blur" | "highlight";

/** Per-tool style lookup. Each tool's persisted block in
 *  `EditorToolStyles` is its own discriminated branch here so a single
 *  `activeStyle` consumer can switch over `tool` and get a fully-typed
 *  `style` field with no manual narrowing. */
export type StyleFor<T extends StyledTool> = T extends "arrow"
  ? ArrowToolStyle
  : T extends "text"
    ? TextToolStyle
    : T extends "rect"
      ? RectToolStyle
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
  | { tool: "rect"; style: RectToolStyle }
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
}

// ---- Tunables -------------------------------------------------------

/** 8s matching-text affordance auto-dismiss. Lifted into a named
 *  constant so the test + a future Settings → Editor tuning surface
 *  can read the same number. Plan §"Hover timings": this matches the
 *  `--pse-affordance-auto-dismiss-ms` CSS var. */
const MATCHING_TEXT_AUTO_DISMISS_MS = 8000;

/** Per-(tool, field) coalescing window for `settings:write`. The
 *  Settings substrate already serializes writes — this debounce is a
 *  pure-performance batch, not a race-safety mechanism. */
const STYLE_WRITE_DEBOUNCE_MS = 500;

// ---- Internal helpers -----------------------------------------------

/** Per-tool override map: each tool's block is OPTIONAL and, when
 *  present, its fields are independently optional. Mirrors the shape
 *  of `SettingsPatch["editor"]["toolStyles"]` so `patchFromLocal` can
 *  forward it without translation. */
type LocalStyleOverrides = {
  arrow?: Partial<ArrowToolStyle>;
  text?: Partial<TextToolStyle>;
  rect?: Partial<RectToolStyle>;
  blur?: Partial<BlurToolStyle>;
  highlight?: Partial<HighlightToolStyle>;
};

/** Layered style read: prefer the per-tool override from `local`, fall
 *  back to settings defaults. Shape-only merge — does NOT deep-merge
 *  nested objects beyond one level (none of the tool styles have
 *  recursive shapes today). */
function readEffectiveStyles(
  fromSettings: EditorToolStyles | null,
  local: LocalStyleOverrides
): EditorToolStyles | null {
  if (fromSettings === null) return null;
  return {
    arrow: { ...fromSettings.arrow, ...(local.arrow ?? {}) },
    text: { ...fromSettings.text, ...(local.text ?? {}) },
    rect: { ...fromSettings.rect, ...(local.rect ?? {}) },
    blur: { ...fromSettings.blur, ...(local.blur ?? {}) },
    highlight: { ...fromSettings.highlight, ...(local.highlight ?? {}) }
  };
}

function isStyledTool(tool: Tool): tool is StyledTool {
  return (
    tool === "arrow" ||
    tool === "text" ||
    tool === "rect" ||
    tool === "blur" ||
    tool === "highlight"
  );
}

/** Build the discriminated `ActiveStyle` from the merged tool styles.
 *  Pointer + crop return their own no-style branches; styled tools
 *  read their per-tool block. */
function selectActiveStyle(
  tool: Tool,
  styles: EditorToolStyles | null
): ActiveStyle {
  if (tool === "pointer") return { tool: "pointer" };
  if (tool === "crop") return { tool: "crop" };
  // styles can be null while settings load — return pointer-style
  // placeholder; the editor's toolbar is disabled until settings
  // resolve so the user never observes this mid-state.
  if (styles === null) return { tool: "pointer" };
  switch (tool) {
    case "arrow":
      return { tool: "arrow", style: styles.arrow };
    case "text":
      return { tool: "text", style: styles.text };
    case "rect":
      return { tool: "rect", style: styles.rect };
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
  if (local.rect !== undefined) toolStyles.rect = local.rect;
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
      pending.rect !== undefined ||
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
          target.rect = { ...(target.rect ?? {}), color };
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
      // this on tool change).
      if (
        placement.tool === "arrow" &&
        matchingTextEnabled &&
        placement.anchorPoint !== undefined &&
        settingsToolStyles !== null
      ) {
        // Read the effective arrow style (settings + local overrides)
        // so the affordance captures what the user is currently
        // working with.
        const effective = readEffectiveStyles(settingsToolStyles, localStyles);
        const baseStyle =
          effective !== null ? effective.arrow : settingsToolStyles.arrow;
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
    [
      clearAutoDismissTimer,
      localStyles,
      matchingText.kind,
      matchingTextEnabled,
      settingsToolStyles
    ]
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

  return {
    activeTool,
    activeStyle,
    setActiveTool,
    setStyleField,
    onAnnotationPlaced,
    matchingText,
    clickMatchingTextAffordance,
    dismissMatchingTextAffordance
  };
}

// Re-export so consumers can import the type without reaching into the
// shared protocol package — keeps the hook's public surface coherent.
export { isStyledTool };
