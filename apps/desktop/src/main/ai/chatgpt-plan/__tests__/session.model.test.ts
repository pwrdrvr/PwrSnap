import fc from "fast-check";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { PLAN_SCOPE } from "../oauth-client";

const DISCOVERY = { issuer: "https://auth.openai.com", authorization_endpoint: "https://auth.openai.com/authorize",
  token_endpoint: "https://auth.openai.com/token", jwks_uri: "https://auth.openai.com/jwks", revocation_endpoint: "https://auth.openai.com/revoke" };
const signedInPlan = () => ({ accountLabel: "Fixture", planGranted: true, backgroundConsent: false, welcomeSeen: false });

const fixture = vi.hoisted(() => ({
  record: {} as Record<string, unknown>,
  settings: { ai: { chatgptPlan: {} as Record<string, unknown>, customConnections: [] as unknown[] } },
  fetch: vi.fn(), getValue: vi.fn(), save: vi.fn(), dispatch: vi.fn(), role: "agent"
}));
vi.mock("../oauth-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../oauth-client")>();
  return { ...actual, SiwcOAuthClient: class extends actual.SiwcOAuthClient {
    constructor() { super(fixture.fetch as typeof fetch); }
  } };
});
vi.mock("../../../settings/desktop-settings-store", () => ({ getDesktopSettingsStore: () => ({ read: async () => fixture.settings }) }));
vi.mock("../../../handlers/settings-handlers", () => ({ getDesktopSettingsServices: () => ({
  service: { read: async () => fixture.settings,
    write: async (patch: { ai: { chatgptPlan: Record<string, unknown> } }) => { Object.assign(fixture.settings.ai.chatgptPlan, patch.ai.chatgptPlan); } },
  secrets: { getValue: fixture.getValue, replace: fixture.save }
}), broadcastSettingsChanged: vi.fn() }));
vi.mock("../../../process-role", () => ({ getRuntimeProcessRole: () => fixture.role }));
vi.mock("../../../command-bus", () => ({ bus: { dispatch: fixture.dispatch } }));
import { invalidatePlanSession, planAccessToken, publicStatus, signOut } from "../session";

beforeEach(() => {
  fixture.settings.ai = { chatgptPlan: signedInPlan(), customConnections: [] };
  fixture.record = { hostId: "urn:uuid:fixture", clientId: "oaiapp_fixture", subject: "fixture", label: "Fixture",
    accessToken: "fixture-expired", refreshToken: "fixture-original-refresh", expiresAt: 1, scope: PLAN_SCOPE };
  fixture.getValue.mockReset().mockImplementation(async () => JSON.stringify(fixture.record));
  fixture.save.mockReset().mockImplementation(async (_name: string, value: string) => { fixture.record = JSON.parse(value); });
  fixture.dispatch.mockReset(); fixture.role = "agent";
  fixture.fetch.mockReset().mockImplementation(async (url: string) => url.includes("openid-configuration")
    ? new Response(JSON.stringify(DISCOVERY))
    : url.endsWith("/revoke") ? new Response(null, { status: 200 })
    : new Response(JSON.stringify({ access_token: "fixture-renewed", refresh_token: "fixture-rotated", expires_in: 3600, scope: PLAN_SCOPE })));
});

// Generated state transitions use a disk oracle: the token presented to the
// fake rotating endpoint must be the latest persisted refresh token.
test("session command sequences preserve registration and rotate exactly once per concurrent batch", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("read", "expire", "offline", "invalidate", "signOut"), { minLength: 1, maxLength: 20 }), async commands => {
    const dir = await mkdtemp(join(tmpdir(), "pwrsnap-siwc-model-"));
    const file = join(dir, "registration.json");
    const initial = { hostId: "urn:uuid:model", clientId: "oaiapp_model", accessToken: "access-0",
      refreshToken: "refresh-0", expiresAt: Date.now() + 3600000, scope: PLAN_SCOPE };
    await writeFile(file, JSON.stringify(initial));
    fixture.getValue.mockImplementation(async () => readFile(file, "utf8"));
    fixture.save.mockImplementation(async (_name: string, value: string) => { await writeFile(file, value); });
    let signedIn = true;
    let expired = false;
    let rotation = 0;
    let offline = false;
    fixture.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (offline) throw new Error("offline");
      if (!url.endsWith("/token")) return new Response(JSON.stringify(DISCOVERY));
      if (!(init?.body instanceof URLSearchParams)) throw new Error("Expected form token request");
      expect(init.body.get("refresh_token")).toBe(`refresh-${rotation}`);
      rotation++;
      return new Response(JSON.stringify({ access_token: `access-${rotation}`, refresh_token: `refresh-${rotation}`, expires_in: 3600, scope: PLAN_SCOPE }));
    });
    try {
      for (const command of commands) {
        if (command === "expire") {
          const record = JSON.parse(await readFile(file, "utf8"));
          record.expiresAt = 1; await writeFile(file, JSON.stringify(record)); expired = true;
        } else if (command === "invalidate" || command === "signOut") {
          if (command === "invalidate") await invalidatePlanSession();
          else await signOut();
          signedIn = false;
        } else {
          offline = command === "offline";
          const before = rotation;
          const batch = await Promise.allSettled(Array.from({ length: 3 }, () => planAccessToken()));
          expect(batch.every(r => r.status === (signedIn && !(expired && offline) ? "fulfilled" : "rejected"))).toBe(true);
          expect(rotation - before).toBe(signedIn && expired && !offline ? 1 : 0);
          if (signedIn && !offline) expired = false;
          offline = false;
        }
        const stored = JSON.parse(await readFile(file, "utf8"));
        expect(stored.hostId).toBe(initial.hostId); expect(stored.clientId).toBe(initial.clientId);
        expect(stored.refreshToken).toBe(signedIn ? `refresh-${rotation}` : undefined);
        const status = await publicStatus();
        expect(JSON.stringify(status)).not.toMatch(/access-|refresh-/);
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  }), { numRuns: 100 });
});
