# Verified external-file boundary

PwrSnap treats a pasted, dropped, clipboard-selected, or opened file path as
untrusted. A path-only check is not a trust boundary: a parent symlink or
Windows junction can change where it resolves, and the leaf can be replaced
after validation but before a decoder reopens it.

The shared boundary lives in
`apps/desktop/src/main/security/verified-file.ts`:

- `withVerifiedFileHandle(...)` resolves and opens the candidate once, checks
  the leaf and opened-file identity, keeps the handle valid only inside the
  supplied callback, and closes it afterward. The callback is a staging
  boundary: consumers must await all reads inside it, must not close the
  handle or reopen the pathname, and must not publish externally visible side
  effects. Return privately staged data from the callback, await the wrapper's
  final stability check, and commit that data only after the wrapper resolves.
- `readVerifiedFileSnapshot(...)` reads from that verified handle with an
  explicit byte cap. It never hands a validated pathname to another process or
  worker for reopening.
- Callers may supply a path validator. The pasted-image policy uses this hook
  to reject both lexical and canonical paths inside credential or system
  roots, re-canonicalizing those roots at each pre/post-open boundary so a
  privileged-root symlink retarget cannot stale the policy.

The generic verifier explicitly rejects a leaf symlink or redirecting reparse
point, requires a regular file, and compares the initial, opened-handle, and
post-open `dev`/`ino` identities. POSIX opens add `O_NOFOLLOW | O_NONBLOCK`:
the latter ensures a raced regular-file-to-FIFO swap fails at `fstat` instead
of blocking indefinitely in `open`. Replacement after the open cannot
redirect the handle; in-place size or timestamp changes fail closed.
Verifier-generated errors expose stable codes and generic messages only,
never private absolute paths.

Windows has a stronger leaf boundary than Node can express directly. The
bundled `PwrSnapVerifiedFile.exe` opens the candidate with
`FILE_FLAG_OPEN_REPARSE_POINT`, rejects every leaf reparse point, obtains its
final path and file ID from that handle, and withholds write/delete sharing.
Node opens that proved final path while the native lease remains alive,
requires the same volume/file ID, and releases the lease only after the
callback and final `fstat`. Extended drive/UNC names are normalized before
policy checks; device/object-manager namespaces and drive/admin shares fail
closed. This helper is separate from, and does not implement, native CF_HDROP
clipboard discovery.

## Ownership

- The security module owns canonical open, handle identity, bounded reads, and
  pasted-file privileged-root policy.
- Editor drop and clipboard `file://` ingestion consume bounded byte snapshots.
  Their image workers and decoders never receive the source pathname.
- The Windows media-clipboard work owns native `CF_HDROP` discovery and
  parsing. That native layer returns only a candidate path; after it rebases,
  the shared security boundary must read the candidate bytes.
- Cross-device `.pwrsnap` import owns ZIP validation and import semantics. It
  must use `withVerifiedFileHandle` (for example with `yauzl.fromFd` configured
  not to auto-close the descriptor) after it rebases, awaiting ZIP completion
  inside the callback. That keeps ZIP-specific integration out of the security
  module and avoids a pathname reopen.

This separation deliberately does not add cross-device import behavior,
native clipboard parsing, or cross-device move fallbacks to the security
change.

## Platform notes

On macOS, `/var/folders/...` canonicalizes beneath `/private/var`. The broad
system-root protection therefore has one narrow exception for the current
user's canonical `tmpdir()` only when its real path has the expected
`/private/var/folders/<bucket>/<user-token>/T` shape, is owned by the current
uid, is a directory, and grants no group/other permissions. A hostile TMPDIR
override cannot create an exception; the rest of `/private/var` remains
blocked.

On Windows, the native leaf check deliberately rejects all reparse-backed
files, including cloud placeholders. That compatibility cost is preferable at
an explicit paste/drop/import trust boundary to following an unverified
reparse target.

Hard links are a residual limitation of pathname-based privileged-root policy:
canonical paths do not reveal another hard link's provenance. The identity
checks still prevent a candidate from being swapped between validation and
consumption.
