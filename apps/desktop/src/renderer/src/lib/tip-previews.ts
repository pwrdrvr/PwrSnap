// Pictures for the fast tooltip (useFastTooltip.tsx).
//
// A control that is easier shown than described opts in with
// `data-tip-preview="<name>"`, and the feature that owns the picture
// registers a renderer under that name. The renderer is handed the anchor,
// so it reads whatever else it needs from the anchor's own data attributes
// (the Draw modes read the color and weight the next stroke would use).
//
// The registry keeps lib free of feature code: the tooltip knows a name,
// never what a stroke or a blur is.

import type { ReactElement } from "react";

export type TipPreview = (anchor: HTMLElement) => ReactElement | null;

const previews = new Map<string, TipPreview>();

/** Register the picture shown for `data-tip-preview="<name>"`. A second
 *  registration under the same name replaces the first (a module that
 *  hot-reloads registers again). */
export function registerTipPreview(name: string, render: TipPreview): void {
  previews.set(name, render);
}

/** The picture for `name` on `anchor`, or null when nothing is registered
 *  under it — an unknown name shows the words alone. */
export function renderTipPreview(name: string, anchor: HTMLElement): ReactElement | null {
  return previews.get(name)?.(anchor) ?? null;
}
