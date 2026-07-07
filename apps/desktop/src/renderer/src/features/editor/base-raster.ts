// Moved to @pwrsnap/shared (packages/shared/src/base-raster.ts) so the
// crop projection in resolveCropViewport — used by main's compositor and
// paste placement as well as this renderer — identifies the base raster
// with the SAME sha-match logic as the editor. Re-exported here so the
// editor's existing import sites stay stable.
export { selectBaseRaster } from "@pwrsnap/shared";
