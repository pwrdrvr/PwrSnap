import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

// The Electron entrypoint has process-wide startup side effects. Pin its
// production wiring here; the filesystem/gate behavior runs against real
// temporary directories in render-cache-maintenance.test.ts.
describe("startup storage maintenance wiring", () => {
  test("awaits durable source repair but starts rebuildable cache maintenance without awaiting it", async () => {
    const source = await readFile(new URL("../index.ts", import.meta.url), "utf8");
    expect(source).toContain("await migrateLegacyCaptureSources();");
    expect(source).not.toContain("await migrateLegacyRenderCache();");
    expect(source).toContain("void migrateLegacyRenderCache()");
    const migration = source.indexOf("void migrateLegacyRenderCache()");
    expect(migration).toBeGreaterThan(source.indexOf("await migrateLegacyCaptureSources();"));
    // Admission must close before handlers/IPC can receive a cleanup request,
    // so Clear cannot run first and have maintenance restore the old cache.
    expect(migration).toBeLessThan(source.indexOf("registerStorageHandlers("));
    const normalBoot = source.slice(source.indexOf("// ── Normal boot"), migration);
    expect(normalBoot).toContain('if (role === "library")');
    expect(normalBoot).toContain('openDatabase({ migrations: "verify" })');
    expect(normalBoot).toMatch(/if \(!startupProfilingEnabled\(\)\) \{\s*$/);
    expect(source.slice(migration, migration + 550)).toContain('.catch(');
  });
});
