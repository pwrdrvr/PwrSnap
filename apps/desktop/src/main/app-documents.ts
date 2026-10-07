import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { app } from "electron";
import {
  APP_DOCUMENT_TITLES,
  type AppDocument,
  type AppDocumentKind
} from "@pwrsnap/shared";

/** The bundled file behind each document. All three ship as
 *  `extraResources` (electron-builder.yml) and are required by
 *  verify-asar-contents.mjs; in a dev checkout they sit at the repo root. */
const DOCUMENT_FILES: Record<AppDocumentKind, string> = {
  changelog: "CHANGELOG.md",
  license: "LICENSE",
  "third-party-licenses": "THIRD_PARTY_LICENSES"
};

export function resolveAppDocumentPath(
  kind: AppDocumentKind,
  roots: {
    resourcesPath?: string | undefined;
    appPath?: string | undefined;
    cwd?: string | undefined;
  } = {}
): string {
  const fileName = DOCUMENT_FILES[kind];
  const resourcesPath =
    roots.resourcesPath ??
    (typeof process.resourcesPath === "string" ? process.resourcesPath : undefined);
  const appPath = roots.appPath ?? app.getAppPath();
  const cwd = roots.cwd ?? process.cwd();
  const candidates = [
    resourcesPath === undefined ? undefined : resolve(resourcesPath, fileName),
    resolve(appPath, "..", "..", fileName),
    resolve(appPath, fileName),
    resolve(cwd, "..", "..", fileName),
    resolve(cwd, fileName)
  ].filter((candidate): candidate is string => candidate !== undefined);
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

export async function readAppDocument(kind: AppDocumentKind): Promise<AppDocument> {
  const content = await readFile(resolveAppDocumentPath(kind), "utf8");
  return {
    kind,
    title: APP_DOCUMENT_TITLES[kind],
    content
  };
}
