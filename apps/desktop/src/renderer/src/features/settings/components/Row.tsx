import type { ReactElement, ReactNode } from "react";

type RowProps = {
  label: string;
  labelId?: string;
  sub: string;
  tag?: string;
  children: ReactNode;
};

export function Row({ label, labelId, sub, tag, children }: RowProps): ReactElement {
  return (
    <div className="pss__row">
      <div className="pss__row-l">
        <div className="pss__row-label" id={labelId}>{label}</div>
        {sub.length > 0 ? <div className="pss__row-sub">{sub}</div> : null}
        {tag !== undefined ? <div className="pss__row-tag">{tag}</div> : null}
      </div>
      <div className="pss__row-r">{children}</div>
    </div>
  );
}
