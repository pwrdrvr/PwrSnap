// The presenter, as one field of a reel scene's inspector.
//
// A scene uses its recording's presenter until it is edited here; the
// first edit gives the scene its own copy (badge: THIS SCENE), and "Use
// the recording's presenter" drops that copy again. Same actions and
// geometry as the Library stage's toolbar, laid out for a rail.

import type { ReactElement } from "react";
import {
  formatSyncOffset,
  geometryFor,
  presenterAnchor,
  presenterEdge,
  presenterFraming,
  presenterLook,
  presenterSize,
  resolvePresenterStyle,
  type AvatarStyle,
  type CaptureRecord,
  type PresenterFraming,
  type PresenterLook,
  type PresenterSize
} from "@pwrsnap/shared";
import { PresenterIcon } from "./PresenterIcons";
import { EdgeControl, type PresenterAction } from "./PresenterToolbar";
import { applyPresenterAction } from "./usePresenter";
import "./presenter.css";

const LOOKS: ReadonlyArray<{ look: PresenterLook; label: string; icon: "person" | "circle" | "rounded" | "square" }> = [
  { look: "cut", label: "Cut out", icon: "person" },
  { look: "circle", label: "Circle", icon: "circle" },
  { look: "rounded", label: "Rounded", icon: "rounded" },
  { look: "square", label: "Square", icon: "square" }
];
const FRAMINGS: ReadonlyArray<{ framing: PresenterFraming; label: string }> = [
  { framing: "face", label: "Face" },
  { framing: "upper", label: "Upper body" },
  { framing: "full", label: "Whole" }
];
const SIZES: ReadonlyArray<{ size: PresenterSize; label: string }> = [
  { size: "small", label: "S" },
  { size: "medium", label: "M" },
  { size: "large", label: "L" }
];

export function ScenePresenterField({
  capture,
  sceneAvatar,
  canvas,
  onChange
}: {
  readonly capture: CaptureRecord;
  /** The scene's own presenter, or undefined when it inherits. */
  readonly sceneAvatar: AvatarStyle | undefined;
  readonly canvas: { width: number; height: number };
  /** `null` drops the scene's copy so it inherits again. */
  readonly onChange: (avatar: AvatarStyle | null) => void;
}): ReactElement | null {
  const camera = capture.video?.camera;
  if (!camera) return null;
  const geometry = geometryFor(camera, canvas);
  const own = sceneAvatar !== undefined;
  const style = resolvePresenterStyle(sceneAvatar ?? capture.video?.avatar, geometry);
  const look = presenterLook(style);
  const framing = presenterFraming(style, geometry.cameraAspect);
  const size = presenterSize(style);
  const anchor = presenterAnchor(style, geometry);
  const act = (action: PresenterAction): void => {
    if (action.type === "inherit") {
      onChange(null);
      return;
    }
    const next = applyPresenterAction(style, action, geometry);
    if (next !== null) onChange(next);
  };

  return (
    <div className="szl__insp-field pres-field" data-testid="scene-presenter">
      <div className="pres-field__hd">
        <span className="szl__insp-label">Presenter</span>
        <span
          className={"pres-badge" + (own ? " is-own" : "")}
          data-tip={own ? "This scene has its own presenter" : "Same as the recording"}
        >
          {!style.visible ? "Hidden" : own ? "This scene" : "Recording’s"}
        </span>
        <button
          type="button"
          className={"pres-ib" + (style.visible ? " is-on" : "")}
          aria-label="Show presenter"
          aria-pressed={style.visible}
          data-tip={style.visible ? "Hide presenter in this scene" : "Show presenter in this scene"}
          onClick={() => act({ type: "toggleVisible" })}
          data-testid="scene-presenter-visible"
        >
          <PresenterIcon name={style.visible ? "eye" : "eyeOff"} />
        </button>
      </div>
      {style.visible ? (
        <>
          <span className="pres-seg pres-seg--fill" role="radiogroup" aria-label="Look">
            {LOOKS.map((entry) => (
              <button
                key={entry.look}
                type="button"
                role="radio"
                aria-checked={look === entry.look}
                aria-label={entry.label}
                className={look === entry.look ? "is-on" : undefined}
                data-tip={entry.label}
                onClick={() => act({ type: "look", look: entry.look })}
              >
                <PresenterIcon name={entry.icon} />
              </button>
            ))}
          </span>
          {look === "cut" ? (
            <EdgeControl edge={presenterEdge(style)} onChange={(edge) => act({ type: "edge", edge })} />
          ) : null}
          <span className="pres-seg pres-seg--fill" role="radiogroup" aria-label="Framing">
            {FRAMINGS.map((entry) => (
              <button
                key={entry.framing}
                type="button"
                role="radio"
                aria-checked={framing === entry.framing}
                className={framing === entry.framing ? "is-on" : undefined}
                onClick={() => act({ type: "framing", framing: entry.framing })}
              >
                {entry.label}
              </button>
            ))}
          </span>
          <div className="pres-field__row">
            <span className="pres-grid9 pres-grid9--inline" role="radiogroup" aria-label="Position">
              {(["top", "middle", "bottom"] as const).flatMap((v) =>
                (["left", "center", "right"] as const).map((h) => {
                  const on = anchor.h === h && anchor.v === v;
                  return (
                    <button
                      key={`${v}-${h}`}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      aria-label={`${v} ${h}`}
                      className={on ? "is-on" : undefined}
                      data-h={h}
                      data-v={v}
                      onClick={() => act({ type: "place", anchor: { h, v } })}
                    />
                  );
                })
              )}
            </span>
            <div className="pres-field__col">
              <span className="pres-seg pres-seg--fill" role="radiogroup" aria-label="Size">
                {SIZES.map((entry) => (
                  <button
                    key={entry.size}
                    type="button"
                    role="radio"
                    aria-checked={size === entry.size}
                    className={size === entry.size ? "is-on" : undefined}
                    onClick={() => act({ type: "size", size: entry.size })}
                  >
                    {entry.label}
                  </button>
                ))}
              </span>
              <div className="pres-field__inline">
                <button
                  type="button"
                  className={"pres-ib" + (style.mirror ? " is-on" : "")}
                  aria-label="Mirror"
                  aria-pressed={style.mirror}
                  data-tip="Mirror"
                  onClick={() => act({ type: "mirror" })}
                >
                  <PresenterIcon name="mirror" />
                </button>
                <span className="pres-sync" role="group" aria-label="Camera sync" data-tip="Camera sync">
                  <button type="button" aria-label="Camera one frame earlier" onClick={() => act({ type: "sync", frames: -1 })}>
                    <PresenterIcon name="left" />
                  </button>
                  <b>{formatSyncOffset(style.syncOffsetSec)}</b>
                  <button type="button" aria-label="Camera one frame later" onClick={() => act({ type: "sync", frames: 1 })}>
                    <PresenterIcon name="right" />
                  </button>
                </span>
              </div>
            </div>
          </div>
        </>
      ) : null}
      {own ? (
        <button
          type="button"
          className="pres-link"
          onClick={() => act({ type: "inherit" })}
          data-testid="scene-presenter-inherit"
        >
          Use the recording’s presenter
        </button>
      ) : null}
    </div>
  );
}
