import { join, resolve } from "node:path";
import { app } from "electron";

/** Traces land next to the hot-CPU sessions
 *  (`<userData>/diagnostics/hot-cpu/…`) so one incident's artifacts stay
 *  in one place — the two harnesses are usually run together. */
export function contentTraceDiagnosticsRoot(): string {
  const envRoot = process.env.PWRSNAP_TRACE_OUTPUT_ROOT?.trim();
  if (envRoot) return resolve(envRoot);
  return join(app.getPath("userData"), "diagnostics", "trace");
}
