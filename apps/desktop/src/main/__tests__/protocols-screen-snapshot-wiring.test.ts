import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (request: Request) => Promise<Response>>(),
  screenSnapshotProtocolResponse: vi.fn()
}));

vi.mock("electron", () => ({
  app: {},
  protocol: {
    handle: vi.fn(
      (scheme: string, handler: (request: Request) => Promise<Response>) => {
        mocks.handlers.set(scheme, handler);
      }
    ),
    registerSchemesAsPrivileged: vi.fn()
  }
}));

vi.mock("../screen-snapshot-protocol-response", () => ({
  screenSnapshotProtocolResponse: mocks.screenSnapshotProtocolResponse
}));

vi.mock("../log", () => ({
  getMainLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}));

vi.mock("../startup-profiler", () => ({
  markStartup: vi.fn(),
  startupProfilingEnabled: () => false
}));

vi.mock("../storage/captures-access-health", () => ({
  reportCapturesAccessFailure: vi.fn()
}));

import {
  installProtocolHandlers,
  type ProtocolResolver
} from "../protocols";

const unusedResolver: ProtocolResolver = {
  captureSourcePath: vi.fn(async () => null),
  sourceBytesPath: vi.fn(async () => null),
  cacheFile: vi.fn(async () => null),
  videoAssetPath: vi.fn(async () => null),
  appIconPath: vi.fn(async () => null),
  sizzleOutputPath: vi.fn(async () => null)
};

describe("pwrsnap-screen protocol production wiring", () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.screenSnapshotProtocolResponse.mockReset();
  });

  test("delegates the registered screen handler to the registry-aware responder", async () => {
    const expected = new Response("preview", {
      status: 200,
      headers: { "content-type": "image/jpeg" }
    });
    mocks.screenSnapshotProtocolResponse.mockResolvedValue(expected);
    installProtocolHandlers(unusedResolver);

    const handler = mocks.handlers.get("pwrsnap-screen");
    expect(handler).toBeTypeOf("function");
    const request = new Request("pwrsnap-screen://r/memory-id");
    const response = await handler!(request);

    expect(response).toBe(expected);
    expect(mocks.screenSnapshotProtocolResponse).toHaveBeenCalledTimes(1);
    expect(mocks.screenSnapshotProtocolResponse).toHaveBeenCalledWith(
      "memory-id",
      request
    );
  });
});
