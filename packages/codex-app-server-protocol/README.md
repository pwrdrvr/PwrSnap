# @pwrsnap/codex-app-server-protocol

TypeScript types for the [Codex App Server](https://github.com/openai/codex) JSON-RPC protocol, generated from the locally-installed Codex CLI.

The contents of `src/` are **generator output** — do not hand-edit. Every file in `src/` and `src/v2/` carries a `// GENERATED CODE! DO NOT MODIFY BY HAND!` header.

To refresh:

```bash
pnpm codex:generate-protocol
# (equivalent: pnpm --filter @pwrsnap/codex-app-server-protocol generate)
```

This runs `codex app-server generate-ts --out ./src` against the Codex
binary the script picks up. By default it uses **Codex Desktop's bundled
binary**:

```
/Applications/Codex.app/Contents/Resources/codex
```

To override (for a system-installed Codex CLI, a custom build, or CI):

```bash
PWRSNAP_CODEX_BIN=/path/to/codex pnpm codex:generate-protocol
```

The generated files are committed so PwrSnap builds cleanly without a Codex
install at hand. Regenerate whenever:

- Codex Desktop autoupdates (the bundled `codex` binary version bumps).
- A new Codex protocol surface lands that PwrSnap wants to consume.
- The `// GENERATED CODE!` header version drifts from what `codex --version` reports.

Current generated source: **`codex-cli 0.128.0-alpha.1`** (509 generated `.ts` files; v1 surface in `src/`, v2 surface in `src/v2/`).

## Why a separate package

PwrSnap connects to the user's locally-installed Codex CLI / Codex Desktop instance over stdio JSON-RPC for **every** AI feature — annotation, descriptions, tag suggestions, smart filenames, sensitive-data review, voice describe (Phase 4–6). Keeping the protocol types in their own package means:

- The generator (`codex app-server generate-ts`) writes into one well-known location.
- `apps/desktop/src/main/ai/` imports types via `@pwrsnap/codex-app-server-protocol` and `@pwrsnap/codex-app-server-protocol/v2`, exactly mirroring how PwrAgnt consumes its own copy.
- Future PwrDrvr products in this repo (none yet) can depend on the same package.

## Subpath exports

| Import path | Maps to | Use for |
|---|---|---|
| `@pwrsnap/codex-app-server-protocol` | `src/index.ts` | v1 protocol surface |
| `@pwrsnap/codex-app-server-protocol/v2` | `src/v2/index.ts` | v2 protocol surface (preferred — has `DynamicToolCall*`, `ContentItem` with image, `ThreadRealtime*`, `Skill*`, `Hook*`, `Mcp*`) |

## Source of truth

The Rust source for the protocol is in the Codex repo under `app-server/`. The generator emits one TS file per Rust type, plus barrel `index.ts` files. PwrSnap pins no version explicitly — running `pnpm generate` simply re-emits whatever the user's Codex install knows about. Commit the diff, ship.
