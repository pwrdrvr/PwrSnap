import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { resolveCustomModel, type CustomConnection, type CustomModelInput, type ResolvedCustomModel } from "@pwrsnap/shared";
const storage = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true), getSelectedStorageBackend: vi.fn(() => "keychain"),
  encryptString: vi.fn((s: string) => Buffer.from(`fixture-envelope:${Buffer.from(s).toString("base64")}`)),
  decryptString: vi.fn((b: Buffer) => Buffer.from(b.toString().slice("fixture-envelope:".length), "base64").toString())
}));
vi.mock("electron", () => ({ safeStorage: storage }));
vi.mock("../../../log", () => ({ getMainLogger: () => ({ warn: vi.fn(), info: vi.fn() }) }));
import { DesktopSecretStore } from "../../../settings/desktop-secret-store";
import { DesktopSettingsService, defaultSettings } from "../../../settings/desktop-settings-service";
import { CustomCredentials, credentialBinding, credentialName, endpointOf } from "../credentials";
import { CustomModelService } from "../service";
import { body, connection, json, server } from "./fixtures";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((f) => f())); storage.isEncryptionAvailable.mockReturnValue(true); storage.getSelectedStorageBackend.mockReturnValue("keychain"); });
async function fixture(openBrowser: (url: string) => Promise<void> = async () => undefined): Promise<{
  secrets: DesktopSecretStore; credentials: CustomCredentials; service: CustomModelService; settings: DesktopSettingsService; dir: string
}> {
  const dir = await mkdtemp(join(tmpdir(), "pwrsnap-direct-fixture-")); cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const secrets = new DesktopSecretStore({ filePath: join(dir, "secrets.bin") });
  const settings = new DesktopSettingsService({ filePath: join(dir, "settings.json"), appVersion: "1.1.4" });
  const credentials = new CustomCredentials(secrets, openBrowser);
  return { secrets, credentials, settings, dir, service: new CustomModelService(settings, credentials, async () => undefined, secrets) };
}
function entry(modelId: string, extra: Partial<CustomModelInput> = {}): CustomModelInput {
  return { modelId, displayName: modelId, capabilities: { vision: null, streaming: true }, maxOutputTokens: 100, ...extra };
}
/** A saved connection with one model, resolved the way a request sees it. */
async function saved(f: Awaited<ReturnType<typeof fixture>>, c: CustomConnection, modelId = "fixture/exact-model"): Promise<ResolvedCustomModel> {
  const [m] = await f.service.setModels(c.id, [entry(modelId)]);
  const s = await f.settings.read();
  const resolved = m && resolveCustomModel(s.ai.customConnections, s.ai.customModels, m.id);
  if (!resolved) throw new Error("fixture model missing");
  return resolved;
}
const LOOPBACK = "http://127.0.0.1:18080/v1";

test("persists connections and models, and isolates each connection's encrypted credential", async () => {
  const f = await fixture();
  await f.settings.write({ codex: { profile: "keep-existing" }, ai: { acp: { enabledAgentIds: ["kimi"] } } });
  const [a, b] = await Promise.all([f.service.saveConnection(connection(LOOPBACK)), f.service.saveConnection(connection("http://127.0.0.1:18081/v1"))]);
  if (!a || !b) throw new Error("fixture");
  const ma = await saved(f, a); const mb = await saved(f, b, "second/model");
  await f.service.setKey(a.id, "synthetic-key-one"); await f.service.setKey(b.id, "synthetic-key-two");
  expect(await f.credentials.headers(ma)).toEqual({ Authorization: "Bearer synthetic-key-one" });
  expect(await f.credentials.headers(mb)).toEqual({ Authorization: "Bearer synthetic-key-two" });
  await f.settings.write({ ai: { defaults: { libraryChat: { provider: `custom:${mb.id}`, model: mb.modelId } } } });
  const reloaded = await new DesktopSettingsService({ filePath: join(f.dir, "settings.json"), appVersion: "1.1.4" }).read();
  expect(reloaded.ai.customConnections).toHaveLength(2); expect(reloaded.ai.customModels).toHaveLength(2);
  expect(reloaded.ai.defaults.libraryChat.provider).toBe(`custom:${mb.id}`);
  expect(reloaded.codex.profile).toBe("keep-existing"); expect(reloaded.ai.acp.enabledAgentIds).toContain("kimi");
  for (const path of ["settings.json", "secrets.bin"]) expect(await readFile(join(f.dir, path), "utf8")).not.toContain("synthetic-key");
  // The broadcast status carries each connection's credential, from the index alone.
  expect((await f.secrets.getAllStatus())[credentialName(a.id)]?.configured).toBe(true);
  await f.service.removeConnection(a.id);
  expect(await f.credentials.headers(mb)).toEqual({ Authorization: "Bearer synthetic-key-two" });
  expect((await f.secrets.getStatus(credentialName(a.id))).configured).toBe(false);
  expect((await f.settings.read()).ai.customModels?.map((m) => m.id)).toEqual([mb.id]);
});
test("models under one connection share its credential", async () => {
  const f = await fixture(); const c = await f.service.saveConnection(connection(LOOPBACK));
  const models = await f.service.setModels(c.id, [entry("first"), entry("second")]);
  await f.service.setKey(c.id, "synthetic-shared");
  const s = await f.settings.read();
  for (const m of models) {
    const resolved = resolveCustomModel(s.ai.customConnections, s.ai.customModels, m.id);
    if (!resolved) throw new Error("fixture");
    expect(await f.credentials.headers(resolved)).toEqual({ Authorization: "Bearer synthetic-shared" });
  }
});
test("repointing a connection clears its key; a rename or protocol change keeps it", async () => {
  const f = await fixture(); const c = await f.service.saveConnection(connection(LOOPBACK));
  const m = await saved(f, c); await f.service.setKey(c.id, "synthetic-bound");
  await f.service.saveConnection({ ...c, name: "Renamed fixture", protocol: "openai-responses" });
  expect((await f.secrets.getStatus(credentialName(c.id))).configured).toBe(true);
  // A stale view of the old address can never read a key saved for a new one.
  await f.service.saveConnection({ ...c, baseUrl: "http://127.0.0.1:18081/v1" });
  expect((await f.secrets.getStatus(credentialName(c.id))).configured).toBe(false);
  await f.service.setKey(c.id, "synthetic-new-address");
  await expect(f.credentials.headers(m)).rejects.toThrow("previous address");
  expect((await f.settings.read()).ai.customModels?.map((x) => x.id)).toEqual([m.id]);
});
test("switching to no auth clears the key the connection held", async () => {
  const f = await fixture(); const c = await f.service.saveConnection(connection(LOOPBACK));
  await f.service.setKey(c.id, "synthetic-dropped");
  await f.service.saveConnection({ ...c, auth: { type: "none" } });
  expect((await f.secrets.getStatus(credentialName(c.id))).configured).toBe(false);
  expect(await readFile(join(f.dir, "secrets.bin"), "utf8")).not.toContain("synthetic-dropped");
});
test("setModels keeps known ids, mints new ones, and replaces the set exactly", async () => {
  const f = await fixture(); const c = await f.service.saveConnection(connection(LOOPBACK));
  const other = await f.service.saveConnection(connection("http://127.0.0.1:18081/v1"));
  const [kept] = await f.service.setModels(other.id, [entry("elsewhere")]);
  const [first, dropped] = await f.service.setModels(c.id, [entry("first"), entry("dropped")]);
  if (!first || !dropped || !kept) throw new Error("fixture");
  const next = await f.service.setModels(c.id, [{ ...entry("first", { displayName: "First, renamed" }), id: first.id }, entry("added", { id: kept.id })]);
  expect(next[0]).toMatchObject({ id: first.id, displayName: "First, renamed", connectionId: c.id });
  // An id belonging to another connection cannot be claimed.
  expect(next[1]?.id).not.toBe(kept.id);
  expect((await f.settings.read()).ai.customModels?.map((m) => m.modelId).sort()).toEqual(["added", "elsewhere", "first"]);
  await expect(f.service.setModels(c.id, [entry("twice"), entry("twice")])).rejects.toThrow("listed twice");
  await expect(f.service.setModels("12345678-1234-4234-8234-1234567890ff", [entry("orphan")])).rejects.toThrow("removed");
});
test("a stored credential no connection claims is swept before the next change", async () => {
  const f = await fixture();
  const stray = "12345678-1234-4234-8234-1234567890aa";
  await f.secrets.replace(credentialName(stray), JSON.stringify({ binding: "fixture", key: "synthetic-stray" }));
  await f.service.saveConnection(connection(LOOPBACK));
  expect((await f.secrets.getStatus(credentialName(stray))).configured).toBe(false);
});
test.each(["unavailable", "basic_text"])("refuses %s storage without plaintext fallback", async (failure) => {
  const f = await fixture(); const c = await f.service.saveConnection(connection(LOOPBACK));
  if (failure === "basic_text") storage.getSelectedStorageBackend.mockReturnValue("basic_text"); else storage.isEncryptionAvailable.mockReturnValue(false);
  await expect(f.service.setKey(c.id, "synthetic-never-written")).rejects.toThrow("safeStorage");
  await expect(readFile(join(f.dir, "secrets.bin"))).rejects.toMatchObject({ code: "ENOENT" });
});
test("OAuth fixture verifies state, S256 PKCE, callback, encrypted tokens, shared refresh, logout and revocation", async () => {
  let challenge = ""; let code = ""; let redirect = ""; let refreshes = 0; const revoked: string[] = [];
  const http = await server(async (req, res) => {
    const params = new URLSearchParams(await body(req));
    if (req.url === "/token") {
      if (params.get("grant_type") === "authorization_code") {
        expect(params.get("code")).toBe(code); expect(params.get("redirect_uri")).toBe(redirect);
        expect(createHash("sha256").update(params.get("code_verifier") ?? "").digest("base64url")).toBe(challenge);
        json(res, { token_type: "Bearer", access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_in: 1 });
      } else {
        expect(params.get("refresh_token")).toBe("synthetic-refresh"); refreshes += 1;
        json(res, { token_type: "Bearer", access_token: "synthetic-renewed", refresh_token: "synthetic-rotated", expires_in: 3600 });
      }
    } else if (req.url === "/revoke") { revoked.push(params.get("token") ?? ""); json(res, {}); }
    else res.writeHead(404).end();
  }); cleanup.push(http.close);
  const f = await fixture(async (url) => {
    const auth = new URL(url); expect(auth.pathname).toBe("/authorize"); expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    challenge = auth.searchParams.get("code_challenge") ?? ""; redirect = auth.searchParams.get("redirect_uri") ?? ""; code = "synthetic-code";
    expect((await fetch(`${redirect}?state=wrong&code=synthetic-code`)).status).toBe(400);
    expect((await fetch(`${redirect}?${new URLSearchParams({ state: auth.searchParams.get("state") ?? "", code })}`)).status).toBe(200);
  });
  const c = await f.service.saveConnection(connection(`${http.url}/v1`, { type: "oauth",
    oauth: { authorizationUrl: `${http.url}/authorize`, tokenUrl: `${http.url}/token`, revocationUrl: `${http.url}/revoke`, clientId: "fixture-public-client", scopes: "models.read inference", callbackPort: 0 } }));
  const models = await f.service.setModels(c.id, [entry("one-model"), entry("another-model")]);
  await f.service.login(c.id, new AbortController().signal);
  expect(await readFile(join(f.dir, "secrets.bin"), "utf8")).not.toContain("synthetic-access");
  const s = await f.settings.read();
  const [a, b] = models.map((m) => resolveCustomModel(s.ai.customConnections, s.ai.customModels, m.id));
  if (!a || !b) throw new Error("fixture");
  const headers = await Promise.all([f.credentials.headers(a), f.credentials.headers(b)]);
  expect(headers).toEqual([{ Authorization: "Bearer synthetic-renewed" }, { Authorization: "Bearer synthetic-renewed" }]); expect(refreshes).toBe(1);
  await f.service.logout(c.id); expect(revoked).toEqual(["synthetic-rotated", "synthetic-renewed"]);
  expect((await f.secrets.getStatus(credentialName(c.id))).configured).toBe(false);
  await expect(f.credentials.headers(a)).rejects.toThrow("unavailable");
});
test("logout cancels an in-flight OAuth callback and cannot resurrect credentials", async () => {
  let opened: () => void = () => undefined; const ready = new Promise<void>((resolve) => { opened = resolve; });
  const f = await fixture(async () => { opened(); });
  const c = await f.service.saveConnection(connection("http://127.0.0.1:1/v1", { type: "oauth",
    oauth: { authorizationUrl: "http://127.0.0.1:1/authorize", tokenUrl: "http://127.0.0.1:1/token", clientId: "fixture", scopes: "", callbackPort: 0 } }));
  const login = f.service.login(c.id, new AbortController().signal); const rejected = expect(login).rejects.toThrow("cancelled");
  await ready; await f.service.logout(c.id); await rejected;
  expect((await f.secrets.getStatus(credentialName(c.id))).configured).toBe(false);
});
test("locked storage cannot disclose errors or overwrite another connection's credential", async () => {
  const f = await fixture(); const a = await f.service.saveConnection(connection(LOOPBACK));
  const b = await f.service.saveConnection(connection("http://127.0.0.1:18081/v1"));
  const ma = await saved(f, a); const mb = await saved(f, b);
  await f.service.setKey(a.id, "synthetic-preserved-one"); await f.service.setKey(b.id, "synthetic-preserved-two");
  const before = await readFile(join(f.dir, "secrets.bin"), "utf8");
  storage.decryptString.mockImplementationOnce(() => { throw new Error("synthetic-sensitive-error-text"); });
  await expect(f.credentials.headers(ma)).rejects.toThrow("Credentials are unavailable");
  storage.decryptString.mockImplementationOnce(() => { throw new Error("synthetic-sensitive-error-text"); });
  await expect(f.service.setKey(a.id, "replacement")).rejects.toThrow("refusing to write");
  expect(await readFile(join(f.dir, "secrets.bin"), "utf8")).toBe(before);
  expect(await f.credentials.headers(mb)).toEqual({ Authorization: "Bearer synthetic-preserved-two" });
});
test("protocol selects the standard API-key header and none emits no credentials", async () => {
  const f = await fixture(); const c = await f.service.saveConnection(connection(LOOPBACK, { type: "api-key" }, "anthropic-messages"));
  const m = await saved(f, c); await f.service.setKey(c.id, "synthetic-anthropic");
  expect(await f.credentials.headers(m)).toEqual({ "x-api-key": "synthetic-anthropic" });
  expect(await f.credentials.headers({ ...m, auth: { type: "none" } })).toEqual({});
});
test("cancellation stops waiting for a shared refresh without cancelling another request's refresh", async () => {
  let ready: () => void = () => undefined;
  const received = new Promise<void>((resolve) => { ready = resolve; });
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let refreshes = 0;
  const http = await server(async (_req, res) => {
    refreshes += 1; ready(); await gate;
    json(res, { token_type: "Bearer", access_token: "synthetic-refreshed", expires_in: 3600 });
  }); cleanup.push(http.close);
  const f = await fixture();
  const c = await f.service.saveConnection(connection(`${http.url}/v1`, { type: "oauth",
    oauth: { authorizationUrl: `${http.url}/authorize`, tokenUrl: `${http.url}/token`, clientId: "fixture", scopes: "", callbackPort: 0 } }));
  const endpoint = endpointOf(c);
  await f.secrets.replace(credentialName(c.id), JSON.stringify({ binding: credentialBinding(c), tokens: { accessToken: "synthetic-expired", refreshToken: "synthetic-refresh", expiresAt: 0 } }));
  const abort = new AbortController(); const waiting = f.credentials.headers(endpoint, abort.signal);
  const rejected = expect(waiting).rejects.toThrow("cancelled");
  await received; abort.abort(); await rejected; release();
  expect(await f.credentials.headers(endpoint)).toEqual({ Authorization: "Bearer synthetic-refreshed" });
  expect(refreshes).toBe(1);
});
test("settings without custom entries migrate additively and preserve built-in selections", async () => {
  const f = await fixture(); const legacy = defaultSettings(); delete legacy.ai.customModels; delete legacy.ai.customConnections;
  legacy.ai.defaults.libraryChat = { provider: "acp:kimi", model: "fixture-existing" };
  await writeFile(join(f.dir, "settings.json"), JSON.stringify(legacy));
  const migrated = await f.settings.read();
  expect(migrated.ai.customConnections).toEqual([]); expect(migrated.ai.customModels).toEqual([]);
  expect(migrated.ai.defaults.libraryChat).toEqual(legacy.ai.defaults.libraryChat);
});
test("the first cut's flat per-model entries regroup into connections and keep their key", async () => {
  const f = await fixture();
  const credentialId = "12345678-1234-4234-8234-123456789003";
  const flat = (id: string, modelId: string, auth: unknown, baseUrl = LOOPBACK) => ({ id, displayName: modelId, modelId, baseUrl,
    protocol: "openai-chat", auth, capabilities: { vision: false, streaming: true }, maxOutputTokens: 100 });
  const legacy = { ...defaultSettings(), ai: { ...defaultSettings().ai, customConnections: undefined, customModels: [
    flat("12345678-1234-4234-8234-123456789001", "keyed-one", { type: "api-key", credentialId }),
    flat("12345678-1234-4234-8234-123456789002", "keyed-two", { type: "api-key", credentialId }),
    flat("12345678-1234-4234-8234-123456789005", "local-one", { type: "none" }, "http://127.0.0.1:18090/v1"),
    flat("12345678-1234-4234-8234-123456789006", "local-two", { type: "none" }, "http://127.0.0.1:18090/v1")
  ] } };
  await writeFile(join(f.dir, "settings.json"), JSON.stringify(legacy));
  const keyed = { baseUrl: LOOPBACK, auth: { type: "api-key" as const } };
  await f.secrets.replace(credentialName(credentialId), JSON.stringify({ binding: credentialBinding(keyed), key: "synthetic-legacy" }));
  const s = await f.settings.read();
  expect(s.ai.customConnections?.map((c) => [c.id, c.name, c.auth.type])).toEqual([
    [credentialId, "127.0.0.1:18080", "api-key"], ["12345678-1234-4234-8234-123456789005", "127.0.0.1:18090", "none"]]);
  expect(s.ai.customModels?.map((m) => m.connectionId)).toEqual([credentialId, credentialId,
    "12345678-1234-4234-8234-123456789005", "12345678-1234-4234-8234-123456789005"]);
  const m = resolveCustomModel(s.ai.customConnections, s.ai.customModels, "12345678-1234-4234-8234-123456789002");
  if (!m) throw new Error("fixture");
  expect(await f.credentials.headers(m)).toEqual({ Authorization: "Bearer synthetic-legacy" });
});
