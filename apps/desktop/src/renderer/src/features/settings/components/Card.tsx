import { useState, type MouseEvent, type ReactElement, type ReactNode } from "react";

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
  children: ReactNode;
};

export function Card({
  eyebrow,
  title,
  defaultCollapsed,
  headerAction,
  children
}: CardProps): ReactElement {
  const [collapsed, setCollapsed] = useState<boolean>(defaultCollapsed === true);

  const onHeaderClick = (event: MouseEvent<HTMLButtonElement>): void => {
    // Clicks that bubbled up from inside `headerAction` (e.g. the
    // AI Providers Refresh button) shouldn't toggle the card.
    const target = event.target as HTMLElement;
    if (target.closest(".pss__card-hdr-action") !== null) return;
    setCollapsed((prev) => !prev);
  };

  return (
    <section className={"pss__card" + (collapsed ? " is-collapsed" : "")}>
      <button
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
