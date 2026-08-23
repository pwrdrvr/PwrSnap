import type { QuickCaptureAction } from "@pwrsnap/shared";

/** Main-side enforcement for the persisted policy. The renderer supplies the
 *  terminal choice only in `ask` mode; fixed policies do not trust or depend
 *  on the renderer echo. */
export function resolveQuickCaptureAction(
  preference: QuickCaptureAction,
  selectorAction: "snap" | "record"
): "snap" | "record" {
  return preference === "ask" ? selectorAction : preference;
}
