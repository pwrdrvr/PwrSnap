# Shared Electron runtime extraction cache

PwrSnap's desktop postinstall runs `scripts/ensure-electron-runtime.mjs`
before native helper builds and the Linux sandbox advisory. Both POSIX and
Windows `.codex/environments/environment.toml` setup paths reach it through
`pnpm install`; the generated environment file needs no changes.

The implementation is ported unchanged from
[PwrAgent #3580](https://github.com/pwrdrvr/PwrAgent/pull/3580), whose cache
implementation commits are `046d94f34` and `13c19ca2c`. Its additional native
entry-point tests arrived in `776c3c4d0`. The two installer modules are
byte-identical to donor permission fix `e64619ca8`. The cache is shared with PwrAgent and the other
PwrDrvr desktop products; application state stays separate.

## Shared v1 contract

The default is **`~/.pwragent/cache/electron-runtime/v1`**, deliberately retaining
PwrAgent's directory name across products. `PWRAGENT_HOME` overrides the common
home for isolated installs/tests. `PWRSNAP_USER_DATA` does not affect this cache.
There is no product-specific override or product name in the key.

The identity is serialized with this exact field order:

```js
{ format: 1, version, platform, arch, checksum }
```

`checksum` is the verified ZIP's SHA-256; the directory key is
`SHA256(JSON.stringify(identity))`. Each entry contains `dist/` and
`runtime.json`, with `identity` and the complete `files` inventory. The
inventory records paths, modes, file hashes, directories and relative symlink
targets. Cache reads recheck the entire inventory, and links escaping `dist/`
are rejected. Keep this protocol aligned across consumers.

`@electron/get` retains archive checksum verification, mirror configuration,
force-download and ZIP-cache options. The installer also checks the bundled
release checksum when available. A fully verified existing install works
offline without reading the cache or requesting a ZIP. A fresh install can use
the existing verified ZIP cache offline.

Extraction and installation use unique staging directories, verification and
rename publication. Concurrent cache publishers reuse the verified winner.
Installers targeting one package serialize with PID/token locks; only
OS-confirmed dead owners can be recovered. Invalid entries remain available
for diagnosis and are bypassed; an unavailable cache falls back to extraction
inside the target package. A killed installer can leave its own staging files.
The installer performs no eviction or migration of existing worktrees.

Worktree-only write permissions are supported. Download and checksum temporary
files live in an owned `.runtime-download-*` directory inside the current
Electron package. If the ZIP cache rejects a write with `EACCES`, `EPERM` or
`EROFS`, the installer makes one attempt with a ZIP cache inside that same
temporary directory. Both attempts retain `@electron/get` checksum validation
and download settings. Network and integrity failures do not trigger this
permission fallback. The entry-point callback forwards `tempDirectory` and
optional `cacheRoot` overrides **after** its default download options.

A readable, verified shared extraction can still be cloned without modifying
the shared cache. When shared storage cannot be used, installation remains
local and may allocate a private runtime. Download scratch and its local ZIP
cache are removed in `finally`; the package lock is released even if staging
cleanup throws. No existing user cache is removed. This behavior is ported from
PwrAgent's signed fix `e64619ca8`; the shared cache format, key and default are
unchanged.

Every worktree still installs its own dependencies. Runtime files are never
hard-linked, and workspace packages are never linked to donor source. On macOS,
native `/bin/cp -cRpP` creates independent writable APFS clones. Linux and Windows
use Node's existing reflink request with an independent-copy fallback. A
filesystem without cloning retains correctness but allocates private bytes.

The dev launcher's missing-runtime repair runs the same sibling installer as
postinstall. Its existing before/after health checks and error handling remain
in place, and a healthy install still returns without invoking the installer.
Repair finishes before the Linux sandbox advisory, native helper builds and
the dev launch. This does not migrate already installed runtimes.

## Tests and filesystem evidence

```sh
pnpm exec vitest run --config vitest.workspace.ts --project desktop-main \
  apps/desktop/scripts/ensure-electron-runtime.test.mjs \
  apps/desktop/scripts/electron-runtime-lifecycle.test.mjs \
  apps/desktop/scripts/dev-electron-runtime-cache.test.mjs \
  apps/desktop/scripts/dev.test.mjs \
  scripts/__tests__/linux-sandbox.test.mjs
```

The lifecycle oracle selects the install command from the real desktop hook.
Before the port it failed with different APFS clone IDs (`236632612` and
`236632634`) for repeated extractions. Its setup-chain guard also failed on
the original `install-electron` hook. The fixed hook passes both.

The focused suite passed 48 tests on macOS. Generated target combinations and
cache mutations cover version/platform/architecture/archive separation,
corruption, unavailable caches, offline reuse, incomplete installs, concurrent
processes and recovery after a killed installer. A native-host entry-point test
installs three different project layouts against one cache. Another checks the
common default home, exact identity/key and separation from PwrSnap state.
The dev repair oracle copies the production launcher and installers into
disposable layouts, seeds a verified common cache, and repairs a missing
runtime through the launcher's default entry point. It checks the complete
inventory, unchanged cache entry, independent inodes, APFS clone IDs/private
allocation on macOS, write isolation, and the healthy fast path offline. The
oracle failed on the previous repair path because it executed the dependency's
sentinel `install.js` (exit code 73). No test invokes the launcher main function
or starts Electron.
Linux and Windows native behavior is exercised by CI, not by foreign-binary
execution on the Mac.

Permission regressions model `EACCES`/`EPERM`/`EROFS`, verify network errors are
not retried, assert native entry-point override precedence, and inject a cleanup
failure in a disposable child process to verify lock release. Another test uses
the **real `@electron/get`**, replacing only HTTP with a local fixture ZIP, with
both external caches set to mode `0555`. It verifies checksum handling, the
single local-cache retry, scratch cleanup, installed content and unchanged
external caches. This test reproduced `EACCES` before the fix and passed on
macOS afterward. It skips Windows (where POSIX mode bits do not deny writes)
and root processes; generated permission and native entry-point tests still
cover those code paths. All caches in these tests are disposable fixtures.

To measure a real runtime without starting Electron, pass an existing ZIP that
matches this checkout's installed Electron package and a report destination.
An optional peer scripts directory supplies PwrAgent's production installer
read-only:

```sh
node apps/desktop/scripts/probe-electron-runtime-sharing.mjs \
  /absolute/path/to/electron-v44.9.3-darwin-arm64.zip \
  .local/electron-sharing-report.json \
  /absolute/path/to/PwrAgent/apps/desktop/scripts
```

The probe copies both products' entry points into disposable independent
package layouts and supplies the pre-verified ZIP. Each entry point also
verifies its package checksum. Both products must publish/reuse exactly one
entry. The probe compiles `fixtures/apfs-private-size.c` and uses macOS
`getattrlist` with `ATTR_CMNEXT_PRIVATESIZE` and `ATTR_CMNEXT_CLONEID`, checking
that the filesystem returned both attributes. It measures every regular file,
checks hashes and distinct inodes, and tests a private write. It removes only
its disposable directory, leaves existing caches/worktrees untouched, and
retains the JSON report with installer source hashes.

Measured on 2026-11-10, Node 24.22.0, Electron **44.9.3 darwin/arm64**:

| Installation | Regular files | Private bytes |
| --- | ---: | ---: |
| Ordinary extraction A | 260 | 322,994,176 |
| Ordinary extraction B | 260 | 323,305,472 |
| PwrAgent production entry point | 260 | **0** |
| PwrSnap production entry point | 260 | **0** |

The shared entry key was
`d3a2469bcddef14cc7c75cffe6e50104e4732ff60d9b23b770285f94d426e566`.
The verified ZIP SHA-256 was
`4af51382278d00291dfcda265eddd9bab6e98cebb09f46aadc8438bf606de162`.
All four Framework files had SHA-256
`dd63e2ed3669826c26ce9adaabaff14be544cae0937c36067577eff33f05bbf7`.
The PwrAgent/PwrSnap Framework inodes were `236639596` and `236640209`, with
common clone ID `236638991` and zero private bytes. A 4 KiB write into PwrSnap's
copy allocated 16,384 private bytes and changed its hash; PwrAgent's hash and
zero private allocation stayed unchanged. The ordinary extractions had different
clone IDs. Node's `COPYFILE_FICLONE` alone allocated 203,493,376 private bytes
for the Framework on this host, which is why macOS needs native `cp`.

These observations prove shared extents with private write isolation. Equal
content and `du` output alone would not establish that property. Existing
private allocations are not reclaimed until their owning installs are explicitly
replaced; this change never cleans up the user's existing worktrees or caches.

## CI checkouts and completed dependency caches

PwrAgent's follow-up review in `84721056b` found sparse checkout lists that
selected the installer without its new helper. A dependency-cache hit could
hide that failure by skipping installation. PwrSnap's audit found no sparse
checkout lists: all 15 checkouts in jobs using `configure-nodejs` currently
retain the full repository. The release signing archives consume prepared
stages rather than running dependency installation.

PwrSnap did have a related omission: the completed dependency-cache input list
did not include either installer module. Both are now explicit inputs, so an
installer or helper change invalidates the completed tree for producers and
consumers. The cache-key test discovers the transitive local import closure
rather than maintaining another list of helper names.

`scripts/electron-install-sparse-checkout.test.mjs` adapts the donor's real Git
oracle to PwrSnap's full checkouts and any future non-cone sparse lists. It
discovers install jobs across every workflow, applies their actual Git patterns
to disposable indexes with `git read-tree`, and checks the whole import closure.
The parser includes static, side-effect, re-export and literal dynamic imports.
A counterexample proves that an installer-only sparse list omits the helper,
while the complete list retains it. No fixture commits, network, user checkout
changes or cache hits are involved.

The 19-test suite exposed the missing cache inputs before the fix; it passes
after adding both files:

```sh
pnpm exec vitest run --config vitest.workspace.ts --project desktop-main \
  scripts/electron-install-sparse-checkout.test.mjs
```
