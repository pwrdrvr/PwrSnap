import { readFile } from "node:fs/promises";
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
  ownerClientId?: string;
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

export class LocalAgentMcpResourceError extends Error {
  constructor(
    public readonly code: "not_found" | "forbidden",
    message: string
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
    return { resource: resolved.resource, bytes: await readFile(resolved.path) };
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
