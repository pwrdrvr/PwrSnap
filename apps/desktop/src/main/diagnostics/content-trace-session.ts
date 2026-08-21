// Session directory + manifest for a multi-process Chrome trace.
//
// Deliberately mirrors `hot-cpu-profile-session.ts`: same
// `<prefix>-<YYYY-MM-DD-HHMM>-<6 hex>` directory naming, same
// `session.json` manifest with a growing `artifacts` array, same
// `events.ndjson` breadcrumb log. Anyone who has read one session
// directory can read the other without re-learning the layout.

import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ContentTraceConfig } from "./content-trace-config";

export type ContentTraceEvent = {
  capturedAt: string;
  type: string;
  detail?: Record<string, unknown>;
};

export type ContentTraceProcessSnapshot = {
  pid: number;
  type: string;
  cpuPercent?: number;
  cumulativeCpuSeconds?: number;
  name?: string;
  serviceName?: string;
};

export type ContentTraceSession = {
  id: string;
  directoryName: string;
  directoryPath: string;
  eventsPath: string;
  createTracePath: (index: number) => string;
  appendEvent: (event: ContentTraceEvent) => Promise<void>;
  registerArtifact: (filename: string) => Promise<void>;
};

export type ContentTraceSessionCreateResult =
  | { ok: true; session: ContentTraceSession }
  | { ok: false; code: "SESSION_CREATE_FAILED"; message: string; cause: unknown };

type ContentTraceSessionManifest = {
  id: string;
  directoryName: string;
  createdAt: string;
  outputRoot: string;
  artifacts: string[];
  config: {
    categories: string[];
    durationMs: number;
    autoStartDelayMs: number;
  };
  versions: {
    appVersion: string;
    electronVersion: string;
    chromeVersion: string;
    nodeVersion: string;
  };
};

function formatSessionPrefix(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}-${hours}${minutes}`;
}

async function writeManifest(
  manifestPath: string,
  manifest: ContentTraceSessionManifest
): Promise<void> {
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export async function createContentTraceSession(options: {
  config: Extract<ContentTraceConfig, { enabled: true }>;
  createdAt?: Date;
  sessionId?: string;
  versions: ContentTraceSessionManifest["versions"];
}): Promise<ContentTraceSessionCreateResult> {
  const createdAt = options.createdAt ?? new Date();
  const sessionId = options.sessionId ?? randomBytes(3).toString("hex");
  const directoryName = `trace-${formatSessionPrefix(createdAt)}-${sessionId}`;
  const directoryPath = path.join(options.config.outputRoot, directoryName);
  const manifestPath = path.join(directoryPath, "session.json");
  const eventsPath = path.join(directoryPath, "events.ndjson");
  const artifacts: string[] = [];

  const manifest: ContentTraceSessionManifest = {
    id: sessionId,
    directoryName,
    createdAt: createdAt.toISOString(),
    outputRoot: options.config.outputRoot,
    artifacts,
    config: {
      categories: options.config.categories,
      durationMs: options.config.durationMs,
      autoStartDelayMs: options.config.autoStartDelayMs
    },
    versions: options.versions
  };

  try {
    await fs.mkdir(options.config.outputRoot, { recursive: true });
    await fs.mkdir(directoryPath);
    await writeManifest(manifestPath, manifest);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      code: "SESSION_CREATE_FAILED",
      message: `Unable to create trace diagnostics session in ${options.config.outputRoot}: ${reason}`,
      cause: error
    };
  }

  return {
    ok: true,
    session: {
      id: sessionId,
      directoryName,
      directoryPath,
      eventsPath,
      createTracePath: (index) =>
        path.join(directoryPath, `trace-${String(index).padStart(4, "0")}.json`),
      appendEvent: async (event) => {
        await fs.appendFile(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
      },
      registerArtifact: async (filename) => {
        artifacts.push(filename);
        await writeManifest(manifestPath, manifest);
      }
    }
  };
}
