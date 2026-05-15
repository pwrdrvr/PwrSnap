import type { ReactElement, ReactNode } from "react";

type OptionRowProps = {
  icon: ReactNode;
  primary: string;
  sub?: string;
  badges?: ReactNode;
  /** Trailing action — e.g. a "Use" button — rendered AFTER the
   *  badges block. */
  action?: ReactNode;
  /** Highlights the row as the currently-resolved choice (copper
   *  border + tint). */
  using?: boolean;
};

export function OptionRow({
  icon,
  primary,
  sub,
  badges,
  action,
  using
}: OptionRowProps): ReactElement {
  return (
    <div className={"pss__opt" + (using === true ? " is-using" : "")}>
      <span className="pss__opt-icon">{icon}</span>
      <div className="pss__opt-text">
        <span className="pss__opt-primary">{primary}</span>
        {sub !== undefined && sub.length > 0 ? (
          <span className="pss__opt-sub">{sub}</span>
        ) : null}
      </div>
      {badges !== undefined || action !== undefined ? (
        <span className="pss__opt-badges">
          {badges}
          {action}
        </span>
      ) : null}
    </div>
  );
}
