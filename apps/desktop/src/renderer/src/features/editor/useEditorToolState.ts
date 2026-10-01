// `useEditorToolState` — the v2 editor's single state machine for the
// tool-UX layer. Owns three things, all window-scoped:
//
//   1. The currently-active tool (sticky after placement; ⌥-click
//      single-shot mode flips back to pointer after one annotation).
//   2. Per-tool style memory, layered ON TOP of `settings.editor.
//      toolStyles` defaults. Local edits override the Settings read;
//      writes coalesce over a 500ms window before dispatching
//      `settings:write` once. Each tool's style is its own — picking a
//      color for arrows does not recolor text. (It used to: a shared
//      COLOR slot fanned every color pick out to every tool, which is
//      exactly what made "a red arrow and a green arrow" a chore. The
//      tool bag replaced it.)
//   3. The tool bag (`settings.editor.toolBag`): nine saved complete
//      styles. Arming a slot makes its tool active and loads its whole
//      style as that tool's working style; `armedSlot` remembers which
//      slot is armed so the toolbar can show it, and whether the working
//      style has since drifted from it. Pasting a slot onto a SELECTION
//      is the editor's job (it owns the layers) — see tool-bag.ts.
//
// State changes are LOCAL to this hook instance — cross-window
// broadcasts are explicitly avoided. Each editor window owns its own
// active tool + per-session style overrides; opening a second editor
// reads the (possibly-updated) settings defaults but does NOT stomp
// the first window's in-progress work. The bag is the exception by
// nature: it is a saved setting, so a slot saved in one window shows
// up in the others through the settings broadcast.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ArrowToolStyle,
  BlurToolStyle,
  EditorToolBag,
  EditorToolStyles,
  HighlightToolStyle,
  ShapeToolStyle,
  Settings,
  SettingsPatch,
  TextToolStyle,
  ToolBagSlot
} from "@pwrsnap/shared";
import {
  defaultEditorToolBag,
  defaultEditorToolStyles,
  TOOL_BAG_SIZE
} from "@pwrsnap/shared";
import { dispatch } from "../../lib/pwrsnap";
import { useSettings } from "../settings/useSettings";
import type { Tool } from "./editor-tools";
import { styleValuesEqual } from "./tool-bag";

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

export interface UseEditorToolStateOptions {
  /** The capture being edited. Switching captures disarms the bag slot
   *  (the tool and its working style carry over). */
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
  /** Called once per committed annotation. Only single-shot (⌥-click)
   *  mode reacts: it returns to pointer. */
  onAnnotationPlaced(placement: { tool: Tool }): void;
  /** The saved bag — settings, overlaid with any slot write still in
   *  flight. Always exactly `TOOL_BAG_SIZE` entries. */
  bag: EditorToolBag;
  /** Index of the armed slot, or null. Cleared by picking a tool
   *  family directly, by switching captures, and by clearing the slot. */
  armedSlot: number | null;
  /** True when the armed slot's tool is active but its working style no
   *  longer matches the slot — the user tweaked it after arming. */
  armedSlotModified: boolean;
  /** Arm slot `index`: activate its tool and load its full style. An
   *  empty slot is a no-op that returns false. */
  armSlot(index: number, options?: { singleShot?: boolean }): boolean;
  /** Save (or with null, clear) slot `index`. Writes the whole bag. */
  setBagSlot(index: number, slot: ToolBagSlot | null): void;
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
  const settingsBag: EditorToolBag | null =
    settings === null ? null : settings.editor.toolBag;

  // Active tool — window-scoped React state. No broadcast.
  const [activeTool, setActiveToolState] = useState<Tool>(initialTool);

  // Per-tool, per-field overrides on top of `settings.editor.toolStyles`.
  // Locked in until either the user changes them again (overwrites the
  // override) or the editor closes (the pending debounce flushes on
  // beforeunload). NOTE: this is intentionally NOT cleared on capture
  // change — style memory follows the user across captures within the
  // same window session.
  const [localStyles, setLocalStyles] = useState<LocalStyleOverrides>({});

  // Armed bag slot. Only the INDEX is state; the slot's content is read
  // from the bag each render, so saving over the armed slot re-bases
  // "modified" against what was saved.
  const [armedSlot, setArmedSlot] = useState<number | null>(null);

  // A bag write that has been dispatched but whose settings broadcast
  // has not landed yet. Rendered in place of the settings bag so a save
  // shows immediately; dropped when its own write resolves (the
  // substrate broadcasts before it replies), and only if no newer write
  // has replaced it since.
  const [pendingBag, setPendingBag] = useState<EditorToolBag | null>(null);
  const bagWriteSeqRef = useRef(0);

  // Single-shot flag. Set by `setActiveTool(tool, { singleShot: true })`
  // (the ⌥-click affordance); consumed by `onAnnotationPlaced`, which
  // flips us back to "pointer" once and clears the flag. Stored in a
  // ref so back-to-back setActiveTool + onAnnotationPlaced inside the
  // same act() batch sees the latest value without React's state-
  // batching reordering it.
  const singleShotRef = useRef<boolean>(false);

  // Live mirrors for callbacks that outlive their render closure — an
  // async commit reads styles AFTER awaiting `settledToolStyles`, by
  // which point the closure's `settingsToolStyles` may be a settings
  // round-trip stale. Written during render (see the Selectors
  // section); read at call time.
  const effectiveStylesRef = useRef<EditorToolStyles | null>(null);
  const bagRef = useRef<EditorToolBag>(defaultEditorToolBag());
  const bagLoadedRef = useRef<boolean>(false);
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

  // A different capture is a different job: keep the tool and its
  // working style, but stop claiming a slot is armed.
  useEffect(() => {
    setArmedSlot(null);
  }, [captureId]);

  // ---- Settings-write coalescer ----------------------------------
  //
  // Each setStyleField call resets the 500ms horizon. When the timer
  // fires, every pending field (across tools) goes out in ONE
  // `settings:write`.
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
  // cancel sites for in-flight style edits.
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
      // Flush any pending writes for the PREVIOUS tool — the user has
      // moved on; we don't want a stale debounce holding a patch that a
      // subsequent settings read would clobber.
      flushPendingWrites();
      singleShotRef.current = opts?.singleShot === true;
      // Picking a family directly is not "using slot N" any more.
      setArmedSlot(null);
      setActiveToolState(tool);
    },
    [flushPendingWrites]
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
      // The double-cast through `unknown` is required because TS can't
      // prove that a `Partial<StyleFor<T>>` is assignable to the
      // index-signature-free union member at the specific T; the
      // runtime invariant (field is a known key of T's style) is
      // enforced by the public generic.
      const applyFieldUpdate = (target: LocalStyleOverrides): void => {
        const existing = (target[tool] ?? {}) as Partial<StyleFor<T>>;
        const updated = { ...existing, [field]: value } as Partial<
          StyleFor<T>
        >;
        (target as Record<StyledTool, unknown>)[tool] = updated;
      };

      setLocalStyles((prev) => {
        const next: LocalStyleOverrides = { ...prev };
        applyFieldUpdate(next);
        return next;
      });

      applyFieldUpdate(pendingRef.current);
      scheduleWriteFlush();
    },
    [scheduleWriteFlush]
  );

  const armSlot = useCallback(
    (index: number, opts?: { singleShot?: boolean }): boolean => {
      const slot = bagRef.current.slots[index] ?? null;
      if (slot === null) return false;
      flushPendingWrites();
      // The slot's style becomes the tool's working style whole — every
      // field, so nothing from the previous working style leaks in —
      // and is remembered as that tool's default like any other pick.
      const loadInto = (target: LocalStyleOverrides): void => {
        (target as Record<StyledTool, unknown>)[slot.tool] = { ...slot.style };
      };
      setLocalStyles((prev) => {
        const next: LocalStyleOverrides = { ...prev };
        loadInto(next);
        return next;
      });
      loadInto(pendingRef.current);
      scheduleWriteFlush();
      singleShotRef.current = opts?.singleShot === true;
      setArmedSlot(index);
      setActiveToolState(slot.tool);
      return true;
    },
    [flushPendingWrites, scheduleWriteFlush]
  );

  const setBagSlot = useCallback(
    (index: number, slot: ToolBagSlot | null): void => {
      if (!Number.isInteger(index) || index < 0 || index >= TOOL_BAG_SIZE) return;
      // The bag is written WHOLE. Until settings land, `bagRef` holds
      // the factory bag, and a save then would write the factory slots
      // over the user's saved ones. Settings arrive in one local IPC
      // round-trip, so dropping a save that early costs one click.
      if (!bagLoadedRef.current) return;
      const slots = [...bagRef.current.slots];
      slots[index] = slot;
      const next: EditorToolBag = { slots };
      // Keep the mirror current so a second save in the same tick
      // builds on this one instead of on the pre-save bag.
      bagRef.current = next;
      const seq = ++bagWriteSeqRef.current;
      setPendingBag(next);
      if (slot === null) {
        setArmedSlot((armed) => (armed === index ? null : armed));
      }
      void dispatch("settings:write", { editor: { toolBag: next } }).finally(() => {
        if (bagWriteSeqRef.current === seq) setPendingBag(null);
      });
    },
    []
  );

  const onAnnotationPlaced = useCallback((_placement: { tool: Tool }): void => {
    // Single-shot: a one-shot tool returns to pointer.
    if (singleShotRef.current) {
      singleShotRef.current = false;
      setArmedSlot(null);
      setActiveToolState("pointer");
    }
  }, []);

  // ---- Selectors --------------------------------------------------

  const effectiveStyles = useMemo(
    () => readEffectiveStyles(settingsToolStyles, localStyles),
    [settingsToolStyles, localStyles]
  );

  const activeStyle = useMemo(
    () => selectActiveStyle(activeTool, effectiveStyles),
    [activeTool, effectiveStyles]
  );

  const bag: EditorToolBag = pendingBag ?? settingsBag ?? bagRef.current;

  const armedSlotContent = armedSlot === null ? null : (bag.slots[armedSlot] ?? null);
  const armedSlotModified =
    armedSlotContent !== null &&
    armedSlotContent.tool === activeTool &&
    !styleValuesEqual(effectiveStyles[armedSlotContent.tool], armedSlotContent.style);

  // ---- Commit-time style access (see the interface docs) ----------
  //
  // Ref-mirrored so an async commit handler reads the LIVE merged
  // styles — a render closure captured before an await still holds the
  // pre-settle value. Written during render on purpose: an event
  // handler firing between a commit and its passive effects must see
  // this render's values, not the previous one's.
  effectiveStylesRef.current = effectiveStyles;
  settingsLoadedRef.current = settingsToolStyles !== null;
  bagRef.current = bag;
  bagLoadedRef.current = settingsBag !== null;

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
    bag,
    armedSlot,
    armedSlotModified,
    armSlot,
    setBagSlot,
    settledToolStyles
  };
}

// Re-export so consumers can import the type without reaching into the
// shared protocol package — keeps the hook's public surface coherent.
export { isStyledTool };
