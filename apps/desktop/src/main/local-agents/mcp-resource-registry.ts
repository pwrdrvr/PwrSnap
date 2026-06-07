import type { LocalAgentCapability } from "@pwrsnap/shared";

export type LocalAgentMcpResource = {
  uri: string;
  name: string;
  mimeType?: string;
  requiredCapabilities: readonly LocalAgentCapability[];
  read: () => Promise<Uint8Array>;
};

export class LocalAgentMcpResourceRegistry {
  private readonly resources = new Map<string, LocalAgentMcpResource>();

  register(resource: LocalAgentMcpResource): void {
    if (this.resources.has(resource.uri)) {
      throw new Error(`duplicate MCP resource: ${resource.uri}`);
    }
    this.resources.set(resource.uri, resource);
  }

  list(): LocalAgentMcpResource[] {
    return Array.from(this.resources.values());
  }

  get(uri: string): LocalAgentMcpResource | undefined {
    return this.resources.get(uri);
  }

  clear(): void {
    this.resources.clear();
  }
}
