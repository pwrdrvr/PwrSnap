import type {
  DynamicToolCallParams,
  DynamicToolCallResponse
} from "@pwrdrvr/codex-app-server-protocol/v2";
import type { CommandDispatchOptions } from "../command-bus";

const MAX_TERMINAL_TURNS = 512;

export function missingChatToolContext(): DynamicToolCallResponse {
  return {
    success: false,
    contentItems: [{ type: "inputText", text: "This tool call no longer has an active turn owner." }]
  };
}

function turnKey(threadId: string, turnId: string): string {
  return JSON.stringify([threadId, turnId]);
}

/** Exact turn ownership for tool callbacks that outlive the send command. */
export class ChatTurnToolContextStore {
  private readonly contexts = new Map<string, Map<string, CommandDispatchOptions>>();
  private readonly terminalTurns = new Set<string>();

  commit(threadId: string, turnId: string, context: CommandDispatchOptions): void {
    if (this.terminalTurns.has(turnKey(threadId, turnId))) return;
    const turns = this.contexts.get(threadId) ?? new Map<string, CommandDispatchOptions>();
    turns.set(turnId, context);
    this.contexts.set(threadId, turns);
  }

  forToolCall(params: Pick<DynamicToolCallParams, "threadId" | "turnId">):
    | CommandDispatchOptions
    | undefined {
    return this.contexts.get(params.threadId)?.get(params.turnId);
  }

  clearTurn(threadId: string, turnId: string): void {
    const key = turnKey(threadId, turnId);
    this.terminalTurns.delete(key);
    this.terminalTurns.add(key);
    while (this.terminalTurns.size > MAX_TERMINAL_TURNS) {
      const oldest = this.terminalTurns.values().next().value;
      if (oldest === undefined) break;
      this.terminalTurns.delete(oldest);
    }
    const turns = this.contexts.get(threadId);
    if (turns === undefined) return;
    turns.delete(turnId);
    if (turns.size === 0) this.contexts.delete(threadId);
  }

  clearThread(threadId: string): void {
    this.contexts.delete(threadId);
  }

  clearAll(): void {
    this.contexts.clear();
    this.terminalTurns.clear();
  }
}
