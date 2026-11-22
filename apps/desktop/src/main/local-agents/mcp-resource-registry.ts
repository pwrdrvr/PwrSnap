import { open } from "node:fs/promises";
import type {
  LocalAgentAuditAction,
  LocalAgentCapability
} from "@pwrsnap/shared";

export type LocalAgentMcpResource = {
  uri: string;
  name: string;
  mimeType: string;
  resolvePath: (context: LocalAgentResourceReadContext) => Promise<string>;
  requiredCapabilities: readonly LocalAgentCapability[];
  captureId?: string;
  ownerClientId?: string;
  /** What to do instead when the file is too large to read over MCP. */
  oversizeAdvice?: string;
  audit?: {
    action: LocalAgentAuditAction;
    capability: LocalAgentCapability;
    subjectKind: "capture" | "sizzle";
    subjectId: string;
  };
};

export type LocalAgentResourceReadContext = {
  clientId: string;
  capabilities: readonly LocalAgentCapability[];
};

/** The smallest per-message cap among the MCP clients PwrSnap serves: the
 *  official SDK's stdio `ReadBuffer` refuses a line over 10 MiB and, in at
 *  least one host, takes the whole app down with it. */
export const MCP_CLIENT_MESSAGE_LIMIT_BYTES = 10 * 1024 * 1024;

/** The largest file `resources/read` returns. One read is one JSON-RPC message
 *  holding the base64 blob (4/3 of the bytes), so 6 MiB encodes to 8 MiB and
 *  leaves 2 MiB of the client's limit for the envelope. MCP has no ranged or
 *  chunked resource read, so anything larger is refused, never split. */
export const MCP_MAX_RESOURCE_BLOB_BYTES = 6 * 1024 * 1024;

/** How a tool result tells an agent whether its media can be read over MCP,
 *  before it tries. */
export type McpMediaSize = {
  byteSize: number;
  mcpReadable: boolean;
  maxMcpReadBytes: number;
};

export function mcpMediaSize(byteSize: number): McpMediaSize {
  return {
    byteSize,
    mcpReadable: byteSize <= MCP_MAX_RESOURCE_BLOB_BYTES,
    maxMcpReadBytes: MCP_MAX_RESOURCE_BLOB_BYTES
  };
}

export function mcpTooLargeMessage(byteSize: number): string {
  return (
    `This media is ${formatMiB(byteSize)} (${byteSize} bytes); MCP resources/read ` +
    `returns at most ${formatMiB(MCP_MAX_RESOURCE_BLOB_BYTES)} ` +
    `(${MCP_MAX_RESOURCE_BLOB_BYTES} bytes) in one message, and MCP has no ranged read.`
  );
}

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export class LocalAgentMcpResourceError extends Error {
  constructor(
    public readonly code: "not_found" | "forbidden" | "too_large",
    message: string,
    public readonly byteSize?: number
  ) {
    super(message);
    this.name = "LocalAgentMcpResourceError";
  }
}

export class LocalAgentMcpResourceRegistry {
  private readonly resources = new Map<string, LocalAgentMcpResource>();

  register(resource: LocalAgentMcpResource): LocalAgentMcpResource {
    this.resources.set(resource.uri, resource);
    return resource;
  }

  get(uri: string): LocalAgentMcpResource | undefined {
    return this.resources.get(uri);
  }

  async read(
    uri: string,
    context: LocalAgentResourceReadContext
  ): Promise<{ resource: LocalAgentMcpResource; bytes: Buffer }> {
    const resolved = await this.resolve(uri, context);
    return { resource: resolved.resource, bytes: await readBounded(resolved.path) };
  }

  async resolve(
    uri: string,
    context: LocalAgentResourceReadContext
  ): Promise<{ resource: LocalAgentMcpResource; path: string }> {
    const resource = this.resources.get(uri);
    if (resource === undefined) {
      throw new LocalAgentMcpResourceError("not_found", `resource not found: ${uri}`);
    }
    if (
      resource.ownerClientId !== undefined &&
      resource.ownerClientId !== context.clientId
    ) {
      throw new LocalAgentMcpResourceError("forbidden", "resource belongs to another client");
    }
    const held = new Set(context.capabilities);
    if (!resource.requiredCapabilities.every((capability) => held.has(capability))) {
      throw new LocalAgentMcpResourceError(
        "forbidden",
        "the current grant no longer permits this resource"
      );
    }
    return { resource, path: await resource.resolvePath(context) };
  }

  clear(): void {
    this.resources.clear();
  }
}

/** Reads a whole file only when it fits in one MCP message. The size is taken
 *  from the open handle before any bytes are read, so an oversized render is
 *  refused without loading it, and checked again after the read in case the
 *  file grew in between. */
async function readBounded(path: string): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    if (size > MCP_MAX_RESOURCE_BLOB_BYTES) throw tooLarge(size);
    const bytes = await handle.readFile();
    if (bytes.length > MCP_MAX_RESOURCE_BLOB_BYTES) throw tooLarge(bytes.length);
    return bytes;
  } finally {
    await handle.close();
  }
}

function tooLarge(byteSize: number): LocalAgentMcpResourceError {
  return new LocalAgentMcpResourceError("too_large", mcpTooLargeMessage(byteSize), byteSize);
}
