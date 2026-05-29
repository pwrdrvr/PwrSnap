// Result-pattern for cross-process error handling.
//
// Electron's `ipcRenderer.invoke` strips `instanceof Error` and reduces
// thrown errors to `{ message, name, stack }` — which loses any
// discriminator we'd want to dispatch on (`error.code`, `error.kind`).
// Instead, every command-bus handler returns a `Result<T, PwrSnapError>`
// and the transport (ipcMain, HTTP RPC, MCP) carries the typed error
// envelope directly.
//
// Usage:
//   bus.register("capture:region", async (req, ctx) => {
//     try {
//       const record = await runCapture(req, ctx.signal);
//       return ok(record);
//     } catch (cause) {
//       return err({ kind: "capture", code: "tcc_denied", message: "..." });
//     }
//   });

export type Ok<T> = { ok: true; value: T };
export type Err<E> = { ok: false; error: E };
export type Result<T, E = PwrSnapError> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

export type PwrSnapErrorKind =
  | "capture"
  | "render"
  | "persistence"
  | "clipboard"
  | "upload"
  | "codex"
  // Library Chat surface (codex:libraryChat:*). Distinct from "codex"
  // (the capture-enrichment one-shot) so the renderer can branch chat
  // failures — codex_unreachable, rate_limited, turn_in_progress — from
  // enrichment failures. See plan §F2 #6.
  | "ai"
  | "library"
  | "settings"
  | "permission"
  | "validation"
  | "unknown";

export type PwrSnapError = {
  kind: PwrSnapErrorKind;
  code: string;
  message: string;
  cause?: unknown;
};

export function pwrSnapError(
  kind: PwrSnapErrorKind,
  code: string,
  message: string,
  cause?: unknown
): PwrSnapError {
  return { kind, code, message, cause };
}
