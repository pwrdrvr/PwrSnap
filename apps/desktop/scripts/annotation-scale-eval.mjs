#!/usr/bin/env node
// Visual eval harness for the annotation size ladder.
//
//   node apps/desktop/scripts/annotation-scale-eval.mjs [--out DIR] [--only NAME]
//   node apps/desktop/scripts/annotation-scale-eval.mjs --base shot.png --dims 777x207 [--ui 15]
//
// Renders every text bucket and every arrow/shape thickness preset over
// a synthetic UI screenshot at each of the capture shapes users
// actually have, and writes one PNG per shape. Each PNG stacks the
// scenario twice: once with the PRE-recalibration formulas, once with
// the ladder in `@pwrsnap/shared/annotation-scale`. Open them side by
// side and judge.
//
// Why a harness and not just numbers: the question "is Medium too
// small?" is not answerable from a divisor. It is answerable from
// looking at an annotation sitting next to UI text, which is why the
// mock background renders body copy at a realistic UI font size
// (~15 px for a 1x capture, ~30 px for a 2x one) — the annotation has
// to hold its own against THAT, and that is the reference the numeric
// matrix in `packages/shared/src/__tests__/annotation-scale.test.ts`
// asserts against.
//
// The background is synthetic on purpose. Real captures are the user's
// private screenshots; a committed harness must not depend on them.
// To spot-check against a real one, pass --base /path/to.png --dims WxH
// (and --ui with that capture's UI text height, default 15).
//
// Chromium comes from @playwright/test (already a desktop devDependency
// for the E2E suite) — the same ENGINE the editor and the HTML text bake
// render through, so font metrics match production.
//
// Fidelity caveat, so nobody over-trusts these pictures: the harness
// draws SVG `<text>` with `stroke` + `paint-order`, whereas the editor
// and the bake render text as HTML with `-webkit-text-stroke` via
// `computeTextHtmlStyle`. Glyph SIZE (what this harness exists to
// judge) is identical; halo geometry differs slightly. Likewise the
// arrow markup here is a compact stand-in for `arrowSvgForV2` — that
// lives in apps/desktop/src/main and drags in sharp + Electron, which a
// bare-Node diagnostic script can't load. Stroke widths and head
// geometry come from the real `computeArrowGeometry`.

import { registerHooks } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

// `@pwrsnap/shared` ships raw TypeScript with extensionless relative
// imports (fine for Vite / vitest / electron-vite, not for bare Node).
// Node 24 strips types on its own, so all that is missing is extension
// resolution — add it for the two shared modules this script pulls in,
// rather than putting a bundler step in front of a diagnostic script.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
      try {
        return next(`${specifier}.ts`, context);
      } catch {
        // Fall through to default resolution (and its error message).
      }
    }
    return next(specifier, context);
  }
});

const SHARED_SRC = new URL("../../../packages/shared/src/", import.meta.url);
const { annotationBasisPx, annotationStrokeWidthPx, annotationTextSizePx } =
  await import(new URL("annotation-scale.ts", SHARED_SRC).href);
const { computeArrowGeometry } = await import(
  new URL("arrow.ts", SHARED_SRC).href
);

const HERE = dirname(fileURLToPath(import.meta.url));
const ACCENT = "#ff8a1f";
const PRESETS = /** @type {const} */ (["small", "medium", "large", "x-large"]);
const LABEL = { small: "S", medium: "M", large: "L", "x-large": "XL" };

// Same matrix as the numeric regression test — keep them in step.
const SCENARIOS = [
  { name: "slack-strip-1x", w: 777, h: 207, ui: 15 },
  { name: "tiny-crop-1x", w: 200, h: 80, ui: 15 },
  { name: "small-dialog-2x", w: 473, h: 178, ui: 30 },
  { name: "toolbar-strip-2x", w: 2212, h: 249, ui: 30 },
  { name: "tall-sidebar-2x", w: 366, h: 832, ui: 30 },
  { name: "window-1x", w: 1200, h: 800, ui: 15 },
  { name: "window-2x", w: 1876, h: 1410, ui: 30 },
  { name: "fullscreen-1080p-1x", w: 1920, h: 1080, ui: 15 },
  { name: "fullscreen-mbp-2x", w: 2880, h: 1800, ui: 30 },
  { name: "fullscreen-5k-2x", w: 5120, h: 2880, ui: 30 }
];

// ---------------------------------------------------------------
// The PRE-recalibration formulas, kept verbatim as the comparison
// baseline. Do not "fix" these to match the new ones — their whole
// job is to show what changed.
// ---------------------------------------------------------------

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Old text: bucket ÷ image SHORT SIDE. No x-large existed; the popover
 *  coerced it to large. */
function legacyTextPx(w, h, bucket) {
  const short = Math.min(w, h);
  return short / { small: 50, medium: 30, large: 18, "x-large": 18 }[bucket];
}

/** Old stroke: multiplier on a short-side auto stroke that was clamped
 *  to an absolute [4, 14] px, with a short-side floor fraction rescuing
 *  only Large and X-Large. */
function legacyStrokePx(w, h, preset) {
  const short = Math.min(w, h);
  const auto = clamp(short / 220, 4, 14);
  return {
    small: Math.max(auto * 0.5, short * 0.003),
    medium: auto,
    large: Math.max(auto * 2, short * 0.012),
    "x-large": Math.max(auto * 3, short * 0.02)
  }[preset];
}

// ---------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------

/** A stand-in screenshot: window chrome, a sidebar, and body copy at
 *  `uiPx` — the size reference the annotations must beat. */
function mockUiHtml(w, h, uiPx) {
  const rowCount = Math.max(1, Math.floor((h - uiPx * 4) / (uiPx * 2)));
  const body = Array.from({ length: rowCount }, (_, i) => {
    const muted = i % 3 === 0;
    const text = "Deploy pipeline finished · commit a4f9c21 · view logs · retry job · "
      .repeat(6)
      .slice(0, 40 + ((i * 7) % 50));
    return `<div style="height:${uiPx}px;line-height:${uiPx}px;font-size:${uiPx}px;color:${
      muted ? "#8b949e" : "#c9d1d9"
    };font-family:-apple-system,Helvetica,sans-serif;margin-bottom:${uiPx}px;white-space:nowrap;overflow:hidden">${text}</div>`;
  }).join("");
  const dot = (c) =>
    `<div style="width:${uiPx * 0.7}px;height:${uiPx * 0.7}px;border-radius:50%;background:${c}"></div>`;
  return `<div style="position:absolute;inset:0;background:#0d1117;overflow:hidden">
    <div style="height:${uiPx * 2.2}px;background:#161b22;border-bottom:1px solid #30363d;display:flex;align-items:center;padding:0 ${uiPx}px;gap:${uiPx * 0.5}px">
      ${dot("#ff5f57")}${dot("#febc2e")}${dot("#28c840")}
      <div style="margin-left:${uiPx}px;font:${uiPx}px -apple-system,Helvetica,sans-serif;color:#c9d1d9">Build · staging</div>
    </div>
    <div style="display:flex;height:calc(100% - ${uiPx * 2.2}px)">
      <div style="width:${Math.min(w * 0.22, uiPx * 14)}px;background:#161b22;border-right:1px solid #30363d;padding:${uiPx}px;box-sizing:border-box;font:${uiPx}px -apple-system,Helvetica,sans-serif;color:#8b949e">Jobs<br><br>Build<br>Test<br>Deploy</div>
      <div style="flex:1;padding:${uiPx}px;box-sizing:border-box">${body}</div>
    </div>
  </div>`;
}

/** Text samples down the left, arrows down the right, one per rung. */
function overlaySvg(w, h, mode) {
  const basis = annotationBasisPx(w, h);
  const textPx = (b) =>
    mode === "current" ? annotationTextSizePx(b, basis) : legacyTextPx(w, h, b);
  const strokePx = (p) =>
    mode === "current"
      ? annotationStrokeWidthPx(p, basis)
      : legacyStrokePx(w, h, p);

  let out = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="position:absolute;inset:0">`;

  let y = h * 0.08;
  for (const bucket of PRESETS) {
    const px = textPx(bucket);
    y += px * 0.6;
    out += `<text x="${w * 0.02}" y="${y}" font-family="-apple-system, Helvetica, Arial, sans-serif" font-size="${px}" font-weight="700" fill="${ACCENT}" stroke="#fff" stroke-width="${px * 0.08}" paint-order="stroke" dominant-baseline="central">${LABEL[bucket]} Look here</text>`;
    y += px * 0.8;
  }

  let arrowY = h * 0.1;
  for (const preset of PRESETS) {
    const stroke = strokePx(preset);
    const geom = computeArrowGeometry({
      from: { x: 0.55, y: arrowY / h },
      to: { x: 0.97, y: arrowY / h },
      imageWidthPx: w,
      imageHeightPx: h,
      basisPx: basis,
      strokeWidthOverridePx: stroke,
      styleVersion: 2
    });
    const pt = (p) => `${p.x * w},${p.y * h}`;
    const halo = Math.max(1.5, geom.strokeWidthPx * 0.25);
    out += `<g stroke-linecap="round">
      <line x1="${geom.from.x * w}" y1="${geom.from.y * h}" x2="${geom.baseCenter.x * w}" y2="${geom.baseCenter.y * h}" stroke="#fff" stroke-width="${geom.strokeWidthPx + halo * 2}"/>
      <polygon points="${pt(geom.to)} ${pt(geom.baseLeft)} ${pt(geom.baseRight)}" fill="#fff" stroke="#fff" stroke-width="${halo * 2}" stroke-linejoin="round"/>
      <line x1="${geom.from.x * w}" y1="${geom.from.y * h}" x2="${geom.baseCenter.x * w}" y2="${geom.baseCenter.y * h}" stroke="${ACCENT}" stroke-width="${geom.strokeWidthPx}"/>
      <polygon points="${pt(geom.to)} ${pt(geom.baseLeft)} ${pt(geom.baseRight)}" fill="${ACCENT}"/>
    </g>`;
    arrowY += Math.max(stroke * 7, h * 0.055);
  }
  return `${out}</svg>`;
}

function panelHtml(scenario, mode, baseDataUri) {
  const { w, h, ui, name } = scenario;
  const basis = Math.round(annotationBasisPx(w, h));
  const caption =
    mode === "current"
      ? `AFTER  ${name} ${w}x${h}  ui=${ui}px  basis=${basis}`
      : `BEFORE ${name} ${w}x${h}  ui=${ui}px  shortSide=${Math.min(w, h)}`;
  const background =
    baseDataUri !== null
      ? `<img src="${baseDataUri}" style="position:absolute;inset:0;width:${w}px;height:${h}px">`
      : mockUiHtml(w, h, ui);
  return `<div style="position:relative;width:${w}px;height:${h}px;overflow:hidden;background:#0d1117">
    ${background}
    ${overlaySvg(w, h, mode)}
    <div style="position:absolute;left:0;bottom:0;background:#000;color:${
      mode === "current" ? "#4ade80" : "#f87171"
    };font:12px ui-monospace,monospace;padding:2px 6px">${caption}</div>
  </div>`;
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? null : argv[i + 1] ?? null;
  };
  const outDir = resolve(flag("out") ?? join(HERE, "../../../.annotation-scale-eval"));
  const only = flag("only");
  const basePath = flag("base");
  const dims = flag("dims");

  let scenarios = SCENARIOS;
  if (basePath !== null) {
    if (dims === null) {
      throw new Error("--base requires --dims WxH (the raster's natural size)");
    }
    const parsed = /^(\d+)x(\d+)$/.exec(dims.trim());
    if (parsed === null) {
      throw new Error(`--dims must look like 1920x1080 (got "${dims}")`);
    }
    const w = Number(parsed[1]);
    const h = Number(parsed[2]);
    if (w <= 0 || h <= 0) {
      throw new Error(`--dims must be positive (got "${dims}")`);
    }
    // `--ui` lets the caller say what UI text size the real capture
    // contains (~15 for a 1x grab, ~30 for a 2x one) — that is the
    // reference the annotation has to hold its own against.
    const ui = Number(flag("ui") ?? 15);
    scenarios = [{ name: "custom", w, h, ui, base: basePath }];
  } else if (only !== null) {
    scenarios = SCENARIOS.filter((s) => s.name.includes(only));
    if (scenarios.length === 0) {
      throw new Error(`--only ${only} matched no scenario`);
    }
  }

  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const scenario of scenarios) {
      const baseDataUri =
        scenario.base === undefined
          ? null
          : `data:image/png;base64,${readFileSync(scenario.base).toString("base64")}`;
      const page = await browser.newPage({
        viewport: { width: scenario.w, height: Math.min(scenario.h * 2 + 8, 4000) },
        deviceScaleFactor: 1
      });
      await page.setContent(
        `<body style="margin:0;background:#3a3a3a">
          ${panelHtml(scenario, "legacy", baseDataUri)}
          <div style="height:8px"></div>
          ${panelHtml(scenario, "current", baseDataUri)}
        </body>`
      );
      const file = join(outDir, `${scenario.name}.png`);
      await page.screenshot({ path: file, fullPage: true });
      await page.close();
      process.stdout.write(`${file}\n`);
    }
  } finally {
    await browser.close();
  }

  // A plain index so the whole set can be flipped through in a browser.
  const index = `<!doctype html><meta charset="utf-8"><title>Annotation scale eval</title>
<body style="margin:0;background:#222;color:#eee;font:14px ui-monospace,monospace">
<h1 style="padding:16px">Annotation scale — before / after</h1>
${scenarios
  .map(
    (s) =>
      `<section style="padding:8px 16px 24px"><h2>${s.name} — ${s.w}x${s.h}</h2><img src="${s.name}.png" style="max-width:100%;border:1px solid #555"></section>`
  )
  .join("\n")}
</body>`;
  writeFileSync(join(outDir, "index.html"), index);
  process.stdout.write(`${join(outDir, "index.html")}\n`);
}

await main();
