import { join } from "node:path";
import { app } from "electron";

/** The host launches only this signed transport executable, never Electron. */
export function mcpExecutablePath(): string {
  const name = process.platform === "win32" ? "pwrsnap-mcp.exe" : "pwrsnap-mcp";
  return app.isPackaged
    ? join(process.resourcesPath, name)
    : join(app.getAppPath(), "build", "mcp", name);
}

/** Quote for the platform's normal terminal (POSIX shell or PowerShell). */
export function quoteMcpExecutable(path: string, platform = process.platform): string {
  return "'" + path.replaceAll("'", platform === "win32" ? "''" : "'\\''") + "'";
}
