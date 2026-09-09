import {
  desktopCapturer,
  type DesktopCapturerSource,
  type Session,
  type WebFrameMain
} from "electron";
import { getMainLogger } from "../log";

const log = getMainLogger("pwrsnap:selector-display-media");

export type SelectorDisplayMediaStrategy = "renderer-display-media" | "legacy-file";

// Runtime experiment state is fail-safe: startup, settings-read failures, E2E,
// and any process that never wires settings all retain the shipping legacy
// path. The settings listener updates this synchronously for the next picker;
// an already-active invocation keeps the strategy it resolved at acceptance.
let rendererOwnedSelectorCaptureEnabled = false;

export function setRendererOwnedSelectorCaptureEnabled(enabled: boolean): void {
  rendererOwnedSelectorCaptureEnabled = enabled;
}

export function isRendererOwnedSelectorCaptureEnabled(): boolean {
  return rendererOwnedSelectorCaptureEnabled;
}

/**
 * Electron's programmatic getDisplayMedia source selection is deterministic on
 * Windows and macOS. PipeWire exposes one portal-selected source on Linux, so
 * PwrSnap cannot truthfully bind that source to an Electron Display id there.
 */
export function selectorDisplayMediaStrategy(
  platform: NodeJS.Platform,
  rendererOwnedEnabled: boolean
): SelectorDisplayMediaStrategy {
  return rendererOwnedEnabled && (platform === "win32" || platform === "darwin")
    ? "renderer-display-media"
    : "legacy-file";
}

export function selectExactDisplaySource(
  sources: readonly DesktopCapturerSource[],
  displayId: number,
  displayCount: number
): DesktopCapturerSource | null {
  const exact = sources.find((source) => source.display_id === String(displayId));
  if (exact !== undefined) return exact;

  // Some Windows remote/single-monitor sessions omit display_id. A single
  // source for a single Electron display is still unambiguous. Never use an
  // ordering fallback with multiple displays: it can capture the wrong screen.
  if (displayCount === 1 && sources.length === 1 && sources[0]!.display_id.length === 0) {
    return sources[0]!;
  }
  return null;
}

type SelectorDisplayMediaGrant = {
  invocationId: number;
  displayId: number;
  displayCount: number;
  frame: WebFrameMain;
  frameUrl: string;
  isStillActive: () => boolean;
};

type DisplayMediaRequest = Parameters<
  NonNullable<Parameters<Session["setDisplayMediaRequestHandler"]>[0]>
>[0];
type DisplayMediaCallback = Parameters<
  NonNullable<Parameters<Session["setDisplayMediaRequestHandler"]>[0]>
>[1];

function isSelectorFrameUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const params = new URLSearchParams(parsed.hash.replace(/^#/, ""));
    return params.get("stage") === "region";
  } catch {
    return false;
  }
}

export type SelectorDisplayMediaBroker = {
  install(session: Session): void;
  arm(session: Session, grant: SelectorDisplayMediaGrant): boolean;
  revoke(session: Session, invocationId: number): boolean;
};

export function createSelectorDisplayMediaBroker(deps: {
  getSources: typeof desktopCapturer.getSources;
}): SelectorDisplayMediaBroker {
  const installed = new WeakSet<Session>();
  const grants = new WeakMap<Session, SelectorDisplayMediaGrant>();
  const lastArmedInvocation = new WeakMap<Session, number>();

  const deny = (
    callback: DisplayMediaCallback,
    request: DisplayMediaRequest,
    reason: string,
    invocationId: number | null
  ): void => {
    log.warn("selector display-media request denied", {
      reason,
      invocationId,
      securityOrigin: request.securityOrigin,
      videoRequested: request.videoRequested,
      audioRequested: request.audioRequested,
      userGesture: request.userGesture
    });
    callback({});
  };

  return {
    install(session): void {
      if (installed.has(session)) return;
      installed.add(session);
      session.setDisplayMediaRequestHandler((request, callback) => {
        const grant = grants.get(session);
        if (grant === undefined) {
          deny(callback, request, "not_armed", null);
          return;
        }

        // Consume before asynchronous source enumeration. A renderer gets one
        // request, even if it races a second getDisplayMedia call.
        grants.delete(session);
        if (!request.videoRequested || request.audioRequested) {
          deny(callback, request, "invalid_media_shape", grant.invocationId);
          return;
        }
        if (
          request.frame === null ||
          request.frame !== grant.frame ||
          request.frame.url !== grant.frameUrl ||
          !isSelectorFrameUrl(request.frame.url)
        ) {
          deny(callback, request, "wrong_frame", grant.invocationId);
          return;
        }
        if (!grant.isStillActive()) {
          deny(callback, request, "stale_invocation", grant.invocationId);
          return;
        }

        void deps
          .getSources({
            types: ["screen"],
            thumbnailSize: { width: 0, height: 0 },
            fetchWindowIcons: false
          })
          .then((sources) => {
            if (!grant.isStillActive()) {
              deny(callback, request, "stale_after_enumeration", grant.invocationId);
              return;
            }
            const source = selectExactDisplaySource(sources, grant.displayId, grant.displayCount);
            if (source === null) {
              deny(callback, request, "display_not_matched", grant.invocationId);
              return;
            }
            log.info("selector display-media request authorized", {
              invocationId: grant.invocationId,
              displayId: grant.displayId,
              sourceId: source.id,
              displayIdMatched: source.display_id === String(grant.displayId),
              thumbnailEmpty: source.thumbnail.isEmpty()
            });
            // Pass only the source identity. The NativeImage thumbnail is neither
            // serialized nor retained; Chromium opens the selected source itself.
            callback({ video: { id: source.id, name: source.name } });
          })
          .catch((cause) => {
            log.error("selector display-media source enumeration failed", {
              invocationId: grant.invocationId,
              displayId: grant.displayId,
              message: cause instanceof Error ? cause.message : String(cause)
            });
            callback({});
          });
      });
    },

    arm(session, grant): boolean {
      if (
        grants.has(session) ||
        lastArmedInvocation.get(session) === grant.invocationId ||
        !isSelectorFrameUrl(grant.frameUrl) ||
        !grant.isStillActive()
      ) {
        return false;
      }
      grants.set(session, grant);
      lastArmedInvocation.set(session, grant.invocationId);
      return true;
    },

    revoke(session, invocationId): boolean {
      const grant = grants.get(session);
      if (grant?.invocationId !== invocationId) return false;
      grants.delete(session);
      return true;
    }
  };
}

export const selectorDisplayMediaBroker = createSelectorDisplayMediaBroker({
  getSources: (options) => desktopCapturer.getSources(options)
});
