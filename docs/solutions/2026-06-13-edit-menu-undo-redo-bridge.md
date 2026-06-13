# Native Edit ▸ Undo / Edit ▸ Redo weren't wired to the editor's undo stack

**Date:** 2026-06-13
**Reported symptom:** The native **Edit ▸ Undo** and **Edit ▸ Redo** menu
items did nothing for editor operations — crop, arrow, and every other
canvas annotation. ⌘Z / Ctrl+Z worked (renderer keyboard path), but the
menu items were inert for canvas edits.

## Root cause — two unrelated "undo" systems, no bridge between them

1. **The editor's undo stack** lives entirely in the renderer:
   [`useUndoRedo.ts`](../../apps/desktop/src/renderer/src/features/editor/useUndoRedo.ts)
   (React `useState` `past`/`future`, exposing `undo()`/`redo()`).
   Crop/arrow/geometry/style are all correctly recorded here. Before
   this fix, the *only* way to reach it was the hook's own `window`
   keydown listener (⌘Z / ⌘⇧Z / Ctrl+Y), which skipped editable fields.

2. **The native app menu** used `{ role: "editMenu" }`. Electron's
   `role: "undo"` / `role: "redo"` call the *browser's* native
   edit-undo (`webContents.undo()` / `.redo()`), which only affects
   editable DOM (search box, chat input, OCR field). They have **no
   connection** to `useUndoRedo`. There was no bridge from a menu undo
   to the editor's renderer undo, and `useUndoRedo` subscribed to no IPC
   channel.

This is a menu-not-wired gap, **not** a recording bug and **not** a
threading issue.

## The fix — a focus-aware menu→renderer bridge, cross-platform

- **Custom Edit submenu** in
  [`main/index.ts`](../../apps/desktop/src/main/index.ts) replaces
  `{ role: "editMenu" }`. It keeps the free standard roles
  (`cut`/`copy`/`paste`/`pasteAndMatchStyle` (mac)/`delete`/`selectAll`
  + the macOS Speech submenu) and mirrors per-platform exactly what
  `role: "editMenu"` would have produced — only **Undo/Redo** become
  custom items.
- **Accelerators** are `CmdOrCtrl+Z` (undo) and `CmdOrCtrl+Shift+Z`
  (redo) so one template works on macOS, Windows, and Linux.
  `Menu.setApplicationMenu` is called unconditionally (no `isMac` gate),
  so the menu — and its accelerators — install on all three platforms.
- The custom items' `click(_item, window)` call `sendEditCommand`, which
  resolves the `BaseWindow` to its `BrowserWindow` and
  `webContents.send(EVENT_CHANNELS.editUndo | editRedo)`. **No
  `executeJavaScript`** (sandbox crack — forbidden by CLAUDE.md).
- **Renderer bridge**
  [`editMenuBridge.ts`](../../apps/desktop/src/renderer/src/lib/editMenuBridge.ts)
  is mounted once per `BrowserWindow` at the `App` root (`useEditMenuBridge`).
  It subscribes to `editUndo`/`editRedo` and applies a single focus rule:
  - **editable field focused** (`INPUT`/`TEXTAREA`/`contentEditable`) →
    `document.execCommand("undo" | "redo")` (native text undo).
  - **otherwise** → drive the editor undo/redo registered via
    `registerEditorUndoRedo` (no-op when no editor is mounted).
  The editor registers its `undo`/`redo` from `useUndoRedo` while it is
  mounted.

### Why the bridge is at the `App` root, not in the editor

Every PwrSnap window loads the same renderer bundle and routes by
`?stage=` (see `App.tsx`). The search box exists in the Library window
**even when no editor is open**, and Settings/Sizzle have their own text
fields. If the bridge only lived in the editor's `useUndoRedo`, ⌘Z in the
search box (or any window without a mounted editor) would hit the menu
accelerator, find no subscriber, and do nothing — a regression of native
text-field undo. Mounting the bridge once at `App` keeps text-field undo
working everywhere; the editor-undo arm is simply absent where no editor
is registered.

### Why `execCommand` for editable fields (and why it doesn't double-apply)

Once ⌘Z / ⌘⇧Z are **registered menu accelerators**, Electron consumes the
keystroke for the menu command and suppresses Chromium's built-in editing
default — which is exactly why `role: "undo"` never double-undoes a text
field. Replacing the role with a custom click means the text field gets
*no* native undo unless we perform it ourselves, hence
`document.execCommand`. Because the browser default is suppressed, there's
no double-apply. (On the Ctrl+Y keydown path, `preventDefault()` provides
the same suppression.)

## The double-fire trap — menu accelerator vs renderer keydown

**An Electron menu accelerator and a renderer `window` `keydown`
listener BOTH fire for the same keystroke.** The accelerator does *not*
consume the JS keyboard event, and `preventDefault()` in the renderer
does *not* stop the accelerator. So if you register ⌘Z as a menu
accelerator **and** keep a renderer keydown listener that also calls
`undo()`, every ⌘Z undoes twice.

Resolution: **the menu is the single keyboard source** for ⌘Z / ⌘⇧Z. The
former keydown listener in `useUndoRedo.ts` was removed (replaced by
`registerEditorUndoRedo`).

`registerAccelerator: false` (which would show the shortcut without
registering it, letting a renderer listener stay the source) is **not** a
cross-platform option: it is honored only on macOS/Windows. On Linux the
accelerator registers regardless, so that path would double-fire on
Linux.

### Ctrl+Y (Windows/Linux redo) is handled in the renderer, on purpose

A single menu item can register/display only one accelerator, and we use
`CmdOrCtrl+Shift+Z` for Redo. The Windows/Linux **Ctrl+Y** convention is
handled by a tiny keydown listener inside the bridge. Ctrl+Y is
deliberately **not** a registered menu accelerator, so it can't
double-fire against the menu; it routes through the same focus-aware
`runEditRedo`.

## Enabled state (deferred)

The Undo/Redo items are always-enabled (stable ids `edit-undo` /
`edit-redo` are in place for a future toggle). Undo/redo on an empty
stack is a harmless no-op. Driving `menuItem.enabled` from
`canUndo`/`canRedo` would require the renderer to broadcast availability
to main on every stack change; deferred to keep the core fix focused.

## Files

- `packages/shared/src/ipc.ts` — `editUndo` / `editRedo` channels.
- `apps/desktop/src/main/index.ts` — custom Edit submenu + `sendEditCommand`.
- `apps/desktop/src/renderer/src/lib/editMenuBridge.ts` — bridge + registry.
- `apps/desktop/src/renderer/src/App.tsx` — `useEditMenuBridge()` at root.
- `apps/desktop/src/renderer/src/features/editor/useUndoRedo.ts` —
  removed the keydown listener; registers with the bridge instead.
