# macOS TCC denials on `~/Documents/PwrSnap` — broken thumbnails that look like corruption

**Date:** 2026-06-12
**Symptom:** A handful of Library thumbnails render as broken images
(`<img>` error icon) while the rest of the library looks fine. The
capture rows are healthy v2 records, the `.pwrsnap` files exist on
disk, owner/permissions/flags are normal, and other tools (Finder,
a Full-Disk-Access shell) read the files fine.

## Root cause

`~/Documents` is TCC-protected ("Files & Folders → Documents Folder").
When the app's **TCC client** lacks that grant, `open()` on a file
there returns **`EPERM`** — not `EACCES`, not `ENOENT` — even for a
user-owned, mode-0600 file. Three macOS behaviors combine to make this
look like per-file corruption instead of a permission problem:

1. **The TCC client for a dev run is the terminal, not Electron.**
   `pnpm dev` → node → `Electron.app` from `node_modules` rolls TCC
   responsibility up to the launching terminal app (Ghostty, Terminal,
   VS Code…). Which terminal launched the app — and whether *that app*
   has the Documents grant — decides whether the session can read the
   captures folder. Sessions flap between healthy and denied when dev
   runs move between terminals, or when a terminal app's grant is
   lost (app update re-prompt, TCC reset, macOS upgrade).

2. **Per-file `com.apple.macl` grants make denial PER-FILE.** A file
   *created* by a client that lacks the blanket grant gets a
   `com.apple.macl` xattr that lets that client keep accessing its own
   file. Files created *while a blanket grant existed* (or under a
   different client identity) carry **no macl** — they become
   unreadable the moment the blanket grant goes away. Same directory,
   same owner, same mode: some files open fine, others EPERM forever.
   `xattr -l <file>` showing `com.apple.macl` on readable files and
   not on broken ones is the fingerprint. (The xattr is SIP-protected;
   you can't add it back by hand.)

3. **The render cache masks the rot.** Thumbnails serve from
   `<userData>/render-cache` (App Support — never TCC-gated). Only a
   cache miss touches the bundle, so 88% of the library can be
   unreadable while only the few never-baked captures render broken.
   Any future `BAKE_PIPELINE_VERSION` bump (which orphans the cache —
   see 2026-05-28-bake-render-cache-orphans.md) would convert a silent
   denial into a library-wide outage.

## How it presented (June 2026)

- Searching `index man` surfaced 3 captures from May 26/29 with broken
  thumbs — exactly the matches with no `render-cache/<id>/` directory.
- `main.log` (UTC timestamps): `cache handler threw … EPERM: operation
  not permitted, open '/Users/…/Documents/PwrSnap/….pwrsnap'`, plus
  `bundle filename maintenance stopped after error budget { failed:
  10, attempted: 1215 }` — ten copies of the same denial.
- 1094 of 1248 bundles had no `com.apple.macl`; every file the
  failing sessions touched and EPERM'd was macl-less, every success
  was macl'd. macl'd files first appear 2026-05-20 — the date the
  blanket-grant era ended.

## Diagnosis recipe

```bash
# 1. EPERM (not ENOENT) in the app log for files that exist → think TCC.
grep -A4 "cache handler threw" ~/Library/Logs/PwrSnap/main.log | grep EPERM

# 2. Compare xattrs: readable vs broken capture bundles.
xattr -l "~/Documents/PwrSnap/<broken>.pwrsnap"    # provenance only
xattr -l "~/Documents/PwrSnap/<readable>.pwrsnap"  # provenance + macl

# 3. Identify the TCC client: walk the dev app's parent chain to the
#    terminal app, then check System Settings → Privacy & Security →
#    Files & Folders for that app's Documents toggle.
ps -o pid,ppid,command -p <electron-main-pid>   # … → ghostty/Terminal/etc
```

**Fix for the user:** grant Documents-folder (or Full Disk) access to
the *terminal app that launches dev runs* (and to PwrSnap.app for
packaged runs), then relaunch. Once the blanket grant exists, macl-less
files read fine again — no data was ever lost or corrupted.

### Gotcha: relaunching the dev app is NOT enough — restart the TERMINAL

The TCC "responsible process" for a dev run is the **long-lived
terminal** (Ghostty/Terminal/iTerm), not the Electron app. macOS
evaluates and caches a responsible process's grants at *its* launch.
So the chain is:

```
dev Electron  ← you ⌘Q + `pnpm dev` this
  └ node/pnpm
      └ zsh / login
          └ Ghostty  ← TCC attributes file access HERE; grant is cached
                        at Ghostty's launch, not the dev app's
```

If Ghostty has been running since before you granted Documents/FDA,
restarting only the dev app changes nothing — its parent Ghostty still
runs under the pre-grant TCC snapshot and keeps EPERMing. This exact
trap appeared in the June 2026 incident: the user granted Ghostty
access, relaunched the dev app, and the *new* session still logged 90
EPERMs because Ghostty itself was 9 days old. **Fully quit the terminal
app (⌘Q, all windows — not just the tab or the dev process), reopen it,
then `pnpm dev`.** Confirm the Files & Folders toggle is actually
switched on while you're there — a selected row is not an enabled grant.

## What the app now does (this incident's code change)

- `main/storage/captures-access-health.ts` accounts EPERM/EACCES
  denials per distinct path, reported from the bundle-store read
  chokepoint (`openAndValidateBundle`) and the `pwrsnap-capture://` /
  `pwrsnap-cache://` protocol handlers. First denial logs one loud,
  actionable error; recovery (later successful read of every denied
  path) clears the banner automatically if access is restored while the
  app keeps running. (Restoring a TCC grant usually means relaunching
  the responsible terminal — see the gotcha above — in which case the
  fresh process just starts clean, so the in-place auto-clear mainly
  covers cases where a grant takes effect without a relaunch.)
- Boot filename maintenance classifies denials as `permissionDenied`
  (skip row, keep going, one summary warn) instead of burning its
  10-failure budget — denials are per-file, so readable rows must
  still get maintained.
- The Library shows a danger-tinted banner ("macOS is blocking
  captures", count + Open Privacy Settings deep link) driven by
  `storage:capturesAccessHealth` + `events:storage:captures-access`.

## Gotchas for future work

- **Don't trust "the app can write, so it can read."** A client with
  no blanket grant can still create files (and gets macl on them);
  reads of *other* files fail. Write-success proves nothing about
  read-permission.
- **`getContentSize`-style invisibility:** `existsSync()` returns true
  and `lstat` succeeds on TCC-denied files — only `open()` fails. A
  "file exists but open EPERMs" combination is the tell.
- **Don't count a TCC denial as data corruption** anywhere new code
  classifies bundle-read failures: route it through
  `isPermissionDenial()` / `reportCapturesAccessFailure()` from
  `main/storage/captures-access-health.ts`.
- **Never suggest deleting/regenerating user data for this.** The
  bundles are intact; the permission is the problem (CLAUDE.md rule).

## Addendum (2026-06-15): pre-warm the Documents prompt before capture UI

A first-capture bug surfaced from this same TCC protection. The captures
root (`~/Documents/PwrSnap`) is created lazily on the first persist, so on
a fresh install the very first capture's write is what triggers the macOS
"Allow Documents folder" consent dialog — **and that write blocks until
the user answers.** In the interactive flow that write
(`persistAndBroadcast`) runs *before* `hideSelector()`, and the region
selector is an `alwaysOnTop` screen-saver-level (1000) window — so the
dialog pops UNDERNEATH the orange selector. The user sees the picker
floating over an unreachable consent dialog and the capture appears wedged
(the persist is parked awaiting an answer they can't click).

Fix: `main/capture/capture-storage-gate.ts` → `ensureCapturesDirReady()`
runs at the **top of every capture/record entrypoint** (right after
`guardScreenCapture`, before any selector/countdown UI), so the Documents
prompt lands on a clean screen. It classifies an `EPERM`/`EACCES` result
via `isPermissionDenial()` into an actionable `captures_dir_denied` error
instead of failing mid-capture. We kept the storage location at
`~/Documents/PwrSnap` (user-discoverable, survives uninstall) — the prompt
is unavoidable for a protected folder; we just moved *when* it appears.

**Gotcha that bit the first attempt: `mkdir(recursive)` is NOT a reliable
trigger.** macOS only prompts on an access that actually *needs* the
grant. If `~/Documents/PwrSnap` already exists — any prior capture, or a
real install sitting behind a throwaway `PWRSNAP_USER_DATA` test profile
(captures live OUTSIDE userData, so the folder persists across profiles) —
`mkdir(recursive)` is a no-op that never touches the protected folder, and
the prompt defers right back to the first persist WRITE (under the
selector). The gate therefore does a real **write probe**: `mkdir`, then
`writeFile` + delete a tiny `.pwrsnap-access-probe` inside the captures
root, which forces the prompt exactly like the persist would. Cached
per-session (probe once, not per capture). If you ever see this prompt
under the selector again, verify the pre-warm does a real *write*, not a
stat/mkdir.

**Structural backstop (the real fix): defer the save until the selector
is gone.** The pre-warm makes the prompt happen up front, but the deeper
correctness rule is that the file save must NEVER run while the picker is
on screen. `capture:interactive`'s commit path now tears the selector
down *completely* — `hideSelector()` + re-activate previous app +
`reclaimDockIconIfLibraryAlive()` — BEFORE calling `persistAndBroadcast`.
After teardown the only PwrSnap window left is the float-over at floating
level (3), which sits *below* a system consent dialog, so even if a prompt
fires at persist time it's reachable. The float-over was pre-shown idle
under the selector, so the reveal shows that idle placeholder for the
(now fast, post-pre-warm) persist window, then swaps to the loaded preview
in place. Don't reorder persist before `hideSelector` again — that's the
original bug.

**Surfacing the status (Settings → System Permissions).** There is NO
non-prompting status read for the Documents folder (unlike
`getMediaAccessStatus` for screen/mic), so the "Captures Folder" row
reflects the *observed-access* signal — `storage:capturesAccessHealth`
(`denied` vs OK), the same snapshot + `events:storage:captures-access`
the Library banner uses — plus a **Check access** button
(`storage:checkCapturesAccess`) that forces a real write probe to verify
and, if macOS has no decision on file, trigger the consent prompt right
there. When denied it offers `storage:openCapturesAccessSettings` (Files &
Folders pane). The check routes its result back through
`reportCapturesAccessFailure/Success`, so the row, the banner, and the
event stay in lockstep.

## Addendum (2026-08-04): sticky `~/PwrSnap` fallback and test layers

Issue #263 supersedes the June decision to stop after surfacing a denial.
When a real Documents-scoped write returns `EPERM`/`EACCES`, PwrSnap now
persists `storage.capturesLocation = "home"`, switches new captures to
`~/PwrSnap`, and retries the failed persist once. The choice is sticky: a
later Documents grant never silently moves new writes back and splits a
large library across two roots. Existing rows remain readable because their
bundle/source paths are absolute.

Settings may switch new writes back to Documents only after an explicit
successful Documents write probe and only while `~/PwrSnap` is empty **and**
SQLite has no durable path reference below it (including soft-deleted rows,
because Restore targets their original absolute paths). This is a root
selection, not a migration; moving a populated library is separate work.

### Two test layers, with different jobs

1. The ordinary macOS Playwright suite exercises the application contract
   deterministically by making its isolated `<fixture-home>/Documents`
   directory non-writable. That produces a real filesystem `EACCES`, proves
   fallback persistence + retry + stickiness + guarded switch-back, and never
   touches the runner's TCC database or the host user's folders.

2. A future native-consent lab test should validate the OS integration itself.
   Playwright's Electron driver controls Chromium web contents; the consent
   dialog is owned by macOS and sits outside that tree. Use a separately built,
   consistently signed E2E app identity (for example
   `com.pwrdrvr.pwrsnap.e2e`) and reset only its Documents decision with
   `tccutil reset SystemPolicyDocumentsFolder <bundle-id>`. Never reset all
   TCC state, never test through the unbranded `node_modules/Electron.app`, and
   never reset the production PwrSnap bundle ID.

The native click needs an XCTest UI-interruption handler or a small
Accessibility (`AXUIElement`) controller. A separate controller needs its own
Accessibility grant; on the persistent Tart runner that can be provisioned
once, while the targeted Documents reset affects only the E2E app. That gives
us a clean first-run Documents decision without paying for an ephemeral VM on
every job. Apple references:
[reset protected-resource access](https://developer.apple.com/documentation/xcode/resetting-access-to-protected-resources-in-macos),
[`NSDocumentsFolderUsageDescription`](https://developer.apple.com/documentation/bundleresources/information-property-list/nsdocumentsfolderusagedescription),
[XCTest UI interruptions](https://developer.apple.com/documentation/xctest/handling-ui-interruptions), and
[`AXUIElement`](https://developer.apple.com/documentation/applicationservices/axuielement_h).

## Addendum (2026-08-22): startup beachball — a sync `readdir` on Documents parked the main thread

**Symptom.** Launching a build from a NEW binary location (a fresh git
worktree's `out/main/index.js`, so a TCC identity macOS had never seen)
showed the Library window and then the whole app beachballed —
"Application Not Responding", ~0% CPU. `sample` on the main process put
the main thread in `readdirSync → uv_fs_scandir → opendir →
open$NOCANCEL` under `~/Documents/PwrSnap`, renderers idle. A shell `ls
~/Documents/PwrSnap` in the same state returned "Interrupted system call"
— the Documents consent prompt was pending for that identity, and macOS
parks every `open()`/`opendir()` under the folder until the user
answers. Running with `PWRSNAP_E2E=1` **and** `PWRSNAP_USER_DATA` avoided
it entirely, which nailed the path. Note it takes both: the
`app.setPath("documents", …)` rebase sits inside the `PWRSNAP_USER_DATA`
branch and is additionally gated on `isE2E`, so `PWRSNAP_E2E=1` alone
changes nothing and a launch with only that flag still reads the real
`~/Documents/PwrSnap`.

**Cause.** `ChatThreadStore.ensureImported()` — the one-time legacy
`pwrsnap-thread.json` import — did `readdirSync(<captures>/Chats)` plus a
`readFileSync` per entry, on the main thread, the first time any store
method ran. The Library mounts `LibraryChatPanel`, which dispatches
`codex:libraryChat:list` on mount, so the first read of a TCC-gated path
in a fresh install happened synchronously, inside the first IPC after
first paint. A *pending* prompt blocks that call indefinitely (the
beachball); a *denied* grant would have EPERM'd it (caught, harmless).
The Electron event loop, the IPC dispatcher, and the AppKit run loop all
share that thread, so nothing — not even the OS consent dialog's
activation of our app — could proceed.

**Fix ([#459](https://github.com/pwrdrvr/PwrSnap/pull/459)).** The import is now async (`node:fs/promises`) and
time-bounded: every store method awaits `ensureImported()` BEFORE its
SQLite section (so `update`/`appendFocus` keep their SELECT→UPDATE
yield-free), and `ensureImported()` resolves when the import settles OR
after `LEGACY_IMPORT_WAIT_MS` (1.5 s), whichever first. The SQLite index
is the source of truth for every thread created since the index landed;
the sidecar walk only back-fills pre-index threads, so proceeding without
it is always correct and the background import lands whenever the read
returns. A denied dir (`EPERM`/`EACCES`) logs one warn and skips; `ENOENT`
stays silent. `setBackendConfig` / `setOwnerClientId` became async with
it. `codex-discovery.ts`'s `nvmNodeBinDirs` lost its `readdirSync` too
(not TCC-gated — `~/.nvm` — but its call chain was already async, so
there was no reason to keep it sync). Other sync directory reads remain
on the main thread and are fine: `persistence/db.ts` reads the bundled
migrations dir, and `dev/seeder/wipe.ts` is gated behind
`isOverriddenDataRoot()`. Neither can resolve under Documents.

**One import per root, not per store.** The bound is charged once for a
Chats root and shared by every `ChatThreadStore` pointed at it
(`legacyImportFor()` + the module-level `legacyImports` map). Both halves
matter. Per-*call* re-arming made waits additive — a "New chat" chained
four gated calls and paid 4 × the bound, and `cleanupProjectChats` paid it
once per thread deleted. Per-*instance* imports were worse: there are five
`ChatThreadStore` construction sites, and libuv's default threadpool is
**4 threads**, so five parked `readdir`s on a pending prompt would starve
every other async fs / dns / crypto call in the main process — trading a
diagnosable beachball for an app that paints and then silently completes
nothing. If you add a store construction site, it costs nothing; if you
move the import back onto the instance, it costs a threadpool slot each.

**Deletes beat a late import.** The import snapshots sidecars from disk
and applies them in one transaction, so a `delete()` that ran after the
bound elapsed would be undone by the pending `INSERT OR IGNORE`. `delete()`
records the id in `LegacyImport.deleted` before removing the row, and the
transaction skips it. Pinned by "does not resurrect a thread deleted while
the import was still reading".

**The rule.** Nothing in the main process may do a synchronous read
(`readdirSync`, `readFileSync`, `openSync`, `opendirSync`, …) of a path
under `getCapturesRoot()` / `getChatsRoot()` / `getDurableCapturesRoots()`
— not at startup, not on window open, not on a hot path. `open()` and
`opendir()` are the gated syscalls; a pending prompt parks them without
bound and there is no UI on the main thread to answer it from. Use
`node:fs/promises` and let the caller await or degrade (the bounded-wait
shape above is the template). Metadata calls (`stat`/`access`/
`existsSync`) don't open the file and have not been observed to prompt —
but don't add new sync ones under these roots either.

**Finding the next one.**

```bash
# Every sync fs call site in main; then check each path argument against
# the captures/chats roots. Most hits are userData / app resources and fine.
grep -rn -E "readdirSync|readFileSync|openSync|opendirSync" apps/desktop/src/main --include='*.ts' | grep -v __tests__
```

Pinned by
`apps/desktop/src/main/ai/__tests__/chat-thread-store-documents-access.test.ts`:
`list()`/`get()` answer from the index while the dir read is parked
(hooked `readdir` that never settles) and when it is denied (`EPERM`); the
bound is charged once per root across two stores and only one read is ever
in flight; a delete during the import window is not resurrected; and the
module never imports from `node:fs` in any spelling.

**Still unbounded, deliberately:** `mintThreadDir`'s `readdir` and
`ensureMetadataNeverIndex`'s `writeFile` on the create path. A pending
prompt leaves "New chat" spinning (the IPC never resolves) — but the main
thread is free, so it is not a beachball, and there is no correct way to
create a directory in a folder the app has not been granted. Surfacing a
timeout error there is a separate change.
