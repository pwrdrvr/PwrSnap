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

// A single in-flight Accessory→Regular transition. app.dock.show() is
// async and app.dock.isVisible() doesn't flip to true until it
// resolves, so the reclaim flow (scheduleDockReclaim fires a SPREAD of
// attempts) would otherwise kick off several overlapping show()+setIcon
// transitions for the same demotion. Coalescing to one at a time is
// what keeps those racing setIcon calls — the phantom-tile trigger —
// from happening.
let dockShowInFlight: Promise<void> | null = null;

export function installDevelopmentDockIcon(options: DevelopmentDockIconOptions = {}): void {
  const platform = options.platform ?? process.platform;
  // Only paint the icon when the Dock tile actually EXISTS (Regular
  // policy / visible). Calling app.dock.setIcon() while Accessory — no
  // tile yet — races tile creation and leaves a malformed phantom tile
  // in the Dock: a tiny, unclickable icon wedged between real icons,
  // with no tooltip and no owning window. The reclaim flow calls this
  // exactly when the dock is hidden, so this guard is load-bearing.
  if (platform === "darwin" && app.dock?.isVisible() !== true) {
    return;
  }
  const icon = loadDevelopmentDockIcon(options);
  if (icon === null) {
    return;
  }

  app.dock?.setIcon(icon);
}

export function showDockWithDevelopmentIcon(options: DevelopmentDockIconOptions = {}): void {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" || app.dock === undefined) {
    return;
  }
  // Coalesce: one Accessory→Regular transition at a time (see
  // dockShowInFlight). Overlapping transitions are what spawn the
  // phantom Dock tile.
  if (dockShowInFlight !== null) {
    return;
  }
  // Show FIRST, then set the icon — once the tile exists. (The pre-show
  // setIcon we used to do ran while Accessory and was the phantom's
  // origin.) installDevelopmentDockIcon self-guards on isVisible, so a
  // late call can't paint onto a vanished tile either.
  dockShowInFlight = app.dock
    .show()
    .then(() => {
      installDevelopmentDockIcon(options);
    })
    .catch(() => undefined)
    .finally(() => {
      dockShowInFlight = null;
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
