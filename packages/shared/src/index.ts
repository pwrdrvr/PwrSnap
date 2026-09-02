// Barrel export for @pwrsnap/shared. Subpath exports are also available
// (`@pwrsnap/shared/protocol`, `/overlay`, `/result`, `/ipc`) — prefer
// the subpaths in main / preload / renderer code so refactor scopes stay
// tight.

export * from "./protocol";
export * from "./editor-tool-defaults";
export * from "./chat-schemas";
export * from "./annotation-scale";
export * from "./overlay-schemas";
export * from "./ai-enrichment-schemas";
export * from "./result";
export * from "./ipc";
export * from "./arrow";
export * from "./appearance-arg";
export * from "./bundle-manifest-schema-v2";
export * from "./crop-viewport";
export * from "./base-raster";
export * from "./clipboard-layer-fragment";
export * from "./clipboard-placement";
export * from "./clipboard-copy-verbs";
export * from "./text-glyph-size";
export * from "./outline-auto";
export * from "./text-html-style";
export * from "./sizzle-video-fit";
export * from "./sizzle-media-trim";
export * from "./sizzle-reel-duration";
export * from "./sizzle-phrase-match";
export * from "./sizzle-sequence-timeline";
export * from "./export-ladder";
export * from "./local-agent-policy";
export * from "./desktop-platform";
export * from "./shortcut-semantics";
export * from "./capture-invocation";
