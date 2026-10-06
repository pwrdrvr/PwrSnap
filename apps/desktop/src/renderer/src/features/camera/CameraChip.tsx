// The camera, as a recording source chip in the region selector — beside
// Microphone and System audio, on `K`. Arming it opens the camera for a
// live preview; the caret opens a device list with a larger preview.
//
// The camera is recorded as its own track. Where the presenter goes, and
// how it looks, is decided afterwards on the stage, so nothing here asks
// about placement or background.
//
// While armed, the take may not start until the stream is open
// (`onReady(false)`): a recording the user asked to include the camera in
// must not silently start without it. A stream that fails or disconnects
// keeps blocking until the user picks another camera or turns it off.

import { useEffect, useRef, useState, type ReactElement } from "react";
import type { RecordingCamera } from "@pwrsnap/shared";
import { useDismissable } from "../../lib/useDismissable";
import { SourceChip, type SourceChipState } from "../shared/SourceChip";
import "./camera.css";

export function CameraChip({
  enabled,
  onToggle,
  value,
  onChange,
  onReady
}: {
  readonly enabled: boolean;
  readonly onToggle: (next: boolean) => void;
  readonly value: RecordingCamera | undefined;
  readonly onChange: (camera: RecordingCamera | undefined) => void;
  readonly onReady: (ready: boolean) => void;
}): ReactElement {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState(value?.deviceId ?? "");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const change = useRef(onChange);
  change.current = onChange;
  const ready = useRef(onReady);
  ready.current = onReady;
  const toggle = useRef(onToggle);
  toggle.current = onToggle;
  const caretRef = useRef<HTMLSpanElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  // A prewarmed selector that is hidden must not keep the camera light on.
  useEffect(() => {
    const hidden = (): void => {
      if (!document.hidden) return;
      setOpen(false);
      change.current(undefined);
      ready.current(true);
      toggle.current(false);
    };
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, []);

  const wasEnabled = useRef(false);
  useEffect(() => {
    if (!enabled) {
      setStream(null);
      setError("");
      setOpen(false);
      ready.current(true);
      // Disarming drops the camera from the take. Only on the way down:
      // a chip that mounts disarmed has nothing to drop.
      if (wasEnabled.current) change.current(undefined);
      wasEnabled.current = false;
      return;
    }
    wasEnabled.current = true;
    ready.current(false);
    let retired = false;
    let opened: MediaStream | null = null;
    const enumerate = async (): Promise<void> => {
      try {
        const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(
          (device) => device.kind === "videoinput"
        );
        if (!retired) setDevices(inputs);
      } catch {
        /* The opened camera can still record if enumeration fails. */
      }
    };
    setError("");
    void navigator.mediaDevices
      .getUserMedia({ video: deviceId ? { deviceId: { exact: deviceId } } : true, audio: false })
      .then(async (media) => {
        if (retired) {
          media.getTracks().forEach((track) => track.stop());
          return;
        }
        opened = media;
        const track = media.getVideoTracks()[0]!;
        const selected = track.getSettings().deviceId;
        if (!selected) throw new Error("This camera did not provide a device identifier.");
        track.onended = () => {
          if (retired) return;
          ready.current(false);
          setStream(null);
          setError("Camera disconnected. Choose a camera or turn it off to continue.");
          change.current(undefined);
        };
        setStream(media);
        change.current({ deviceId: selected });
        ready.current(true);
        await enumerate();
      })
      .catch((cause: unknown) => {
        opened?.getTracks().forEach((track) => track.stop());
        if (retired) return;
        ready.current(false);
        setStream(null);
        setError(cause instanceof Error ? cause.message : "Camera unavailable");
        change.current(undefined);
      });
    navigator.mediaDevices.addEventListener("devicechange", enumerate);
    return () => {
      retired = true;
      opened?.getTracks().forEach((track) => track.stop());
      navigator.mediaDevices.removeEventListener("devicechange", enumerate);
      ready.current(true);
    };
  }, [enabled, deviceId]);

  useDismissable({
    open,
    onDismiss: () => setOpen(false),
    surfaceRef: popRef,
    triggerRef,
    dismissOnFocusLeave: true
  });
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      const root = caretRef.current;
      if (root !== null && e.target instanceof Node && root.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open]);

  const state: SourceChipState = !enabled ? "off" : error !== "" ? "nodevice" : "live";
  const why = !enabled ? undefined : error !== "" ? "unavailable" : stream === null ? "starting" : undefined;
  const current = deviceId || value?.deviceId || "";
  const label = devices.find((d) => d.deviceId === current)?.label;

  return (
    <span
      className="camera-chip"
      ref={caretRef}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <SourceChip
        source="camera"
        state={state}
        {...(why !== undefined ? { why } : {})}
        kbd="K"
        hasDevices={enabled}
        onOpenDevices={() => {
          triggerRef.current = caretRef.current?.querySelector<HTMLElement>(".ps-chip__devices") ?? null;
          setOpen((v) => !v);
        }}
        onToggle={() => onToggle(!enabled)}
        testId="region-hud-camera"
      />
      {enabled && !open && stream !== null ? (
        <span className="camera-bubble" aria-hidden="true">
          <CameraPreview stream={stream} />
        </span>
      ) : null}
      {open ? (
        <div
          ref={popRef}
          className="camera-pop"
          role="dialog"
          aria-label="Camera"
          data-testid="region-hud-camera-devices"
        >
          <div className="camera-pop__hd">Camera</div>
          <div className="camera-pop__list" role="radiogroup" aria-label="Camera device">
            {devices.length === 0 ? (
              <span className="camera-pop__empty">{error !== "" ? "No camera available" : "Opening camera…"}</span>
            ) : (
              devices.map((device, index) => (
                <button
                  key={device.deviceId}
                  type="button"
                  role="radio"
                  aria-checked={device.deviceId === current}
                  className="camera-pop__row"
                  onClick={() => {
                    if (device.deviceId === current) return;
                    ready.current(false);
                    setDeviceId(device.deviceId);
                  }}
                >
                  <span className="camera-pop__dot" aria-hidden="true" />
                  {device.label || `Camera ${index + 1}`}
                </button>
              ))
            )}
          </div>
          <div className="camera-pop__pv">
            {stream !== null ? <CameraPreview stream={stream} /> : null}
            <span className="camera-pop__tag">{label ? "Preview · mirrored" : "Preview"}</span>
          </div>
          <p className="camera-pop__note">
            Saved as its own track. Place it and change its look after recording.
          </p>
          {error !== "" ? (
            <div className="camera-pop__err" role="alert">
              {error}
            </div>
          ) : null}
        </div>
      ) : error !== "" ? (
        <span className="camera-chip__err" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}

function CameraPreview({ stream }: { readonly stream: MediaStream }): ReactElement {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    video.srcObject = stream;
    void video.play().catch(() => undefined);
    return () => {
      video.srcObject = null;
    };
  }, [stream]);
  return <video ref={ref} muted playsInline aria-label="Camera preview" />;
}
