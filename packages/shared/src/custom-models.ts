import { z } from "zod";

// Direct API configuration. A CONNECTION is one endpoint — base URL,
// protocol and sign-in — and owns at most one credential. MODELS hang under
// it and share that credential. Public configuration only: credentials live
// exclusively in DesktopSecretStore, keyed by connection id.

export const customModelIdSchema = z.string().uuid();
export const apiUrlSchema = z.url().max(2048).refine((value) =>
  /^(?:https:\/\/[^/?#@]+|http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?)(?:\/[^?#]*)?$/.test(value),
  "Use HTTPS, or HTTP on loopback, without credentials, query, or fragment.");

export const customOAuthSchema = z.object({
  authorizationUrl: apiUrlSchema,
  tokenUrl: apiUrlSchema,
  revocationUrl: apiUrlSchema.optional(),
  clientId: z.string().trim().min(1).max(256),
  scopes: z.string().max(1024),
  /** Register http://127.0.0.1:<port>/oauth/callback. 0 requests an ephemeral port. */
  callbackPort: z.number().int().min(0).max(65535),
  resource: apiUrlSchema.optional()
}).strict();

export const customProtocolSchema = z.enum(["openai-responses", "openai-chat", "anthropic-messages"]);
export const customAuthSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }).strict(),
  z.object({ type: z.literal("api-key") }).strict(),
  z.object({ type: z.literal("oauth"), oauth: customOAuthSchema }).strict()
]);

export const customConnectionSchema = z.object({
  id: customModelIdSchema,
  name: z.string().trim().min(1).max(120),
  baseUrl: apiUrlSchema,
  protocol: customProtocolSchema,
  auth: customAuthSchema
}).strict();

const modelIdTextSchema = z.string().trim().min(1).max(200).regex(/^[^\x00-\x1f\x7f]+$/);
export const customModelSchema = z.object({
  id: customModelIdSchema,
  connectionId: customModelIdSchema,
  displayName: z.string().trim().min(1).max(120),
  modelId: modelIdTextSchema,
  capabilities: z.object({
    /** `null` = not known. Only an explicit `true` sends images; nothing
     *  infers it from a model name or endpoint. */
    vision: z.boolean().nullable(),
    streaming: z.boolean()
  }).strict(),
  maxOutputTokens: z.number().int().min(1).max(131072)
}).strict();

export const MAX_CUSTOM_CONNECTIONS = 50;
export const MAX_CUSTOM_MODELS = 100;
export const DEFAULT_CUSTOM_MAX_OUTPUT_TOKENS = 4096;

/** A connection as the editor submits it; main assigns a new connection's id. */
export const customConnectionInputSchema = customConnectionSchema.extend({ id: customModelIdSchema.optional() }).strict();
/** One model as the editor submits it; main assigns a new model's id and its connection. */
export const customModelInputSchema = customModelSchema.omit({ connectionId: true })
  .extend({ id: customModelIdSchema.optional() }).strict();

export type CustomProtocol = z.infer<typeof customProtocolSchema>;
export type CustomAuth = z.infer<typeof customAuthSchema>;
export type CustomConnection = z.infer<typeof customConnectionSchema>;
export type CustomConnectionInput = z.infer<typeof customConnectionInputSchema>;
export type CustomModel = z.infer<typeof customModelSchema>;
export type CustomModelInput = z.infer<typeof customModelInputSchema>;
export type CustomOAuth = z.infer<typeof customOAuthSchema>;
/** A saved model joined with its connection: everything one request needs. */
export type ResolvedCustomModel = CustomModel & Pick<CustomConnection, "baseUrl" | "protocol" | "auth">;
/** What an endpoint listed. `vision` is per model and `null` unless that row said. */
export type CustomModelDiscovery = { models: { id: string; vision: boolean | null }[] };

export function customProviderId(id: string): string { return `custom:${id}`; }
export function isCustomProvider(provider: string | undefined | null): boolean {
  return typeof provider === "string" && provider.startsWith("custom:");
}
export function customCredentialSecretName(connectionId: string): `customModelCredential:${string}` {
  return `customModelCredential:${connectionId}`;
}
export function resolveCustomModel(
  connections: readonly CustomConnection[] | undefined,
  models: readonly CustomModel[] | undefined,
  id: string
): ResolvedCustomModel | null {
  const model = models?.find((m) => m.id === id);
  const connection = model && connections?.find((c) => c.id === model.connectionId);
  if (!model || !connection) return null;
  return { ...model, baseUrl: connection.baseUrl, protocol: connection.protocol, auth: connection.auth };
}

/** The path each protocol POSTs to, relative to the base URL. */
export function customProtocolPath(protocol: CustomProtocol): string {
  return protocol === "openai-responses" ? "responses" : protocol === "openai-chat" ? "chat/completions" : "messages";
}
/** Loopback endpoints are the only ones allowed plain HTTP, and read "this Mac". */
export function isLoopbackApiUrl(url: string): boolean {
  return /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?(?:[/?#]|$)/i.test(url);
}
/** `host[:port]` of an API URL, for labels. */
export function apiUrlHost(url: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url)?.[1]?.toLowerCase() ?? "";
}

// ---- On-disk parse --------------------------------------------------------
// Tolerant by entry: one bad connection or model is dropped rather than
// failing the whole settings file (which would quarantine every setting).

/** The first cut of this feature stored one flat entry per model, carrying
 *  its own endpoint and a `credentialId`. Read so a file written by it keeps
 *  its models, and its keys: a keyed connection takes the credential id as its
 *  own, so the stored secret stays attached. */
const legacyFlatModelSchema = z.object({
  id: customModelIdSchema,
  displayName: z.string().trim().min(1).max(120),
  modelId: modelIdTextSchema,
  baseUrl: apiUrlSchema,
  protocol: customProtocolSchema,
  auth: z.discriminatedUnion("type", [
    z.object({ type: z.literal("none") }).strict(),
    z.object({ type: z.literal("api-key"), credentialId: customModelIdSchema }).strict(),
    z.object({ type: z.literal("oauth"), credentialId: customModelIdSchema, oauth: customOAuthSchema }).strict()
  ]),
  capabilities: z.object({ vision: z.boolean(), streaming: z.boolean() }).strict(),
  maxOutputTokens: z.number().int().min(1).max(131072)
}).strict();

function hostLabel(url: string): string {
  return apiUrlHost(url).slice(0, 120) || "Connection";
}

export function parseCustomAi(rawConnections: unknown, rawModels: unknown): {
  customConnections: CustomConnection[]; customModels: CustomModel[];
} {
  const connections: CustomConnection[] = [];
  const ids = new Set<string>();
  for (const raw of Array.isArray(rawConnections) ? rawConnections : []) {
    const parsed = customConnectionSchema.safeParse(raw);
    if (!parsed.success || ids.has(parsed.data.id) || connections.length >= MAX_CUSTOM_CONNECTIONS) continue;
    connections.push(parsed.data); ids.add(parsed.data.id);
  }
  const models: CustomModel[] = [];
  const modelIds = new Set<string>();
  const keep = (model: CustomModel): void => {
    if (modelIds.has(model.id) || !ids.has(model.connectionId) || models.length >= MAX_CUSTOM_MODELS) return;
    models.push(model); modelIds.add(model.id);
  };
  // Legacy loopback entries with no credential group by endpoint.
  const legacyNone = new Map<string, string>();
  for (const raw of Array.isArray(rawModels) ? rawModels : []) {
    const current = customModelSchema.safeParse(raw);
    if (current.success) { keep(current.data); continue; }
    const legacy = legacyFlatModelSchema.safeParse(raw);
    if (!legacy.success) continue;
    const m = legacy.data;
    let connectionId: string;
    if (m.auth.type === "none") {
      const key = JSON.stringify([m.baseUrl, m.protocol]);
      connectionId = legacyNone.get(key) ?? m.id;
      legacyNone.set(key, connectionId);
    } else {
      connectionId = m.auth.credentialId;
    }
    if (!ids.has(connectionId)) {
      if (connections.length >= MAX_CUSTOM_CONNECTIONS) continue;
      const auth: CustomAuth = m.auth.type === "none" ? { type: "none" }
        : m.auth.type === "api-key" ? { type: "api-key" } : { type: "oauth", oauth: m.auth.oauth };
      connections.push({ id: connectionId, name: hostLabel(m.baseUrl), baseUrl: m.baseUrl, protocol: m.protocol, auth });
      ids.add(connectionId);
    }
    keep({ id: m.id, connectionId, displayName: m.displayName, modelId: m.modelId,
      capabilities: m.capabilities, maxOutputTokens: m.maxOutputTokens });
  }
  return { customConnections: connections, customModels: models };
}
