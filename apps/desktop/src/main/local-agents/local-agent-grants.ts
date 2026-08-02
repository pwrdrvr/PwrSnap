import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  LocalAgentCapability,
  LocalAgentClientGrant,
  LocalAgentClientGrantPatch,
  LocalAgentOAuthClient,
  LocalAgentRoleProfile,
  LocalAgentRoleProfilePatch,
  Settings
} from "@pwrsnap/shared";
import {
  findRoleForCapabilities,
  isLocalAgentCapability,
  isValidRole,
  resolveLocalAgentPolicy,
  type ResolvedLocalAgentPolicy
} from "@pwrsnap/shared";
import type { CommandContext } from "../command-bus";
import { DesktopSecretStore } from "../settings/desktop-secret-store";
import { DesktopSettingsService } from "../settings/desktop-settings-service";

const TOKEN_PREFIX = "pws_local_";
const TOKEN_BYTES = 32;
const TOKEN_SECRET_PREFIX = "localAgentToken:";
const DEFAULT_USAGE_WRITE_INTERVAL_MS = 60_000;

export type LocalAgentCredentialIssueResult = {
  grant: LocalAgentClientGrant;
  token: string;
};

export type LocalAgentAuthResult =
  | { ok: true; grant: LocalAgentClientGrant; context: NonNullable<CommandContext["localAgent"]> }
  | { ok: false; code: "missing_token" | "invalid_token" | "revoked" | "invalid_role" | "missing_capability" };

export type LocalAgentGrantServiceConfig = {
  settings: DesktopSettingsService;
  secrets: DesktopSecretStore;
  now?: () => Date;
  makeId?: () => string;
  makeRoleId?: () => string;
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
  private readonly makeRoleId: () => string;
  private readonly usageWriteIntervalMs: number;
  private readonly onSettingsChanged: ((settings: Settings) => void | Promise<void>) | undefined;
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(config: LocalAgentGrantServiceConfig) {
    this.settings = config.settings;
    this.secrets = config.secrets;
    this.now = config.now ?? (() => new Date());
    this.makeId = config.makeId ?? (() => `lag_${randomBytes(12).toString("hex")}`);
    this.makeRoleId =
      config.makeRoleId ?? (() => `lar_${randomBytes(12).toString("hex")}`);
    this.makeToken = config.makeToken ?? (() => `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString("base64url")}`);
    this.usageWriteIntervalMs =
      config.usageWriteIntervalMs ?? DEFAULT_USAGE_WRITE_INTERVAL_MS;
    this.onSettingsChanged = config.onSettingsChanged;
  }

  async list(): Promise<LocalAgentClientGrant[]> {
    const settings = await this.settings.read();
    return settings.localAgents.grants;
  }

  async listRoles(): Promise<LocalAgentRoleProfile[]> {
    const settings = await this.settings.read();
    return settings.localAgents.roles;
  }

  async createRole(input: {
    name: string;
    description: string;
    permissions: readonly unknown[];
  }): Promise<LocalAgentRoleProfile> {
    return this.serializeMutation(async () => {
      const settings = await this.settings.read();
      const role: LocalAgentRoleProfile = {
        id: this.makeRoleId(),
        name: normalizeName(input.name),
        description: normalizeDescription(input.description),
        builtIn: false,
        permissions: normalizeCapabilitiesStrict(input.permissions)
      };
      this.validateNewRole(settings, role);
      const nextSettings = await this.settings.write({
        localAgents: { roles: [...settings.localAgents.roles, role] }
      });
      await this.notifySettingsChanged(nextSettings);
      return role;
    });
  }

  async updateRole(
    id: string,
    patch: Omit<LocalAgentRoleProfilePatch, "permissions"> & {
      permissions?: readonly unknown[];
    }
  ): Promise<LocalAgentRoleProfile> {
    return this.serializeMutation(async () => {
      const settings = await this.settings.read();
      const existing = settings.localAgents.roles.find((role) => role.id === id);
      if (existing === undefined) {
        throw new LocalAgentGrantError("role_not_found", `local-agent role not found: ${id}`);
      }
      if (existing.builtIn) {
        throw new LocalAgentGrantError("builtin_role_immutable", "built-in roles cannot be edited");
      }
      const role: LocalAgentRoleProfile = {
        ...existing,
        ...(patch.name !== undefined ? { name: normalizeName(patch.name) } : {}),
        ...(patch.description !== undefined
          ? { description: normalizeDescription(patch.description) }
          : {}),
        ...(patch.permissions !== undefined
          ? { permissions: normalizeCapabilitiesStrict(patch.permissions) }
          : {})
      };
      if (!isValidRole(role)) {
        throw new LocalAgentGrantError("invalid_role", "local-agent role is invalid");
      }
      if (settings.localAgents.roles.some(
        (item) =>
          item.id !== id &&
          item.name.localeCompare(role.name, undefined, { sensitivity: "accent" }) === 0
      )) {
        throw new LocalAgentGrantError(
          "duplicate_role_name",
          `local-agent role name already exists: ${role.name}`
        );
      }
      const roles = settings.localAgents.roles.map((item) => item.id === id ? role : item);
      const grants = settings.localAgents.grants.map((grant) =>
        grant.roleId === id
          ? { ...grant, capabilities: [...role.permissions], updatedAt: this.now().toISOString() }
          : grant
      );
      const nextSettings = await this.settings.write({
        localAgents: { roles, grants }
      });
      await this.notifySettingsChanged(nextSettings);
      return role;
    });
  }

  async deleteRole(id: string): Promise<void> {
    await this.serializeMutation(async () => {
      const settings = await this.settings.read();
      const existing = settings.localAgents.roles.find((role) => role.id === id);
      if (existing === undefined) {
        throw new LocalAgentGrantError("role_not_found", `local-agent role not found: ${id}`);
      }
      if (existing.builtIn) {
        throw new LocalAgentGrantError("builtin_role_immutable", "built-in roles cannot be deleted");
      }
      if (settings.localAgents.grants.some((grant) => grant.roleId === id)) {
        throw new LocalAgentGrantError("role_assigned", "assigned roles cannot be deleted");
      }
      const nextSettings = await this.settings.write({
        localAgents: {
          roles: settings.localAgents.roles.filter((role) => role.id !== id)
        }
      });
      await this.notifySettingsChanged(nextSettings);
    });
  }

  async assignRole(sessionId: string, roleId: string): Promise<LocalAgentClientGrant> {
    return this.serializeMutation(async () => {
      const settings = await this.settings.read();
      const role = settings.localAgents.roles.find((item) => item.id === roleId);
      if (role === undefined || !isValidRole(role)) {
        throw new LocalAgentGrantError("role_not_found", `local-agent role not found: ${roleId}`);
      }
      const existing = settings.localAgents.grants.find((grant) => grant.id === sessionId);
      if (existing === undefined) {
        throw new LocalAgentGrantError("not_found", `local agent grant not found: ${sessionId}`);
      }
      const grant: LocalAgentClientGrant = {
        ...existing,
        roleId: role.id,
        capabilities: [...role.permissions],
        updatedAt: this.now().toISOString()
      };
      const nextSettings = await this.settings.write({
        localAgents: {
          grants: settings.localAgents.grants.map((item) =>
            item.id === sessionId ? grant : item
          )
        }
      });
      await this.notifySettingsChanged(nextSettings);
      return grant;
    });
  }

  async createGrant(args: {
    name: string;
    capabilities: readonly LocalAgentCapability[];
  }): Promise<LocalAgentCredentialIssueResult> {
    const name = normalizeName(args.name);
    const capabilities = normalizeCapabilities(args.capabilities);
    if (name.length === 0) {
      throw new LocalAgentGrantError("invalid_name", "local agent name is required");
    }
    if (capabilities.length === 0) {
      throw new LocalAgentGrantError("invalid_capabilities", "at least one capability is required");
    }

    const id = this.makeId();
    const token = this.makeToken();
    return this.serializeMutation(async () => {
      const settings = await this.settings.read();
      if (settings.localAgents.grants.some((existing) => existing.id === id)) {
        throw new LocalAgentGrantError("duplicate_id", `local agent grant already exists: ${id}`);
      }
      const roleState = this.roleForCapabilities(settings, name, capabilities);
      const now = this.now().toISOString();
      const grant: LocalAgentClientGrant = {
        id,
        name,
        roleId: roleState.role.id,
        capabilities: [...roleState.role.permissions],
        createdAt: now,
        updatedAt: now,
        lastUsedAt: null,
        revokedAt: null
      };
      await this.secrets.replace(secretNameForClient(id), hashToken(token));
      let nextSettings: Settings;
      try {
        nextSettings = await this.settings.write({
          localAgents: {
            grants: [...settings.localAgents.grants, grant],
            roles: roleState.roles
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

  /** Issue one independently named and revocable session for a registered
   *  OAuth client. The OAuth registration describes software; the grant is
   *  the user's durable authorization session. */
  async issueOAuthGrant(args: {
    name: string;
    capabilities: readonly LocalAgentCapability[];
    oauthClient: LocalAgentOAuthClient;
  }): Promise<LocalAgentCredentialIssueResult> {
    const name = normalizeName(args.name);
    const capabilities = normalizeCapabilities(args.capabilities);
    if (name.length === 0) {
      throw new LocalAgentGrantError("invalid_name", "local agent name is required");
    }
    if (capabilities.length === 0) {
      throw new LocalAgentGrantError(
        "invalid_capabilities",
        "at least one capability is required"
      );
    }
    const token = this.makeToken();
    return this.serializeMutation(async () => {
      const settings = await this.settings.read();
      if (settings.localAgents.grants.some(
        (grant) => grant.revokedAt === null && grant.name.localeCompare(name, undefined, { sensitivity: "accent" }) === 0
      )) {
        throw new LocalAgentGrantError(
          "duplicate_name",
          `an active local-agent session already uses the name: ${name}`
        );
      }
      const now = this.now().toISOString();
      const roleState = this.roleForCapabilities(settings, name, capabilities);
      const grant: LocalAgentClientGrant = {
        id: this.makeId(),
        name,
        roleId: roleState.role.id,
        capabilities: [...roleState.role.permissions],
        createdAt: now,
        updatedAt: now,
        lastUsedAt: null,
        revokedAt: null,
        oauthClient: args.oauthClient
      };
      if (settings.localAgents.grants.some((item) => item.id === grant.id)) {
        throw new LocalAgentGrantError(
          "duplicate_id",
          `local agent grant already exists: ${grant.id}`
        );
      }
      const secretName = secretNameForClient(grant.id);
      await this.secrets.replace(secretName, hashToken(token));
      let nextSettings: Settings;
      try {
        nextSettings = await this.settings.write({
          localAgents: {
            grants: [...settings.localAgents.grants, grant],
            roles: roleState.roles
          }
        });
      } catch (cause) {
        await this.secrets.clear(secretName).catch(() => undefined);
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
    const nextName =
      patch.name !== undefined ? normalizeName(patch.name) : existing.name;
    const roleState =
      patch.capabilities === undefined
        ? null
        : this.roleForCapabilities(
            settings,
            nextName,
            normalizeCapabilitiesStrict(patch.capabilities)
          );
    const next: LocalAgentClientGrant = {
      ...existing,
      name: nextName,
      ...(roleState !== null
        ? {
            roleId: roleState.role.id,
            capabilities: [...roleState.role.permissions]
          }
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
    if (
      next.revokedAt === null &&
      settings.localAgents.grants.some(
        (grant) =>
          grant.id !== id &&
          grant.revokedAt === null &&
          grant.name.localeCompare(next.name, undefined, { sensitivity: "accent" }) === 0
      )
    ) {
      throw new LocalAgentGrantError(
        "duplicate_name",
        `an active local-agent session already uses the name: ${next.name}`
      );
    }
    const grants = settings.localAgents.grants.map((grant) => grant.id === id ? next : grant);
    const nextSettings = await this.settings.write({
      localAgents: {
        grants,
        ...(roleState !== null ? { roles: roleState.roles } : {})
      }
    });
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
    const resolution = resolveLocalAgentPolicy(settings.localAgents, grant.id);
    if (!resolution.ok) return { ok: false, code: "invalid_role" };
    const required = args.requiredCapabilities ?? [];
    if (!hasCapabilities(resolution.policy, required)) {
      return { ok: false, code: "missing_capability" };
    }
    return {
      ok: true,
      grant,
      context: localAgentContextFromPolicy(resolution.policy)
    };
  }

  async authorizeClient(
    clientId: string,
    requiredCapabilities: readonly LocalAgentCapability[] = []
  ): Promise<NonNullable<CommandContext["localAgent"]> | null> {
    const settings = await this.settings.read();
    const grant = settings.localAgents.grants.find((item) => item.id === clientId);
    if (grant === undefined || grant.revokedAt !== null) return null;
    const resolution = resolveLocalAgentPolicy(settings.localAgents, grant.id);
    if (
      !resolution.ok ||
      !hasCapabilities(resolution.policy, requiredCapabilities)
    ) return null;
    return localAgentContextFromPolicy(resolution.policy);
  }

  private roleForCapabilities(
    settings: Settings,
    sessionName: string,
    capabilities: readonly LocalAgentCapability[]
  ): { role: LocalAgentRoleProfile; roles: LocalAgentRoleProfile[] } {
    const existing = findRoleForCapabilities(
      settings.localAgents.roles,
      capabilities
    );
    if (existing !== undefined) {
      return { role: existing, roles: settings.localAgents.roles };
    }
    const role: LocalAgentRoleProfile = {
      id: this.makeRoleId(),
      name: `${sessionName} Access`.slice(0, 200),
      description: `Custom access profile created for ${sessionName}.`.slice(0, 500),
      builtIn: false,
      permissions: [...capabilities]
    };
    if (settings.localAgents.roles.some((item) => item.id === role.id)) {
      throw new LocalAgentGrantError(
        "duplicate_role_id",
        `local-agent role already exists: ${role.id}`
      );
    }
    return { role, roles: [...settings.localAgents.roles, role] };
  }

  private validateNewRole(settings: Settings, role: LocalAgentRoleProfile): void {
    if (!isValidRole(role)) {
      throw new LocalAgentGrantError("invalid_role", "local-agent role is invalid");
    }
    if (settings.localAgents.roles.some((item) => item.id === role.id)) {
      throw new LocalAgentGrantError("duplicate_role_id", `local-agent role already exists: ${role.id}`);
    }
    if (settings.localAgents.roles.some(
      (item) => item.name.localeCompare(role.name, undefined, { sensitivity: "accent" }) === 0
    )) {
      throw new LocalAgentGrantError("duplicate_role_name", `local-agent role name already exists: ${role.name}`);
    }
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
  grant: { capabilities: readonly LocalAgentCapability[] },
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

function normalizeDescription(value: string): string {
  return value.trim().slice(0, 500);
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

export function localAgentContextFromPolicy(
  policy: ResolvedLocalAgentPolicy
): NonNullable<CommandContext["localAgent"]> {
  return {
    clientId: policy.sessionId,
    sessionName: policy.sessionName,
    roleId: policy.roleId,
    roleName: policy.roleName,
    capabilities: policy.capabilities
  };
}

export function localAgentGrantsFromSettings(settings: Settings): LocalAgentClientGrant[] {
  return settings.localAgents.grants;
}
