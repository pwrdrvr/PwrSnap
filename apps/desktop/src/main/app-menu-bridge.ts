// Renderer <-> main bridge for the Windows custom title-bar menu bar.
//
// On Windows we hide the native title bar (titleBarStyle: "hidden") to draw our
// own chrome, which ALSO removes the native menu bar (the menu lives in the
// title bar Windows just hid). So the renderer paints its own always-visible
// top-level menu buttons (File / Edit / View / Window / Library / Help) and,
// on click / Alt-mnemonic, asks main to pop the REAL native submenu at that
// spot via `Menu.popup()`. The submenus — roles (Undo/Copy/Paste), accelerators,
// dynamic enable/disable, click handlers — are exactly the ones
// `installApplicationMenu` already builds, so there is a single source of truth
// for menu behavior; the renderer only owns the top-level bar's looks.
//
// macOS/Linux never call this — they keep the native menu bar.

import { BrowserWindow, ipcMain, Menu } from "electron";

const APP_MENU_MODEL_CHANNEL = "app-menu:model";
const APP_MENU_POPUP_CHANNEL = "app-menu:popup";

export type AppMenuTopLevel = { index: number; label: string };

/**
 * Top-level entries of the current application menu, for the renderer's custom
 * menu bar. `buildFromTemplate` has already expanded roles, so labels like
 * "Edit" / "Window" are concrete. The macOS app menu (role: "appMenu") is
 * excluded — it never appears on Windows, where this bridge is used.
 */
function appMenuTopLevel(): AppMenuTopLevel[] {
  const menu = Menu.getApplicationMenu();
  if (menu === null) return [];
  const out: AppMenuTopLevel[] = [];
  menu.items.forEach((item, index) => {
    if (item.role === "appMenu") return;
    if (item.visible === false) return;
    if (typeof item.label !== "string" || item.label.length === 0) return;
    if (item.submenu === undefined) return;
    out.push({ index, label: item.label });
  });
  return out;
}

let wired = false;

/**
 * Register the menu-bar bridge. Idempotent — call once after the first
 * `installApplicationMenu()`. The handlers read `Menu.getApplicationMenu()`
 * live on each call, so they always reflect the latest menu (developer-mode
 * rebuilds, dynamic enable state) without re-registration.
 */
export function wireAppMenuBridge(): void {
  if (wired) return;
  wired = true;

  ipcMain.handle(APP_MENU_MODEL_CHANNEL, () => appMenuTopLevel());

  ipcMain.on(APP_MENU_POPUP_CHANNEL, (event, payload: unknown) => {
    if (payload === null || typeof payload !== "object") return;
    const { index, x, y } = payload as { index?: unknown; x?: unknown; y?: unknown };
    if (typeof index !== "number") return;
    const menu = Menu.getApplicationMenu();
    const submenu = menu?.items[index]?.submenu;
    if (submenu === undefined) return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win === null) return;
    // x/y are window-relative DIP (the button's bottom-left). Round to whole
    // pixels; omit when absent so Electron falls back to the cursor position.
    const popupOptions: Electron.PopupOptions = { window: win };
    if (typeof x === "number" && Number.isFinite(x)) popupOptions.x = Math.round(x);
    if (typeof y === "number" && Number.isFinite(y)) popupOptions.y = Math.round(y);
    submenu.popup(popupOptions);
  });
}
