import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { app } from "electron";
import type { AppDocument, AppDocumentKind } from "@pwrsnap/shared";

const DOCUMENTS: Record<AppDocumentKind, { fileName: string; title: string }> = {
  changelog: { fileName: "CHANGELOG.md", title: "Changelog" },
  "third-party-licenses": {
    fileName: "THIRD_PARTY_LICENSES",
    title: "Third-Party Licenses"
  }
};

export function isAppDocumentKind(value: unknown): value is AppDocumentKind {
  return value === "changelog" || value === "third-party-licenses";
}

export function resolveAppDocumentPath(
  kind: AppDocumentKind,
  roots: {
    resourcesPath?: string | undefined;
    appPath?: string | undefined;
    cwd?: string | undefined;
  } = {}
): string {
  const { fileName } = DOCUMENTS[kind];
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
  const definition = DOCUMENTS[kind];
  const content = await readFile(resolveAppDocumentPath(kind), "utf8");
  return {
    kind,
    title: definition.title,
    content
  };
}
