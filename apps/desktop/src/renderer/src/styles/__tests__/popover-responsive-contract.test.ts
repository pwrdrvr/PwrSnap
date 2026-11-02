import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { stripCssComments } from "./css-block";

const stylesDir = join(__dirname, "..");
const trayCss = stripCssComments(readFileSync(join(stylesDir, "library.css"), "utf8"));
const floatCss = stripCssComments(readFileSync(join(stylesDir, "float-over.css"), "utf8"));

describe("compact popover styling", () => {
  it("shortens both image preview slots without cropping their media", () => {
    expect(floatCss).toMatch(
      /\[data-popover-density="compact"\]\s+\.fo__preview\s*\{[^}]*aspect-ratio\s*:\s*2\s*\/\s*1/s
    );
    expect(trayCss).toMatch(
      /\[data-popover-density="compact"\]\s+\.ps-tray__last-preview\s*\{[^}]*aspect-ratio\s*:\s*2\s*\/\s*1/s
    );
    expect(floatCss).toMatch(/\.fo__preview img\s*\{[^}]*object-fit\s*:\s*contain/s);
    expect(trayCss).toMatch(/\.ps-tray__last-preview img\s*\{[^}]*object-fit\s*:\s*contain/s);
  });

  it("drops the mode-row chords but keeps the headline chords in the compact tray", () => {
    expect(trayCss).toMatch(
      /\[data-popover-density="compact"\]\s+\.ps-mode__hk\s*\{[^}]*display\s*:\s*none/s
    );
    // Quick Capture and Record Video carry the chords a new user has, so the
    // chip must never be hidden there.
    expect(trayCss).not.toMatch(
      /\[data-popover-density="compact"\][^{}]*\.ps-tray__quick-hk[^{}]*\{[^}]*display\s*:\s*none/s
    );
    // The chip rides the eyebrow row: a grid area, with the label column
    // flattened so eyebrow and sub-line are items of the button.
    expect(trayCss).toMatch(
      /\[data-popover-density="compact"\]\s+\.ps-tray__quick-l\s*\{[^}]*display\s*:\s*contents/s
    );
    expect(trayCss).toMatch(
      /\[data-popover-density="compact"\]\s+\.ps-tray__quick-hk\s*\{[^}]*grid-area\s*:\s*k/s
    );
  });

  it("keeps the video toast's receipt to one line, and its Codex row reachable", () => {
    expect(floatCss).toMatch(
      /\[data-popover-density="compact"\]\s+\.fo__sources\s+\.ps-chip__name\s*\{[^}]*clip-path\s*:\s*inset\(50%\)/s
    );
    // Visually hidden, not display: none, so the chip keeps its name.
    expect(floatCss).not.toMatch(
      /\[data-popover-density="compact"\]\s+\.fo__sources\s+\.ps-chip__name\s*\{[^}]*display\s*:\s*none/s
    );
    expect(floatCss).toMatch(
      /\[data-popover-density="compact"\]\s+\.fo__body\s*>\s*\.fo__ai-row\s*\{[^}]*position\s*:\s*sticky[^}]*bottom\s*:\s*0/s
    );
  });

  it("wraps the AI-off call to action instead of truncating it", () => {
    expect(floatCss).toMatch(
      /\[data-popover-density="compact"\]\s+\.fo__ai-row\s+\.ps-codex-pill__summary\s*\{[^}]*-webkit-line-clamp\s*:\s*2/s
    );
  });

  it("shows one export format at a time at compact, and only at compact", () => {
    // Outside compact the switch does not render at all, so the Library rail
    // and the regular popovers keep both rows.
    expect(trayCss).toMatch(/\.psl__copy-format-switch\s*\{[^}]*display\s*:\s*none/s);
    expect(trayCss).toMatch(
      /\[data-popover-density="compact"\]\s+\.psl__copy-row-group\[data-switchable\]\s+\.psl__copy-format-switch\s*\{[^}]*display\s*:\s*inline-flex/s
    );
    expect(trayCss).toMatch(
      /\[data-popover-density="compact"\]\s+\.psl__copy-row-group\[data-inactive="true"\]\s*\{[^}]*display\s*:\s*none/s
    );
    // The hide is never unscoped, or the Library rail would lose a row.
    expect(trayCss).not.toMatch(/(^|\})\s*\.psl__copy-row-group\[data-inactive[^{]*\{/);
  });

  it("spends the video toast's compact headroom on spacing only at compact", () => {
    expect(floatCss).toMatch(
      /\[data-popover-density="compact"\]\s+\.fo__body\s*>\s*\.fo__sources:first-child\s*\{[^}]*padding-top/s
    );
    expect(floatCss).toMatch(
      /\[data-popover-density="compact"\]\s+\.fo__tags\s*\{[^}]*min-height\s*:\s*0/s
    );
  });
});
