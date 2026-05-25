# PwrSnap — Project Notes for Claude

These are persistent instructions for any session working in this project. Read this **before** touching brand marks, logos, wordmarks, or hotkey copy.

---

## 1. The PwrSnap brand mark — there is exactly ONE

**There are many marks like it, but this one is mine.** If you find yourself drawing a lightning bolt, a "P" glyph, a camera, a shutter, or anything else inside the PwrSnap tile, **stop**. The mark is a **stack of three offset rounded squares** — the "stacked screenshots" metaphor. Nothing else.

### Geometry

- viewBox `0 0 24 24`
- Three `<rect>`s, each `13 × 13`, `rx="2.5"`
- Stacked diagonally **lower-left front, upper-right back**:
  - **Back** layer at `(x=8, y=3)` — top-right corner of the stack
  - **Mid** layer at `(x=5.5, y=5.5)` — centered
  - **Front** layer at `(x=3, y=8)` — bottom-left corner of the stack
- Stroke-only (no fill); `strokeLinejoin="round"`, `strokeLinecap="round"`

> Direction matters. **Front is bottom-LEFT.** If you draw front at bottom-right (or top-left), the mark is wrong — that is the "reversed" version the user has flagged twice now.

### Colors

Each layer has an **explicit** stroke color — do NOT use `currentColor`. The mark must read as orange/copper regardless of the surrounding text color (it lives in titlebars, menubars, and dark panels where the inherited color varies).

| Layer | Stroke | Why |
|---|---|---|
| Back  | `var(--accent-deep)` (`#b35f15`) | Deepest, recedes into the tile |
| Mid   | `color-mix(in oklch, var(--accent-deep), var(--accent))` ≈ `#d97419` | Midpoint between deep and accent |
| Front | `var(--accent)` (`#ff8a1f`) | Bright tangerine, the "live" screenshot on top |

Stroke widths: back `1.5`, mid `1.5`, front `1.6` (front a touch thicker to pop).

### Canonical JSX

```jsx
function PwrSnapMark({ size = 14 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size}
         fill="none" strokeLinejoin="round" strokeLinecap="round"
         style={{ display: "block" }} aria-label="PwrSnap">
      {/* Back — top-right, deepest */}
      <rect x="8"   y="3"   width="13" height="13" rx="2.5"
            style={{ stroke: "var(--accent-deep)" }} strokeWidth="1.5"/>
      {/* Mid — centered, copper midpoint */}
      <rect x="5.5" y="5.5" width="13" height="13" rx="2.5"
            style={{ stroke: "color-mix(in oklch, var(--accent-deep), var(--accent))" }}
            strokeWidth="1.5"/>
      {/* Front — bottom-left, bright tangerine */}
      <rect x="3"   y="8"   width="13" height="13" rx="2.5"
            style={{ stroke: "var(--accent)" }} strokeWidth="1.6"/>
    </svg>
  );
}
```

### Where it lives

Exactly **two** definitions exist, and they must stay byte-identical to the snippet above:

1. `src/AppIcons.jsx` → `APP_ICONS.pwrsnap` — used by `<PsAppIcon app="pwrsnap" />` in Library, Settings, Tray titlebars and the macOS menubar slot. Surfaces in `PwrSnap Library.html`, `PwrSnap Settings.html`, `PwrSnap Tray.html`.
2. `src/FloatOver.jsx` → `FoMark` — used in the Float-Over toast header and its faux macOS menubar slot. Surfaces in `PwrSnap Float-Over.html`. (FoMark exists separately because `PwrSnap Float-Over.html` doesn't load `AppIcons.jsx`.)

**Both must move together.** Any edit to one is incomplete until the other matches.

### Don'ts

- ❌ Don't draw a lightning bolt. (Crept in during an unknown refactor; permanently retired.)
- ❌ Don't draw a "P" glyph as the brand mark. (`FoMark` was previously a P-shape; corrected.)
- ❌ Don't reverse the offset direction.
- ❌ Don't rely on `currentColor` for any of the three stroke colors.
- ❌ Don't invent a fourth layer, a tile background inside the SVG, a frame, a shutter, or any "extra detail." Three rects, that's it.

---

## 2. The PwrSnap wordmark

- **One word**, two colors: `Pwr<span class="a">Snap</span>` — "Pwr" in `--text-primary` (bone-white), "Snap" in `--accent` (tangerine).
- Letter-spacing `-0.03em`. Reads as "PwrSnap", not "Pwr Snap" — no visible gap.
- **Wrap both fragments in a single span** when the parent is a flex container with `gap`. Otherwise the bare "Pwr" text node becomes its own anonymous flex item and the `gap` opens a visible space between "Pwr" and "Snap". See `psl__wordmark` in `src/Library.jsx` for the pattern.

---

## 3. Suite color tokens (PwrAgent is system-of-record)

- `--bg-app` is **pure black `#000000`**, not warm near-black.
- `--accent` is **tangerine `#ff8a1f`**, not burnt copper.
- `--button-text-on-accent` is `#000000`, not a warm near-black.
- Geist + Geist Mono everywhere; never substitute Inter/Roboto/system fonts.

Tokens live in `ds/colors_and_type.css`. Never hardcode brand colors in component files — reference the token. If a literal hex is unavoidable (e.g. in an SVG attribute that can't take `var()`), use `style={{ stroke: "var(--…)" }}` instead.

The PwrAgent design system project (read-only) at `/projects/019debaf-c070-7afe-98db-4c9bbe10e72b/` is the visual reference for anything not pinned here.

---

## 4. Hotkeys

- **Quick Capture is `⌘⇧C`** (was `⌘⇧P` historically; swapped to free `P` for other uses).
- Region `⌘⇧R`, Video Capture `⌘⇧V`, Full Screen `⌘⇧F`, Library `⌘L`, Search `⌘K`.

---

## 5. House style

- Voice: technical, terse, lowercase jargon, no emoji, no marketing gloss. Engineers writing for engineers. See PwrDrvr design system README for full rules.
- No invented copy unless asked — if a section feels empty, that's a layout problem, not a content problem.
