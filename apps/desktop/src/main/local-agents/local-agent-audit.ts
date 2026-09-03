import { randomBytes } from "node:crypto";
import type {
  LocalAgentAuditAction,
  LocalAgentAuditEntry,
  LocalAgentCapability,
  Settings
} from "@pwrsnap/shared";
import type { DesktopSettingsStoreApi } from "../settings/desktop-settings-store";

const MAX_AUDIT_ENTRIES = 500;

export class LocalAgentAuditService {
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly settings: Pick<DesktopSettingsStoreApi, "read" | "write">,
    private readonly onSettingsChanged?: (settings: Settings) => void | Promise<void>
  ) {}

  async list(limit = 100): Promise<LocalAgentAuditEntry[]> {
    const settings = await this.settings.read();
    const clamped = Math.max(1, Math.min(MAX_AUDIT_ENTRIES, Math.floor(limit)));
    return settings.localAgents.audit.slice(-clamped).reverse();
  }

  async record(args: {
    clientId: string;
    action: LocalAgentAuditAction;
    capability: LocalAgentCapability;
    subjectKind: "capture" | "sizzle";
    subjectId: string;
    outcome: "success" | "failure";
  }): Promise<LocalAgentAuditEntry> {
    const entry: LocalAgentAuditEntry = {
      id: `lae_${randomBytes(12).toString("hex")}`,
      clientId: args.clientId,
      action: args.action,
      capability: args.capability,
      subjectKind: args.subjectKind,
      subjectId: args.subjectId,
      outcome: args.outcome,
      occurredAt: new Date().toISOString()
    };
    return this.serialize(async () => {
      const current = await this.settings.read();
      const settings = await this.settings.write({
        localAgents: {
          audit: [...current.localAgents.audit, entry].slice(-MAX_AUDIT_ENTRIES)
        }
      });
      await this.onSettingsChanged?.(settings);
      return entry;
    });
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.catch(() => undefined).then(task);
    this.writeQueue = run;
    return run;
  }
}
