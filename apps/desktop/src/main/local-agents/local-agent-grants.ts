import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  LocalAgentCapability,
  LocalAgentClientGrant,
  LocalAgentClientGrantPatch,
  Settings
} from "@pwrsnap/shared";
import { isLocalAgentCapability } from "@pwrsnap/shared";
import type { CommandContext } from "../command-bus";
import { DesktopSecretStore } from "../settings/desktop-secret-store";
import { DesktopSettingsService } from "../settings/desktop-settings-service";

const TOKEN_PREFIX = "pws_local_";
const TOKEN_BYTES = 32;
const TOKEN_SECRET_PREFIX = "localAgentToken:";
const DEFAULT_USAGE_WRITE_INTERVAL_MS = 60_000;

export type LocalAgentPairingResult = {
  grant: LocalAgentClientGrant;
  token: string;
};

export type LocalAgentAuthResult =
  | { ok: true; grant: LocalAgentClientGrant; context: NonNullable<CommandContext["localAgent"]> }
  | { ok: false; code: "missing_token" | "invalid_token" | "revoked" | "missing_capability" };

export type LocalAgentGrantServiceConfig = {
  settings: DesktopSettingsService;
  secrets: DesktopSecretStore;
  now?: () => Date;
  makeId?: () => string;
  makeToken?: () => string;
  usageWriteIntervalMs?: number;
  onSettingsChanged?: (settings: Settings) => void | Promise<void>;
};

type LocalAgentGrantPatchInput = Omit<LocalAgentClientGrantPatch, "capabilities"> & {
  capabilities?: readonly unknown[];
};

export class LocalAgentGrantService {
  private readonly settings: DesktopSettingsService;
  private readonly secrets: DesktopSecretStore;
  private readonly now: () => Date;
  private readonly makeId: () => string;
  private readonly makeToken: () => string;
  private readonly usageWriteIntervalMs: number;
  private readonly onSettingsChanged: ((settings: Settings) => void | Promise<void>) | undefined;
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(config: LocalAgentGrantServiceConfig) {
    this.settings = config.settings;
    this.secrets = config.secrets;
    this.now = config.now ?? (() => new Date());
    this.makeId = config.makeId ?? (() => `lag_${randomBytes(12).toString("hex")}`);
    this.makeToken = config.makeToken ?? (() => `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString("base64url")}`);
    this.usageWriteIntervalMs =
      config.usageWriteIntervalMs ?? DEFAULT_USAGE_WRITE_INTERVAL_MS;
    this.onSettingsChanged = config.onSettingsChanged;
  }

  async list(): Promise<LocalAgentClientGrant[]> {
    const settings = await this.settings.read();
    return settings.localAgents.grants;
  }

  async createGrant(args: {
    name: string;
    capabilities: readonly LocalAgentCapability[];
  }): Promise<LocalAgentPairingResult> {
    const name = normalizeName(args.name);
    const capabilities = normalizeCapabilities(args.capabilities);
    if (name.length === 0) {
      throw new LocalAgentGrantError("invalid_name", "local agent name is required");
    }
    if (capabilities.length === 0) {
      throw new LocalAgentGrantError("invalid_capabilities", "at least one capability is required");
    }

    const now = this.now().toISOString();
    const id = this.makeId();
    const token = this.makeToken();
    const grant: LocalAgentClientGrant = {
      id,
      name,
      capabilities,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
      revokedAt: null
    };
    return this.serializeMutation(async () => {
      const settings = await this.settings.read();
      if (settings.localAgents.grants.some((existing) => existing.id === id)) {
        throw new LocalAgentGrantError("duplicate_id", `local agent grant already exists: ${id}`);
      }
      await this.secrets.replace(secretNameForClient(id), hashToken(token));
      let nextSettings: Settings;
      try {
        nextSettings = await this.settings.write({
          localAgents: {
            grants: [...settings.localAgents.grants, grant]
          }
        });
      } catch (cause) {
        await this.secrets.clear(secretNameForClient(id)).catch(() => undefined);
        throw cause;
      }
      await this.notifySettingsChanged(nextSettings);
      return { grant, token };
    });
  }

  async updateGrant(id: string, patch: LocalAgentGrantPatchInput): Promise<LocalAgentClientGrant> {
    return this.serializeMutation(async () => {
      const { grant, settings } = await this.updateGrantNow(id, patch);
      await this.notifySettingsChanged(settings);
      return grant;
    });
  }

  async revokeGrant(id: string): Promise<LocalAgentClientGrant> {
    return this.serializeMutation(async () => {
      const revokedAt = this.now().toISOString();
      const { grant, settings } = await this.updateGrantNow(id, { revokedAt });
      await this.secrets.clear(secretNameForClient(id));
      await this.notifySettingsChanged(settings);
      return grant;
    });
  }

  async recordUsage(clientId: string): Promise<void> {
    await this.serializeMutation(async () => {
      const settings = await this.settings.read();
      const existing = settings.localAgents.grants.find(
        (grant) => grant.id === clientId
      );
      if (existing === undefined || existing.revokedAt !== null) return;
      const now = this.now();
      const lastUsedMs =
        existing.lastUsedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(existing.lastUsedAt);
      if (
        Number.isFinite(lastUsedMs) &&
        now.getTime() - lastUsedMs < this.usageWriteIntervalMs
      ) {
        return;
      }
      const { settings: nextSettings } = await this.updateGrantNow(clientId, {
        lastUsedAt: now.toISOString()
      });
      await this.notifySettingsChanged(nextSettings);
    });
  }

  private async updateGrantNow(
    id: string,
    patch: LocalAgentGrantPatchInput
  ): Promise<{ grant: LocalAgentClientGrant; settings: Settings }> {
    const settings = await this.settings.read();
    const existing = settings.localAgents.grants.find((grant) => grant.id === id);
    if (existing === undefined) {
      throw new LocalAgentGrantError("not_found", `local agent grant not found: ${id}`);
    }
    const now = this.now().toISOString();
    const next: LocalAgentClientGrant = {
      ...existing,
      ...(patch.name !== undefined ? { name: normalizeName(patch.name) } : {}),
      ...(patch.capabilities !== undefined
        ? { capabilities: normalizeCapabilitiesStrict(patch.capabilities) }
        : {}),
      ...(patch.lastUsedAt !== undefined ? { lastUsedAt: normalizeNullableTimestamp(patch.lastUsedAt) } : {}),
      ...(patch.revokedAt !== undefined ? { revokedAt: normalizeNullableTimestamp(patch.revokedAt) } : {}),
      updatedAt: now
    };
    if (next.name.length === 0) {
      throw new LocalAgentGrantError("invalid_name", "local agent name is required");
    }
    if (next.capabilities.length === 0) {
      throw new LocalAgentGrantError("invalid_capabilities", "at least one capability is required");
    }
    const grants = settings.localAgents.grants.map((grant) => grant.id === id ? next : grant);
    const nextSettings = await this.settings.write({ localAgents: { grants } });
    return { grant: next, settings: nextSettings };
  }

  async authenticate(args: {
    clientId: string;
    token: string | null | undefined;
    requiredCapabilities?: readonly LocalAgentCapability[];
  }): Promise<LocalAgentAuthResult> {
    if (args.token === null || args.token === undefined || args.token.length === 0) {
      return { ok: false, code: "missing_token" };
    }
    const settings = await this.settings.read();
    const grant = settings.localAgents.grants.find((item) => item.id === args.clientId);
    if (grant === undefined) return { ok: false, code: "invalid_token" };
    if (grant.revokedAt !== null) return { ok: false, code: "revoked" };
    const storedHash = await this.secrets.getValue(secretNameForClient(args.clientId));
    if (storedHash === null || !tokenHashMatches(args.token, storedHash)) {
      return { ok: false, code: "invalid_token" };
    }
    const required = args.requiredCapabilities ?? [];
    if (!hasCapabilities(grant, required)) return { ok: false, code: "missing_capability" };
    return {
      ok: true,
      grant,
      context: {
        clientId: grant.id,
        capabilities: grant.capabilities
      }
    };
  }

  private async notifySettingsChanged(settings: Settings): Promise<void> {
    await this.onSettingsChanged?.(settings);
  }

  private serializeMutation<T>(task: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.catch(() => undefined).then(task);
    this.mutationQueue = run;
    return run;
  }
}

export class LocalAgentGrantError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LocalAgentGrantError";
    this.code = code;
  }
}

export function hasCapabilities(
  grant: Pick<LocalAgentClientGrant, "capabilities">,
  required: readonly LocalAgentCapability[]
): boolean {
  const held = new Set(grant.capabilities);
  return required.every((capability) => held.has(capability));
}

export function secretNameForClient(clientId: string): `localAgentToken:${string}` {
  return `${TOKEN_SECRET_PREFIX}${clientId}`;
}

function normalizeName(value: string): string {
  return value.trim().slice(0, 200);
}

function normalizeCapabilities(
  values: readonly LocalAgentCapability[]
): LocalAgentCapability[] {
  const seen = new Set<LocalAgentCapability>();
  for (const value of values) {
    if (!isLocalAgentCapability(value)) continue;
    seen.add(value);
  }
  return [...seen];
}

function normalizeCapabilitiesStrict(values: readonly unknown[]): LocalAgentCapability[] {
  const seen = new Set<LocalAgentCapability>();
  for (const value of values) {
    if (!isLocalAgentCapability(value)) {
      throw new LocalAgentGrantError(
        "invalid_capability",
        `unknown local-agent capability: ${String(value)}`
      );
    }
    seen.add(value);
  }
  return [...seen];
}

function normalizeNullableTimestamp(value: string | null): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0) {
    throw new LocalAgentGrantError("invalid_timestamp", "timestamp must be an ISO string or null");
  }
  return value;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function tokenHashMatches(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashToken(token), "utf8");
  const expected = Buffer.from(expectedHash, "utf8");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function localAgentContextFromGrant(
  grant: LocalAgentClientGrant
): NonNullable<CommandContext["localAgent"]> {
  return {
    clientId: grant.id,
    capabilities: grant.capabilities
  };
}

export function localAgentGrantsFromSettings(settings: Settings): LocalAgentClientGrant[] {
  return settings.localAgents.grants;
}
