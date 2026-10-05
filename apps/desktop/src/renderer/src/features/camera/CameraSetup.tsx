import { useEffect, useRef, useState } from "react";
import type { RecordingCamera } from "@pwrsnap/shared";
import "./camera.css";

export function CameraSetup({
  value,
  onChange,
  onReady,
}: {
  value: RecordingCamera | undefined;
  onChange: (camera: RecordingCamera | undefined) => void;
  onReady: (ready: boolean) => void;
}) {
  const [enabled, setEnabled] = useState(value !== undefined);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState(value?.deviceId ?? "");
  const [error, setError] = useState("");
  const video = useRef<HTMLVideoElement>(null);
  const change = useRef(onChange);
  change.current = onChange;
  const ready = useRef(onReady);
  ready.current = onReady;
  useEffect(() => {
    const hidden = () => {
      if (document.hidden) {
        setEnabled(false);
        change.current(undefined);
        ready.current(true);
      }
    };
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, []);
  useEffect(() => {
    if (!enabled) {
      ready.current(true);
      return;
    }
    ready.current(false);
    let retired = false;
    let stream: MediaStream | null = null;
    const enumerate = async () => {
      try {
        const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(
          (device) => device.kind === "videoinput",
        );
        if (!retired) setDevices(inputs);
      } catch {
        /* The opened camera can still record if enumeration fails. */
      }
    };
    setError("");
    void navigator.mediaDevices
      .getUserMedia({
        video: deviceId ? { deviceId: { exact: deviceId } } : true,
        audio: false,
      })
      .then(async (opened) => {
        if (retired) {
          opened.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = opened;
        const track = opened.getVideoTracks()[0]!;
        const selected = track.getSettings().deviceId;
        if (!selected)
          throw new Error("This camera did not provide a device identifier.");
        track.onended = () => {
          if (!retired) {
            ready.current(false);
            setError(
              "Camera disconnected. Choose a camera or turn Camera off to continue.",
            );
            change.current(undefined);
          }
        };
        if (video.current) {
          video.current.srcObject = opened;
          await video.current.play();
        }
        if (!retired) {
          change.current({ deviceId: selected });
          ready.current(true);
        }
        await enumerate();
      })
      .catch((cause) => {
        stream?.getTracks().forEach((track) => track.stop());
        if (!retired) {
          ready.current(false);
          setError(
            cause instanceof Error ? cause.message : "Camera unavailable",
          );
          change.current(undefined);
        }
      });
    navigator.mediaDevices.addEventListener("devicechange", enumerate);
    return () => {
      retired = true;
      stream?.getTracks().forEach((track) => track.stop());
      navigator.mediaDevices.removeEventListener("devicechange", enumerate);
      ready.current(true);
    };
  }, [enabled, deviceId]);
  return (
    <div
      className="camera-setup"
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="region-hud__toggle"
        aria-pressed={enabled}
        onClick={() => {
          ready.current(enabled);
          setEnabled(!enabled);
          if (enabled) change.current(undefined);
        }}
      >
        Camera: {enabled ? "on" : "off"}
      </button>
      {enabled && (
        <div className="camera-setup__panel">
          <label>
            Camera
            <select
              aria-label="Camera device"
              value={deviceId || value?.deviceId || ""}
              onChange={(event) => {
                ready.current(false);
                setDeviceId(event.target.value);
              }}
            >
              {devices.length === 0 && (
                <option value="">Opening camera…</option>
              )}
              {devices.map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `Camera ${index + 1}`}
                </option>
              ))}
            </select>
          </label>
          <video ref={video} muted playsInline aria-label="Camera preview" />
          <span>
            Your camera is saved separately. Change its background and placement
            in the editor.
          </span>
          {error && <div role="alert">{error}</div>}
        </div>
      )}
    </div>
  );
}
