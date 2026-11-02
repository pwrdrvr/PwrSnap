import { randomUUID } from "node:crypto";
import type { AvatarStyle, CaptureRecord } from "@pwrsnap/shared";
import { bus } from "../command-bus";
import { relayCancellationToPeer } from "../process-split/event-relay";

/** The reel owns scene orchestration; the agent owns all presenter caches.
 * Call only after the render handler has authorized and loaded the capture.
 * Each scene is a separate consumer, even when its mask/placement is shared. */
export async function prepareSceneAvatar(
  capture: CaptureRecord,
  avatar: AvatarStyle | undefined,
  signal: AbortSignal | undefined,
  canvas: { width: number; height: number }
): Promise<string> {
  signal?.throwIfAborted();
  if (!capture.legacy_src_path) throw new Error("Recording source missing");
  if (!capture.video?.camera) return capture.legacy_src_path;

  const cancellationKey = `scene-avatar:${randomUUID()}`;
  const cancel = (): void => {
    bus.cancel(cancellationKey);
    relayCancellationToPeer(cancellationKey);
  };
  const pending = bus.dispatch("video:prepareAvatar", {
    captureId: capture.id,
    ...(avatar ? { avatar } : {}),
    canvas
  }, { principal: "bridge", cancellationKey });
  // Internal authorization resolves in one microtask. Let dispatch admit/send
  // the request before cancellation, including an already-aborted parent.
  // The bridge preserves request/cancel order.
  await Promise.resolve();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    const result = await pending;
    signal?.throwIfAborted();
    if (!result.ok) {
      if (result.error.code === "cancelled") throw new DOMException(result.error.message, "AbortError");
      throw new Error(result.error.message);
    }
    return result.value.path;
  } finally {
    signal?.removeEventListener("abort", cancel);
    // Retire this unique bus scope after the response too.
    cancel();
  }
}
