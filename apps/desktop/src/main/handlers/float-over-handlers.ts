// Command-bus registration for the `float-over:dismiss` command. The
// renderer's float-over countdown calls this when it auto-dismisses.
// In Phase 1.5 the float-over becomes a singleton; this handler stays
// stable as the implementation underneath swaps from destroy() to
// hide+reload.

import { ok } from "@pwrsnap/shared";
import { bus } from "../command-bus";
import { dismissFloatOver } from "../float-over";

export function registerFloatOverHandlers(): void {
  bus.register("float-over:dismiss", async () => {
    dismissFloatOver();
    return ok(undefined);
  });
}
