// Real-data wrapper around <FloatOver>. Fetches the capture record by
// id (dispatched library:byId), renders the preview through the
// pwrsnap-cache:// custom protocol (no IPC bytes — Chromium decodes
// off-thread), wires ⌘1/⌘2/⌘3 to clipboard:copy.

import { useEffect, useState } from "react";
import type { CaptureRecord } from "@pwrsnap/shared";
import { FloatOver } from "./FloatOver";
import { dispatch } from "../../lib/pwrsnap";

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; record: CaptureRecord }
  | { kind: "error"; message: string };

export function FloatOverForCapture({ captureId }: { captureId: string }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    void dispatch("library:byId", { id: captureId }).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setState({ kind: "error", message: result.error.message });
        return;
      }
      if (result.value === null) {
        setState({ kind: "error", message: `capture not found: ${captureId}` });
        return;
      }
      setState({ kind: "loaded", record: result.value });
    });
    return () => {
      cancelled = true;
    };
  }, [captureId]);

  // ⌘1 / ⌘2 / ⌘3 → clipboard:copy. Bound at the renderer level so the
  // toast captures the keystrokes when focused.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (!event.metaKey || event.shiftKey || event.altKey) return;
      let preset: "low" | "med" | "high" | null = null;
      if (event.key === "1") preset = "low";
      else if (event.key === "2") preset = "med";
      else if (event.key === "3") preset = "high";
      if (preset === null) return;
      event.preventDefault();
      void dispatch("clipboard:copy", { captureId, preset });
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [captureId]);

  if (state.kind === "loading") {
    return (
      <div style={{ padding: 20, color: "var(--text-secondary)", font: "500 12px var(--font-sans)" }}>
        Loading capture…
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div style={{ padding: 20, color: "var(--danger-text)", font: "500 12px var(--font-sans)" }}>
        Couldn't load capture: {state.message}
      </div>
    );
  }

  const { record } = state;
  // Use the cache protocol at the medium preset for the preview —
  // matches the float-over's intended display size and pre-warms the
  // cache for the user's most-likely first ⌘ shortcut.
  const previewSrc = `pwrsnap-cache://${record.id}/1440w.webp`;
  return (
    <FloatOver
      src={previewSrc}
      srcW={record.width_px}
      srcH={record.height_px}
      onDismiss={() => {
        void dispatch("float-over:dismiss", {});
      }}
    />
  );
}
