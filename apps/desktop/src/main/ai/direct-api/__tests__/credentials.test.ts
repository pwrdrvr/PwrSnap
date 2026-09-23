import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { CustomModel } from "@pwrsnap/shared";
const storage = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true), getSelectedStorageBackend: vi.fn(() => "keychain"),
  encryptString: vi.fn((s: string) => Buffer.from(`fixture-envelope:${Buffer.from(s).toString("base64")}`)),
  decryptString: vi.fn((b: Buffer) => Buffer.from(b.toString().slice("fixture-envelope:".length), "base64").toString())
}));
vi.mock("electron", () => ({ safeStorage: storage }));
vi.mock("../../../log", () => ({ getMainLogger: () => ({ warn: vi.fn(), info: vi.fn() }) }));
import { DesktopSecretStore } from "../../../settings/desktop-secret-store";
import { DesktopSettingsService, defaultSettings } from "../../../settings/desktop-settings-service";
import { CustomCredentials, credentialBinding, credentialName } from "../credentials";
import { CustomModelService } from "../service";
import { body, CREDENTIAL_ID, json, model, OTHER_CREDENTIAL_ID, SECOND_ID, server } from "./fixtures";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((f) => f())); storage.isEncryptionAvailable.mockReturnValue(true); storage.getSelectedStorageBackend.mockReturnValue("keychain"); });
async function fixture(openBrowser: (url: string) => Promise<void> = async () => undefined): Promise<{
  secrets: DesktopSecretStore; credentials: CustomCredentials; service: CustomModelService; settings: DesktopSettingsService; dir: string
}> {
  const dir = await mkdtemp(join(tmpdir(), "pwrsnap-direct-fixture-")); cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const secrets = new DesktopSecretStore({ filePath: join(dir, "secrets.bin") });
  const settings = new DesktopSettingsService({ filePath: join(dir, "settings.json"), appVersion: "1.1.4" });
  const credentials = new CustomCredentials(secrets, openBrowser);
  return { secrets, credentials, settings, dir, service: new CustomModelService(settings, credentials, async () => undefined) };
}
function withKey(base = "http://127.0.0.1:18080/v1"): CustomModel { return { ...model(base), auth: { type: "api-key", credentialId: CREDENTIAL_ID } }; }

test("persists multiple entries, migrates old settings, and isolates encrypted credentials", async () => {
  const f = await fixture();
  await f.settings.write({ codex: { profile: "keep-existing" }, ai: { acp: { enabledAgentIds: ["kimi"] } } });
  const a = withKey(); const b = { ...a, id: SECOND_ID, modelId: "second/model", auth: { type: "api-key" as const, credentialId: OTHER_CREDENTIAL_ID } };
  await Promise.all([f.service.save(a), f.service.save(b)]);
  await f.service.setKey(a.id, "synthetic-key-one"); await f.service.setKey(b.id, "synthetic-key-two");
  expect(await f.credentials.headers(a)).toEqual({ Authorization: "Bearer synthetic-key-one" });
  expect(await f.credentials.headers(b)).toEqual({ Authorization: "Bearer synthetic-key-two" });
  await f.settings.write({ ai: { defaults: { libraryChat: { provider: `custom:${b.id}`, model: b.modelId } } } });
  const reloaded = await new DesktopSettingsService({ filePath: join(f.dir, "settings.json"), appVersion: "1.1.4" }).read();
  expect(reloaded.ai.customModels).toHaveLength(2); expect(reloaded.ai.defaults.libraryChat.provider).toBe(`custom:${b.id}`);
  expect(reloaded.codex.profile).toBe("keep-existing"); expect(reloaded.ai.acp.enabledAgentIds).toContain("kimi");
  for (const path of ["settings.json", "secrets.bin"]) expect(await readFile(join(f.dir, path), "utf8")).not.toContain("synthetic-key");
  await f.service.remove(a.id); expect(await f.credentials.headers(b)).toEqual({ Authorization: "Bearer synthetic-key-two" });
  expect((await f.secrets.getStatus(credentialName(CREDENTIAL_ID))).configured).toBe(false);
});
test("credential reuse is explicit, endpoint-bound, and last-reference deletion owns cleanup", async () => {
  const f = await fixture(); const a = withKey(); const b = { ...a, id: SECOND_ID, displayName: "shared second", modelId: "other" };
  await f.service.save(a); await f.service.setKey(a.id, "synthetic-shared"); await f.service.save(b);
  expect(await f.service.status(a.id)).toEqual({ configured: true, sharedBy: 2 });
  await expect(f.service.save({ ...a, baseUrl: "http://127.0.0.1:18081/v1" })).rejects.toThrow("new credential");
  await expect(f.credentials.headers({ ...a, baseUrl: "http://127.0.0.1:18081/v1" })).rejects.toThrow("different endpoint");
  await f.service.remove(a.id); expect(await f.credentials.headers(b)).toEqual({ Authorization: "Bearer synthetic-shared" });
  await f.service.remove(b.id); expect((await f.secrets.getStatus(credentialName(CREDENTIAL_ID))).configured).toBe(false);
});
test.each(["unavailable", "basic_text"])("refuses %s storage without plaintext fallback", async (failure) => {
  const f = await fixture(); const a = withKey(); await f.service.save(a);
  if (failure === "basic_text") storage.getSelectedStorageBackend.mockReturnValue("basic_text"); else storage.isEncryptionAvailable.mockReturnValue(false);
  await expect(f.service.setKey(a.id, "synthetic-never-written")).rejects.toThrow("safeStorage");
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
  const a: CustomModel = { ...model(`${http.url}/v1`), auth: { type: "oauth", credentialId: CREDENTIAL_ID,
    oauth: { authorizationUrl: `${http.url}/authorize`, tokenUrl: `${http.url}/token`, revocationUrl: `${http.url}/revoke`, clientId: "fixture-public-client", scopes: "models.read inference", callbackPort: 0 } } };
  await f.service.save(a); await f.service.save({ ...a, id: SECOND_ID, modelId: "another-model" });
  await f.service.login(a.id, new AbortController().signal);
  expect(await readFile(join(f.dir, "secrets.bin"), "utf8")).not.toContain("synthetic-access");
  const headers = await Promise.all([f.credentials.headers(a), f.credentials.headers({ ...a, id: SECOND_ID })]);
  expect(headers).toEqual([{ Authorization: "Bearer synthetic-renewed" }, { Authorization: "Bearer synthetic-renewed" }]); expect(refreshes).toBe(1);
  await f.service.logout(a.id); expect(revoked).toEqual(["synthetic-rotated", "synthetic-renewed"]);
  expect(await f.service.status(SECOND_ID)).toEqual({ configured: false, sharedBy: 2 });
  await expect(f.credentials.headers(a)).rejects.toThrow("unavailable");
});
test("logout cancels an in-flight OAuth callback and cannot resurrect credentials", async () => {
  let opened: () => void = () => undefined; const ready = new Promise<void>((resolve) => { opened = resolve; });
  const f = await fixture(async () => { opened(); });
  const a: CustomModel = { ...model("http://127.0.0.1:1/v1"), auth: { type: "oauth", credentialId: CREDENTIAL_ID,
    oauth: { authorizationUrl: "http://127.0.0.1:1/authorize", tokenUrl: "http://127.0.0.1:1/token", clientId: "fixture", scopes: "", callbackPort: 0 } } };
  await f.service.save(a); const login = f.service.login(a.id, new AbortController().signal); const rejected = expect(login).rejects.toThrow("cancelled");
  await ready; await f.service.logout(a.id); await rejected;
  expect((await f.service.status(a.id)).configured).toBe(false);
});

test("locked storage cannot disclose errors or overwrite another model's credentials", async () => {
  const f = await fixture(); const a = withKey();
  const b = { ...a, id: SECOND_ID, auth: { type: "api-key" as const, credentialId: OTHER_CREDENTIAL_ID } };
  await f.service.save(a); await f.service.save(b); await f.service.setKey(a.id, "synthetic-preserved-one"); await f.service.setKey(b.id, "synthetic-preserved-two");
  const before = await readFile(join(f.dir, "secrets.bin"), "utf8");
  storage.decryptString.mockImplementationOnce(() => { throw new Error("synthetic-sensitive-error-text"); });
  await expect(f.credentials.headers(a)).rejects.toThrow("Credentials are unavailable");
  storage.decryptString.mockImplementationOnce(() => { throw new Error("synthetic-sensitive-error-text"); });
  await expect(f.service.setKey(a.id, "replacement")).rejects.toThrow("refusing to write");
  expect(await readFile(join(f.dir, "secrets.bin"), "utf8")).toBe(before);
  expect(await f.credentials.headers(b)).toEqual({ Authorization: "Bearer synthetic-preserved-two" });
});

test("protocol selects the standard API-key header and none emits no credentials", async () => {
  const f = await fixture(); const a = { ...withKey(), protocol: "anthropic-messages" as const };
  await f.service.save(a); await f.service.setKey(a.id, "synthetic-anthropic");
  expect(await f.credentials.headers(a)).toEqual({ "x-api-key": "synthetic-anthropic" });
  expect(await f.credentials.headers({ ...a, auth: { type: "none" } })).toEqual({});
});


test("cancellation stops waiting for a shared refresh without cancelling another model's refresh", async () => {
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
  const a: CustomModel = { ...model(`${http.url}/v1`), auth: { type: "oauth", credentialId: CREDENTIAL_ID,
    oauth: { authorizationUrl: `${http.url}/authorize`, tokenUrl: `${http.url}/token`, clientId: "fixture", scopes: "", callbackPort: 0 } } };
  await f.service.save(a);
  await f.secrets.replace(credentialName(CREDENTIAL_ID), JSON.stringify({ binding: credentialBinding(a), tokens: { accessToken: "synthetic-expired", refreshToken: "synthetic-refresh", expiresAt: 0 } }));
  const abort = new AbortController(); const waiting = f.credentials.headers(a, abort.signal);
  const rejected = expect(waiting).rejects.toThrow("cancelled");
  await received; abort.abort(); await rejected; release();
  expect(await f.credentials.headers(a)).toEqual({ Authorization: "Bearer synthetic-refreshed" });
  expect(refreshes).toBe(1);
});

test("settings without custom entries migrate additively and preserve built-in selections", async () => {
  const f = await fixture(); const legacy = defaultSettings(); delete legacy.ai.customModels;
  legacy.ai.defaults.libraryChat = { provider: "acp:kimi", model: "fixture-existing" };
  await writeFile(join(f.dir, "settings.json"), JSON.stringify(legacy));
  const migrated = await f.settings.read();
  expect(migrated.ai.customModels).toEqual([]);
  expect(migrated.ai.defaults.libraryChat).toEqual(legacy.ai.defaults.libraryChat);
});
