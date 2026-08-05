import { randomBytes } from "node:crypto";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { redirectUriMatches } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import {
  InvalidGrantError,
  InvalidRequestError,
  InvalidTargetError,
  InvalidTokenError
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  AuthorizationParams,
  OAuthServerProvider
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type {
  LocalAgentCapability,
  LocalAgentOAuthClient
} from "@pwrsnap/shared";
import {
  LOCAL_AGENT_CAPABILITIES,
  isLocalAgentCapability
} from "@pwrsnap/shared";
import type { LocalAgentGrantService } from "./local-agent-grants";

const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1_000;
const CONSENT_TRANSACTION_TTL_MS = 5 * 60 * 1_000;
const MAX_PENDING_CODES = 64;
const MAX_PENDING_CONSENTS = 64;
const MAX_PENDING_CLIENTS = 64;
const DEFAULT_CAPABILITIES: readonly LocalAgentCapability[] = [
  "library.read",
  "capture.composite.read"
];

type OAuthGrantService = Pick<
  LocalAgentGrantService,
  "authenticate" | "issueOAuthGrant" | "list" | "revokeGrant"
>;

type AuthorizationCodeRecord = {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  sessionName: string;
  roleId: string | null;
  capabilities: LocalAgentCapability[];
  maxCaptureAgeDays?: number | null;
  expiresAtMs: number;
};

type ConsentTransactionRecord = {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  requestedCapabilities: LocalAgentCapability[];
  expiresAtMs: number;
};

export type LocalAgentAuthorizationGrant = {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  sessionName: string;
  roleId?: string | null;
  capabilities: readonly LocalAgentCapability[];
  maxCaptureAgeDays?: number | null;
};

export type LocalAgentAuthorizationResult =
  | {
      kind: "consent";
      client: OAuthClientInformationFull;
      params: AuthorizationParams;
      requestedCapabilities: readonly LocalAgentCapability[];
      transactionId: string;
    }
  | { kind: "redirect"; url: string }
  | { kind: "error"; status: number; error: string; description: string };

export const LOCAL_AGENT_CAPABILITY_LABELS: Record<LocalAgentCapability, string> = {
  "library.read": "Search library metadata",
  "capture.composite.read": "Read edited images",
  "capture.original.read": "Read original images",
  "capture.export": "Export and convert images",
  "capture.edit": "Edit images with AI",
  "trash.write": "Move captures to Trash",
  "sizzle.compose": "Create sizzle reels",
  "sizzle.preview.read":
    "Render low-resolution reel previews (may use billable TTS/network access, write cache files, and update project state)",
  "sizzle.full.read":
    "Render full-resolution reels (may use billable TTS/network access, write to Videos, and update project state)"
};

export const LOCAL_AGENT_CAPABILITY_DETAILS: Record<LocalAgentCapability, string> = {
  "library.read":
    "Reads capture titles, OCR snippets, tags, and other searchable metadata.",
  "capture.composite.read":
    "Reads images as currently shown, including visible edits and redactions.",
  "capture.original.read":
    "Reads source pixels and may reveal content hidden by crops or redactions.",
  "capture.export":
    "Creates downloadable image or PDF derivatives from permitted source images.",
  "capture.edit":
    "Changes captures by sending edit instructions through PwrSnap-owned AI threads.",
  "trash.write":
    "Moves captures out of the library and into recoverable PwrSnap Trash.",
  "sizzle.compose":
    "Creates and changes reel projects through PwrSnap-owned AI threads.",
  "sizzle.preview.read": "Reads low-resolution rendered reel media.",
  "sizzle.full.read": "Reads full-resolution rendered reel media."
};

class LocalAgentOAuthClientsStore implements OAuthRegisteredClientsStore {
  private readonly grantService: OAuthGrantService;
  private readonly now: () => Date;
  private readonly makeClientId: () => string;
  private readonly pending = new Map<string, OAuthClientInformationFull>();

  constructor(options: {
    grantService: OAuthGrantService;
    now: () => Date;
    makeClientId: () => string;
  }) {
    this.grantService = options.grantService;
    this.now = options.now;
    this.makeClientId = options.makeClientId;
  }

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const pending = this.pending.get(clientId);
    if (pending !== undefined) return pending;
    const grant = (await this.grantService.list()).find(
      (item) => item.oauthClient?.clientId === clientId
    );
    return grant?.oauthClient === undefined
      ? undefined
      : oauthClientFromStored(grant.oauthClient);
  }

  async registerClient(
    client: Parameters<
      NonNullable<OAuthRegisteredClientsStore["registerClient"]>
    >[0]
  ): Promise<OAuthClientInformationFull> {
    const registered: OAuthClientInformationFull = {
      ...client,
      client_id: this.makeClientId(),
      client_id_issued_at: Math.floor(this.now().getTime() / 1_000),
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"]
    };
    delete registered.client_secret;
    delete registered.client_secret_expires_at;
    if (this.pending.size >= MAX_PENDING_CLIENTS) {
      const oldest = this.pending.keys().next().value as string | undefined;
      if (oldest !== undefined) this.pending.delete(oldest);
    }
    this.pending.set(registered.client_id, registered);
    return registered;
  }
}

export class LocalAgentOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  private readonly grantService: OAuthGrantService;
  private readonly resourceUrl: URL;
  private readonly now: () => Date;
  private readonly makeCode: () => string;
  private readonly makeConsentId: () => string;
  private readonly codes = new Map<string, AuthorizationCodeRecord>();
  private readonly consents = new Map<string, ConsentTransactionRecord>();

  constructor(options: {
    grantService: OAuthGrantService;
    resourceUrl: URL;
    now?: () => Date;
    makeClientId?: () => string;
    makeCode?: () => string;
    makeConsentId?: () => string;
  }) {
    this.grantService = options.grantService;
    this.resourceUrl = new URL(options.resourceUrl.href);
    this.now = options.now ?? (() => new Date());
    this.makeCode = options.makeCode ?? (() => randomBytes(32).toString("base64url"));
    this.makeConsentId =
      options.makeConsentId ?? (() => randomBytes(32).toString("base64url"));
    this.clientsStore = new LocalAgentOAuthClientsStore({
      grantService: this.grantService,
      now: this.now,
      makeClientId:
        options.makeClientId ?? (() => `lag_${randomBytes(16).toString("hex")}`)
    });
  }

  async authorize(
    _client: Parameters<OAuthServerProvider["authorize"]>[0],
    _params: Parameters<OAuthServerProvider["authorize"]>[1],
    _response: Parameters<OAuthServerProvider["authorize"]>[2]
  ): Promise<void> {
    throw new InvalidRequestError("PwrSnap authorization requires the consent page");
  }

  async handleAuthorizationRequest(url: URL): Promise<LocalAgentAuthorizationResult> {
    const clientId = url.searchParams.get("client_id") ?? "";
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    if (clientId.length === 0 || redirectUri.length === 0 || !URL.canParse(redirectUri)) {
      return oauthError(400, "invalid_request", "client_id and redirect_uri are required");
    }
    const client = await this.clientsStore.getClient(clientId);
    if (client === undefined) {
      return oauthError(400, "invalid_client", "The requesting MCP client is not registered");
    }
    if (!client.redirect_uris.some((registered) => redirectUriMatches(redirectUri, registered))) {
      return oauthError(400, "invalid_request", "redirect_uri is not registered for this client");
    }
    const responseType = url.searchParams.get("response_type");
    const codeChallenge = url.searchParams.get("code_challenge") ?? "";
    const codeChallengeMethod = url.searchParams.get("code_challenge_method");
    const resourceValue = url.searchParams.get("resource");
    if (
      responseType !== "code" ||
      codeChallenge.length === 0 ||
      codeChallengeMethod !== "S256" ||
      resourceValue === null ||
      !URL.canParse(resourceValue)
    ) {
      return oauthRedirectError(
        redirectUri,
        url.searchParams.get("state"),
        "invalid_request",
        "PwrSnap requires an authorization code flow with PKCE and a resource"
      );
    }
    const resource = new URL(resourceValue);
    if (resource.href !== this.resourceUrl.href) {
      return oauthRedirectError(
        redirectUri,
        url.searchParams.get("state"),
        "invalid_target",
        `resource must be ${this.resourceUrl.href}`
      );
    }
    const scope = url.searchParams.get("scope");
    const requested = scope === null || scope.trim().length === 0
      ? [...DEFAULT_CAPABILITIES]
      : [...new Set(scope.split(/\s+/u))];
    if (!requested.every(isLocalAgentCapability)) {
      return oauthRedirectError(
        redirectUri,
        url.searchParams.get("state"),
        "invalid_scope",
        "The request contains an unknown PwrSnap permission"
      );
    }
    const params: AuthorizationParams = {
      codeChallenge,
      redirectUri,
      resource,
      scopes: requested as LocalAgentCapability[]
    };
    const state = url.searchParams.get("state");
    if (state !== null) params.state = state;
    if (
      url.searchParams.has("pwrsnap_decision") ||
      url.searchParams.has("capability") ||
      url.searchParams.has("consent_transaction")
    ) {
      return oauthError(
        400,
        "invalid_request",
        "Consent decisions require a server-issued browser transaction"
      );
    }
    const requestedCapabilities = requested as LocalAgentCapability[];
    const transactionId = this.createConsentTransaction({
      client,
      params,
      requestedCapabilities
    });
    return {
      kind: "consent",
      client,
      params,
      requestedCapabilities,
      transactionId
    };
  }

  handleConsentDecision(input: {
    transactionId: string;
    decision: string;
    sessionName: string;
    roleId: string | null;
    capabilities: readonly string[];
    maxCaptureAgeDays?: number | null;
  }): LocalAgentAuthorizationResult {
    this.pruneConsents();
    const transaction = this.consents.get(input.transactionId);
    if (transaction === undefined) {
      return oauthError(
        400,
        "invalid_request",
        "Consent transaction is invalid, expired, or already used"
      );
    }
    this.consents.delete(input.transactionId);
    const state = transaction.params.state ?? null;
    if (input.decision === "deny") {
      return oauthRedirectError(
        transaction.params.redirectUri,
        state,
        "access_denied",
        "The user denied access to PwrSnap"
      );
    }
    if (input.decision !== "allow") {
      return oauthError(400, "invalid_request", "Consent decision is invalid");
    }
    const sessionName = input.sessionName.trim();
    if (sessionName.length === 0 || sessionName.length > 200) {
      return oauthError(400, "invalid_request", "Session Name must be between 1 and 200 characters");
    }
    const selected = [...new Set(input.capabilities)];
    if (!selected.every(isLocalAgentCapability)) {
      return oauthError(400, "invalid_scope", "An unknown PwrSnap permission was selected");
    }
    const capabilities = selected as LocalAgentCapability[];
    if (capabilities.length === 0) {
      return oauthError(400, "invalid_scope", "Select at least one PwrSnap permission");
    }
    if (
      capabilities.some(
        (capability) => !transaction.requestedCapabilities.includes(capability)
      )
    ) {
      return oauthError(
        400,
        "invalid_scope",
        "Approval cannot grant permissions the MCP client did not request"
      );
    }
    if (
      input.roleId === null &&
      !isValidCaptureAge(input.maxCaptureAgeDays)
    ) {
      return oauthError(
        400,
        "invalid_request",
        "Custom access requires a valid capture-history limit"
      );
    }
    const code = this.createAuthorizationCode({
      client: transaction.client,
      params: transaction.params,
      sessionName,
      roleId: input.roleId,
      capabilities,
      ...(input.roleId === null
        ? { maxCaptureAgeDays: input.maxCaptureAgeDays }
        : {})
    });
    const callback = new URL(transaction.params.redirectUri);
    callback.searchParams.set("code", code);
    if (state !== null) callback.searchParams.set("state", state);
    return { kind: "redirect", url: callback.href };
  }

  private createConsentTransaction(input: {
    client: OAuthClientInformationFull;
    params: AuthorizationParams;
    requestedCapabilities: LocalAgentCapability[];
  }): string {
    this.pruneConsents();
    if (this.consents.size >= MAX_PENDING_CONSENTS) {
      const oldest = this.consents.keys().next().value as string | undefined;
      if (oldest !== undefined) this.consents.delete(oldest);
    }
    const transactionId = this.makeConsentId();
    this.consents.set(transactionId, {
      client: input.client,
      params: input.params,
      requestedCapabilities: [...input.requestedCapabilities],
      expiresAtMs: this.now().getTime() + CONSENT_TRANSACTION_TTL_MS
    });
    return transactionId;
  }

  createAuthorizationCode(grant: LocalAgentAuthorizationGrant): string {
    this.validateResource(grant.params.resource);
    this.pruneCodes();
    if (this.codes.size >= MAX_PENDING_CODES) {
      const oldest = this.codes.keys().next().value as string | undefined;
      if (oldest !== undefined) this.codes.delete(oldest);
    }
    const code = this.makeCode();
    this.codes.set(code, {
      client: grant.client,
      params: grant.params,
      sessionName: grant.sessionName,
      roleId: grant.roleId ?? null,
      capabilities: [...grant.capabilities],
      ...(grant.maxCaptureAgeDays !== undefined
        ? { maxCaptureAgeDays: grant.maxCaptureAgeDays }
        : {}),
      expiresAtMs: this.now().getTime() + AUTHORIZATION_CODE_TTL_MS
    });
    return code;
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const record = this.requireCode(client, authorizationCode);
    return record.params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    const record = this.requireCode(client, authorizationCode);
    if (redirectUri !== record.params.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    this.validateResource(resource);
    if (record.params.resource?.href !== resource?.href) {
      throw new InvalidTargetError("resource does not match the authorization request");
    }
    this.codes.delete(authorizationCode);
    const issued = await this.grantService.issueOAuthGrant({
      name: record.sessionName,
      capabilities: record.capabilities,
      roleId: record.roleId,
      ...(record.maxCaptureAgeDays !== undefined
        ? { maxCaptureAgeDays: record.maxCaptureAgeDays }
        : {}),
      oauthClient: oauthClientToStored(client, this.now())
    });
    return {
      access_token: `${issued.grant.id}:${issued.token}`,
      token_type: "bearer",
      scope: issued.grant.capabilities.join(" ")
    };
  }

  async exchangeRefreshToken(
    _client: OAuthClientInformationFull,
    _refreshToken: string,
    _scopes?: string[],
    _resource?: URL
  ): Promise<OAuthTokens> {
    throw new InvalidGrantError("PwrSnap access tokens do not expire or refresh");
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const [clientId, credential] = splitAccessToken(token);
    if (clientId === null || credential === null) {
      throw new InvalidTokenError("invalid PwrSnap access token");
    }
    const auth = await this.grantService.authenticate({ clientId, token: credential });
    if (!auth.ok) throw new InvalidTokenError("invalid or revoked PwrSnap access token");
    return {
      token,
      clientId: auth.grant.id,
      scopes: [...auth.context.capabilities],
      resource: new URL(this.resourceUrl.href),
      extra: {
        capabilities: [...auth.context.capabilities]
      }
    };
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest
  ): Promise<void> {
    const [clientId] = splitAccessToken(request.token);
    if (clientId === null) return;
    const grant = (await this.grantService.list()).find((item) => item.id === clientId);
    if (
      grant === undefined ||
      grant.revokedAt !== null ||
      grant.oauthClient?.clientId !== client.client_id
    ) return;
    await this.grantService.revokeGrant(clientId);
  }

  private requireCode(
    client: OAuthClientInformationFull,
    authorizationCode: string
  ): AuthorizationCodeRecord {
    this.pruneCodes();
    const record = this.codes.get(authorizationCode);
    if (record === undefined || record.client.client_id !== client.client_id) {
      throw new InvalidGrantError("invalid or expired authorization code");
    }
    return record;
  }

  private validateResource(resource: URL | undefined): void {
    if (resource === undefined || resource.href !== this.resourceUrl.href) {
      throw new InvalidTargetError(`resource must be ${this.resourceUrl.href}`);
    }
  }

  private pruneCodes(): void {
    const now = this.now().getTime();
    for (const [code, record] of this.codes) {
      if (record.expiresAtMs <= now) this.codes.delete(code);
    }
  }

  private pruneConsents(): void {
    const now = this.now().getTime();
    for (const [transactionId, record] of this.consents) {
      if (record.expiresAtMs <= now) this.consents.delete(transactionId);
    }
  }
}

function isValidCaptureAge(value: unknown): value is number | null {
  return value === null || (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 36_500
  );
}

function oauthClientToStored(
  client: OAuthClientInformationFull,
  now: Date
): LocalAgentOAuthClient {
  return {
    clientId: client.client_id,
    clientName: client.client_name?.trim() || "Local MCP client",
    redirectUris: [...client.redirect_uris],
    clientUri: client.client_uri ?? null,
    scope: client.scope ?? null,
    grantTypes: [...(client.grant_types ?? ["authorization_code"])],
    responseTypes: [...(client.response_types ?? ["code"])],
    softwareId: client.software_id ?? null,
    softwareVersion: client.software_version ?? null,
    registeredAt:
      client.client_id_issued_at !== undefined &&
      Number.isFinite(client.client_id_issued_at)
        ? new Date(client.client_id_issued_at * 1_000).toISOString()
        : now.toISOString()
  };
}

function oauthClientFromStored(
  client: LocalAgentOAuthClient
): OAuthClientInformationFull {
  return {
    client_id: client.clientId,
    client_id_issued_at: Math.floor(Date.parse(client.registeredAt) / 1_000),
    client_name: client.clientName,
    redirect_uris: [...client.redirectUris],
    token_endpoint_auth_method: "none",
    grant_types: [...client.grantTypes],
    response_types: [...client.responseTypes],
    ...(client.clientUri !== null ? { client_uri: client.clientUri } : {}),
    ...(client.scope !== null ? { scope: client.scope } : {}),
    ...(client.softwareId !== null ? { software_id: client.softwareId } : {}),
    ...(client.softwareVersion !== null
      ? { software_version: client.softwareVersion }
      : {})
  };
}

function splitAccessToken(value: string): [string | null, string | null] {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) return [null, null];
  return [value.slice(0, separator), value.slice(separator + 1)];
}

function oauthError(
  status: number,
  error: string,
  description: string
): LocalAgentAuthorizationResult {
  return { kind: "error", status, error, description };
}

function oauthRedirectError(
  redirectUri: string,
  state: string | null,
  error: string,
  description: string
): LocalAgentAuthorizationResult {
  const callback = new URL(redirectUri);
  callback.searchParams.set("error", error);
  callback.searchParams.set("error_description", description);
  if (state !== null) callback.searchParams.set("state", state);
  return { kind: "redirect", url: callback.href };
}
