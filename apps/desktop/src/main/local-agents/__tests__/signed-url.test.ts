import { describe, expect, test, vi } from "vitest";
import { LocalAgentSignedUrlService } from "../signed-url";

describe("LocalAgentSignedUrlService", () => {
  test("mints, verifies, expires, and rejects tampered media grants", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T12:00:00.000Z"));
    const service = new LocalAgentSignedUrlService(Buffer.alloc(32, 7));
    const minted = service.mint({
      baseUrl: "http://127.0.0.1:12345",
      resourceUri: "pwrsnap://capture/cap_1/composite",
      clientId: "lag_1",
      ttlMs: 1_000
    });

    expect(service.verify(new URL(minted.url))).toEqual({
      resourceUri: "pwrsnap://capture/cap_1/composite",
      clientId: "lag_1",
      expiresAt: Date.parse("2026-07-31T12:00:01.000Z")
    });

    const tampered = new URL(minted.url);
    tampered.searchParams.set("signature", "bad");
    expect(service.verify(tampered)).toBeNull();

    vi.advanceTimersByTime(1_001);
    expect(service.verify(new URL(minted.url))).toBeNull();
    vi.useRealTimers();
  });
});
