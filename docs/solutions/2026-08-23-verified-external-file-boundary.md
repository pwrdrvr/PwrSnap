# Verified external-file boundary

PwrSnap treats a pasted, dropped, clipboard-selected, or opened file path as
untrusted. A path-only check is not a trust boundary: a parent symlink or
Windows junction can change where it resolves, and the leaf can be replaced
after validation but before a decoder reopens it.

The shared boundary lives in
`apps/desktop/src/main/security/verified-file.ts`:

- `withVerifiedFileHandle(...)` resolves and opens the candidate once, checks
  the leaf and opened-file identity, keeps the handle valid only inside the
  supplied callback, and closes it afterward. Consumers must await all work
  inside that callback and must not close the handle themselves.
- `readVerifiedFileSnapshot(...)` reads from that verified handle with an
  explicit byte cap. It never hands a validated pathname to another process or
  worker for reopening.
- Callers may supply a path validator. The pasted-image policy uses this hook
  to reject both lexical and canonical paths inside credential or system
  roots, re-canonicalizing those roots at each pre/post-open boundary so a
  privileged-root symlink retarget cannot stale the policy.

The generic verifier explicitly rejects a leaf symlink or redirecting reparse
point, requires a regular file, opens the canonical path with `O_NOFOLLOW` as
POSIX defense-in-depth, and compares the initial, opened-handle, and post-open
`dev`/`ino` identities. Replacement after the open cannot redirect the handle;
in-place size or timestamp changes fail closed. Verifier-generated errors
expose stable codes and generic messages only, never private absolute paths.

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
user's canonical `tmpdir()`; the rest of `/private/var` remains blocked.

On Windows, Node/libuv exposes redirecting symlinks and junctions through
`lstat`, and file identity through `dev`/`ino`. Pure Node does not expose every
non-redirecting reparse attribute; rejecting all reparse-backed files would
also reject legitimate cloud placeholders such as OneDrive files.

Hard links are a residual limitation of pathname-based privileged-root policy:
canonical paths do not reveal another hard link's provenance. The identity
checks still prevent a candidate from being swapped between validation and
consumption.
