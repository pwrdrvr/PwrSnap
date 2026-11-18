# Agent rules: Bundle format v2

This file holds rules that used to live in the root
[AGENTS.md](../../AGENTS.md), moved here verbatim so the root file stays
under Codex's 32 KiB project-doc cap. The root keeps a one-line summary of
each section below and says when to read this file. The rules here bind
exactly as they did there. A reference to a section that is not in this file
("see Workflow above", a heading quoted in a code comment) means the root
AGENTS.md or one of the other files in `docs/agents/`.

## Bundle format v2 — the only bundle format (v1 fully removed)

The v2 layer-tree bundle format (multi-source canvas, layer tree,
contextual effects, private-UTI clipboard) is **the only format**.
`persistCaptureFromTempV2` is the single write entrypoint in
[capture-handlers.ts](../../apps/desktop/src/main/handlers/capture-handlers.ts);
the [coordinator.ts](../../apps/desktop/src/main/render/coordinator.ts) read
path is v2-only and **throws** for any non-v2 record.

The entire v1 path — the v1→v2 doctor (lazy/eager/reconcile), the v1
linear compositor (`compose()` in `compose.ts`), `overlays-repo.ts`,
the `overlays:*` IPC verbs, the renderer's v1 model arm + doctor
banners, `legacy-bundle-migration.ts`, the v1 bundle read handle, the
v1 manifest/overlays zod schemas (`bundle-manifest-schema.ts`), and the
`overlays` SQLite table (migration `0020_drop_overlays_table.sql`) —
has been deleted. `compose.ts` survives only as a holder for the v2
SVG rasterize helpers (`arrowSvgForV2` etc.) that `compose-tree.ts`
imports; the v2 compositor is `composeV2` in `compose-tree.ts`.

Notes for anyone touching this area:

- **`bundle_format_version` still exists as a column** and reads of it
  are fine, but it is always `2` for image captures. **Videos carry a
  vestigial `bundle_format_version = 1`** (they have no layer-tree
  bundle and render via the `pwrsnap-capture://` protocol, not the
  compositor) — so a `WHERE bundle_format_version = 1` count is NOT a
  "v1 captures remain" signal. Nothing reads the flag for videos.
- A pre-v2 `.pwrsnap` opened from Finder now fails to parse — v1 is
  unsupported, by design.
- `Overlay` / `OverlayRow` (in `overlay-schemas.ts`) are **kept** — v2
  `VectorLayer.shape` is an `Overlay`, and the editor's draw→layer
  adapter (`overlayToLayer.ts`) still uses them. Don't confuse these
  with the deleted v1 *bundle* schemas.

See
[docs/architecture-bundle-format.md](../../docs/architecture-bundle-format.md)
§Status for the rollout history.
