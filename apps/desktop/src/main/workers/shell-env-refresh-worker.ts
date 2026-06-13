// Off-thread login-shell env resolution for login-shell-path.ts (which
// extracts ONLY `PATH` from the result).
//
// `resolveInteractiveLoginShellEnv` is execFileSync-based — it blocks
// whatever thread it runs on for the full login-shell startup (~0.3–1s,
// worse with heavy dotfiles). On the main thread that block freezes
// compositing for EVERY window, so resolution runs here instead. The
// worker gets a copy of the parent's process.env at construction, which
// is exactly the base env the resolver wants.
//
// Protocol: posts the resolved env object, or null when the shell could
// not be queried (Windows, exotic shells, timeout). One-shot — the
// client terminates the worker after the first message.

import { parentPort } from "node:worker_threads";
import { resolveInteractiveLoginShellEnv } from "@pwrdrvr/agent-transport";

const env = resolveInteractiveLoginShellEnv();
parentPort?.postMessage(env ?? null);
