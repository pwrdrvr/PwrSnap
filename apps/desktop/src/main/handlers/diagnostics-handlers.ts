import fs from "node:fs/promises";
import { shell } from "electron";
import { err, ok } from "@pwrsnap/shared";
import { bus } from "../command-bus";
import { clearHotCpuProfileSessions } from "../diagnostics/hot-cpu-profile-retention";
import {
  hotCpuDiagnosticsRoot,
  hotCpuSessionDirectoryPath,
  isHotCpuSessionDirectoryName
} from "../diagnostics/hot-cpu-profile-paths";

async function directoryExists(path: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export function registerDiagnosticsHandlers(): void {
  bus.register("diagnostics:revealHotCpuRoot", async () => {
    const root = hotCpuDiagnosticsRoot();
    await fs.mkdir(root, { recursive: true });
    const openError = await shell.openPath(root);
    if (openError !== "") {
      return err({
        kind: "unknown",
        code: "hot_cpu_diagnostics_reveal_failed",
        message: openError
      });
    }
    return ok(undefined);
  });

  bus.register("diagnostics:revealHotCpuSession", async (req) => {
    if (!isHotCpuSessionDirectoryName(req.sessionDirectoryName)) {
      return err({
        kind: "validation",
        code: "invalid_hot_cpu_session",
        message: "diagnostics:revealHotCpuSession requires a hot CPU session directory name"
      });
    }

    const sessionPath = hotCpuSessionDirectoryPath(req.sessionDirectoryName);
    if (!(await directoryExists(sessionPath))) {
      return err({
        kind: "validation",
        code: "hot_cpu_session_not_found",
        message: `hot CPU diagnostics session not found: ${req.sessionDirectoryName}`
      });
    }

    shell.showItemInFolder(sessionPath);
    return ok(undefined);
  });

  bus.register("diagnostics:clearHotCpuSessions", async () => {
    return ok(
      await clearHotCpuProfileSessions({
        root: hotCpuDiagnosticsRoot()
      })
    );
  });
}
