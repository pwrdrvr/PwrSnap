// EditorChrome — VS-Code-style activity bar + collapsible/poppable right
// panel that wraps the chromeless `<Editor>` viewport in the standalone
// Editor window.
//
// Behaviour summary (from docs/plans/2026-05-23-001-feat-v2-editor-plan.md
// Phase 1 + "Six structural decisions baked into Phase 1"):
//
//   • Pinned mode lays a 320px panel beside the viewport (default OFF
//     for first-time users, persisted via `settings.editor.sidebar`).
//   • Unpinned mode keeps a 38px activity bar; hovering an icon for
//     `--pse-panel-hover-delay-ms` (300ms) opens a content-sized
//     overlay (capped at 380px) anchored to the right edge of the bar.
//   • Mouse-out → `--pse-panel-grace-ms` (500ms) grace + safe-triangle
//     check before hiding (NN/g + Amazon mega-menu pattern).
//   • First-click is always pinned so a brand-new user sees a click-
//     to-pin, not a surprise hover-pop.
//   • Per-window source of truth: settings are read ONCE on mount;
//     subsequent writes are dispatched but cross-window broadcasts are
//     NOT applied live (per spec — Window B's changes don't stomp A).
//
// Outer inline-block measurer: per AGENTS.md "Tray + float-over popover
// sizing", the hover-pop overlay must size its content via an inline-
// block wrapper outside the styled (`overflow: hidden`) container. For
// this in-window popover we apply `width: max-content` (capped at
// 380px) on the wrapper instead of measuring + posting back through
// IPC — the wrapper is part of the same renderer, so layout will
// content-size it naturally.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode
} from "react";
import type { EditorSidebarPanel, Settings } from "@pwrsnap/shared";
import { dispatch } from "../../lib/pwrsnap";

export type EditorPanel = EditorSidebarPanel;

export interface EditorChromeProps {
  /** The editor viewport. Renders inside the main column. */
  children: ReactNode;
  /** Per-panel content. EditorChrome renders the panel switcher; the
   *  caller provides the panel components and we render only the
   *  active one. */
  panels: Record<EditorPanel, ReactNode>;
  /** Optional className passthrough for the outermost wrapper. */
  className?: string;
}

interface ActivityButtonDef {
  id: EditorPanel;
  label: string;
  title: string;
  /** "Available in Phase 7" disabled state for the Chat icon. The
   *  panel itself still renders a placeholder; the icon is rendered
   *  with `aria-disabled` so it isn't activatable. */
  disabled: boolean;
  icon: ReactElement;
}

const ACTIVITY_TOP: ReadonlyArray<ActivityButtonDef> = [
  {
    id: "info",
    label: "Info",
    title: "Info",
    disabled: false,
    icon: (
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
    )
  },
  {
    id: "chat",
    label: "Chat",
    title: "Chat with AI — available in Phase 7",
    disabled: true,
    icon: (
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
    )
  },
  {
    id: "toolConfig",
    label: "Tool Config",
    title: "Tool style",
    disabled: false,
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
      </svg>
    )
  }
];

const ACTIVITY_BOTTOM: ReadonlyArray<ActivityButtonDef> = [
  {
    id: "help",
    label: "Help",
    title: "Editor shortcuts",
    disabled: false,
    icon: (
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
        <path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 1.5-2.5 2-2.5 3.5" />
        <path d="M12 17h0" />
      </svg>
    )
  }
];

const ALL_ACTIVITY: ReadonlyArray<ActivityButtonDef> = [
  ...ACTIVITY_TOP,
  ...ACTIVITY_BOTTOM
];

// Defaults — used until the initial settings read resolves. Mirrors
// the substrate defaults (sidebar.pinned = false, last panel =
// toolConfig) so the user-visible first paint matches the persisted
// state once it loads.
const DEFAULT_PINNED = false;
const DEFAULT_SELECTED: EditorPanel = "toolConfig";

// CSS variable read with a numeric fallback if the variable isn't
// present (e.g. headless DOM or pre-styles teardown). Trims optional
// `ms` suffix.
function readCssMs(name: string, fallbackMs: number): number {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return fallbackMs;
  }
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  if (raw === "") return fallbackMs;
  const num = Number.parseFloat(raw);
  if (Number.isNaN(num)) return fallbackMs;
  // Support `300ms` / `0.3s` literals.
  if (raw.endsWith("ms")) return num;
  if (raw.endsWith("s")) return num * 1000;
  return num;
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// Safe-triangle check: given the current mouse position (`from`), the
// previous mouse position (`prev`), and the target panel rect, return
// `true` if the mouse appears to be moving into the rect's interior.
// Implementation mirrors the classic NN/g + Amazon mega-menu pattern:
// project a line from `prev` through `from` and ask whether it would
// land inside the panel within some short distance.
function isHeadingTowardPanel(
  from: { x: number; y: number },
  prev: { x: number; y: number } | null,
  rect: DOMRect | null
): boolean {
  if (prev === null || rect === null) return false;
  const dx = from.x - prev.x;
  const dy = from.y - prev.y;
  if (dx === 0 && dy === 0) return false;
  // Panel sits to the LEFT of the activity bar — we only count motion
  // that has a leftward component (dx < 0).
  if (dx >= 0) return false;
  // Extend the motion vector forward by a generous multiplier to
  // catch slow / paused diagonal motion. 200px is more than enough at
  // typical activity-bar→panel distances.
  const t = 200 / Math.abs(dx);
  const projectedX = from.x + dx * t;
  const projectedY = from.y + dy * t;
  // Loosen Y tolerance by 24px on each edge — the user doesn't have
  // to aim perfectly at the rect's vertical extent for the safe-
  // triangle to consider them heading "into" it.
  return (
    projectedX <= rect.right &&
    projectedX >= rect.left - 200 &&
    projectedY >= rect.top - 24 &&
    projectedY <= rect.bottom + 24
  );
}

/**
 * Mac vs non-Mac modifier detection. The keyboard shortcuts (⌘\ ⌘1
 * ⌘2 ⌘3) use Cmd on macOS and Ctrl elsewhere — matches the rest of
 * the renderer's chord conventions.
 */
function isPrimaryAccel(event: ReactKeyboardEvent | KeyboardEvent): boolean {
  if (typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform)) {
    return event.metaKey === true;
  }
  return event.ctrlKey === true;
}

export function EditorChrome({
  children,
  panels,
  className
}: EditorChromeProps): ReactElement {
  // --- Settings ingestion (read-ONCE on mount) -------------------
  // Per spec: the per-window component reads settings once and treats
  // its local state as the source of truth thereafter — cross-window
  // broadcasts are deliberately ignored to avoid Window B stomping
  // Window A mid-edit.
  const [pinned, setPinnedState] = useState<boolean>(DEFAULT_PINNED);
  const [selected, setSelectedState] = useState<EditorPanel>(DEFAULT_SELECTED);
  const initialReadDone = useRef<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    void dispatch("settings:read", {}).then((result) => {
      if (cancelled) return;
      if (initialReadDone.current) return; // already touched by user
      if (!result.ok) return;
      const settings = result.value as Settings;
      const sidebar = settings.editor.sidebar;
      setPinnedState(sidebar.pinned);
      setSelectedState(sidebar.lastSelectedPanel);
      initialReadDone.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // --- Persisted writes -----------------------------------------
  // Patches go through `settings:write` directly rather than the
  // useSettings() hook so we don't pull a context subscription into
  // a sandbox-friendly leaf component.
  const writePinned = useCallback((next: boolean): void => {
    void dispatch("settings:write", {
      editor: { sidebar: { pinned: next } }
    });
  }, []);
  const writeSelected = useCallback((next: EditorPanel): void => {
    void dispatch("settings:write", {
      editor: { sidebar: { lastSelectedPanel: next } }
    });
  }, []);

  // --- Hover-pop state ------------------------------------------
  // `hoverPanel` is the panel currently being hover-popped (null when
  // either nothing is hovered or the panel is pinned).
  const [hoverPanel, setHoverPanel] = useState<EditorPanel | null>(null);
  // Has the user clicked an activity icon at least once this session?
  // First-click is always pinned — hover-pop only engages AFTER the
  // user has explicitly clicked once, so a brand-new user can't
  // accidentally pop a panel by passing the mouse over the bar.
  const hasClickedOnce = useRef<boolean>(false);

  const enterTimer = useRef<number | null>(null);
  const exitTimer = useRef<number | null>(null);
  const lastMouse = useRef<{ x: number; y: number } | null>(null);
  const prevMouse = useRef<{ x: number; y: number } | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const clearEnterTimer = (): void => {
    if (enterTimer.current !== null) {
      window.clearTimeout(enterTimer.current);
      enterTimer.current = null;
    }
  };
  const clearExitTimer = (): void => {
    if (exitTimer.current !== null) {
      window.clearTimeout(exitTimer.current);
      exitTimer.current = null;
    }
  };

  useEffect(() => {
    return () => {
      clearEnterTimer();
      clearExitTimer();
    };
  }, []);

  // --- Activity icon click --------------------------------------
  const handleActivityClick = useCallback(
    (id: EditorPanel): void => {
      initialReadDone.current = true;
      hasClickedOnce.current = true;
      clearEnterTimer();
      clearExitTimer();
      setHoverPanel(null);

      if (pinned && selected === id) {
        // Clicking the active icon while pinned UNPINS, but the panel
        // stays visible as a hover-pop until the user mouses out.
        setPinnedState(false);
        writePinned(false);
        setHoverPanel(id);
        return;
      }
      if (!pinned) {
        // First click in unpinned mode → pin.
        setPinnedState(true);
        writePinned(true);
      }
      if (selected !== id) {
        setSelectedState(id);
        writeSelected(id);
      }
    },
    [pinned, selected, writePinned, writeSelected]
  );

  // --- Hover handlers -------------------------------------------
  const handleIconMouseEnter = useCallback(
    (id: EditorPanel): void => {
      if (pinned) return; // pinned panels swap via click, not hover
      if (!hasClickedOnce.current) return; // first-click required
      clearExitTimer();
      clearEnterTimer();
      const delay = readCssMs("--pse-panel-hover-delay-ms", 300);
      enterTimer.current = window.setTimeout(() => {
        enterTimer.current = null;
        setHoverPanel(id);
      }, delay);
    },
    [pinned]
  );

  const startExitTimer = useCallback((): void => {
    clearExitTimer();
    const delay = readCssMs("--pse-panel-grace-ms", 500);
    exitTimer.current = window.setTimeout(() => {
      exitTimer.current = null;
      setHoverPanel(null);
    }, delay);
  }, []);

  const handleIconMouseLeave = useCallback((): void => {
    clearEnterTimer();
    if (hoverPanel === null) return;
    // Safe-triangle: if the mouse is heading INTO the popped panel,
    // don't start the grace timer.
    const prev = prevMouse.current;
    const now = lastMouse.current;
    const rect = panelRef.current?.getBoundingClientRect() ?? null;
    if (now !== null && isHeadingTowardPanel(now, prev, rect)) {
      return;
    }
    startExitTimer();
  }, [hoverPanel, startExitTimer]);

  const handlePanelMouseEnter = useCallback((): void => {
    clearExitTimer();
  }, []);
  const handlePanelMouseLeave = useCallback((): void => {
    if (pinned) return;
    startExitTimer();
  }, [pinned, startExitTimer]);

  // Track the last two mouse positions on the chrome so the safe-
  // triangle calculation has fresh data when the icon's mouseleave
  // fires.
  const handleChromeMouseMove = useCallback((event: React.MouseEvent): void => {
    prevMouse.current = lastMouse.current;
    lastMouse.current = { x: event.clientX, y: event.clientY };
  }, []);

  // --- Keyboard shortcuts ---------------------------------------
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      // Ignore when an input/textarea/contentEditable owns focus —
      // text typing in the panel or canvas must not eat shortcuts
      // unintended for them. (We still own Escape across the board.)
      const target = event.target as HTMLElement | null;
      const inEditable =
        target !== null &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);

      if (event.key === "Escape") {
        if (hoverPanel !== null && !pinned) {
          event.preventDefault();
          clearEnterTimer();
          clearExitTimer();
          setHoverPanel(null);
        }
        return;
      }
      if (inEditable) return;
      if (!isPrimaryAccel(event)) return;

      // ⌘\ toggles the sidebar entirely.
      if (event.key === "\\") {
        event.preventDefault();
        hasClickedOnce.current = true;
        const next = !pinned;
        setPinnedState(next);
        writePinned(next);
        if (next) setHoverPanel(null);
        return;
      }

      // ⌘1 / ⌘2 / ⌘3 select Info / Chat / Tool Config.
      const numericMap: Record<string, EditorPanel> = {
        "1": "info",
        "2": "chat",
        "3": "toolConfig"
      };
      const panelByKey = numericMap[event.key];
      if (panelByKey !== undefined) {
        event.preventDefault();
        hasClickedOnce.current = true;
        clearEnterTimer();
        clearExitTimer();
        setHoverPanel(null);
        if (!pinned) {
          setPinnedState(true);
          writePinned(true);
        }
        if (selected !== panelByKey) {
          setSelectedState(panelByKey);
          writeSelected(panelByKey);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
    };
  }, [hoverPanel, pinned, selected, writePinned, writeSelected]);

  // --- Render ----------------------------------------------------
  const reducedMotion = useMemo(() => prefersReducedMotion(), []);
  const showPinnedPanel = pinned;
  const showHoverPanel = !pinned && hoverPanel !== null;
  const activePanel: EditorPanel = showHoverPanel
    ? (hoverPanel as EditorPanel)
    : selected;

  const rootClass =
    "pse-chrome" +
    (className !== undefined && className !== "" ? ` ${className}` : "") +
    (reducedMotion ? " is-reduced-motion" : "");

  return (
    <div className={rootClass} onMouseMove={handleChromeMouseMove}>
      <div className="pse-chrome__viewport">{children}</div>

      {showPinnedPanel && (
        <div
          className="pse-chrome__panel pse-chrome__panel--pinned"
          role="region"
          aria-label={`${labelFor(selected)} panel`}
          data-testid="pse-panel-pinned"
        >
          <div className="pse-chrome__panel-body">{panels[selected]}</div>
        </div>
      )}

      <div
        className="pse-chrome__activity"
        role="tablist"
        aria-orientation="vertical"
        aria-label="Editor sidebar"
      >
        {ACTIVITY_TOP.map((btn) => (
          <ActivityButton
            key={btn.id}
            def={btn}
            active={pinned && selected === btn.id}
            onClick={handleActivityClick}
            onMouseEnter={handleIconMouseEnter}
            onMouseLeave={handleIconMouseLeave}
          />
        ))}
        <div className="pse-chrome__activity-spacer" />
        {ACTIVITY_BOTTOM.map((btn) => (
          <ActivityButton
            key={btn.id}
            def={btn}
            active={pinned && selected === btn.id}
            onClick={handleActivityClick}
            onMouseEnter={handleIconMouseEnter}
            onMouseLeave={handleIconMouseLeave}
          />
        ))}
      </div>

      {showHoverPanel && (
        // Outer inline-block wrapper so the panel is content-sized
        // (capped at 380px) by layout, not by a measurement loop. See
        // AGENTS.md "Tray + float-over popover sizing" for the
        // rationale — `.pse-chrome__panel` carries `overflow: hidden`
        // for its border-radius, which would clip a self-measurement
        // and starve the panel of room to grow.
        <div
          ref={panelRef}
          className="pse-chrome__panel-wrap"
          style={INLINE_BLOCK_WRAP_STYLE}
          onMouseEnter={handlePanelMouseEnter}
          onMouseLeave={handlePanelMouseLeave}
          data-testid="pse-panel-hover"
        >
          <div
            className="pse-chrome__panel pse-chrome__panel--hover"
            role="region"
            aria-label={`${labelFor(activePanel)} panel`}
          >
            <div className="pse-chrome__panel-body">{panels[activePanel]}</div>
          </div>
        </div>
      )}
    </div>
  );
}

const INLINE_BLOCK_WRAP_STYLE: CSSProperties = {
  display: "inline-block",
  width: "max-content",
  maxWidth: "380px"
};

function labelFor(p: EditorPanel): string {
  const found = ALL_ACTIVITY.find((b) => b.id === p);
  return found?.label ?? p;
}

interface ActivityButtonProps {
  def: ActivityButtonDef;
  active: boolean;
  onClick: (id: EditorPanel) => void;
  onMouseEnter: (id: EditorPanel) => void;
  onMouseLeave: (id: EditorPanel) => void;
}

function ActivityButton({
  def,
  active,
  onClick,
  onMouseEnter,
  onMouseLeave
}: ActivityButtonProps): ReactElement {
  return (
    <button
      type="button"
      className={
        "pse-chrome__act" +
        (active ? " is-active" : "") +
        (def.disabled ? " is-disabled" : "")
      }
      role="tab"
      aria-label={def.label}
      aria-pressed={active}
      aria-disabled={def.disabled}
      title={def.title}
      data-panel={def.id}
      // data-testid is for E2E spec selectors only — added per the
      // v2 editor refresh task #11 (editor-activity-bar spec). The
      // `data-panel` attribute above is the renderer-side anchor;
      // this duplicates it under the conventional testid prefix.
      data-testid={`editor-activity-bar-icon-${def.id}`}
      onClick={() => onClick(def.id)}
      onMouseEnter={() => onMouseEnter(def.id)}
      onMouseLeave={() => onMouseLeave(def.id)}
    >
      <span className="pse-chrome__act-ico">{def.icon}</span>
    </button>
  );
}
