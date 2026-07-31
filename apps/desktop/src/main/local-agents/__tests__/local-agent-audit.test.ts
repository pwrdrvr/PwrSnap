import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DesktopSettingsService } from "../../settings/desktop-settings-service";
import { LocalAgentAuditService } from "../local-agent-audit";

describe("LocalAgentAuditService", () => {
  test("stores bounded metadata without prompts, queries, or filenames", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pwrsnap-audit-"));
    const settings = new DesktopSettingsService({
      filePath: join(dir, "settings.json")
    });
    const audit = new LocalAgentAuditService(settings);

    await audit.record({
      clientId: "lag_test",
      action: "capture.original.read",
      capability: "capture.original.read",
      subjectKind: "capture",
      subjectId: "cap_123",
      outcome: "success"
    });

    const entries = await audit.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      clientId: "lag_test",
      action: "capture.original.read",
      capability: "capture.original.read",
      subjectKind: "capture",
      subjectId: "cap_123",
      outcome: "success"
    });
    expect(Object.keys(entries[0] ?? {})).toEqual([
      "id",
      "clientId",
      "action",
      "capability",
      "subjectKind",
      "subjectId",
      "outcome",
      "occurredAt"
    ]);
  });
});
