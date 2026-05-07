// `import.meta.env.DEV` (+ MODE / PROD / SSR / BASE_URL) for the main
// process. Without this, `import.meta.env.DEV` either errors or
// silently degrades to `any` and the static-substitution tree-shake
// guarantee is invalidated. Same reference the renderer uses; the
// extra CSS / asset module declarations it pulls in are unused in
// main but harmless.
//
// electron-vite statically replaces `import.meta.env.DEV` at build
// time, so `if (import.meta.env.DEV) { ... }` becomes dead code in
// production and Rollup drops the branch + any imports inside it.
/// <reference types="vite/client" />
