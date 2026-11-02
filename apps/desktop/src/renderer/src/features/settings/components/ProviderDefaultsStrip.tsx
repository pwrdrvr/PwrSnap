import type { ReactElement } from "react";
import type { AiSurfaceId } from "@pwrsnap/shared";
import { AI_SURFACE_LABELS } from "../ai-provider-status";

/** Ported from PwrAgnt's `ProviderDefaultsStrip`: a provider screen must not
 *  strand the operator away from the defaults that decide whether it is used
 *  at all, so it leads with that answer and one action to change them. */
export function ProviderDefaultsStrip({
  routed,
  onEdit
}: {
  routed: readonly AiSurfaceId[];
  onEdit: () => void;
}): ReactElement {
  return (
    <div className="pss__prov-strip">
      <span className="pss__prov-strip-eyebrow">Default for</span>
      <span className="pss__prov-strip-items">
        {routed.length > 0
          ? routed.map((surface) => AI_SURFACE_LABELS[surface]).join(" · ")
          : "No jobs yet"}
      </span>
      <button className="pss__top-btn" type="button" onClick={onEdit}>
        Change defaults
      </button>
    </div>
  );
}
