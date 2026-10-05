import { useEffect, useRef, useState } from "react";
import { DEFAULT_AVATAR_STYLE, type AvatarStyle, type CaptureRecord } from "@pwrsnap/shared";
import { useDismissable } from "../../lib/useDismissable";
import { AvatarControls } from "./AvatarControls";
import "./camera.css";

/** Settings float over the stage, so opening them never shrinks the preview. */
export function CameraTrack({ capture, onChange, error = "" }: {
  capture: CaptureRecord;
  onChange: (style: AvatarStyle) => void;
  error?: string;
}) {
  const [open, setOpen] = useState(false);
  const [sourceState, setSourceState] = useState("Opening camera…");
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useDismissable({ open, onDismiss: () => setOpen(false), triggerRef: trigger,
    surfaceRef: panel, dismissOnFocusLeave: true });
  useEffect(() => { setOpen(false); setSourceState("Opening camera…"); }, [capture.id]);
  const camera = capture.video?.camera;
  if (!camera) return null;
  const style = capture.video?.avatar ?? DEFAULT_AVATAR_STYLE;
  return <div className="camera-track" data-testid="camera-track" onKeyDown={event => event.stopPropagation()}>
    <video className="camera-track__thumbnail" src={`pwrsnap-capture://c/${capture.id}`}
      muted playsInline preload="auto" aria-label="Recorded camera source"
      onLoadedData={() => setSourceState(`${camera.width} × ${camera.height} · ${camera.durationSec.toFixed(1)}s saved`)}
      onError={() => setSourceState("Camera file unavailable")} />
    <div className="camera-track__label"><strong>Camera <span>Avatar track</span></strong>
      <span role="status">{error || sourceState}{!style.visible ? " · hidden" : ""}</span></div>
    <button type="button" aria-label={style.visible ? "Hide avatar" : "Show avatar"}
      aria-pressed={style.visible} onClick={() => onChange({ ...style, visible: !style.visible })}>
      {style.visible ? "Visible" : "Hidden"}</button>
    <button type="button" ref={trigger} aria-expanded={open} onClick={() => setOpen(value => !value)}>Avatar settings</button>
    {open && <div ref={panel} className="camera-track__settings" role="dialog" aria-label="Avatar settings">
      <div className="camera-track__heading"><strong>Avatar settings</strong>
        <button type="button" onClick={() => { setOpen(false); trigger.current?.focus(); }}>Done</button></div>
      {camera.timing === "estimated" && <p className="camera-track__notice">Timing recovered from an older recording. Use Sync adjustment to refine it.</p>}
      <AvatarControls value={style} cameraAspectRatio={camera.width / camera.height}
        canvasAspectRatio={capture.width_px / capture.height_px} onChange={onChange} />
    </div>}
  </div>;
}
