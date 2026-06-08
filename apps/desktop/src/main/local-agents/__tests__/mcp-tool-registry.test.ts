import type { LocalAgentCapability } from "@pwrsnap/shared";
import { ok } from "@pwrsnap/shared";
import { describe, expect, test } from "vitest";
import type { CommandContext } from "../../command-bus";
import {
  createDefaultLocalAgentMcpTools,
  type LocalAgentToolContext
} from "../mcp-tool-registry";

function ctx(capabilities: readonly LocalAgentCapability[] = []): LocalAgentToolContext {
  const signal = new AbortController().signal;
  const commandContext: CommandContext = {
    principal: "mcp",
    signal,
    localAgent: {
      clientId: "lag_test",
      capabilities
    }
  };
  return {
    clientId: "lag_test",
    capabilities,
    signal,
    commandContext
  };
}

describe("createDefaultLocalAgentMcpTools", () => {
  test("search and delete tools dispatch through distinct command paths", async () => {
    const calls: Array<{ name: string; input: unknown }> = [];
    const tools = createDefaultLocalAgentMcpTools({
      search: async (input) => {
        calls.push({ name: "search", input });
        return ok({ searched: input.query ?? "" });
      },
      deleteToTrash: async (input) => {
        calls.push({ name: "delete", input });
        return ok({ deleted: input.captureId });
      }
    });
    const search = tools.find((tool) => tool.name === "pwrsnap_library_search");
    const del = tools.find((tool) => tool.name === "pwrsnap_capture_delete_to_trash");
    if (search === undefined || del === undefined) throw new Error("expected default tools");

    await search.dispatch({ query: "pairing" }, ctx(["library.read"]));
    await del.dispatch({ captureId: "cap_123" }, ctx(["trash.write"]));

    expect(calls).toEqual([
      { name: "search", input: { query: "pairing" } },
      { name: "delete", input: { captureId: "cap_123" } }
    ]);
  });

  test("delete-to-trash requires a capture id in its MCP schema", () => {
    const tools = createDefaultLocalAgentMcpTools({
      search: async () => ok({}),
      deleteToTrash: async () => ok({})
    });
    const del = tools.find((tool) => tool.name === "pwrsnap_capture_delete_to_trash");
    expect(del?.inputSchema).toHaveProperty("captureId");
  });
});
