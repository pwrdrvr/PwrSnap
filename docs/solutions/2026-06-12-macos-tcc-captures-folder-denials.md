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
  path) clears automatically — TCC grants apply to new opens without a
  relaunch.
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
