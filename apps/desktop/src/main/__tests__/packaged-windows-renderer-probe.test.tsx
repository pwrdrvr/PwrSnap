// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PwrSnapMark, PwrSnapWordmark } from "../../renderer/src/features/shared/BrandMark";
import { packagedRendererProbeSource } from "../packaged-windows-smoke";

const dispatch = vi.fn(async () => ({
  ok: true,
  value: { rows: [], totalLive: 0, trashTotal: 0 }
}));

beforeEach(() => {
  document.title = "PwrSnap";
  document.body.dataset.stage = "library";
  // Render the actual brand components used by Library, including its
  // decorative SVG. Layout is supplied because jsdom does not lay out text.
  document.body.innerHTML = renderToStaticMarkup(
    <div id="root"><div className="app-shell">
      <div className="psl" data-library-readiness="ready" data-library-total-live="0">
        <div className="psl__title"><PwrSnapMark decorative /><PwrSnapWordmark /></div>
      </div>
    </div></div>
  );
  vi.spyOn(document, "readyState", "get").mockReturnValue("complete");
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    width: 120, height: 24, x: 0, y: 0, top: 0, left: 0, right: 120, bottom: 24,
    toJSON: () => ({})
  });
  dispatch.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function probe(): Promise<{ ready: boolean; brandVisible: boolean }> {
  const evaluate = new Function(
    "document", "window", "requestAnimationFrame", "getComputedStyle",
    `return ${packagedRendererProbeSource()};`
  );
  return evaluate(
    document,
    { pwrsnapApi: { dispatch } },
    (callback: () => void) => callback(),
    window.getComputedStyle.bind(window)
  );
}

test("accepts the current Library wordmark with a decorative SVG and proves fresh IPC", async () => {
  expect(document.querySelector('svg[aria-label="PwrSnap"]')).toBeNull();
  expect(document.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  await expect(probe()).resolves.toMatchObject({ ready: true, brandVisible: true });
  expect(dispatch).toHaveBeenCalledWith("library:list", { limit: 1, includeDeleted: true });
});

test.each(["missing", "wrong text", "display", "visibility", "opacity", "zero size"])(
  "refuses a %s Library wordmark before dispatching IPC", async (condition) => {
    const brand = document.querySelector<HTMLElement>(".pwrsnap-wordmark")!;
    if (condition === "missing") brand.remove();
    if (condition === "wrong text") brand.textContent = "Other app";
    if (condition === "display") brand.style.display = "none";
    if (condition === "visibility") brand.style.visibility = "hidden";
    if (condition === "opacity") brand.style.opacity = "0";
    if (condition === "zero size") {
      vi.spyOn(brand, "getBoundingClientRect").mockReturnValue({
        width: 0, height: 0, x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0,
        toJSON: () => ({})
      });
    }
    await expect(probe()).resolves.toMatchObject({ ready: false, brandVisible: false });
    expect(dispatch).not.toHaveBeenCalled();
  }
);
