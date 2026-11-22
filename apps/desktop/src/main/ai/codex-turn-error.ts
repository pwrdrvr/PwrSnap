// A Codex turn that ended `failed`, with the App Server's own classification.
//
// The App Server says why a turn failed in `TurnError.codexErrorInfo`, on the
// final `error` notification and on `turn/completed`'s `turn.error`. The
// normalized thread events keep only the message, so the one-shot pool reads
// the raw notifications and throws this, and capture enrichment can tell a
// Mac with no network apart from every other failure.

import type { CodexErrorInfo } from "@pwrdrvr/codex-app-server-protocol/v2";

export class CodexTurnFailedError extends Error {
  constructor(message: string, readonly codexErrorInfo: CodexErrorInfo | null) {
    super(message);
    this.name = "CodexTurnFailedError";
  }
}

/** Transport failures that carry no HTTP status: nothing on the other end
 *  answered. With a status, a server did answer, which is a provider problem
 *  and not this Mac being offline. */
const NO_ANSWER_TRANSPORT_FAILURES = [
  "httpConnectionFailed",
  "responseStreamConnectionFailed",
  "responseTooManyFailedAttempts"
] as const;

/** Whether Codex's classification proves the network was unreachable: a
 *  connection that never got an HTTP answer. Conservative on purpose — a
 *  stream that disconnected mid-answer may already have spent tokens, and
 *  sign-in, plan, policy, overload and "other" failures are things the
 *  operator must see. Unknown shapes are not offline. */
export function isCodexNetworkUnavailable(info: CodexErrorInfo | null | undefined): boolean {
  if (info === null || info === undefined || typeof info !== "object") return false;
  for (const key of NO_ANSWER_TRANSPORT_FAILURES) {
    if (!Object.prototype.hasOwnProperty.call(info, key)) continue;
    const detail = (info as Record<string, unknown>)[key];
    if (typeof detail !== "object" || detail === null) return false;
    const status = (detail as { httpStatusCode?: unknown }).httpStatusCode;
    return status === null || status === undefined;
  }
  return false;
}

/** The `TurnError` in a raw App Server notification for this turn, from the
 *  final `error` notification (`willRetry: false`) or `turn/completed`. An
 *  `error` Codex will retry on its own is not the turn's outcome. */
export function rawTurnErrorFor(
  method: string,
  params: unknown,
  threadId: string,
  turnId: string
): { message: string; codexErrorInfo: CodexErrorInfo | null } | null {
  if (typeof params !== "object" || params === null) return null;
  const record = params as Record<string, unknown>;
  if (record["threadId"] !== threadId) return null;
  let error: unknown;
  if (method === "error") {
    if (record["turnId"] !== turnId || record["willRetry"] === true) return null;
    error = record["error"];
  } else if (method === "turn/completed") {
    const turn = record["turn"];
    if (typeof turn !== "object" || turn === null) return null;
    if ((turn as Record<string, unknown>)["id"] !== turnId) return null;
    error = (turn as Record<string, unknown>)["error"];
  } else {
    return null;
  }
  if (typeof error !== "object" || error === null) return null;
  const message = (error as Record<string, unknown>)["message"];
  const info = (error as Record<string, unknown>)["codexErrorInfo"];
  return {
    message: typeof message === "string" ? message : "",
    codexErrorInfo: info === undefined ? null : (info as CodexErrorInfo)
  };
}
