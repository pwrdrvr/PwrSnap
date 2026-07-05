import { join } from "node:path";
import { app } from "electron";

const HOT_CPU_SESSION_DIRECTORY_RE =
  /^hot-cpu-\d{4}-\d{2}-\d{2}-\d{4}-[a-f0-9]{6}$/;

export function hotCpuDiagnosticsRoot(): string {
  return join(app.getPath("userData"), "diagnostics", "hot-cpu");
}

export function isHotCpuSessionDirectoryName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    HOT_CPU_SESSION_DIRECTORY_RE.test(value)
  );
}

export function hotCpuSessionDirectoryPath(sessionDirectoryName: string): string {
  return join(hotCpuDiagnosticsRoot(), sessionDirectoryName);
}
