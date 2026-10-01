import { act, useRef, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { useHideDanglingSeparators } from "../useHideDanglingSeparators";

// jsdom has no layout, so each element says which row it is on and the
// layout getters read that: 30px rows, a 22px divider centered in its row.
const originalTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetTop");
const originalHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const isSep = (el: HTMLElement): boolean => el.classList.contains("psl__et-sep");
  Object.defineProperty(HTMLElement.prototype, "offsetTop", {
    configurable: true,
    get(this: HTMLElement) {
      return Number(this.dataset.row ?? 0) * 30 + (isSep(this) ? 4 : 0);
    }
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return isSep(this) ? 22 : 30;
    }
  });
});

afterAll(() => {
  if (originalTop !== undefined) Object.defineProperty(HTMLElement.prototype, "offsetTop", originalTop);
  if (originalHeight !== undefined) Object.defineProperty(HTMLElement.prototype, "offsetHeight", originalHeight);
});

let host: HTMLDivElement;
let root: Root;

function Row({ rows }: { rows: readonly number[] }): ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);
  useHideDanglingSeparators(ref);
  // tool, sep, tool, sep, reset, sep, zoom — `rows` gives each one's row.
  const kinds = ["tool", "sep", "tool", "sep", "reset", "sep", "zoom"];
  return (
    <div ref={ref}>
      {kinds.map((kind, i) =>
        kind === "sep" ? (
          <span key={i} className="psl__et-sep" data-row={rows[i]} data-testid={`sep-${i}`} />
        ) : (
          <button key={i} type="button" data-row={rows[i]}>
            {kind}
          </button>
        )
      )}
    </div>
  );
}

function render(rows: readonly number[]): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<Row rows={rows} />));
}

function dangling(): string[] {
  return [...host.querySelectorAll(".psl__et-sep.is-dangling")].map(
    (el) => (el as HTMLElement).dataset.testid ?? ""
  );
}

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("useHideDanglingSeparators", () => {
  test("one row: every divider separates two things", () => {
    render([0, 0, 0, 0, 0, 0, 0]);
    expect(dangling()).toEqual([]);
  });

  test("a divider left at the end of a row is hidden; the one between Reset and Fit stays", () => {
    render([0, 0, 0, 0, 1, 1, 1]);
    expect(dangling()).toEqual(["sep-3"]);
  });

  test("a divider wrapped to the start of a row is hidden", () => {
    render([0, 0, 0, 1, 1, 1, 1]);
    expect(dangling()).toEqual(["sep-3"]);
  });
});
