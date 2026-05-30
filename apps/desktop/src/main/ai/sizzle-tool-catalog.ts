// Catalog generator + dispatcher for the Sizzle composer chat tools.
// Thin surface-specific wiring over the generic, allowlist-parameterized
// builder/dispatcher in `library-tool-catalog.ts` — the Sizzle allowlist
// is built per chat instance because its mutations are bound to the
// thread's project (see `buildSizzleToolAllowlist`).

import type {
  DynamicToolCallParams,
  DynamicToolCallResponse,
  DynamicToolSpec
} from "@pwrsnap/codex-app-server-protocol/v2";
import { toDynamicToolSpec } from "./define-tool";
import { dispatchLibraryToolCall } from "./library-tool-catalog";
import { buildSizzleToolAllowlist, type SizzleToolDeps } from "./sizzle-tool-allowlist";

/** Friendly present-tense labels for Sizzle tool activity chips. */
export const SIZZLE_TOOL_LABELS: Record<string, string> = {
  library_search: "Searched the library",
  library_get_metadata: "Read capture details",
  project_get: "Read the reel",
  scenes_set: "Rebuilt the scene list",
  scenes_append: "Added scenes",
  scenes_insert: "Inserted scenes",
  scenes_remove: "Removed scenes",
  scenes_reorder: "Reordered scenes",
  scene_set_script: "Wrote a script line",
  scene_set_transition: "Set a transition",
  scene_set_audio_source: "Set the audio source",
  scene_set_media_trim: "Trimmed a clip",
  scene_set_duration_override: "Set a scene duration",
  project_render: "Rendered the reel"
};

/** Build the Sizzle chat's tool catalog + dispatcher. The allowlist is
 *  bound to the supplied project resolver so every mutation targets the
 *  calling thread's project and no other (locked decision #4). */
export function makeSizzleChatTools(deps: SizzleToolDeps): {
  catalog: DynamicToolSpec[];
  dispatch: (params: DynamicToolCallParams) => Promise<DynamicToolCallResponse>;
} {
  const allowlist = buildSizzleToolAllowlist(deps);
  return {
    catalog: allowlist.map(toDynamicToolSpec),
    dispatch: (params) => dispatchLibraryToolCall(params, allowlist)
  };
}
