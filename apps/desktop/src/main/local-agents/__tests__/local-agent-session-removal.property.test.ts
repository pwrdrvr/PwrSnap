import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import {
  MAX_RETAINED_LOCAL_AGENT_OAUTH_CLIENTS,
  type LocalAgentOAuthClient
} from "@pwrsnap/shared";
import { describe, expect, test, vi } from "vitest";

const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((s: string): Buffer =>
    Buffer.from(`PWR-ENC|${Buffer.from(s, "utf8").toString("base64")}`, "utf8")),
  decryptString: vi.fn((b: Buffer): string =>
    Buffer.from(b.toString("utf8").slice("PWR-ENC|".length), "base64").toString("utf8"))
}));

vi.mock("electron", () => ({ safeStorage: safeStorageMock }));

import { DesktopSecretStore } from "../../settings/desktop-secret-store";
import { DesktopSettingsService } from "../../settings/desktop-settings-service";
import { LocalAgentAuditService } from "../local-agent-audit";
import {
  LocalAgentGrantError,
  LocalAgentGrantService,
  secretNameForClient
} from "../local-agent-grants";
import { LocalAgentOAuthProvider } from "../local-agent-oauth";

// Model-based test for removing revoked Sessions (Settings → Local Agents).
// The rule: removal deletes a revoked Session's saved entry and nothing else.
// It never ends or restores access, never touches an active Session, never
// erases audit history, and never makes PwrSnap forget an agent's OAuth
// registration while that agent might ask for approval again.

const CLIENTS = ["lag_oauth_a", "lag_oauth_b", "lag_oauth_c"] as const;
const NAMES = ["PwrAgent", "Claude Code"] as const;

function oauthClient(clientId: string): LocalAgentOAuthClient {
  return {
    clientId,
    clientName: `Client ${clientId}`,
    redirectUris: ["http://127.0.0.1:43123/callback"],
    clientUri: null,
    scope: null,
    grantTypes: ["authorization_code"],
    responseTypes: ["code"],
    softwareId: null,
    softwareVersion: null,
    registeredAt: "2026-11-07T12:00:00.000Z"
  };
}

type Op =
  | { kind: "issue"; client: number; name: number }
  | { kind: "revoke"; pick: number }
  | { kind: "remove"; pick: number }
  | { kind: "removeAll" };

const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant("issue" as const), client: fc.nat(2), name: fc.nat(1) }),
  fc.record({ kind: fc.constant("revoke" as const), pick: fc.nat(20) }),
  fc.record({ kind: fc.constant("remove" as const), pick: fc.nat(20) }),
  fc.constant({ kind: "removeAll" as const })
);

type ModelSession = {
  id: string;
  name: string;
  clientId: string;
  token: string;
  state: "active" | "revoked" | "removed";
};

function stores(dir: string): { settings: DesktopSettingsService; secrets: DesktopSecretStore } {
  return {
    settings: new DesktopSettingsService({ filePath: join(dir, "settings.json") }),
    secrets: new DesktopSecretStore({ filePath: join(dir, "secrets.bin") })
  };
}

describe("removing revoked local-agent Sessions", () => {
  test("model: removal deletes only revoked entries, restores nothing, and keeps registrations", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 14 }), async (ops) => {
        const dir = mkdtempSync(join(tmpdir(), "pwrsnap-la-removal-"));
        const { settings, secrets } = stores(dir);
        let seq = 0;
        const service = new LocalAgentGrantService({
          settings,
          secrets,
          makeId: () => `lag_session_${++seq}`,
          makeToken: () => `pws_local_token_${seq}`
        });
        const audit = new LocalAgentAuditService(settings);
        const model: ModelSession[] = [];
        const registered = new Set<string>();

        for (const step of ops) {
          if (step.kind === "issue") {
            const name = NAMES[step.name] as string;
            const clientId = CLIENTS[step.client] as string;
            const nameTaken = model.some((s) => s.state === "active" && s.name === name);
            const result = service.issueOAuthGrant({
              name,
              capabilities: ["library.read"],
              oauthClient: oauthClient(clientId)
            });
            if (nameTaken) {
              await expect(result).rejects.toMatchObject({ code: "duplicate_name" });
              continue;
            }
            const issued = await result;
            registered.add(clientId);
            model.push({ id: issued.grant.id, name, clientId, token: issued.token, state: "active" });
            await audit.record({
              clientId: issued.grant.id,
              action: "capture.original.read",
              capability: "capture.original.read",
              subjectKind: "capture",
              subjectId: `cap_${issued.grant.id}`,
              outcome: "success"
            });
            continue;
          }
          const live = model.filter((s) => s.state !== "removed");
          if (step.kind === "removeAll") {
            const expected = live.filter((s) => s.state === "revoked").map((s) => s.id);
            const removed = await service.removeRevokedGrants("all-revoked");
            expect([...removed].sort()).toEqual([...expected].sort());
            for (const s of live) if (s.state === "revoked") s.state = "removed";
            continue;
          }
          const target = live[step.pick % Math.max(1, live.length)];
          if (target === undefined) continue;
          if (step.kind === "revoke") {
            if (target.state !== "active") continue;
            await service.revokeGrant(target.id);
            target.state = "revoked";
            continue;
          }
          // remove
          const before = JSON.stringify(await service.list());
          if (target.state === "active") {
            const error = await service.removeRevokedGrants([target.id]).catch((e: unknown) => e);
            expect(error).toBeInstanceOf(LocalAgentGrantError);
            expect((error as LocalAgentGrantError).code).toBe("session_active");
            expect(JSON.stringify(await service.list())).toBe(before);
          } else {
            await expect(service.removeRevokedGrants([target.id])).resolves.toEqual([target.id]);
            target.state = "removed";
          }
        }

        // Check every invariant against a fresh read from disk, as after a restart.
        const reopened = stores(dir);
        const restarted = new LocalAgentGrantService(reopened);
        const provider = new LocalAgentOAuthProvider({
          grantService: restarted,
          resourceUrl: new URL("http://127.0.0.1:51729/mcp")
        });
        const listed = await restarted.list();
        const listedIds = new Set(listed.map((grant) => grant.id));
        for (const s of model) {
          const auth = await restarted.authenticate({ clientId: s.id, token: s.token });
          if (s.state === "active") {
            expect(auth.ok).toBe(true);
            expect(listedIds.has(s.id)).toBe(true);
          } else {
            expect(auth.ok).toBe(false);
            expect(await reopened.secrets.getValue(secretNameForClient(s.id))).toBeNull();
            expect(listedIds.has(s.id)).toBe(s.state === "revoked");
          }
        }
        expect(listed).toHaveLength(model.filter((s) => s.state !== "removed").length);
        // Every agent that ever registered can still start an approval.
        for (const clientId of registered) {
          expect(await provider.clientsStore.getClient(clientId)).toMatchObject({
            client_id: clientId
          });
        }
        const settingsNow = await reopened.settings.read();
        // A registration a live Session holds is not duplicated in the kept list.
        for (const kept of settingsNow.localAgents.retainedOAuthClients) {
          expect(listed.some((grant) => grant.oauthClient?.clientId === kept.clientId)).toBe(false);
        }
        // Audit history survives removal, removed Sessions included.
        const issuedCount = model.length;
        expect(settingsNow.localAgents.audit).toHaveLength(issuedCount);
      }),
      { numRuns: 60 }
    );
  });

  test("an unknown id refuses the whole call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pwrsnap-la-removal-"));
    const { settings, secrets } = stores(dir);
    let seq = 0;
    const service = new LocalAgentGrantService({
      settings,
      secrets,
      makeId: () => `lag_session_${++seq}`
    });
    const issued = await service.issueOAuthGrant({
      name: "PwrAgent",
      capabilities: ["library.read"],
      oauthClient: oauthClient("lag_oauth_a")
    });
    await service.revokeGrant(issued.grant.id);
    await expect(
      service.removeRevokedGrants([issued.grant.id, "lag_missing"])
    ).rejects.toMatchObject({ code: "not_found" });
    expect((await service.list()).map((grant) => grant.id)).toEqual([issued.grant.id]);
  });

  test("kept registrations are capped, oldest dropped first", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pwrsnap-la-removal-"));
    const { settings, secrets } = stores(dir);
    let seq = 0;
    const service = new LocalAgentGrantService({
      settings,
      secrets,
      makeId: () => `lag_session_${++seq}`
    });
    const total = MAX_RETAINED_LOCAL_AGENT_OAUTH_CLIENTS + 2;
    for (let i = 0; i < total; i += 1) {
      const issued = await service.issueOAuthGrant({
        name: "PwrAgent",
        capabilities: ["library.read"],
        oauthClient: oauthClient(`lag_oauth_${i}`)
      });
      await service.revokeGrant(issued.grant.id);
      await service.removeRevokedGrants([issued.grant.id]);
    }
    const kept = (await settings.read()).localAgents.retainedOAuthClients;
    expect(kept).toHaveLength(MAX_RETAINED_LOCAL_AGENT_OAUTH_CLIENTS);
    expect(kept[0]?.clientId).toBe("lag_oauth_2");
    expect(kept.at(-1)?.clientId).toBe(`lag_oauth_${total - 1}`);
    // A reopened file with the full list still parses.
    expect((await stores(dir).settings.read()).localAgents.retainedOAuthClients).toHaveLength(
      MAX_RETAINED_LOCAL_AGENT_OAUTH_CLIENTS
    );
  });
});
