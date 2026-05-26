// RightActivityBar — VS-Code-style vertical activity bar that hosts
// a stack of right-edge tabs and an auto-hide / pinned-open panel.
//
// Lifted from the editor's `EditorChrome` so the same component can
// also host the Library's DetailRail surface (Info / OCR / Chat).
// EditorChrome remains its own component because it ALSO lays out
// the editor viewport beside the rail — this control is the pure
// rail (no viewport sibling) + the rail behavior generalized.
//
// Behavior (parity with EditorChrome — see that file's header for
// the design rationale):
//
//   • Pinned mode: the panel renders inline beside the activity
//     bar at a fixed width.
//   • Unpinned mode: hovering an icon for `--pse-panel-hover-delay-ms`
//     (default 300ms) pops the panel as an absolute overlay
//     anchored to the bar's left edge. Mouse-out → grace timer +
//     safe-triangle check before hiding.
//   • First click is always pinned — a brand-new user can't pop a
//     panel by sliding past.
//   • Keyboard: ⌘\ (or ⌃\ on non-mac) toggles pin; ⌘1..⌘N pick a
//     tab. Escape closes a hover-pop.
//   • Per-rail source of truth: state lives in the component; the
//     parent gets `onChange` callbacks to persist (settings, local
//     storage, etc).
//
// Why "right" is baked into the name: the activity bar sits on the
// right edge of its parent and the popped panel is anchored to the
// left of the bar. Left-rail variants are a copy-paste away but
// have no caller today.
//
// One window-level listener per mount: the component installs a
// `window.addEventListener("keydown", ...)` for ⌘\ + ⌘N + Escape.
// If a future surface mounts BOTH `EditorChrome` (which has its own
// listener for the same chord set) AND a `RightActivityBar` inside
// the same `BrowserWindow`, the chords fire on both — Escape would
// close both panels at once, ⌘\ would toggle both pin states. There
// is no caller today that combines them; if one lands, lift the
// keydown handling into the parent and pass intents in via props.

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

export interface RightActivityTab<Id extends string> {
  readonly id: Id;
  /** Accessible label + tooltip text. */
  readonly label: string;
  /** Tooltip override; falls back to `label` when omitted. */
  readonly title?: string;
  /** Small notification dot next to the icon when truthy. */
  readonly badge?: boolean;
  /** Slot the tab into the bottom of the bar (after the spacer). */
  readonly bottom?: boolean;
  /** Icon element — typically a small svg. */
  readonly icon: ReactElement;
}

export interface RightActivityBarProps<Id extends string> {
  /** Tab definitions in render order. */
  readonly tabs: ReadonlyArray<RightActivityTab<Id>>;
  /** Currently active tab. The parent owns this so it can persist
   *  the choice to settings / localStorage. */
  readonly activeTab: Id;
  /** Pin state — owned by the parent for the same reason. */
  readonly pinned: boolean;
  /** Fires when the user clicks an icon OR picks one via shortcut. */
  readonly onTabChange: (id: Id) => void;
  /** Fires when the user pins / unpins (click on active icon, ⌘\). */
  readonly onPinChange: (next: boolean) => void;
  /** Render-prop for the panel body. The component swaps between
   *  pinned / hover-pop slots; the renderer only needs the active
   *  tab id. */
  readonly renderPanel: (activeTab: Id) => ReactNode;
  /** Optional className on the outer wrapper. Lets callers tag the
   *  rail surface (e.g. `psl__right`). */
  readonly className?: string;
  /** Optional test-id prefix. The activity icons render as
   *  `${testIdPrefix}-tab-${id}`; the pinned panel renders as
   *  `${testIdPrefix}-panel-pinned`, the hover-pop as
   *  `${testIdPrefix}-panel-hover`. Defaults to `right-activity-bar`. */
   readonly testIdPrefix?: string;
  /** Width of the pinned panel in CSS pixels. Defaults to 320px. */
  readonly pinnedWidthPx?: number;
}

// CSS variable read with a numeric fallback (mirrors EditorChrome).
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

// Safe-triangle (NN/g + Amazon mega-menu pattern): when the panel is
// to the LEFT of the bar, the mouse must have a leftward motion
// component AND the projected path must land within a generous
// envelope around the panel rect for us to count it as "heading
// into" the panel.
function isHeadingTowardPanel(
  from: { x: number; y: number },
  prev: { x: number; y: number } | null,
  rect: DOMRect | null
): boolean {
  if (prev === null || rect === null) return false;
  const dx = from.x - prev.x;
  const dy = from.y - prev.y;
  if (dx === 0 && dy === 0) return false;
  if (dx >= 0) return false;
  const t = 200 / Math.abs(dx);
  const projectedX = from.x + dx * t;
  const projectedY = from.y + dy * t;
  return (
    projectedX <= rect.right &&
    projectedX >= rect.left - 200 &&
    projectedY >= rect.top - 24 &&
    projectedY <= rect.bottom + 24
  );
}

function isPrimaryAccel(event: ReactKeyboardEvent | KeyboardEvent): boolean {
  if (typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform)) {
    return event.metaKey === true;
  }
  return event.ctrlKey === true;
}

export function RightActivityBar<Id extends string>(
  props: RightActivityBarProps<Id>
): ReactElement {
  const {
    tabs,
    activeTab,
    pinned,
    onTabChange,
    onPinChange,
    renderPanel,
    className,
    testIdPrefix = "right-activity-bar",
    pinnedWidthPx = 320
  } = props;

  const [hoverPanel, setHoverPanel] = useState<Id | null>(null);
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

  const handleIconClick = useCallback(
    (id: Id): void => {
      hasClickedOnce.current = true;
      clearEnterTimer();
      clearExitTimer();
      setHoverPanel(null);

      if (pinned && activeTab === id) {
        // Click the active icon while pinned → UNPIN, but keep the
        // panel visible as a hover-pop until the user mouses out.
        onPinChange(false);
        setHoverPanel(id);
        return;
      }
      if (!pinned) {
        onPinChange(true);
      }
      if (activeTab !== id) {
        onTabChange(id);
      }
    },
    [pinned, activeTab, onPinChange, onTabChange]
  );

  const handleIconMouseEnter = useCallback(
    (id: Id): void => {
      if (pinned) return;
      if (!hasClickedOnce.current) return;
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

  const handleChromeMouseMove = useCallback((event: React.MouseEvent): void => {
    prevMouse.current = lastMouse.current;
    lastMouse.current = { x: event.clientX, y: event.clientY };
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
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

      if (event.key === "\\") {
        event.preventDefault();
        hasClickedOnce.current = true;
        const next = !pinned;
        onPinChange(next);
        if (next) setHoverPanel(null);
        return;
      }

      // ⌘1..⌘N pick the Nth tab in render order.
      const n = Number.parseInt(event.key, 10);
      if (!Number.isNaN(n) && n >= 1 && n <= tabs.length) {
        const target = tabs[n - 1];
        if (target === undefined) return;
        event.preventDefault();
        hasClickedOnce.current = true;
        clearEnterTimer();
        clearExitTimer();
        setHoverPanel(null);
        if (!pinned) onPinChange(true);
        if (activeTab !== target.id) onTabChange(target.id);
      }
    };
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
    };
  }, [hoverPanel, pinned, activeTab, onPinChange, onTabChange, tabs]);

  const reducedMotion = useMemo(() => prefersReducedMotion(), []);
  const showPinnedPanel = pinned;
  const showHoverPanel = !pinned && hoverPanel !== null;
  const activeForPanel: Id = showHoverPanel
    ? (hoverPanel as Id)
    : activeTab;

  const topTabs = useMemo(() => tabs.filter((t) => t.bottom !== true), [tabs]);
  const bottomTabs = useMemo(() => tabs.filter((t) => t.bottom === true), [tabs]);

  const rootClass =
    "rab" +
    (className !== undefined && className !== "" ? ` ${className}` : "") +
    (reducedMotion ? " is-reduced-motion" : "");

  const pinnedStyle: CSSProperties = { width: `${pinnedWidthPx}px` };

  // tabpanel id is keyed on the visible-tab id, NOT on pinned vs
  // hover-pop mode, so the tab→panel aria-controls link survives
  // unpinning. Tab buttons reference the SAME id their controlled
  // panel carries; only one panel is mounted at a time.
  const panelId = `${testIdPrefix}-tabpanel-${String(activeForPanel)}`;
  const activeTabId = `${testIdPrefix}-tab-${String(activeForPanel)}-button`;

  return (
    <div className={rootClass} onMouseMove={handleChromeMouseMove}>
      {showPinnedPanel && (
        <div
          className="rab__panel rab__panel--pinned"
          role="tabpanel"
          id={panelId}
          aria-labelledby={activeTabId}
          aria-label={`${labelFor(tabs, activeTab)} panel`}
          data-testid={`${testIdPrefix}-panel-pinned`}
          style={pinnedStyle}
        >
          <div className="rab__panel-body">{renderPanel(activeTab)}</div>
        </div>
      )}

      <div
        className="rab__activity"
        role="tablist"
        aria-orientation="vertical"
        aria-label="Sidebar"
      >
        {topTabs.map((tab) => (
          <ActivityButton
            key={tab.id}
            tab={tab}
            active={pinned && activeTab === tab.id}
            testIdPrefix={testIdPrefix}
            panelId={panelId}
            onClick={handleIconClick}
            onMouseEnter={handleIconMouseEnter}
            onMouseLeave={handleIconMouseLeave}
          />
        ))}
        {bottomTabs.length > 0 && <div className="rab__activity-spacer" />}
        {bottomTabs.map((tab) => (
          <ActivityButton
            key={tab.id}
            tab={tab}
            active={pinned && activeTab === tab.id}
            testIdPrefix={testIdPrefix}
            panelId={panelId}
            onClick={handleIconClick}
            onMouseEnter={handleIconMouseEnter}
            onMouseLeave={handleIconMouseLeave}
          />
        ))}
      </div>

      {showHoverPanel && (
        <div
          ref={panelRef}
          className="rab__panel-wrap"
          style={INLINE_BLOCK_WRAP_STYLE}
          onMouseEnter={handlePanelMouseEnter}
          onMouseLeave={handlePanelMouseLeave}
          data-testid={`${testIdPrefix}-panel-hover`}
        >
          <div
            className="rab__panel rab__panel--hover"
            role="tabpanel"
            id={panelId}
            aria-labelledby={activeTabId}
            aria-label={`${labelFor(tabs, activeForPanel)} panel`}
            style={pinnedStyle}
          >
            <div className="rab__panel-body">{renderPanel(activeForPanel)}</div>
          </div>
        </div>
      )}
    </div>
  );
}

const INLINE_BLOCK_WRAP_STYLE: CSSProperties = {
  display: "inline-block",
  width: "max-content",
  maxWidth: "440px"
};

function labelFor<Id extends string>(
  tabs: ReadonlyArray<RightActivityTab<Id>>,
  id: Id
): string {
  const t = tabs.find((x) => x.id === id);
  return t?.label ?? String(id);
}

interface ActivityButtonProps<Id extends string> {
  tab: RightActivityTab<Id>;
  active: boolean;
  testIdPrefix: string;
  /** DOM id of the tabpanel this tab controls. Both the pinned and
   *  hover-popped panels carry the same id (only one is mounted at a
   *  time) so the tab→panel link survives the pin/unpin transition. */
  panelId: string;
  onClick: (id: Id) => void;
  onMouseEnter: (id: Id) => void;
  onMouseLeave: (id: Id) => void;
}

function ActivityButton<Id extends string>({
  tab,
  active,
  testIdPrefix,
  panelId,
  onClick,
  onMouseEnter,
  onMouseLeave
}: ActivityButtonProps<Id>): ReactElement {
  return (
    <button
      type="button"
      className={"rab__act" + (active ? " is-active" : "")}
      role="tab"
      // role="tab" requires aria-selected, NOT aria-pressed. The two
      // serve different a11y semantics: aria-pressed is for toggle
      // buttons (mute, bookmark); aria-selected is for tabs / listbox
      // options / treeitems where one of N siblings is the chosen one.
      // Screen readers announce "selected" for tabs and "pressed" for
      // toggles, so mixing them breaks the user's mental model.
      aria-selected={active}
      // aria-controls + the tabpanel's matching id let assistive tech
      // jump from the tab to the panel it controls. Both the pinned
      // and hover-popped panels carry the same id since only one is
      // visible at a time.
      aria-controls={panelId}
      // tabindex follows the WAI-ARIA "roving tabindex" pattern for
      // tablists: the active tab is 0, inactive tabs are -1 so they
      // skip the natural Tab traversal.
      tabIndex={active ? 0 : -1}
      id={`${testIdPrefix}-tab-${String(tab.id)}-button`}
      title={tab.title ?? tab.label}
      aria-label={tab.label}
      data-tab={tab.id}
      data-testid={`${testIdPrefix}-tab-${tab.id}`}
      onClick={() => onClick(tab.id)}
      onMouseEnter={() => onMouseEnter(tab.id)}
      onMouseLeave={() => onMouseLeave(tab.id)}
    >
      <span className="rab__act-ico">{tab.icon}</span>
      {tab.badge ? (
        <span className="rab__act-badge" aria-hidden="true" />
      ) : null}
    </button>
  );
}
