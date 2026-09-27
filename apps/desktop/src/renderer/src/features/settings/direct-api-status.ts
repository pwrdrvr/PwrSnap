// One status read per Direct API connection, shared by the Settings
// sidebar's AI Providers children and the hub's Connections card — the same
// "one answer, two renderings" rule `ai-provider-status.ts` keeps for agents.
//
// A connection is one endpoint (base URL, protocol, sign-in) with the models
// saved under it. Its status says only what PwrSnap KNOWS: whether a
// credential is stored and whether any model is saved. It never claims the
// endpoint answers — nothing is probed to draw a sidebar dot.

import {
  apiUrlHost,
  connectionSettingsSub,
  customCredentialSecretName,
  customProtocolPath,
  isLoopbackApiUrl,
  type CustomAuth,
  type CustomConnection,
  type CustomModel,
  type CustomProtocol,
  type DesktopSettingsSecretName,
  type SecretStatus,
  type Settings
} from "@pwrsnap/shared";
import type { AiProviderTone } from "./ai-provider-status";

export type ConnectionStatus = {
  /** `connection:<id>` — this connection's AI Providers screen. */
  sub: string;
  connection: CustomConnection;
  models: readonly CustomModel[];
  label: string;
  tone?: AiProviderTone;
  chip?: string;
  badge: string;
  meta: string;
  /** Whether a credential is stored, or none is needed. `null` = unknown. */
  credentialReady: boolean | null;
};

export const PROTOCOL_LABELS: Readonly<Record<CustomProtocol, string>> = {
  "openai-chat": "Chat Completions",
  "openai-responses": "OpenAI Responses",
  "anthropic-messages": "Anthropic Messages"
};

export function authLabel(auth: CustomAuth["type"]): string {
  return auth === "none" ? "no auth" : auth === "api-key" ? "API key" : "OAuth";
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** The first letter of the name, for the row's monogram tile. */
export function monogram(name: string): string {
  return (/[\p{L}\p{N}]/u.exec(name)?.[0] ?? "?").toUpperCase();
}

/** Where requests go, as a chip: "THIS COMPUTER" for loopback, else the host. */
export function whereLabel(baseUrl: string): { text: string; local: boolean } {
  return isLoopbackApiUrl(baseUrl) ? { text: "THIS COMPUTER", local: true } : { text: apiUrlHost(baseUrl), local: false };
}

/** The exact URL a model request POSTs to. */
export function requestUrl(baseUrl: string, protocol: CustomProtocol): { base: string; path: string } {
  return { base: baseUrl.replace(/\/+$/, ""), path: `/${customProtocolPath(protocol)}` };
}

export function connectionSecret(
  secrets: Readonly<Partial<Record<DesktopSettingsSecretName, SecretStatus>>> | null,
  connectionId: string
): SecretStatus | null {
  if (secrets === null) return null;
  return secrets[customCredentialSecretName(connectionId)] ?? { configured: false, lastSetAt: null };
}

export function describeConnection(
  connection: CustomConnection,
  models: readonly CustomModel[],
  secret: SecretStatus | null
): ConnectionStatus {
  const base = {
    sub: connectionSettingsSub(connection.id),
    connection,
    models,
    label: connection.name,
    meta: `${PROTOCOL_LABELS[connection.protocol]} · ${authLabel(connection.auth.type)} · ${plural(models.length, "model")}`
  };
  const credentialReady = connection.auth.type === "none" ? true : secret === null ? null : secret.configured;
  if (credentialReady === null) return { ...base, credentialReady, badge: "Checking…" };
  if (!credentialReady) {
    return connection.auth.type === "oauth"
      ? { ...base, credentialReady, tone: "warn", chip: "sign in", badge: "Sign in" }
      : { ...base, credentialReady, tone: "warn", chip: "no key", badge: "Add key" };
  }
  if (models.length === 0) {
    return { ...base, credentialReady, tone: "warn", chip: "no models", badge: "Add models" };
  }
  return { ...base, credentialReady, tone: "ok", badge: "Ready" };
}

/** Every saved connection, in the order they were added. */
export function describeConnections(
  settings: Settings | null,
  secrets: Readonly<Partial<Record<DesktopSettingsSecretName, SecretStatus>>> | null
): ConnectionStatus[] {
  const connections = settings?.ai.customConnections ?? [];
  const models = settings?.ai.customModels ?? [];
  return connections.map((c) =>
    describeConnection(c, models.filter((m) => m.connectionId === c.id), connectionSecret(secrets, c.id))
  );
}

/** Starting points for a new connection. A template fills the address,
 *  protocol and sign-in type ONLY — never image input, reasoning or
 *  pricing, which the operator confirms per model. */
export type ConnectionTemplate = {
  id: string;
  name: string;
  protocol: CustomProtocol;
  baseUrl: string;
  auth: "none" | "api-key" | "oauth";
};

export const CONNECTION_TEMPLATES: readonly ConnectionTemplate[] = [
  { id: "anthropic", name: "Anthropic API", protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com/v1", auth: "api-key" },
  { id: "openai", name: "OpenAI API", protocol: "openai-responses", baseUrl: "https://api.openai.com/v1", auth: "api-key" },
  { id: "openrouter", name: "OpenRouter", protocol: "openai-chat", baseUrl: "https://openrouter.ai/api/v1", auth: "api-key" },
  { id: "local", name: "Local server", protocol: "openai-chat", baseUrl: "http://127.0.0.1:8080/v1", auth: "none" },
  { id: "other", name: "Other compatible API", protocol: "openai-chat", baseUrl: "https://", auth: "api-key" },
  { id: "oauth", name: "OAuth endpoint", protocol: "openai-chat", baseUrl: "https://", auth: "oauth" }
];

/** Common local servers' default ports. Chips on a loopback address. */
export const LOCAL_SERVER_PORTS: readonly { label: string; port: number }[] = [
  { label: "llama.cpp", port: 8080 },
  { label: "LM Studio", port: 1234 },
  { label: "Ollama", port: 11434 },
  { label: "vLLM", port: 8000 }
];
