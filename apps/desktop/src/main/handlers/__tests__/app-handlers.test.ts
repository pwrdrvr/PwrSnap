import { describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  showAppDocumentWindow: vi.fn(),
  openExternal: vi.fn(async () => undefined)
}));

vi.mock("../../window", () => ({
  showAppDocumentWindow: mocks.showAppDocumentWindow
}));

vi.mock("electron", (): Partial<typeof import("electron")> => ({
  app: {
    getVersion: () => "1.0.0-test",
    getAppPath: () => process.cwd()
  } as unknown as typeof import("electron").app,
  shell: {
    openExternal: mocks.openExternal
  } as unknown as typeof import("electron").shell
}));

import { bus } from "../../command-bus";
import { registerAppHandlers } from "../app-handlers";

registerAppHandlers();

describe("app:* handlers", () => {
  test("app:version returns runtime metadata", async () => {
    const result = await bus.dispatch("app:version", {}, { principal: "ipc" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.version).toBe("1.0.0-test");
    expect(result.value.nodeVersion).toBe(process.versions.node);
  });

  test("app:readDocument reads the bundled changelog", async () => {
    const result = await bus.dispatch(
      "app:readDocument",
      { kind: "changelog" },
      { principal: "ipc" }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.title).toBe("Changelog");
    expect(result.value.content).toContain("# Changelog");
  });

  test("app:readDocument reads third-party licenses", async () => {
    const result = await bus.dispatch(
      "app:readDocument",
      { kind: "third-party-licenses" },
      { principal: "ipc" }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.title).toBe("Third-Party Licenses");
    expect(result.value.content).toContain("PwrSnap Third-Party Licenses");
  });

  test("app:readDocument rejects an unknown kind", async () => {
    const result = await bus.dispatch(
      "app:readDocument",
      { kind: "not-a-document" } as never,
      { principal: "ipc" }
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.kind).toBe("validation");
    expect(result.error.code).toBe("invalid_document_kind");
  });

  test("app:openDocumentWindow opens the requested document kind", async () => {
    mocks.showAppDocumentWindow.mockReset();

    const result = await bus.dispatch(
      "app:openDocumentWindow",
      { kind: "third-party-licenses" },
      { principal: "ipc" }
    );

    expect(result.ok).toBe(true);
    expect(mocks.showAppDocumentWindow).toHaveBeenCalledWith("third-party-licenses");
  });

  test("app:openExternal opens allowlisted https URLs", async () => {
    mocks.openExternal.mockClear();
    for (const url of [
      "https://pwrsnap.com",
      "https://docs.pwrsnap.com",
      "https://github.com/pwrdrvr/PwrSnap"
    ]) {
      const result = await bus.dispatch("app:openExternal", { url }, { principal: "ipc" });
      expect(result.ok).toBe(true);
      expect(mocks.openExternal).toHaveBeenCalledWith(url);
    }
  });

  test("app:openExternal refuses non-allowlisted hosts and non-https URLs", async () => {
    mocks.openExternal.mockClear();
    for (const url of [
      "https://evil.example.com",
      "http://pwrsnap.com", // non-https
      "https://notpwrsnap.com",
      "https://pwrsnap.com.evil.com", // suffix-spoof
      "javascript:alert(1)",
      "not a url"
    ]) {
      const result = await bus.dispatch("app:openExternal", { url }, { principal: "ipc" });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected error");
      expect(result.error.code).toBe("url_not_allowed");
    }
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });
});
