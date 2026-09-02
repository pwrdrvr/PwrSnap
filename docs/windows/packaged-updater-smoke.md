# Packaged Windows updater smoke

The packaged updater smoke proves the Windows NSIS update path without reading
or mutating a real GitHub Release feed. It installs one signed synthetic
prerelease, serves a newer signed synthetic prerelease from a process-local
loopback feed, and waits for `electron-updater` to download, install, and
relaunch PwrSnap.

This is an updater-only gate. Installed-app renderer/native-module readiness is
owned by the separate packaged-launch smoke.

## Why it is not ordinary PR CI

`electron-builder.yml` enables `win.verifyUpdateCodeSignature`. An unsigned PR
preview cannot update a signed installation, and ordinary PR jobs deliberately
have no Azure Artifact Signing credentials. The smoke therefore reuses the
protected `release.yml` trust boundary:

1. `windows-prepare` builds and hashes the self-contained stage without
   credentials.
2. `windows-sign`, inside the protected `windows-signing` environment, produces
   two same-source versions named
   `X.Y.Z-update-smoke.<run-id>.<attempt>.1` and `.2`. Both installers are
   Authenticode-signed. They are written only under
   `release-stage/update-smoke-input`, never the real `release-stage/dist`
   publication directory.
3. The signed inputs and a standalone runner cross into the
   `windows-updater-smoke` job through a short-lived workflow artifact.
4. `windows-updater-smoke` runs on a fresh hosted Windows runner. It has no
   GitHub Environment, no checkout, no Azure values, and no package install.
   The credential-bearing job never launches PwrSnap.

Tagged releases run this gate before `publish-release-assets`; a failure blocks
publication. A reviewed same-repository PR can run only this path with the
`ci:windows-updater-smoke` label. As with `ci:windows-signing`, temporarily
allow the exact `refs/pull/<number>/merge` ref in the `windows-signing`
environment, approve the protected job, and remove the rule immediately after
validation. Never approve a fork or an unreviewed SHA. PR events cannot run the
publication job.

## Feed and data isolation

The smoke override is compiled into the application but inert in every normal
package. It requires both:

- `PWRSNAP_UPDATE_SMOKE=1` plus the complete expected-version/run/feed/userData
  contract; and
- `resources/pwrsnap-update-smoke-build.json`, stamped with the exact running
  synthetic version.

A marker-bearing smoke build without its contract exits before updater
initialization. An ordinary build with the environment override also exits.
The only accepted feed is exactly `http://127.0.0.1:<nonzero-port>/`—not
`localhost`, IPv6, HTTPS, a path, credentials, query parameters, or a fragment.
In this mode the updater installs a GenericProvider directly, forces
`latest.yml`, disables periodic checks, and bypasses GitHub release discovery
entirely. There is no production-feed fallback.

The runner binds its server only to `127.0.0.1` and serves only the manifest's
target `latest.yml`, blockmap, and versioned installer. It accepts the updater's
single `noCache` query on `latest.yml`, supports bounded byte ranges, and logs
every request. The old-version blockmap request is an expected 404, matching the
real NSIS full-download fallback; any other path or query is rejected.

Every launch receives isolated `APPDATA`, `LOCALAPPDATA`, `HOME`, `TEMP`, `TMP`,
and `PWRSNAP_USER_DATA`, with process splitting disabled. The ephemeral hosted
runner's real `USERPROFILE` is retained because electron-updater clears
`PSModulePath` and inbox Windows PowerShell needs that profile to reconstruct
its trusted system-module path for Authenticode. PwrSnap still rebases
Electron's userData, Documents, and home paths beneath the isolated userData for
this mode. It creates no tray, window, hotkey, login item, Codex process, local
server, capture, or filename-maintenance task.

## Assertions and failure evidence

The runner validates, in order:

- manifest schema, exact filenames, SHA-256 values, and `target > baseline`;
- valid `CN=PwrDrvr LLC` Authenticode signatures on both installers;
- a silent baseline install under the isolated smoke root;
- the baseline executable signature and exact packaged marker;
- real update check, availability, download, install-attempt persistence,
  marker-gated silent `quitAndInstall(true, false)`, and NSIS replacement;
- harness-owned target relaunch with the exact same isolated environment and
  an exact target PID/path check;
- the target executable signature and marker;
- exact target `app.getVersion()`, the same userData path and random continuity
  sentinel, a surviving `pwrsnap.db`, and a cleared
  `pwrsnap-update-install-attempt.json` marker.

The application writes append-only events plus an atomic `result.json` under
`<userData>/windows-update-smoke`. The workflow always uploads the runner log,
stdout/stderr, feed transcript, continuity/result files, main-process logs,
installed marker/signature evidence, process inventory, and updater-cache file
inventory. Cleanup targets only processes whose executable path is under the
isolated install directory and uses a bounded Windows process-tree kill.

## Local validation and remaining limitation

The manifest, version derivation, build-marker injection, feed URL gate,
no-GitHub updater branch, loopback server, range responses, traversal rejection,
controller continuity, workflow topology, and archive allowlist all have
cross-platform unit/static coverage. Run the focused set from the repository
root:

```bash
pnpm exec vitest run \
  apps/desktop/scripts/package-win-update-smoke.test.mjs \
  apps/desktop/scripts/windows-release-config.test.mjs \
  apps/desktop/src/main/__tests__/auto-updater.test.ts \
  apps/desktop/src/main/__tests__/windows-update-smoke.test.ts \
  scripts/e2e/run-windows-update-smoke.test.mjs
```

The first true NSIS replacement remains a protected signing run: it requires
the temporary PR merge-ref rule and reviewer approval described above. The
synthetic pair proves updater mechanics from one source revision; it does not
prove compatibility with an arbitrary historical build. Existing published
Windows prereleases predate the marker-gated loopback seam and must not be used
for this test, because doing so would require real GitHub feed discovery.

The hosted runner deliberately does not assert assisted NSIS's production
`ExecShellAsUser` relaunch. That shell-owned launch cannot reliably retain the
test-only isolated environment, so forcing it could boot PwrSnap outside the
throwaway userData. The smoke instead proves the signed electron-updater
download and silent NSIS replacement, then relaunches the installed target from
the credential-free harness. Production's user-facing assisted-installer
finish-page relaunch remains a manual Windows check.
