// Collapse state is visual-only for v1 — the chevron flips but the
// header isn't a button. Promote to a real toggle when independent
// per-card collapse lands.

import type { ReactElement, ReactNode } from "react";

type CardProps = {
  eyebrow: string;
  title: string;
  collapsed?: boolean;
  /** Optional trailing chunk inside the card header (right of the
   *  chevron). The AI Providers Codex card uses this for the
   *  Refresh button. */
  headerAction?: ReactNode;
  children: ReactNode;
};

export function Card({
  eyebrow,
  title,
  collapsed,
  headerAction,
  children
}: CardProps): ReactElement {
  return (
    <section className={"pss__card" + (collapsed === true ? " is-collapsed" : "")}>
      <header className="pss__card-hdr">
        <div className="pss__card-hdr-l">
          <span className="pss__card-eyebrow">{eyebrow}</span>
          <span className="pss__card-title">{title}</span>
        </div>
        {headerAction !== undefined ? headerAction : null}
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
      </header>
      <div className="pss__card-body">{children}</div>
    </section>
  );
}
