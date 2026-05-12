import { app, nativeImage } from "electron";
import { join } from "node:path";
import { getMainLogger } from "./log";

type DevelopmentDockIconOptions = {
  nodeEnv?: string;
  platform?: NodeJS.Platform;
};

const log = getMainLogger("pwrsnap:dev-dock-icon");

export function installDevelopmentDockIcon(options: DevelopmentDockIconOptions = {}): void {
  const platform = options.platform ?? process.platform;
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;

  if (platform !== "darwin" || nodeEnv === "production") {
    return;
  }

  const iconPath = join(app.getAppPath(), "build/icon.png");
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    log.warn("failed to load development dock icon", { iconPath });
    return;
  }

  app.dock?.setIcon(icon);
}
