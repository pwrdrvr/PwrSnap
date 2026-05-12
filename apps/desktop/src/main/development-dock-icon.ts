import { app, nativeImage } from "electron";
import type { NativeImage } from "electron";
import { join } from "node:path";
import { getMainLogger } from "./log";

type DevelopmentDockIconOptions = {
  nodeEnv?: string;
  platform?: NodeJS.Platform;
};

const log = getMainLogger("pwrsnap:dev-dock-icon");
let developmentDockIcon: NativeImage | null | undefined;

export function installDevelopmentDockIcon(options: DevelopmentDockIconOptions = {}): void {
  const icon = loadDevelopmentDockIcon(options);
  if (icon === null) {
    return;
  }

  app.dock?.setIcon(icon);
}

export function showDockWithDevelopmentIcon(options: DevelopmentDockIconOptions = {}): void {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    return;
  }

  installDevelopmentDockIcon(options);
  void app.dock?.show().then(() => {
    installDevelopmentDockIcon(options);
  });
}

function loadDevelopmentDockIcon(options: DevelopmentDockIconOptions): NativeImage | null {
  const platform = options.platform ?? process.platform;
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;

  if (platform !== "darwin" || nodeEnv === "production") {
    return null;
  }

  if (developmentDockIcon !== undefined) {
    return developmentDockIcon;
  }

  const iconPath = join(app.getAppPath(), "build/icon.png");
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    log.warn("failed to load development dock icon", { iconPath });
    developmentDockIcon = null;
    return null;
  }

  developmentDockIcon = icon;
  return icon;
}
