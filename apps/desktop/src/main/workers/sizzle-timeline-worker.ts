import "../sharp-wasm-steer";
import {
  renderSizzleTimeline,
  type TimelineRenderRequest,
} from "../sizzle/timeline-render";

const controller = new AbortController();
process.parentPort.on(
  "message",
  (event: {
    data:
      | { kind: "render"; request: TimelineRenderRequest }
      | { kind: "cancel" };
  }) => {
    if (event.data.kind === "cancel") {
      controller.abort();
      return;
    }
    void renderSizzleTimeline(event.data.request, controller.signal, (ratio) =>
      process.parentPort.postMessage({ kind: "progress", ratio }),
    )
      .then((result) =>
        process.parentPort.postMessage({ kind: "done", result }),
      )
      .catch(() =>
        process.parentPort.postMessage({
          kind: "error",
          message: controller.signal.aborted
            ? "Render cancelled"
            : "Timeline rendering failed",
        }),
      );
  },
);
