// Barrel export for @pwrsnap/shared. Subpath exports are also available
// (`@pwrsnap/shared/protocol`, `/overlay`, `/result`, `/ipc`) — prefer
// the subpaths in main / preload / renderer code so refactor scopes stay
// tight.

export * from "./protocol";
export * from "./overlay-schemas";
export * from "./ai-enrichment-schemas";
export * from "./result";
export * from "./ipc";
export * from "./arrow";
export * from "./appearance-arg";
export * from "./bundle-manifest-schema";
export * from "./bundle-manifest-schema-v2";
export * from "./clipboard-layer-fragment";
export * from "./text-glyph-size";
