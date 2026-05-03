# @pwrsnap/codex-app-server-protocol

TypeScript types for the [Codex App Server](https://github.com/openai/codex) JSON-RPC protocol, generated from the locally-installed Codex CLI.

The contents of `src/` are **generator output** — do not hand-edit. To refresh:

```bash
pnpm --filter @pwrsnap/codex-app-server-protocol generate
```

This runs `codex app-server generate-ts --out ./src` against whichever `codex` binary is on `PATH`. The generated files are committed so PwrSnap builds cleanly without a Codex install. Regenerate whenever the user's installed Codex CLI ships a newer protocol version (typically alongside a Codex desktop release).

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
