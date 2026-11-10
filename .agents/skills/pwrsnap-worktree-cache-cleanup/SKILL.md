---
name: pwrsnap-worktree-cache-cleanup
description: Audit and manually clean a selected PwrSnap Git project's worktrees of repo-local Vitest caches and convert APFS-confirmed non-clone Electron runtimes to verified shared clones. Use for operator-requested disk reclamation on macOS, not automatic product retention or worktree deletion.
---

# PwrSnap worktree cache cleanup

Use the [cleanup script](scripts/cleanup_worktree_caches.py) with
Python 3.9+ on macOS. Resolve script paths relative to this skill's directory.
This operator-invoked skill lives only in PwrSnap's `.agents/skills/`; do not
install it globally. The CLI requires the selected project to share the skill
checkout's Git identity. It can audit older branches when invoked from a
checkout containing this skill.

Ported from reviewed PwrAgent #3590, commit
`70fbd248dcb70cc333f87b944c5b06655e19bb02`, including both final safety fixes.

Run the skill's fixture tests directly on macOS with
`python3 tests/test_cleanup.py` from this skill's directory. They exercise Git,
APFS and process-ownership oracles in disposable directories. These tests are
operator-run and are not part of product CI. The invoked Node oracle can also
run directly with `node --test tests/prepare-runtime-cache-root.test.mjs`.

Before either `clean` or `share`, show the concrete audit report and require
explicit operator approval of that report. Creating the skill or auditing does
not authorize maintenance. Reuse an approval already given for the same report.

For Electron, prefer conversion to verified shared clones: use `audit-share`
and then `share` with an approved report. This includes busy worktrees when the
runtime itself is unused. A loaded runtime is preserved. Existing runtime bytes,
modes and links must match the package-checksummed artifact; modified runtimes
are preserved. Architecture comes from the installed Mach-O executable.

```sh
python3 scripts/cleanup_worktree_caches.py audit-share \
  --project /Users/huntharo/github/PwrSnap \
  --report /private/tmp/pwrsnap-electron-sharing-plan.json
python3 scripts/cleanup_worktree_caches.py share \
  --project /Users/huntharo/github/PwrSnap \
  --report /private/tmp/pwrsnap-electron-sharing-plan.json
```

`share` uses this checkout's merged Electron installer to prepare and verify the
version/platform/architecture-keyed cache. It independently clones each runtime,
checks contents and APFS private bytes/clone IDs/inodes, and publishes under the
installer lock. It leaves source and package declarations untouched. If activity
starts during publication, it restores or retains the original rather than
removing a loaded runtime. Per-path results go beside the plan as `.result.json`.

The `audit`/`clean` modes remove only known Vitest caches. Electron maintenance
uses `audit-share`/`share`; this port does not offer standalone runtime deletion
based only on bundle identity, so modified nested runtime data survives cache cleanup.

For cache removal, first produce a report using the selected repository:

```sh
python3 scripts/cleanup_worktree_caches.py audit \
  --project /Users/huntharo/github/PwrSnap \
  --report /private/tmp/pwrsnap-worktree-cache-plan.json
```

Summarize candidate counts and private bytes, active worktrees, preserved
runtimes and metadata errors. Show the report path before proposing deletion.

Apply only that approved report:

```sh
python3 scripts/cleanup_worktree_caches.py clean \
  --project /Users/huntharo/github/PwrSnap \
  --report /private/tmp/pwrsnap-worktree-cache-plan.json
```

A failed post-publication filesystem or final process inspection retains the
original backup. Report its exact path, directory inode and original-file
witness from the result; publication alone never permits deleting it.

The helper uses `PWRAGENT_HOME/cache/electron-runtime/v1` when configured,
otherwise the shared `~/.pwragent/cache/electron-runtime/v1` default. This is
PwrSnap's installer setting too. `PWRSNAP_USER_DATA` is separate application
state and does not select this cache. The helper's explicit third cache argument
takes precedence over its environment/default; do not introduce a product-specific
cache namespace.

The script re-discovers registered worktrees with Git, checks their common Git
directory, and revalidates every candidate. Removed paths must still have the
approved identity and fingerprint. An edited report cannot add arbitrary paths.

- Cache discovery covers `node_modules/.vitest-cache` and
  `node_modules/.vite/vitest` at tracked package roots. Do not remove a whole
  `.vite` directory or assume an unfamiliar/custom cache path is Vitest data.
- Electron discovery covers physical pnpm package directories and physical
  `node_modules/electron` installs at tracked package roots. Package version
  and stock macOS bundle identity must agree. Unexpected root files, tracked files, escaping links, hardlinks and
  metadata failures cause preservation.
- `getattrlist` private size, clone ID and sharing flags are the filesystem
  oracle. Any shared-block flag preserves the entire runtime, including a clone
  with private modifications. `du`, equal hashes and private bytes alone do not
  establish that a runtime is unshared.
- For `audit`/`clean`, worktrees referenced by current-user processes are skipped,
  including open shells. For `audit-share`/`share`, activity is checked against the
  runtime itself; a shell or test elsewhere in the worktree does not block sharing.
  Process checks must succeed; do not bypass them when the execution
  sandbox denies `ps` or `lsof`. Request read-only host process access instead.
  The Electron installer lock prevents concurrent installation during sharing.
  Cache candidates are renamed and checked again before removal; new activity
  restores the old path when possible, otherwise reports the retained quarantine path.

This operation does not stop apps, delete worktrees, edit source, clean `.local`
or desktop `out/`, or remove global pnpm/Electron caches. Sharing may populate
the verified Electron extraction cache. No sudo or GUI is needed. Report
allocated bytes separately from measured private bytes: APFS snapshots can retain deleted blocks, so allocation is not an immediate free-space
promise. Zero private bytes alone also does not establish a clone. Report
per-path failures; do not retry a deletion blindly.

An older checkout can recreate a private runtime with its old installer. This
skill uses the merged cache installer from PwrSnap #810 in the invoking checkout
to prepare verified shared clones without editing the older checkout's source.
The normal environment/Dev lifecycle on main also uses that shared installer.
