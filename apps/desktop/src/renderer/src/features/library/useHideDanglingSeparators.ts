import { useEffect, useLayoutEffect, type RefObject } from "react";

/** A divider separates two clusters on one row. When the toolbar wraps
 *  and a divider ends up first or last on a row, it separates nothing
 *  and reads as a stray tick, so it is hidden. `visibility`, not
 *  `display`: the divider keeps its width, so hiding it cannot change
 *  where the row breaks and re-trigger this. Positions are `offsetTop`
 *  — layout, unaffected by the dock's entrance transform. */
export function useHideDanglingSeparators(rowRef: RefObject<HTMLElement | null>): void {
  const mark = (): void => {
    const row = rowRef.current;
    if (row === null) return;
    const middle = (el: HTMLElement): number => el.offsetTop + el.offsetHeight / 2;
    for (const sep of row.querySelectorAll<HTMLElement>(":scope > .psl__et-sep")) {
      const prev = sep.previousElementSibling;
      const next = sep.nextElementSibling;
      const y = middle(sep);
      const sameRow = (el: Element | null): boolean =>
        el instanceof HTMLElement && Math.abs(middle(el) - y) < sep.offsetHeight / 2;
      sep.classList.toggle("is-dangling", !(sameRow(prev) && sameRow(next)));
    }
  };
  // Every render: a label change (Reset's "Confirm? · N") can rewrap the
  // row without resizing it.
  useLayoutEffect(mark);
  useEffect(() => {
    const row = rowRef.current;
    if (row === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(mark);
    observer.observe(row);
    return () => observer.disconnect();
  }, [rowRef]);
}
