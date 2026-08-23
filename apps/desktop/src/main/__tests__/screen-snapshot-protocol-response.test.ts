import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSnapshotProtocolSource: vi.fn(),
  fileResponse: vi.fn()
}));

vi.mock("../capture/screen-snapshot", () => ({
  getSnapshotProtocolSource: mocks.getSnapshotProtocolSource
}));

vi.mock("../protocol-file-response", () => ({
  fileResponse: mocks.fileResponse
}));

import { screenSnapshotProtocolResponse } from "../screen-snapshot-protocol-response";

describe("screenSnapshotProtocolResponse", () => {
  beforeEach(() => {
    mocks.getSnapshotProtocolSource.mockReset();
    mocks.fileResponse.mockReset();
  });

  test("streams registered file snapshots with no-store", async () => {
    const request = new Request("pwrsnap-screen://r/file-id");
    const expected = new Response("file bytes", { status: 200 });
    mocks.getSnapshotProtocolSource.mockReturnValue({
      kind: "file",
      filePath: "/tmp/pwrsnap-screen/file.png"
    });
    mocks.fileResponse.mockResolvedValue(expected);

    const response = await screenSnapshotProtocolResponse("file-id", request);

    expect(response).toBe(expected);
    expect(mocks.fileResponse).toHaveBeenCalledWith(
      "/tmp/pwrsnap-screen/file.png",
      request,
      { cacheControl: "no-store" }
    );
  });

  test("serves a registered in-memory JPEG with bounded response headers", async () => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    mocks.getSnapshotProtocolSource.mockReturnValue({
      kind: "memory",
      bytes,
      mimeType: "image/jpeg"
    });

    const response = await screenSnapshotProtocolResponse(
      "memory-id",
      new Request("pwrsnap-screen://r/memory-id")
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-length")).toBe(String(bytes.byteLength));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(mocks.fileResponse).not.toHaveBeenCalled();
  });

  test("returns no-store 404 for released or unknown snapshot IDs", async () => {
    mocks.getSnapshotProtocolSource.mockReturnValue(null);

    const response = await screenSnapshotProtocolResponse(
      "missing-id",
      new Request("pwrsnap-screen://r/missing-id")
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.fileResponse).not.toHaveBeenCalled();
  });
});
