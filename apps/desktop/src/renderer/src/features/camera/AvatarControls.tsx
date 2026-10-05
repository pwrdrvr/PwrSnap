import { DEFAULT_AVATAR_STYLE, type AvatarStyle } from "@pwrsnap/shared";
import "./camera.css";

export function AvatarControls({
  value,
  onChange,
  cameraAspectRatio = 16 / 9,
  canvasAspectRatio = 16 / 9,
}: {
  value?: AvatarStyle | null | undefined;
  onChange: (style: AvatarStyle) => void;
  cameraAspectRatio?: number;
  canvasAspectRatio?: number;
}) {
  const style = value ?? DEFAULT_AVATAR_STYLE;
  const right = Math.max(0, 0.98 - style.width);
  const bottom = Math.max(
    0,
    0.98 -
      (((style.width * canvasAspectRatio) / cameraAspectRatio) *
        style.crop.height) /
        style.crop.width,
  );
  return (
    <fieldset
      className="avatar-controls"
      onKeyDown={(event) => event.stopPropagation()}
    >
      <legend>Presenter</legend>
      <label>
        <input
          type="checkbox"
          checked={style.visible}
          onChange={(event) =>
            onChange({ ...style, visible: event.target.checked })
          }
        />
        Show presenter
      </label>
      <label>
        <input
          type="checkbox"
          checked={style.background === "remove"}
          onChange={(event) =>
            onChange({
              ...style,
              background: event.target.checked ? "remove" : "original",
            })
          }
        />
        Remove background
      </label>
      <label>
        <input
          type="checkbox"
          checked={style.mirror}
          onChange={(event) =>
            onChange({ ...style, mirror: event.target.checked })
          }
        />
        Mirror camera
      </label>
      <div className="avatar-controls__corners" aria-label="Presenter position">
        {(
          [
            ["Top left", 0.02, 0.02],
            ["Top right", right, 0.02],
            ["Bottom left", 0.02, bottom],
            ["Bottom right", right, bottom],
          ] as const
        ).map(([name, x, y]) => (
          <button
            key={name}
            type="button"
            onClick={() => onChange({ ...style, x, y })}
          >
            {name}
          </button>
        ))}
      </div>
      {(
        [
          ["Horizontal position", "x", 0, 1],
          ["Vertical position", "y", 0, 1],
          ["Size", "width", 0.05, 1],
        ] as const
      ).map(([label, key, min, max]) => (
        <label key={key}>
          {label}
          <input
            aria-label={`Presenter ${label.toLowerCase()}`}
            type="range"
            min={min}
            max={max}
            step="0.01"
            value={style[key]}
            onChange={(event) =>
              onChange({ ...style, [key]: Number(event.target.value) })
            }
          />
        </label>
      ))}
      <label>
        Sync adjustment (seconds)
        <input
          aria-label="Presenter sync adjustment"
          type="number"
          min="-10"
          max="10"
          step="0.033"
          value={style.syncOffsetSec ?? 0}
          onChange={(event) => {
            const value = event.target.valueAsNumber;
            if (Number.isFinite(value) && Math.abs(value) <= 10)
              onChange({ ...style, syncOffsetSec: value });
          }}
        />
      </label>
      <label>
        Framing
        <select
          aria-label="Presenter framing"
          value={
            style.crop.width === 1 && style.crop.height === 1 ? "full" : "upper"
          }
          onChange={(event) =>
            onChange({
              ...style,
              crop:
                event.target.value === "full"
                  ? { x: 0, y: 0, width: 1, height: 1 }
                  : { x: 0.2, y: 0, width: 0.6, height: 0.8 },
            })
          }
        >
          <option value="full">Whole camera</option>
          <option value="upper">Head and upper body</option>
        </select>
      </label>
      <label>
        Crop bottom
        <input
          aria-label="Presenter crop bottom"
          type="range"
          min="0.1"
          max="1"
          step="0.01"
          value={style.crop.height}
          onChange={(event) =>
            onChange({
              ...style,
              crop: { ...style.crop, height: Number(event.target.value), y: 0 },
            })
          }
        />
      </label>
    </fieldset>
  );
}
