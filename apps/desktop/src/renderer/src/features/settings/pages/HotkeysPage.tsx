// Hotkeys settings page — read-only display today. Ported from
// design/src/Settings.jsx `HotkeysPage` (lines 403–476) with the
// hard-coded bindings swapped for `settings.hotkeys.*` reads, the
// Edit affordance removed per the Slice D plan, and the footer
// telling the user editing comes later.

import type { ReactElement } from "react";
import { Card, Hk, HkUnset, Row } from "../components";
import { useSettingsContext } from "../SettingsContext";

/**
 * Translate an Electron accelerator string (e.g. `CommandOrControl+Shift+P`,
 * `Cmd+Alt+R`, `Option+Backspace`) into the array of glyphs the
 * `Hk` component renders. Returns an empty array for `null` so the
 * page can render `<HkUnset />` cleanly.
 *
 * Pure — no DOM access — so it's trivially testable.
 */
export function acceleratorToDisplayKeys(accel: string | null): string[] {
  if (accel === null || accel.length === 0) return [];
  const parts = accel.split("+").map((p) => p.trim());
  const out: string[] = [];
  for (const raw of parts) {
    out.push(modifierToGlyph(raw));
  }
  return out;
}

function modifierToGlyph(part: string): string {
  const lower = part.toLowerCase();
  switch (lower) {
    case "command":
    case "cmd":
    case "commandorcontrol":
    case "cmdorctrl":
    case "super":
      return "⌘"; // ⌘
    case "control":
    case "ctrl":
      return "⌃"; // ⌃
    case "alt":
    case "option":
      return "⌥"; // ⌥
    case "shift":
      return "⇧"; // ⇧
    case "meta":
      return "⌘";
    case "return":
    case "enter":
      return "⏎"; // ⏎
    case "esc":
    case "escape":
      return "Esc";
    case "tab":
      return "Tab";
    case "space":
      return "Space";
    case "backspace":
      return "⌫"; // ⌫
    case "delete":
      return "⌦"; // ⌦
    case "left":
      return "←";
    case "right":
      return "→";
    case "up":
      return "↑";
    case "down":
      return "↓";
    default:
      // Single-character keys (letters / digits / punctuation):
      // uppercase letters for visual parity with how macOS draws
      // them in menus.
      return part.length === 1 ? part.toUpperCase() : part;
  }
}

export function HotkeysPage(): ReactElement {
  const { settings, loading } = useSettingsContext();

  // While the first settings:read is in flight we still render the
  // structure — the rows just degrade to HkUnset. The page is purely
  // read-display, so loading state isn't load-bearing.
  const hk = settings?.hotkeys ?? null;
  void loading;

  return (
    <>
      <div className="pss__main-hdr">
        <div className="pss__main-hdr-l">
          <div className="pss__main-eyebrow">General</div>
          <h1 className="pss__main-title">Hotkeys</h1>
          <p className="pss__main-sub">
            PwrSnap is keyboard-first. &#x2318;&#x21E7;P is the global &ldquo;smart&rdquo; trigger
            that fires whatever capture mode is set as Quick Capture; the rest
            jump straight to a specific mode.
          </p>
        </div>
      </div>

      <Card eyebrow="CAPTURE" title="Global capture shortcuts">
        <Row
          label="Quick Capture"
          sub="The smart trigger. Picks region, window, or full-screen based on the cursor."
          tag="preview"
        >
          {renderHk(hk?.quickCapture ?? null)}
        </Row>
        <Row
          label="Region"
          sub="Drag a marquee on any display."
          tag="global"
        >
          {renderHk(hk?.region ?? null)}
        </Row>
        <Row
          label="Window"
          sub="Click a window. &#x2325; to include shadow."
          tag="global"
        >
          {renderHk(hk?.window ?? null)}
        </Row>
        <Row
          label="Full Screen"
          sub="Active display."
          tag="preview"
        >
          <Hk keys={["⌘", "⇧", "F"]} />
        </Row>
        <Row
          label="All Screens"
          sub="Stitch every connected display into a single image."
          tag="preview"
        >
          <Hk keys={["⌘", "⇧", "A"]} />
        </Row>
        <Row
          label="Scrolling"
          sub="Capture full page from a scroll container."
          tag="preview"
        >
          <Hk keys={["⌘", "⇧", "S"]} />
        </Row>
        <Row
          label="Timed (5 s)"
          sub="Auto-trigger after countdown — useful for menus that close on focus loss."
          tag="preview"
        >
          <Hk keys={["⌘", "⇧", "T"]} />
        </Row>
      </Card>

      <Card eyebrow="APP" title="Library & surfaces">
        <Row
          label="Open Library"
          sub="Brings the Library window to front and focuses the grid."
          tag="preview"
        >
          <Hk keys={["⌘", "⇧", "L"]} />
        </Row>
        <Row
          label="Open Tray"
          sub="Drops the menubar tray under the PwrSnap icon."
          tag="preview"
        >
          <Hk keys={["⌘", "⇧", "M"]} />
        </Row>
        <Row
          label="Re-show last Float-Over"
          sub="Pops the most recent capture back over the screen."
          tag="preview"
        >
          <HkUnset />
        </Row>
        <Row label="Open Settings" sub="This window." tag="global">
          <Hk keys={["⌘", ","]} />
        </Row>
      </Card>

      <Card eyebrow="EDITOR" title="In-canvas tools (Focus + Float-Over)" collapsed>
        <Row
          label="Select / Crop / Arrow / Rect / Highlight / Text / Blur"
          sub="Single-letter when focus is in the editor canvas."
          tag="preview"
        >
          <HkUnset />
        </Row>
      </Card>

      <div className="pss__footer">
        <span className="pss__footer-status">
          Editing comes in a later release. Hotkeys are immutable in this build.
        </span>
      </div>
    </>
  );
}

function renderHk(accel: string | null): ReactElement {
  const keys = acceleratorToDisplayKeys(accel);
  if (keys.length === 0) return <HkUnset />;
  return <Hk keys={keys} />;
}
