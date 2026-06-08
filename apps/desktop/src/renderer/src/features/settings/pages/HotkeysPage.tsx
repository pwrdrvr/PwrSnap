// Hotkeys settings page. Editable rows for the globally-registered
// chords. Quick Capture / Region / Window / Full Screen / All Screens /
// Timed / Video Capture all drive real capture verbs; Re-show last
// Float-Over re-pops the most recent capture. Region / Window / Full
// Screen / All Screens / Timed default to UNBOUND (also reachable from
// the tray) — bind them here if you want a dedicated chord.
//
// The EDITOR card is a read-only reference for the in-canvas tool keys
// (V / A / S / H / B / T / C). Those are hardcoded in the editor and
// aren't rebindable — the card documents them so they're discoverable.

import { useMemo, useState, type ReactElement } from "react";
import {
  Card,
  Hk,
  HotkeyCapture,
  HotkeyResetModal,
  Row,
  type HotkeyChange
} from "../components";
import { useSettingsContext } from "../SettingsContext";
import { TOOLS } from "../../editor/editor-tools";
import { DEFAULT_HOTKEYS } from "@pwrsnap/shared";

/** The hotkey kinds this page edits — derived from the schema so a new
 *  `Settings["hotkeys"]` field is a compile error here until it gets a
 *  label below. */
type HotkeyKey = keyof typeof DEFAULT_HOTKEYS;

/** Values the "Reset to defaults" button writes back. Same object the
 *  service seeds new installs with — no hand-maintained duplicate to
 *  drift (see `DEFAULT_HOTKEYS` in @pwrsnap/shared). */
const HOTKEY_DEFAULTS: Record<HotkeyKey, string> = DEFAULT_HOTKEYS;

/** Human labels for the editable bindings — used both in the in-page
 *  rows and in the reset-confirmation modal's diff list. */
const HOTKEY_LABELS: Record<HotkeyKey, string> = {
  quickCapture: "Quick Capture",
  region: "Region",
  window: "Window",
  fullScreen: "Full Screen",
  allScreens: "All Screens",
  timed: "Timed (5 s)",
  videoCapture: "Video Capture",
  reshowFloatOver: "Re-show last Float-Over"
};

export function HotkeysPage(): ReactElement {
  const { settings, patch } = useSettingsContext();
  const hk = settings?.hotkeys ?? null;
  const [confirmingReset, setConfirmingReset] = useState<boolean>(false);

  const writeOne = async (key: HotkeyKey, next: string): Promise<void> => {
    const hotkeysPatch: Partial<Record<HotkeyKey, string>> = {};
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
          label="Full Screen"
          sub="Capture the display under the cursor — no selector. Unbound by default; also available from the tray."
          tag="global"
        >
          <HotkeyCapture
            value={hk?.fullScreen ?? ""}
            onCommit={onCommit("fullScreen")}
            onUnbind={onUnbind("fullScreen")}
          />
        </Row>
        <Row
          label="All Screens"
          sub="Stitch every connected display into a single image. Unbound by default; also available from the tray."
          tag="global"
        >
          <HotkeyCapture
            value={hk?.allScreens ?? ""}
            onCommit={onCommit("allScreens")}
            onUnbind={onUnbind("allScreens")}
          />
        </Row>
        <Row
          label="Timed (5 s)"
          sub="5-second countdown, then the auto picker — useful for menus that close on focus loss. Unbound by default; also available from the tray."
          tag="global"
        >
          <HotkeyCapture
            value={hk?.timed ?? ""}
            onCommit={onCommit("timed")}
            onUnbind={onUnbind("timed")}
          />
        </Row>
        <Row
          label="Video Capture"
          sub="Pick a region/window, then record. Defaults to ⌘⌥C (not ⌘⇧V — that's Paste & Match Style system-wide)."
          tag="global"
        >
          <HotkeyCapture
            value={hk?.videoCapture ?? ""}
            onCommit={onCommit("videoCapture")}
            onUnbind={onUnbind("videoCapture")}
          />
        </Row>
      </Card>

      <Card eyebrow="APP" title="Library & surfaces">
        <Row
          label="Re-show last Float-Over"
          sub="Pops the most recent capture back over the screen. Defaults to ⌘⌥⇧F — rebind or unbind any time."
          tag="global"
        >
          <HotkeyCapture
            value={hk?.reshowFloatOver ?? ""}
            onCommit={onCommit("reshowFloatOver")}
            onUnbind={onUnbind("reshowFloatOver")}
          />
        </Row>
      </Card>

      <Card
        eyebrow="EDITOR"
        title="In-canvas tools (Focus + Float-Over)"
        defaultCollapsed
      >
        {TOOLS.map((t, i) => (
          <Row
            key={t.id}
            label={t.label}
            sub={
              i === 0
                ? "Single-letter shortcuts, active when the editor canvas has focus. Fixed — not rebindable."
                : ""
            }
          >
            <Hk keys={[t.key]} />
          </Row>
        ))}
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
