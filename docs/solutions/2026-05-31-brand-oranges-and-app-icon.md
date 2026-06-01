---
title: Brand oranges — wordmark #ff8a1f vs app-icon #e8743a (and the calibratedRGB drift)
type: solution
date: 2026-05-31
area: design
tags: [brand, color, accent, app-icon, dmg, swift, deviceRGB, pwragent-parity]
---

# Brand oranges: there are two, on purpose

PwrDrvr products use **two distinct oranges**, for two distinct jobs. They are
easy to confuse (both are "orange," and they sit a few RGB steps apart), and a
native-rendering gotcha keeps spawning a third, wrong one. This note pins down
which is which, where each lives, and why PwrSnap matches PwrAgent.

## The two oranges

| Color | Role | Where it's defined |
|---|---|---|
| **`#ff8a1f`** (255,138,31) — bright tangerine | The **wordmark + all in-app UI accent**. The "Snap" half of the wordmark, buttons, highlights, anything `--accent`. Also the wordmark drawn into the **DMG** background art. | CSS token `--accent` in [tokens.css](../../apps/desktop/src/renderer/src/styles/tokens.css) + [design/ds/colors_and_type.css](../../design/ds/colors_and_type.css); applied to the wordmark via `.pwrsnap-wordmark__a` in [app.css](../../apps/desktop/src/renderer/src/styles/app.css). Hardcoded (deviceRGB) in [generate-dmg-background.swift](../../apps/desktop/scripts/generate-dmg-background.swift). |
| **`#e8743a`** (232,116,58) — deeper amber | The **macOS app icon** only (the stacked-screenshots mark on the dark gradient tile). Nothing else. | Hardcoded (deviceRGB) in [generate-app-icon.swift](../../apps/desktop/scripts/generate-app-icon.swift). Not a CSS token — the icon is native, outside the token system. |

The app-icon orange is intentionally **deeper/less saturated** than the wordmark
tangerine. It is not a mistake and not a token drift — it's a separate brand
value. Don't "fix" the icon to `#ff8a1f` to match the wordmark; they are
supposed to differ.

## PwrAgent uses the same colors for the same things

PwrAgent is the system-of-record for PwrDrvr brand tokens, and PwrSnap mirrors
it exactly on the two real oranges:

- **Wordmark / UI `#ff8a1f`** — PwrAgent's `--accent` is `#ff8a1f`
  (`PwrAgnt/apps/desktop/src/renderer/src/styles/app.css`), and it paints the
  "Agent" half of its wordmark with `var(--accent)` in the sidebar, settings
  nav, **and window title bars** (`.activity-titlebar__brand-accent`,
  `.settings-nav__brand-accent`, `.sidebar__brand-accent`). PwrAgent even has a
  `theme-contract` test locking those brand-accent selectors to `#ff8a1f`.
  PwrSnap's `.pwrsnap-wordmark__a` is the identical construction.
- **App icon `#e8743a`** — PwrAgent's icon (`build/icon.png`, the brightest
  "bar") samples to `#e8743a`; PwrSnap's icon mark is pinned to the same value.
  (PwrAgent's icon `icon.png` is a static asset with no generator, so there's no
  source color to read — it was measured by sampling the PNG.)

So: same `#ff8a1f` for wordmarks/UI, same `#e8743a` for the app icon, in both
products.

### Where PwrAgent and PwrSnap diverge: the DMG

PwrSnap draws the **wordmark** into its DMG background, so the DMG orange is the
wordmark color `#ff8a1f` — deliberately consistent with the in-app wordmark.
PwrAgent's DMG generator uses a *separate, reddish* orange that renders to about
`#ef714a` (and via calibratedRGB, so it also drifts — see below). We did **not**
copy that; PwrSnap's DMG is intentionally tighter than PwrAgent's here.

## The gotcha: calibratedRGB drifts; use deviceRGB in the native generators

The two Swift generators ([generate-app-icon.swift](../../apps/desktop/scripts/generate-app-icon.swift),
[generate-dmg-background.swift](../../apps/desktop/scripts/generate-dmg-background.swift))
render into an `NSBitmapImageRep` whose color space is `deviceRGB`. If a color
is created with **`NSColor(calibratedRed:…)`**, AppKit converts calibrated →
device on the way out and the **output pixels shift lighter**. That conversion
is what produced the *third* orange both surfaces had:

- The icon mark, coded `calibratedRed: 0.910/0.455/0.227` (intending `#e8743a`),
  rendered as a washed-out **`#ee894a`** (238,137,74).
- The DMG wordmark, coded `calibratedRed: 1.000/0.541/0.122` (intending
  `#ff8a1f`), *also* rendered **`#ee894a`** — a spurious third orange next to
  the real two.

The fix in both generators: define the brand colors with **`NSColor(deviceRed:…)`**
(values as `n / 255.0`) so the output pixels land on the intended hex exactly.
`NSGradient` has the same trap — it interpolates in *linear light*, so the icon
background gradient is filled **per-scanline in deviceRGB** to keep the ramp
linear in encoded output (see the icon generator's background loop).

**Rule:** in any native (`AppKit`/`Swift`) art generator, brand colors are
`deviceRed`, not `calibratedRed`. CSS surfaces use the `--accent` token and need
no special handling (CSS is already sRGB-encoded).

## How to verify

Sample the rendered PNGs rather than trusting the source values (which lie under
calibratedRGB). Quick `sharp`-based check — find the most-frequent saturated
orange and the background gradient endpoints:

```js
// from apps/desktop (sharp is a dep there)
import sharp from "sharp";
const { data, info } = await sharp("build/icon.png").raw().toBuffer({ resolveWithObject: true });
// scan opaque pixels, tally R>G>B "orange" colors, report the mode → expect #e8743a
// sample a left-margin vertical strip → expect a warm gradient #1c1813 (top) → #0c0b09 (bottom)
```

Expected, after the deviceRGB fixes:

- `build/icon.png` (and every `icon.iconset/*`): dominant orange **`#e8743a`**;
  background gradient **`#1c1813` → `#0c0b09`** (warm, top→bottom).
- `build/dmg-background.png`: wordmark/arrow orange **`#ff8a1f`**.
- In-app wordmark: `--accent` = **`#ff8a1f`**.

## When you touch this

- Regenerate after editing either generator:
  `pnpm --filter @pwrsnap/desktop generate:app-icon` and
  `pnpm --filter @pwrsnap/desktop generate:dmg-background`. Both commit their
  PNG output (and the icon's `.iconset` + `.icns`).
- Don't unify the icon to `#ff8a1f` or the wordmark to `#e8743a` — the
  two-orange split is intentional and matches PwrAgent.
- If you ever see an orange that isn't `#ff8a1f` or `#e8743a` in a rendered
  asset (e.g. `#ee894a`), it's almost certainly a `calibratedRed` that should be
  `deviceRed`.
