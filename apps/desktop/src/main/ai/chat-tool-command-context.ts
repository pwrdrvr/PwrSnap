import { AsyncLocalStorage } from "node:async_hooks";
import type { CommandDispatchOptions } from "../command-bus";

const chatToolCommandContext = new AsyncLocalStorage<CommandDispatchOptions>();
const INTERNAL_CHAT_CONTEXT: CommandDispatchOptions = { principal: "ipc" };

export function currentChatToolCommandContext(): CommandDispatchOptions {
  return chatToolCommandContext.getStore() ?? INTERNAL_CHAT_CONTEXT;
}

export function runWithChatToolCommandContext<T>(
  context: CommandDispatchOptions,
  task: () => Promise<T>
): Promise<T> {
  return chatToolCommandContext.run(context, task);
}
