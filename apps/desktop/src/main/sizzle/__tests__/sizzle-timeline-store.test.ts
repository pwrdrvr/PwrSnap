import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { SizzleTimelineSchema } from "@pwrsnap/shared";
import { SizzleStore } from "../sizzle-store";

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const store = async (): Promise<{ live: SizzleStore; path: string }> => {
  const root = await mkdtemp(join(tmpdir(), "sizzle-revisions-"));
  roots.push(root);
  const path = join(root, "projects.json");
  return { live: new SizzleStore({ filePath: path }), path };
};
const timeline = SizzleTimelineSchema.parse({
  version: 1,
  width: 320,
  height: 180,
  scenes: [{ id: "first", durationFrames: 30, layers: [] }],
});

describe("persisted timeline revision model", () => {
  it("never reuses a revision even when writes occur within the same clock tick", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-05T00:00:00Z"));
    const { live } = await store();
    const created = await live.create("Reel");
    const first = await live.setTimeline(
      created.id,
      timeline,
      created.modifiedAt,
    );
    const renamed = await live.update(created.id, { name: "Renamed" });
    expect(Date.parse(renamed.modifiedAt)).toBeGreaterThan(
      Date.parse(first.modifiedAt),
    );
    await expect(
      live.setTimeline(created.id, timeline, created.modifiedAt),
    ).rejects.toThrow("changed");
  });

  it("adds a prepared take only if its original project revision still matches", async () => {
    await fc.assert(fc.asyncProperty(fc.boolean(), async (assetFirst) => {
      const { live, path } = await store();
      const created = await live.create("Reel");
      const asset = { id: "a".repeat(64), name: "Narration", kind: "audio" as const,
        extension: ".wav" as const, byteSize: 44, durationSec: 2, width: 0, height: 0 };
      const writeTimeline = () => live.setTimeline(created.id, timeline, created.modifiedAt);
      const writeAsset = () => live.addAsset(created.id, asset, created.modifiedAt);
      const outcomes = await Promise.allSettled((assetFirst ? [writeAsset, writeTimeline] : [writeTimeline, writeAsset]).map(write => write()));
      expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
      const persisted = await new SizzleStore({ filePath: path }).get(created.id);
      expect(Boolean(persisted?.timeline)).toBe(!assetFirst);
      expect(persisted?.assets ?? []).toHaveLength(Number(assetFirst));
    }), { numRuns: 10 });
  });

  it("admits exactly one writer from a shared revision, and survives a process restart", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 300 }), {
          minLength: 2,
          maxLength: 8,
        }),
        async (lengths) => {
          const { live, path } = await store();
          const created = await live.create("Reel");
          const outcomes = await Promise.allSettled(
            lengths.map((durationFrames) =>
              live.setTimeline(
                created.id,
                {
                  ...timeline,
                  scenes: [{ ...timeline.scenes[0]!, durationFrames }],
                },
                created.modifiedAt,
              ),
            ),
          );
          expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(
            1,
          );
          const persisted = await new SizzleStore({ filePath: path }).get(
            created.id,
          );
          expect(persisted?.timeline?.scenes[0]?.durationFrames).toBe(
            lengths[0],
          );
          expect(persisted).toEqual(await live.get(created.id));
        },
      ),
      { numRuns: 20 },
    );
  });
});
