import type { ReactElement } from "react";
import { Card, Row } from "../components";
import { formatBytes } from "../../../lib/format-bytes";
import { useStorageSnapshot } from "../../../lib/useStorageSnapshot";

export function StoragePage(): ReactElement {
  const {
    summary,
    snapshot,
    loading,
    workingAction,
    error,
    refresh,
    clearAppCache,
    maintainRenderCache
  } = useStorageSnapshot({ eagerSnapshot: true });
  const total = snapshot?.totalBytes ?? 0;
  const appCacheBytes =
    (snapshot?.chromiumHttpCache.bytes ?? 0) + (snapshot?.chromiumCodeCache.bytes ?? 0);
  const sourceCaptureCount =
    summary?.sourceCaptures.captureCount ?? snapshot?.sourceCaptures.captureCount ?? 0;
  const sourceCaptureBytes =
    summary?.sourceCaptures.bytes ?? snapshot?.sourceCaptures.bytes ?? 0;
  const storageBusy = workingAction !== null;

  return (
    <>
      <div className="pss__main-hdr">
        <div className="pss__main-hdr-l">
          <div className="pss__main-eyebrow">Library</div>
          <h1 className="pss__main-title">Storage & retention</h1>
          <p className="pss__main-sub">
            Local source captures, rendered derivatives, and Electron cache data.
          </p>
        </div>
        <div className="pss__main-actions">
          <button
            className="pss__top-btn"
            type="button"
            onClick={() => void refresh({ force: true })}
          >
            {loading ? "Refreshing" : "Refresh"}
          </button>
        </div>
      </div>

      <Card eyebrow="LOCAL STORAGE" title={snapshot === null ? "Calculating" : formatBytes(total)}>
        {error !== null ? (
          <Row label="Status" sub="The storage snapshot could not be read.">
            <span className="pss__row-tag">{error}</span>
          </Row>
        ) : null}
        <StorageRow
          label="Source captures"
          sub={`${sourceCaptureCount} snaps`}
          bytes={sourceCaptureBytes}
          total={total}
          detail={
            snapshot === null
              ? "—"
              : `${formatBytes(snapshot.sourceCaptures.documentsBytes)} in Documents · ${formatBytes(
                  snapshot.sourceCaptures.appSupportBytes
                )} legacy`
          }
        />
        <StorageRow
          label="Rendered derivatives"
          sub={`${snapshot?.renderCache.fileCount ?? 0} files`}
          bytes={snapshot?.renderCache.bytes ?? 0}
          total={total}
          detail="Trim keeps the rapid grid and reel sizes; clear removes every derivative."
          action={
            <span className="pss__storage-actions">
              <button
                className="pss__key-btn"
                type="button"
                disabled={storageBusy}
                onClick={() => void maintainRenderCache("trim")}
              >
                {workingAction === "render-trim" ? "Trimming" : "Trim"}
              </button>
              <button
                className="pss__key-btn"
                type="button"
                disabled={storageBusy}
                onClick={() => void maintainRenderCache("clear")}
              >
                {workingAction === "render-clear" ? "Clearing" : "Clear"}
              </button>
            </span>
          }
        />
        <StorageRow
          label="App cache"
          sub={`limit ${formatBytes(snapshot?.chromiumHttpCache.limitBytes ?? 0)}`}
          bytes={appCacheBytes}
          total={total}
          detail={
            snapshot === null
              ? "—"
              : `${formatBytes(snapshot.chromiumHttpCache.bytes)} Chromium cache · ${formatBytes(
                  snapshot.chromiumCodeCache.bytes
                )} code cache`
          }
          action={
            <button
              className="pss__key-btn"
              type="button"
              disabled={storageBusy}
              onClick={() => void clearAppCache()}
            >
              {workingAction === "app-cache" ? "Clearing" : "Clear"}
            </button>
          }
        />
        <StorageRow
          label="Database"
          sub={snapshot === null ? "—" : `${snapshot.database.pageCount} pages`}
          bytes={
            (snapshot?.database.bytes ?? 0) +
            (snapshot?.database.walBytes ?? 0) +
            (snapshot?.database.shmBytes ?? 0)
          }
          total={total}
          detail={
            snapshot === null
              ? "—"
              : `${formatBytes(snapshot.database.bytes)} DB · ${formatBytes(
                  snapshot.database.walBytes + snapshot.database.shmBytes
                )} WAL/SHM · ${snapshot.database.freelistCount} free pages`
          }
        />
        <StorageRow
          label="Other Electron data"
          sub={`${snapshot?.otherAppSupport.fileCount ?? 0} files`}
          bytes={
            (snapshot?.otherAppSupport.bytes ?? 0) +
            (snapshot?.chromiumGpuCaches.bytes ?? 0)
          }
          total={total}
          detail={
            snapshot === null
              ? "—"
              : `${formatBytes(snapshot.chromiumGpuCaches.bytes)} GPU caches · ${formatBytes(
                  snapshot.otherAppSupport.bytes
                )} other`
          }
        />
      </Card>
    </>
  );
}

function StorageRow({
  label,
  sub,
  bytes,
  total,
  detail,
  action
}: {
  label: string;
  sub: string;
  bytes: number;
  total: number;
  detail: string;
  action?: ReactElement;
}): ReactElement {
  const percent = total > 0 ? Math.max(0.01, Math.min(100, (bytes / total) * 100)) : 0;
  return (
    <Row label={label} sub={sub}>
      <div className="pss__storage-row">
        <div className="pss__storage-top">
          <span className="pss__storage-bytes">{formatBytes(bytes)}</span>
          {action}
        </div>
        <div className="pss__storage-bar" aria-hidden="true">
          <span style={{ width: `${percent}%` }} />
        </div>
        <div className="pss__storage-detail">{detail}</div>
      </div>
    </Row>
  );
}
