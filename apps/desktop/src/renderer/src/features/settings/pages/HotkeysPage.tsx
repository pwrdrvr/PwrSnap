// Hotkeys settings page. Editable rows for the four globally-
// registered chords (Quick Capture, Region, Window, Video Capture).
// Every other row in the page is a "preview" placeholder for a future
// surface — the in-canvas editor shortcuts, the All Screens chord,
// etc. — and is intentionally non-interactive.

import { useMemo, useState, type ReactElement } from "react";
import {
  Card,
  Hk,
  HkUnset,
  HotkeyCapture,
  HotkeyResetModal,
  Row,
  type HotkeyChange
} from "../components";
import { useSettingsContext } from "../SettingsContext";

/** Defaults the "Reset to defaults" button writes back. These mirror
 *  the service-side `defaultSettings()` — keep them in lock-step. */
const HOTKEY_DEFAULTS = {
  quickCapture: "CommandOrControl+Shift+C",
  region: "",
  window: "",
  videoCapture: "CommandOrControl+Shift+V"
} as const;

type HotkeyKey = "quickCapture" | "region" | "window" | "videoCapture";

/** Human labels for the four editable bindings — used both in the
 *  in-page rows and in the reset-confirmation modal's diff list. */
const HOTKEY_LABELS: Record<HotkeyKey, string> = {
  quickCapture: "Quick Capture",
  region: "Region",
  window: "Window",
  videoCapture: "Video Capture"
};

export function HotkeysPage(): ReactElement {
  const { settings, patch } = useSettingsContext();
  const hk = settings?.hotkeys ?? null;
  const [confirmingReset, setConfirmingReset] = useState<boolean>(false);

  const writeOne = async (key: HotkeyKey, next: string): Promise<void> => {
    // Explicit object spread so TypeScript can verify the patch shape
    // against `Partial<Settings["hotkeys"]>` without falling back to
    // index-signature inference.
    const hotkeysPatch: Partial<{
      quickCapture: string;
      region: string;
      window: string;
      videoCapture: string;
    }> = {};
    hotkeysPatch[key] = next;
    await patch({ hotkeys: hotkeysPatch });
  };

  const onCommit = (key: HotkeyKey) => (next: string): Promise<void> =>
    writeOne(key, next);
  const onUnbind = (key: HotkeyKey) => (): Promise<void> => writeOne(key, "");

  /** Diff every editable binding against its default. Drives both the
   *  customization-count badge in the header and the modal's diff list. */
  const pendingChanges = useMemo<HotkeyChange[]>(() => {
    if (hk === null) return [];
    const out: HotkeyChange[] = [];
    for (const key of Object.keys(HOTKEY_DEFAULTS) as HotkeyKey[]) {
      const current = hk[key];
      const next = HOTKEY_DEFAULTS[key];
      if (current === next) continue;
      out.push({ key, label: HOTKEY_LABELS[key], current, next });
    }
    return out;
  }, [hk]);

  const onConfirmReset = async (): Promise<void> => {
    await patch({ hotkeys: { ...HOTKEY_DEFAULTS } });
    setConfirmingReset(false);
  };

  const count = pendingChanges.length;
  const customizedNoun = count === 1 ? "customization" : "customizations";

  return (
    <>
      <div className="pss__main-hdr">
        <div className="pss__main-hdr-l">
          <div className="pss__main-eyebrow">General</div>
          <h1 className="pss__main-title">Hotkeys</h1>
          <p className="pss__main-sub">
            PwrSnap is keyboard-first. Quick Capture is the &ldquo;smart&rdquo;
            trigger — picks region, window, or full-screen based on the cursor.
            Click any chord below to rebind. Press Escape mid-record to cancel.
          </p>
        </div>
        <div className="pss__main-actions">
          {count > 0 ? (
            <span className="pss__main-count" aria-live="polite">
              {count} {customizedNoun}
            </span>
          ) : null}
          <button
            type="button"
            className="pss__top-btn"
            disabled={count === 0}
            onClick={() => setConfirmingReset(true)}
          >
            Reset to defaults
          </button>
        </div>
      </div>

      <Card eyebrow="CAPTURE" title="Global capture shortcuts">
        <Row
          label="Quick Capture"
          sub="The smart trigger. Picks region, window, or full-screen based on the cursor."
          tag="global"
        >
          <HotkeyCapture
            value={hk?.quickCapture ?? ""}
            onCommit={onCommit("quickCapture")}
            onUnbind={onUnbind("quickCapture")}
          />
        </Row>
        <Row
          label="Region"
          sub="Drag a marquee on any display. Unbound by default — Quick Capture covers it."
          tag="global"
        >
          <HotkeyCapture
            value={hk?.region ?? ""}
            onCommit={onCommit("region")}
            onUnbind={onUnbind("region")}
          />
        </Row>
        <Row
          label="Window"
          sub="Click a window. Unbound by default — Quick Capture covers it."
          tag="global"
        >
          <HotkeyCapture
            value={hk?.window ?? ""}
            onCommit={onCommit("window")}
            onUnbind={onUnbind("window")}
          />
        </Row>
        <Row
          label="Video Capture"
          sub="Recording surface ships in a later release; the hotkey is wired so muscle memory carries over."
          tag="global"
        >
          <HotkeyCapture
            value={hk?.videoCapture ?? ""}
            onCommit={onCommit("videoCapture")}
            onUnbind={onUnbind("videoCapture")}
          />
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

      <Card eyebrow="EDITOR" title="In-canvas tools (Focus + Float-Over)" defaultCollapsed>
        <Row
          label="Select / Crop / Arrow / Rect / Highlight / Text / Blur"
          sub="Single-letter when focus is in the editor canvas."
          tag="preview"
        >
          <HkUnset />
        </Row>
      </Card>

      {confirmingReset ? (
        <HotkeyResetModal
          changes={pendingChanges}
          onCancel={() => setConfirmingReset(false)}
          onConfirm={onConfirmReset}
        />
      ) : null}
    </>
  );
}
