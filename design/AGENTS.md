# PwrSnap — Project Notes for Claude

**Before touching the brand mark, logo, wordmark, color tokens, hotkey copy,
the icon/tray/README-chip generators, or anything synced with Claude Design,
read [docs/agents/brand-and-design.md](../docs/agents/brand-and-design.md).**
It holds the full rules, geometry and history behind each line below.

## 1. The PwrSnap brand mark — there is exactly ONE

Three stroked rounded rectangles on a diagonal: **front bottom-LEFT, back
top-RIGHT**, opacities 1 / 0.55 / 0.3. No lightning bolt, "P", camera,
shutter, fourth layer or frame. The app icon (`generate-app-icon.swift`), the
in-app `PwrSnapMark` (`BrandMark.tsx`) and the tray PNGs are one drawing:
change them together. The tiers are a **hard stack, never a blend**. The
`design/src/` handoff drawing is reference only.

## 2. The PwrSnap wordmark

One word: "Pwr" in `--text-primary`, "Snap" in `--accent`, `-0.01em`, both
fragments in one span (`PwrSnapWordmark`).

## 3. Suite color tokens (PwrAgent is system-of-record)

`--bg-app` `#000000`, `--accent` `#ff8a1f`, the app icon's separate `#e8743a`
(never unify the two oranges), Geist + Geist Mono. Reference tokens, never
hardcode; native generators use `deviceRGB`. Product design work goes in the
PwrSnap Claude Design **project**, never the design system, and that project
does not appear in `list_projects`. `PwrSnap README Header.html`'s image paths
differ between the repo and project copies.

## 4. Hotkeys

Quick Capture `⌘⇧C`, Region `⌘⇧R`, Video Capture `⌘⇧V`, Full Screen `⌘⇧F`,
Library `⌘L`, Search `⌘K`.

## 5. House style

Technical, terse, no emoji, no marketing gloss; no invented copy unless asked.
