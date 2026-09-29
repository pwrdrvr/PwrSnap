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

  it("drops shortcut chips that compete with mode labels in the compact tray", () => {
    expect(trayCss).toMatch(
      /\[data-popover-density="compact"\]\s+\.ps-tray__quick-hk\s*,\s*\[data-popover-density="compact"\]\s+\.ps-mode__hk\s*\{[^}]*display\s*:\s*none/s
    );
  });
});
