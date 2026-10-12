// The folder picker behind File → Export Library….
//
// Since Electron 43 a dialog without `defaultPath` opens in Downloads every
// time, and the OS stops restoring the folder the user last browsed. An
// export is written straight into the folder picked, usually a new one made
// beside the last, so the picker starts at home and then reopens beside the
// last pick. PwrGit's repo-folder picker follows the same rule.
//
// The save dialogs (`capture:saveAs`, the cart's zip export) are not affected
// on macOS or Windows: they pass a bare file name, so Electron sets no folder
// and the OS still restores the last one. Only an empty `defaultPath` is
// replaced with Downloads.

import { dirname } from "node:path";
import { app, dialog } from "electron";

export function createExportDestinationPicker(): () => Promise<string | null> {
  let lastParent: string | undefined;
  return async () => {
    const result = await dialog.showOpenDialog({
      title: "Choose a destination for the PwrSnap export",
      defaultPath: lastParent ?? app.getPath("home"),
      properties: ["openDirectory", "createDirectory"]
    });
    const destDir = result.filePaths[0];
    if (result.canceled || destDir === undefined) return null;
    lastParent = dirname(destDir);
    return destDir;
  };
}

export const pickExportDestination = createExportDestinationPicker();
