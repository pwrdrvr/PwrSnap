/**
 * How many tag chips fit the float-over's tag row before the rest collapse
 * into a "+N" chip.
 *
 * The row is a fixed number of lines tall (TAG_ROW_LINES) so that
 * enrichment landing cannot change the toast's height. The window is
 * anchored bottom-right, so every pixel the toast grows moves the preview,
 * trim strip and export cards UP under the user's cursor — two accepted
 * tags plus two suggestions wrapped to a second line and shifted all of it
 * 26px the moment Codex answered.
 *
 * This mirrors flex-wrap's line breaking: an item goes on the current line
 * if it fits, otherwise it starts the next one. The sequence is the first
 * `k` chips, then the "+N" chip when anything is hidden, then the tag input
 * at its `min-width` (it is `flex: 1`, so its flex base size is 0 and the
 * min-width is what the line breaker sees).
 *
 * Widths are LAYOUT widths (`offsetWidth`), never `getBoundingClientRect`:
 * the toast mounts under a scale-in animation, and a post-transform width
 * read mid-animation would be permanent here — see AGENTS.md, "Never mix a
 * post-transform rect with a layout measure".
 */
export const TAG_ROW_LINES = 2;

export type TagRowMetrics = {
  /** Row width available to the items: the container's `clientWidth`. */
  readonly rowWidth: number;
  /** `gap` between items, both axes. */
  readonly gap: number;
  /** Width of the "+N" chip. */
  readonly moreWidth: number;
  /** `min-width` of the trailing tag input. */
  readonly inputMinWidth: number;
  readonly lines?: number;
};

/** Offset widths are rounded; one pixel per item keeps a chip whose true
 *  width is x.5 from being placed on a line it does not quite fit. */
const ROUNDING_SLACK_PX = 1;

function lineCount(widths: readonly number[], rowWidth: number, gap: number): number {
  let lines = 1;
  let used = -1;
  for (const raw of widths) {
    const w = raw + ROUNDING_SLACK_PX;
    const need = used < 0 ? w : used + gap + w;
    if (need <= rowWidth || used < 0) {
      used = need;
    } else {
      lines += 1;
      used = w;
    }
  }
  return lines;
}

export function fitTagChips(chipWidths: readonly number[], metrics: TagRowMetrics): number {
  const n = chipWidths.length;
  // Nothing measured yet (jsdom, a detached node): show everything rather
  // than collapse to "+N" on a row we could not see.
  if (metrics.rowWidth <= 0) return n;
  const lines = metrics.lines ?? TAG_ROW_LINES;
  for (let k = n; k >= 0; k -= 1) {
    const sequence = chipWidths.slice(0, k);
    if (k < n) sequence.push(metrics.moreWidth);
    sequence.push(metrics.inputMinWidth);
    if (lineCount(sequence, metrics.rowWidth, metrics.gap) <= lines) return k;
  }
  return 0;
}
