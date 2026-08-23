import { getSnapshotProtocolSource } from "./capture/screen-snapshot";
import { fileResponse } from "./protocol-file-response";

const SNAPSHOT_CACHE_CONTROL = "no-store";

/**
 * Serve a short-lived selector snapshot from its registered representation.
 * Windows previews remain in memory; macOS/Linux keep the streamed temp-file
 * path. Both are explicitly non-cacheable because release invalidates the ID.
 */
export async function screenSnapshotProtocolResponse(
  id: string,
  request: Request
): Promise<Response> {
  const source = getSnapshotProtocolSource(id);
  if (source === null) {
    return new Response("not found", {
      status: 404,
      headers: { "cache-control": SNAPSHOT_CACHE_CONTROL }
    });
  }
  if (source.kind === "file") {
    return fileResponse(source.filePath, request, {
      cacheControl: SNAPSHOT_CACHE_CONTROL
    });
  }
  return new Response(source.bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "cache-control": SNAPSHOT_CACHE_CONTROL,
      "content-type": source.mimeType,
      "content-length": String(source.bytes.byteLength),
      "x-content-type-options": "nosniff"
    }
  });
}
