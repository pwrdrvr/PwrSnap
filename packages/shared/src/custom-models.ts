import { z } from "zod";

/** Public configuration only. Credentials belong exclusively to DesktopSecretStore. */
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

export const customModelSchema = z.object({
  id: customModelIdSchema,
  displayName: z.string().trim().min(1).max(120),
  modelId: z.string().trim().min(1).max(200).regex(/^[^\x00-\x1f\x7f]+$/),
  baseUrl: apiUrlSchema,
  protocol: z.enum(["openai-responses", "openai-chat", "anthropic-messages"]),
  auth: z.discriminatedUnion("type", [
    z.object({ type: z.literal("none") }).strict(),
    z.object({ type: z.literal("api-key"), credentialId: customModelIdSchema }).strict(),
    z.object({ type: z.literal("oauth"), credentialId: customModelIdSchema, oauth: customOAuthSchema }).strict()
  ]),
  capabilities: z.object({
    vision: z.boolean(),
    streaming: z.boolean()
  }).strict(),
  maxOutputTokens: z.number().int().min(1).max(131072)
}).strict();
export const customModelsSchema = z.array(customModelSchema).max(100).refine(
  (models) => new Set(models.map((m) => m.id)).size === models.length, "Duplicate custom model IDs"
);
export type CustomModel = z.infer<typeof customModelSchema>;
export type CustomOAuth = z.infer<typeof customOAuthSchema>;
export type CustomModelDiscovery = { modelIds: string[]; vision: boolean | null };
export type CustomModelStatus = { configured: boolean; sharedBy: number };
export function customProviderId(id: string): string { return `custom:${id}`; }
export function isCustomProvider(provider: string | undefined | null): boolean {
  return typeof provider === "string" && provider.startsWith("custom:");
}
