// Single command registry. Every PwrSnap command — UI button click,
// global hotkey, agent RPC, MCP tool call — dispatches through here.
// Three transports plug in:
//
//   • ipcMain ('cmd' channel) — the renderer's command-bus.dispatch
//     in apps/desktop/src/preload/index.ts.
//   • HTTP RPC (Phase 7) — POST /rpc/<command> on the localhost server.
//   • MCP (later) — exposes the same handlers as MCP tools.
//
// All three call `bus.dispatch(name, req, ctx)`. There is exactly one
// place to register a command and exactly one place to enforce auth +
// capability checks. Adding a UI button without registering a handler
// fails at compile time (the typed Commands map ensures it).
//
// Errors propagate as Result<T, PwrSnapError> (see @pwrsnap/shared/result).
// Electron's `invoke` strips `instanceof Error`, so we never throw across
// process boundaries; we always return Result.

import type { CommandName, Commands, Req, Res } from "@pwrsnap/shared";
import { err, type PwrSnapError, type Result } from "@pwrsnap/shared";
import { getMainLogger } from "./log";
import { markStartup, startupProfilingEnabled } from "./startup-profiler";

const log = getMainLogger("pwrsnap:command-bus");

export type CommandPrincipal = "ipc" | "rpc" | "mcp" | "seeder";

export type CommandSourceBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type CommandContext = {
  signal: AbortSignal;
  principal: CommandPrincipal;
  /** BrowserWindow id for renderer-originated commands, when known. */
  sourceWindowId?: number;
  /** Screen-space bounds for non-window UI affordances, such as the tray icon. */
  sourceBounds?: CommandSourceBounds;
};

export type CommandHandler<C extends CommandName> = (
  req: Req<C>,
  ctx: CommandContext
) => Promise<Result<Res<C>, PwrSnapError>>;

// Storage type is intentionally a wide function — TS can't represent a
// "for some C, CommandHandler<C>" existential, so we erase to any-shape
// and cast on the way out. Type safety lives at the public register/
// dispatch boundaries.
type AnyCommandHandler = (req: unknown, ctx: CommandContext) => Promise<Result<unknown, PwrSnapError>>;

class CommandBus {
  private readonly handlers = new Map<CommandName, AnyCommandHandler>();
  /**
   * AbortControllers keyed by `(captureId | "global")`. Every dispatch
   * inherits the controller's signal. Capture deletion / float-over
   * dismissal calls `cancel(captureId)` to fire the abort.
   */
  private readonly cancellation = new Map<string, AbortController>();

  register<C extends CommandName>(name: C, handler: CommandHandler<C>): void {
    if (this.handlers.has(name)) {
      throw new Error(`command-bus: duplicate handler for ${name}`);
    }
    this.handlers.set(name, handler as AnyCommandHandler);
  }

  unregister<C extends CommandName>(name: C): void {
    this.handlers.delete(name);
  }

  isRegistered(name: string): name is CommandName {
    return this.handlers.has(name as CommandName);
  }

  /**
   * Cancel every in-flight handler keyed by `key`. Called on capture
   * deletion (`key = capture_id`) and on app shutdown (`key = "global"`,
   * which we leave to natural process exit).
   */
  cancel(key: string): void {
    const controller = this.cancellation.get(key);
    if (!controller) return;
    controller.abort();
    this.cancellation.delete(key);
  }

  async dispatch<C extends CommandName>(
    name: C,
    req: Req<C>,
    options: {
      principal: CommandPrincipal;
      cancellationKey?: string | undefined;
      sourceWindowId?: number | undefined;
      sourceBounds?: CommandSourceBounds | undefined;
    }
  ): Promise<Result<Res<C>, PwrSnapError>> {
    const handler = this.handlers.get(name);
    if (!handler) {
      log.warn("unknown command", { name, principal: options.principal });
      return err({
        kind: "validation",
        code: "unknown_command",
        message: `unknown command: ${name}`
      });
    }

    const cancellationKey = options.cancellationKey;
    let controller: AbortController;
    if (cancellationKey !== undefined) {
      controller = this.cancellation.get(cancellationKey) ?? new AbortController();
      this.cancellation.set(cancellationKey, controller);
    } else {
      controller = new AbortController();
    }

    try {
      const ctx: CommandContext = {
        signal: controller.signal,
        principal: options.principal
      };
      if (options.sourceWindowId !== undefined) {
        ctx.sourceWindowId = options.sourceWindowId;
      }
      if (options.sourceBounds !== undefined) {
        ctx.sourceBounds = options.sourceBounds;
      }
      const dispatchStartedAt = startupProfilingEnabled() ? Date.now() : 0;
      const result = (await handler(req, ctx)) as Result<Res<C>, PwrSnapError>;
      if (startupProfilingEnabled()) {
        markStartup(
          `cmd ${name} (${options.principal}) → ${
            result.ok ? "ok" : `err:${result.error.code}`
          } ${Date.now() - dispatchStartedAt}ms`
        );
      }
      return result;
    } catch (cause) {
      log.error("handler threw", {
        name,
        principal: options.principal,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return err({
        kind: "unknown",
        code: "handler_threw",
        message: cause instanceof Error ? cause.message : String(cause),
        cause
      });
    } finally {
      // Don't auto-clean controllers tied to a long-lived cancellation
      // key — capture-keyed dispatches reuse the controller across
      // multiple parallel handlers (Codex fan-out in Phase 4). The key
      // owner explicitly calls cancel() when scope ends.
      if (cancellationKey === undefined) {
        // ephemeral controller, can drop reference
      }
    }
  }
}

export const bus = new CommandBus();
