import type { LocalAgentCapability } from "@pwrsnap/shared";

export type LocalAgentCommandRequirement =
  | { all: readonly LocalAgentCapability[] }
  | { any: readonly LocalAgentCapability[] };

/**
 * Authorization floor for commands reachable from the local-agent MCP surface.
 * Unknown commands are denied. Broader workflow checks may add requirements at
 * the tool boundary, but they may never bypass this floor.
 */
export function localAgentCommandRequirement(
  name: string,
  req: unknown
): LocalAgentCommandRequirement | null {
  switch (name) {
    case "library:list":
    case "library:search":
    case "library:discover":
    case "library:listByIdsWithMetadata":
    case "codex:enrichment":
      return { all: ["library.read"] };

    // These lookup commands support narrowly scoped workflows that already
    // possess a capture/project identifier. Catalog tools separately require
    // library.read before exposing their returned metadata to a model.
    case "library:byId":
      return {
        any: [
          "library.read",
          "capture.edit",
          "trash.write",
          "sizzle.compose",
          "sizzle.preview.read",
          "sizzle.full.read"
        ]
      };

    case "library:delete":
      return { all: ["trash.write"] };

    case "render:composite":
      return { all: ["capture.composite.read"] };

    case "render:captureExport":
      return {
        all: [captureExportVariant(req) === "original"
          ? "capture.original.read"
          : "capture.composite.read"]
      };

    case "codex:libraryChat:create":
    case "codex:libraryChat:list":
    case "codex:libraryChat:send":
    case "codex:libraryChat:wait":
    case "codex:libraryChat:history":
    case "codex:libraryChat:rename":
    case "codex:libraryChat:archive":
    case "codex:libraryChat:interrupt":
    case "codex:libraryChat:approve":
      return { all: ["capture.edit"] };

    case "layers:list":
    case "layers:upsert":
    case "layers:update":
    case "layers:delete":
    case "layers:reorder":
    case "layers:reorderMany":
    case "bundle:cropCanvas":
    case "library:addTag":
    case "library:removeTag":
    case "library:openInLibrary":
    case "editor:open":
      return { all: ["capture.edit"] };

    case "sizzle:create":
    case "sizzle:delete":
    case "sizzle:toggleScene":
    case "sizzle:update":
    case "codex:sizzleChat:create":
    case "codex:sizzleChat:list":
    case "codex:sizzleChat:send":
    case "codex:sizzleChat:history":
    case "codex:sizzleChat:rename":
    case "codex:sizzleChat:archive":
    case "codex:sizzleChat:interrupt":
    case "codex:sizzleChat:approve":
      return { all: ["sizzle.compose"] };

    case "sizzle:list":
      return {
        any: ["sizzle.compose", "sizzle.preview.read", "sizzle.full.read"]
      };

    case "sizzle:render":
      return {
        all: [sizzleRenderMode(req) === "preview"
          ? "sizzle.preview.read"
          : "sizzle.full.read"]
      };

    default:
      return null;
  }
}

export function satisfiesLocalAgentCommandRequirement(
  capabilities: readonly LocalAgentCapability[],
  requirement: LocalAgentCommandRequirement
): boolean {
  const held = new Set(capabilities);
  if ("all" in requirement) {
    return requirement.all.every((capability) => held.has(capability));
  }
  return requirement.any.some((capability) => held.has(capability));
}

function captureExportVariant(req: unknown): "composite" | "original" {
  if (typeof req !== "object" || req === null) return "composite";
  return (req as { variant?: unknown }).variant === "original" ? "original" : "composite";
}

function sizzleRenderMode(req: unknown): "preview" | "full" {
  if (typeof req !== "object" || req === null) return "full";
  return (req as { mode?: unknown }).mode === "preview" ? "preview" : "full";
}
