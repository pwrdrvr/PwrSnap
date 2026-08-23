// Modal grid of Library captures for "+ Add scene" / "+ Clip".

import { useRef, type ReactElement } from "react";
import type { CaptureRecord } from "@pwrsnap/shared";
import { cacheUrl, captureSrcUrl } from "../../lib/pwrsnap";
import { formatDur } from "./sizzle-helpers";

export type CapturePickerProps = {
  captures: CaptureRecord[];
  existing: Set<string>;
  onPick: (captureId: string) => void;
  onClose: () => void;
};

export function CapturePicker({
  captures,
  existing,
  onPick,
  onClose
}: CapturePickerProps): ReactElement {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  return (
    <div
      ref={overlayRef}
      className="szl__modal-overlay"
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <div className="szl__modal">
        <header>
          <h3>Add scene from Library</h3>
          <button
            className="szl__scene-mini"
            type="button"
            onClick={onClose}
            title="Close"
          >
            ✕
          </button>
        </header>
        {captures.length === 0 ? (
          <p className="szl__hint">No captures available.</p>
        ) : (
          <div className="szl__picker-grid">
            {captures
              .filter((c) => c.deleted_at === null)
              .map((c) => {
                const isVideo = c.kind === "video";
                const durSec = isVideo ? c.video?.durationSec ?? 0 : 0;
                return (
                  <button
                    key={c.id}
                    type="button"
                    className={
                      "szl__picker-cell" + (existing.has(c.id) ? " is-used" : "")
                    }
                    onClick={() => onPick(c.id)}
                    title={c.source_app_name ?? ""}
                  >
                    <span className="szl__picker-thumb-wrap">
                      {isVideo ? (
                        // `pwrsnap-cache://` doesn't render image
                        // thumbnails for video captures — it's an
                        // image-render pipeline. Use the source video
                        // directly with `preload="metadata"` so we get
                        // just the first frame as a poster without
                        // decoding the whole clip. Same pattern as
                        // VideoCellThumb in Library.tsx.
                        <video
                          src={captureSrcUrl(c.id)}
                          preload="metadata"
                          muted
                          playsInline
                        />
                      ) : (
                        <img
                          src={cacheUrl(c.id, 240, "webp", c.edits_version)}
                          alt=""
                          // loading=lazy + decoding=async + the cell's
                          // content-visibility:auto skip the cache-protocol
                          // fetch for offscreen cells.
                          loading="lazy"
                          decoding="async"
                        />
                      )}
                      {isVideo ? (
                        <>
                          <span className="szl__picker-play" aria-hidden="true">▶</span>
                          <span className="szl__picker-duration">
                            {formatDur(durSec)}
                          </span>
                        </>
                      ) : null}
                    </span>
                    <span className="szl__picker-label">
                      {c.source_app_name ?? "—"}
                    </span>
                  </button>
                );
              })}
          </div>
        )}
      </div>
    </div>
  );
}
