// Scene regions on the single project axis: a label per scene (index,
// length with a `~` when estimated, clip count), a heavier boundary at
// each scene→scene seam with the transition pill centered on it, and the
// hatched overlay for estimated regions (rendered by the parent so it can
// span every lane).

import type { ReactElement } from "react";
import { sizzleTransitionDurationSec, sizzleTransitionType } from "@pwrsnap/shared";
import { formatSpan } from "../../shared/video-range";
import type { TimelineModel } from "./timeline-model";

export function SceneRegions({
  model,
  x,
  selectedSceneId,
  onSelectScene
}: {
  model: TimelineModel;
  x: (sec: number) => number;
  selectedSceneId: string | null;
  onSelectScene?: ((sceneId: string) => void) | undefined;
}): ReactElement {
  return (
    <div className="szt__lane" data-testid="sizzle-timeline-regions">
      {model.scenes.map((scene) => {
        const left = x(scene.startSec);
        const width = Math.max(0, x(scene.endSec) - left);
        const type = sizzleTransitionType(scene.transition);
        const isFade = type !== "cut" && type !== "none";
        return (
          <div key={scene.sceneId}>
            <button
              type="button"
              className={
                "szt__region" +
                (scene.exact ? "" : " is-est") +
                (selectedSceneId === scene.sceneId ? " is-sel" : "")
              }
              style={{ left: `${left}px`, width: `${width}px` }}
              onClick={(event) => {
                event.stopPropagation();
                onSelectScene?.(scene.sceneId);
              }}
              onPointerDown={(event) => event.stopPropagation()}
              title={
                scene.exact
                  ? `Scene ${scene.index + 1} · ${formatSpan(scene.durationSec)}`
                  : `Scene ${scene.index + 1} · ~${formatSpan(scene.durationSec)} — estimated from the script's word count; synthesize the narration for exact timing`
              }
              data-testid={`sizzle-timeline-scene-${scene.index}`}
              data-exactness={scene.exactness}
            >
              <span>Scene {scene.index + 1}</span>
              <span className="szt__dim">
                {scene.exact ? null : <span className="szt__tilde">~</span>}
                {formatSpan(scene.durationSec)}
                {scene.exact ? "" : " est."}
                {" · "}
                {scene.clips.length} clip{scene.clips.length === 1 ? "" : "s"}
              </span>
            </button>
            {scene.index > 0 ? (
              <>
                <span className="szt__boundary" style={{ left: `${left}px` }} />
                <span
                  className={"szt__pill" + (isFade ? " is-fade" : "")}
                  style={{ left: `${left}px` }}
                  data-testid={`sizzle-timeline-transition-${scene.index}`}
                >
                  {type.replace(/-/g, " ")}
                  {isFade ? (
                    <span className="szt__unit">{sizzleTransitionDurationSec(scene.transition)} s</span>
                  ) : null}
                </span>
              </>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
