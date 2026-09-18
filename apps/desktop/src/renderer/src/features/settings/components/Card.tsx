import {
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactElement,
  type ReactNode
} from "react";
import { settingsScrollBehavior } from "../settings-nav";

type CardProps = {
  eyebrow: string;
  title: string;
  /** Initial collapsed state. The user can toggle from there. */
  defaultCollapsed?: boolean;
  /** Optional trailing chunk inside the card header (right of the
   *  chevron). The AI Providers Codex card uses this for the
   *  Refresh button. The header click-to-toggle ignores clicks that
   *  originate from inside this slot — so the Refresh button stays
   *  clickable without flipping the card. */
  headerAction?: ReactNode;
  /** DOM id, for a sidebar jump link to land on. */
  id?: string;
  /** Set while this card is the section the route asks for; a new value
   *  (including a repeat request for the same section) expands the card,
   *  scrolls it into view, and moves focus to its header. */
  focusRequest?: number | undefined;
  children: ReactNode;
};

export function Card({
  eyebrow,
  title,
  defaultCollapsed,
  headerAction,
  id,
  focusRequest,
  children
}: CardProps): ReactElement {
  const [collapsed, setCollapsed] = useState<boolean>(defaultCollapsed === true);
  const sectionRef = useRef<HTMLElement | null>(null);
  const headerRef = useRef<HTMLButtonElement | null>(null);

  // Layout effect, so a section opened from ANOTHER page lands on its card
  // before the first paint instead of flashing that page's top. The first
  // run is that arrival and snaps there; every later request (another
  // section of the same page, or a re-click) travels from wherever the pane
  // is — never back to the top first.
  const hasRunRef = useRef<boolean>(false);
  useLayoutEffect(() => {
    const arriving = !hasRunRef.current;
    hasRunRef.current = true;
    if (focusRequest === undefined) return;
    setCollapsed(false);
    // Optional call: jsdom implements no `scrollIntoView`, and expanding
    // and focusing are the parts that have to happen.
    sectionRef.current?.scrollIntoView?.({
      block: "start",
      behavior: arriving ? "auto" : settingsScrollBehavior()
    });
    headerRef.current?.focus({ preventScroll: true });
  }, [focusRequest]);

  const onHeaderClick = (event: MouseEvent<HTMLButtonElement>): void => {
    // Clicks that bubbled up from inside `headerAction` (e.g. the
    // AI Providers Refresh button) shouldn't toggle the card.
    const target = event.target as HTMLElement;
    if (target.closest(".pss__card-hdr-action") !== null) return;
    setCollapsed((prev) => !prev);
  };

  return (
    <section
      ref={sectionRef}
      id={id}
      className={"pss__card" + (collapsed ? " is-collapsed" : "")}
    >
      <button
        ref={headerRef}
        type="button"
        className="pss__card-hdr"
        onClick={onHeaderClick}
        aria-expanded={!collapsed}
      >
        <div className="pss__card-hdr-l">
          <span className="pss__card-eyebrow">{eyebrow}</span>
          <span className="pss__card-title">{title}</span>
        </div>
        {headerAction !== undefined ? (
          <span className="pss__card-hdr-action">{headerAction}</span>
        ) : null}
        <span className="pss__card-chev" aria-hidden="true">
          <svg
            width={14}
            height={14}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </button>
      <div className="pss__card-body">{children}</div>
    </section>
  );
}
