// Off-thread login-shell PATH resolution for login-shell-path.ts.
//
// `resolveInteractiveLoginShellEnv` is execFileSync-based — it blocks
// whatever thread it runs on for the full login-shell startup (~0.3–1s,
// worse with heavy dotfiles). On the main thread that block freezes
// compositing for EVERY window, so resolution runs here instead. The
// worker gets a copy of the parent's process.env at construction, which
// is exactly the base env the resolver wants.
//
// Protocol: posts back ONLY the resolved `PATH` string (the sole thing
// login-shell-path.ts consumes — keep the rest of the shell env, which
// can include secrets exported by dotfiles, inside this worker), or
// null when the shell could not be queried (Windows, exotic shells,
// timeout, or no PATH). One-shot — the client terminates the worker
// after the first message.

import { parentPort } from "node:worker_threads";
import { resolveInteractiveLoginShellEnv } from "@pwrdrvr/agent-transport";

const env = resolveInteractiveLoginShellEnv();
const path = env?.PATH;
parentPort?.postMessage(typeof path === "string" && path.length > 0 ? path : null);
