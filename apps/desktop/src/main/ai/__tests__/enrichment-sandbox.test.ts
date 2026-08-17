// The capture-enrichment sandbox invariant (issue #69). The transport-level
// controls are exercised end-to-end in `codex-agent-pool.test.ts` and
// `acp-approval-policy.test.ts`; this file pins the shared pieces those two
// depend on — the posture object, the redaction rule, and the registry.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __clearEnrichmentThreadsForTests,
  codexEnrichmentThreadSandbox,
  defaultEnrichmentWorkspaceDir,
  denyEnrichmentEscalation,
  enrichmentDiagnosticsForThread,
  markEnrichmentThread,
  redactToolIdentity,
  unmarkEnrichmentThread
} from "../enrichment-sandbox";

beforeEach(() => {
  __clearEnrichmentThreadsForTests();
});

describe("codexEnrichmentThreadSandbox", () => {
  it("jails the thread to the supplied workspace with no approvals and no writes", () => {
    expect(codexEnrichmentThreadSandbox("/tmp/jail")).toEqual({
      ephemeral: true,
      cwd: "/tmp/jail",
      runtimeWorkspaceRoots: ["/tmp/jail"],
      approvalPolicy: "never",
      sandbox: "read-only",
      environments: [],
      persistExtendedHistory: false
    });
  });

  it("defaults the jail to an app-owned scratch dir, not a user directory", () => {
    const dir = defaultEnrichmentWorkspaceDir();
    expect(dir).toContain("pwrsnap");
    expect(dir).toContain(".capture-metadata");
    // Nothing the user cares about may be reachable as the agent's cwd.
    expect(dir).not.toContain("Documents");
  });
});

describe("redactToolIdentity", () => {
  it("keeps a short tool name so a denial is actionable", () => {
    expect(redactToolIdentity("shell")).toBe("shell");
    expect(redactToolIdentity("  read_file  ")).toBe("read_file");
  });

  it("drops empty / non-string identities", () => {
    expect(redactToolIdentity(null)).toBeNull();
    expect(redactToolIdentity(undefined)).toBeNull();
    expect(redactToolIdentity("   ")).toBeNull();
  });

  it("truncates an attacker-controlled name so it can't flood the log", () => {
    const redacted = redactToolIdentity("A".repeat(5_000));
    expect(redacted).toHaveLength(121); // 120 + the ellipsis
    expect(redacted?.endsWith("…")).toBe(true);
  });
});

describe("denyEnrichmentEscalation", () => {
  it("always denies, and logs at error with the run + capture id", () => {
    const logger = { error: vi.fn() };

    const decision = denyEnrichmentEscalation({
      logger,
      backend: "codex",
      kind: "approval",
      method: "turn/requestApproval",
      threadId: "thread-1",
      diagnostics: { runId: "run-1", captureId: "cap-1" },
      toolName: "shell"
    });

    expect(decision).toBe("denied");
    expect(logger.error).toHaveBeenCalledWith("capture enrichment sandbox escalation denied", {
      backend: "codex",
      kind: "approval",
      method: "turn/requestApproval",
      threadId: "thread-1",
      runId: "run-1",
      captureId: "cap-1",
      toolName: "shell"
    });
  });

  it("still denies when the run identity is unknown", () => {
    const logger = { error: vi.fn() };
    expect(
      denyEnrichmentEscalation({
        logger,
        backend: "acp",
        kind: "tool_call",
        method: "session/request_permission",
        threadId: null,
        diagnostics: null
      })
    ).toBe("denied");
    expect(logger.error).toHaveBeenCalledWith(
      "capture enrichment sandbox escalation denied",
      expect.objectContaining({ runId: null, captureId: null, toolName: null })
    );
  });
});

describe("enrichment thread registry", () => {
  it("resolves a marked thread and forgets it on release", () => {
    markEnrichmentThread("t1", { runId: "run-1", captureId: "cap-1" });
    expect(enrichmentDiagnosticsForThread("t1")).toEqual({ runId: "run-1", captureId: "cap-1" });

    unmarkEnrichmentThread("t1");
    expect(enrichmentDiagnosticsForThread("t1")).toBeNull();
  });

  it("treats unknown / absent ids as non-enrichment", () => {
    expect(enrichmentDiagnosticsForThread("never-registered")).toBeNull();
    expect(enrichmentDiagnosticsForThread(null)).toBeNull();
    expect(enrichmentDiagnosticsForThread(undefined)).toBeNull();
  });
});
