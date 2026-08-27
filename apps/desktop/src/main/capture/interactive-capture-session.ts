export type InteractiveCaptureOwner = "image" | "video";

export type InteractiveCaptureSessionToken = Readonly<{
  sequence: number;
  owner: InteractiveCaptureOwner;
}>;

export type InteractiveCaptureSessionDecision =
  | { status: "accepted"; token: InteractiveCaptureSessionToken }
  | { status: "busy"; activeOwner: InteractiveCaptureOwner };

let sequence = 0;
let active: InteractiveCaptureSessionToken | null = null;

/** Process-wide selector ownership shared by image and video entry points. */
export function acquireInteractiveCaptureSession(
  owner: InteractiveCaptureOwner
): InteractiveCaptureSessionDecision {
  if (active !== null) return { status: "busy", activeOwner: active.owner };
  const token = Object.freeze({ sequence: ++sequence, owner });
  active = token;
  return { status: "accepted", token };
}

/** Identity-safe release: a stale caller cannot clear a newer owner. */
export function releaseInteractiveCaptureSession(
  token: InteractiveCaptureSessionToken
): boolean {
  if (active !== token) return false;
  active = null;
  return true;
}

export function resetInteractiveCaptureSessionForTests(): void {
  active = null;
  sequence = 0;
}
