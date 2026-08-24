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

The pasted-image policy covers common user secret stores as well as platform
system roots. That includes SSH/AWS/Azure/GCP, kube and container registry
credentials, Git/GitHub CLI, GPG/keyrings, Terraform, package-manager config
files that commonly embed tokens, and shell histories. On Windows it also
covers roaming/local Microsoft Crypto, Protect, Credentials, Vault,
SystemCertificates, IdentityCache, and TokenBroker stores. This is a curated
deny set, not a claim that pathname policy can discover every application that
may invent a new credential location.

Canonicalizing a deny root may omit it only when inspection reports `ENOENT`
or `ENOTDIR`. Permission failures, I/O errors, Windows sharing failures, and
unclassified errors reject the ingest with a path-free
`policy_inspection_failed` code. Treating every `realpath` error as "not
present" would silently remove a configured security boundary precisely when
the operating system could not prove its target.

Built-in deny roots always retain their normalized lexical coverage and are
canonicalized when the OS permits it. Windows commonly denies ordinary
processes from inspecting `Recovery`, `System Volume Information`, and several
credential-vault roots; those expected root-inspection failures keep the
lexical policy instead of globally disabling unrelated paste/drop. Candidate
paths are still canonicalized and checked before and after open, so an
uninspectable candidate or ambiguous parent alias fails closed. Explicit
test/configured roots do not inherit the built-in provenance: their non-absence
inspection errors still fail with `policy_inspection_failed`.

## Raster decode boundary

An encoded-byte cap and per-axis dimensions are not memory limits. A tiny,
solid-colour PNG can declare tens of millions of pixels, and a GIF/TIFF can
hide many frames/pages behind one small input. Every pasted, dropped, or raw
clipboard raster therefore passes through
`apps/desktop/src/main/image/safe-raster-decode.ts` before canonical PNG
conversion. The boundary enforces:

- at most 32 MiB encoded input and 64 MiB canonical PNG output;
- at most 32 Mi pixels, four channels, and 128 MiB estimated decoded samples
  (`width × height × channels × bytes-per-sample`);
- exactly one page/frame, rejecting animations and multipage documents rather
  than silently flattening frame one;
- an explicit still-raster decoder allowlist: PNG, JPEG, WebP, single-frame
  GIF, HEIF/AVIF, TIFF, and JPEG 2000. SVG, PDF, camera-raw, scientific,
  whole-slide, and other libvips loaders are not paste/drop formats;
- the existing 32768 per-axis cap and strict sharp decoder warnings.

Canonical PNG output is consumed as a stream and accumulated only through the
64 MiB cap; it does not use an unbounded `png().toBuffer()`. The worker remains
the primary compressed-input decode boundary, while Electron `NativeImage`
clipboard paths preflight width/height/raw RGBA size before their synchronous
`toPNG()` call and re-enter the same sanitizer afterward.

The private layer-fragment paste path uses the same boundary for every embedded
source before writing pending storage. It verifies the sender's input hash,
canonicalizes approved still rasters to PNG, recomputes the canonical hash, and
rewrites pasted raster references to those bytes. Hostile fragments therefore
cannot use the private UTI to bypass page, format, pixel, decoded-memory, or
output limits. When callers request `preservePng`, the sanitizer performs a
complete bounded raw decode first; metadata-only success is not enough to
persist a truncated original PNG.

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
