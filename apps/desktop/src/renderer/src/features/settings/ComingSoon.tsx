// Placeholder body for every Settings sidebar entry whose backing
// implementation isn't on the floor yet. Matches the design's
// `pss__main-hdr` shape so the page reads as a "real" page that's
// just missing its rows — not a half-finished surface.

import type { ReactElement } from "react";

type ComingSoonProps = {
  eyebrow: string;
  title: string;
};

export function ComingSoon({ eyebrow, title }: ComingSoonProps): ReactElement {
  return (
    <div className="pss__coming-soon">
      <div className="pss__main-hdr">
        <div className="pss__main-hdr-l">
          <div className="pss__main-eyebrow">{eyebrow}</div>
          <h1 className="pss__main-title">{title}</h1>
          <p className="pss__main-sub">
            We haven&rsquo;t built this screen yet. The sidebar entry is real;
            the page just isn&rsquo;t — a future release fills in the rows.
          </p>
        </div>
      </div>
    </div>
  );
}
