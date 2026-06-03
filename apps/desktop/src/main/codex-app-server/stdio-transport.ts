// Codex App Server stdio transport — a thin PwrSnap wrapper over
// @pwrdrvr/agent-transport's `StdioJsonRpcTransport`.
//
// The kit transport is host-agnostic: it takes a FULLY-RESOLVED command + the
// explicit args to spawn, and does no discovery. PwrSnap's transport has always
// resolved the Codex binary itself (via codex-discovery) and spawned it with
// the `app-server` subcommand. This wrapper preserves that: it resolves the
// command on `connect()`, logs the launch, then delegates the actual spawn +
// line-delimited JSON-RPC plumbing to the kit transport.
//
// Consumers construct this with `{ command }` exactly as before — the resolve
// + `["app-server"]` arg injection stays internal.

import type { JsonRpcTransport } from "@pwrdrvr/agent-transport";
import { StdioJsonRpcTransport as KitStdioJsonRpcTransport } from "@pwrdrvr/agent-transport";
import { toAgentKitLogger } from "../ai/agent-kit-bindings";
import { getMainLogger } from "../log";
import { compareCodexCliVersions, resolveCodexCommand } from "../settings/codex-discovery";

const codexTransportLog = getMainLogger("pwrsnap:codex-transport");
const kitTransportLogger = toAgentKitLogger("pwrsnap:codex-transport");

export type StdioJsonRpcTransportOptions = {
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
};

export { compareCodexCliVersions };

export class StdioJsonRpcTransport implements JsonRpcTransport {
  private delegate: KitStdioJsonRpcTransport | null = null;
  private messageHandler: (message: string) => void = () => undefined;
  private closeHandler: (error?: Error) => void = () => undefined;

  constructor(private readonly options: StdioJsonRpcTransportOptions) {}

  setMessageHandler(handler: (message: string) => void): void {
    this.messageHandler = handler;
    this.delegate?.setMessageHandler(handler);
  }

  setCloseHandler(handler: (error?: Error) => void): void {
    this.closeHandler = handler;
    this.delegate?.setCloseHandler(handler);
  }

  async connect(): Promise<void> {
    if (this.delegate) {
      return;
    }

    const env = this.options.env ?? process.env;
    const command = await resolveCodexCommand({
      command: this.options.command,
      env
    });
    codexTransportLog.info("launch app-server", {
      command: command.command,
      source: command.source,
      version: command.version ?? null
    });

    const delegate = new KitStdioJsonRpcTransport({
      command: command.command,
      args: ["app-server", ...(this.options.args ?? [])],
      env,
      logger: kitTransportLogger
    });
    delegate.setMessageHandler(this.messageHandler);
    delegate.setCloseHandler(this.closeHandler);
    this.delegate = delegate;
    await delegate.connect();
  }

  async close(): Promise<void> {
    const delegate = this.delegate;
    this.delegate = null;
    if (delegate) {
      await delegate.close();
    }
  }

  send(message: string): void {
    if (!this.delegate) {
      throw new Error("codex app server stdio not connected");
    }
    this.delegate.send(message);
  }
}
