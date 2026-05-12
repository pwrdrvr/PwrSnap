import type { Settings, SettingsPatch } from "@pwrsnap/shared";
import { getDb } from "../persistence/db";

const DEFAULT_SETTINGS: Settings = {
  codexCommand: "",
  aiEnabled: false,
  aiConsentAcceptedAt: null
};

type SettingsKey = keyof Settings;

const SETTINGS_KEYS: SettingsKey[] = ["codexCommand", "aiEnabled", "aiConsentAcceptedAt"];

function parseSetting(key: SettingsKey, value: string | null): Settings[SettingsKey] {
  switch (key) {
    case "codexCommand":
      return value ?? "";
    case "aiEnabled":
      return value === "true";
    case "aiConsentAcceptedAt":
      return value && value.trim().length > 0 ? value : null;
  }
}

function serializeSetting(value: Settings[SettingsKey]): string | null {
  if (typeof value === "boolean") return value ? "true" : "false";
  return value;
}

export function readSettings(): Settings {
  const db = getDb();
  const rows = db
    .prepare("SELECT key, value FROM app_settings WHERE key IN (?, ?, ?)")
    .all(...SETTINGS_KEYS) as Array<{ key: string; value: string | null }>;
  const next: Settings = { ...DEFAULT_SETTINGS };
  for (const row of rows) {
    if (!SETTINGS_KEYS.includes(row.key as SettingsKey)) continue;
    const key = row.key as SettingsKey;
    Object.assign(next, { [key]: parseSetting(key, row.value) });
  }
  return next;
}

export function writeSettings(patch: SettingsPatch): Settings {
  const db = getDb();
  const write = db.prepare(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES (@key, @value, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`
  );
  const tx = db.transaction(() => {
    for (const key of SETTINGS_KEYS) {
      if (!Object.hasOwn(patch, key)) continue;
      const value = patch[key];
      if (value === undefined) continue;
      write.run({ key, value: serializeSetting(value) });
    }
  });
  tx();
  return readSettings();
}
