// Voice / provider / resolution are set once per reel, so they hide
// behind a summary chip instead of taking a toolbar row every session.

import type { ReactElement } from "react";
import { SIZZLE_VOICES, type SizzleProject, type SizzleVoice } from "@pwrsnap/shared";

export type ReelSettingsProps = {
  project: SizzleProject;
  open: boolean;
  onToggle: () => void;
  onVoice: (voice: SizzleVoice) => void;
  onProvider: (provider: "openai") => void;
  onResolution: (resolution: "1080p" | "720p") => void;
};

export function ReelSettings({
  project,
  open,
  onToggle,
  onVoice,
  onProvider,
  onResolution
}: ReelSettingsProps): ReactElement {
  const resolutionLabel = project.resolution === "1080p" ? "1080p" : "720p";
  const providerLabel = project.ttsProvider === "openai" ? "OpenAI" : project.ttsProvider;
  return (
    <>
      <button
        type="button"
        className={"szl__reel-settings" + (open ? " is-open" : "")}
        aria-expanded={open}
        aria-controls="szl-reel-settings"
        onClick={onToggle}
        title="Voice, provider and resolution for this reel"
        data-testid="sizzle-reel-settings-toggle"
      >
        <span className="szl__reel-settings-label">Reel settings</span>
        <span className="szl__reel-settings-summary">
          {project.voice} · {providerLabel} · {resolutionLabel}
        </span>
        <span className="szl__title-caret" aria-hidden="true">{open ? "▴" : "▾"}</span>
      </button>
      <div
        id="szl-reel-settings"
        className="szl__reel-settings-fields"
        hidden={!open}
      >
      <label className="szl__field">
        <span>Voice</span>
        <select
          value={project.voice}
          onChange={(e) => onVoice(e.target.value as SizzleVoice)}
        >
          {SIZZLE_VOICES.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label className="szl__field">
        <span>Provider</span>
        <select
          value={project.ttsProvider}
          onChange={(e) => onProvider(e.target.value as "openai")}
        >
          <option value="openai">OpenAI</option>
        </select>
      </label>
      <label className="szl__field">
        <span>Resolution</span>
        <select
          value={project.resolution}
          onChange={(e) =>
            onResolution(e.target.value as "1080p" | "720p")
          }
        >
          <option value="1080p">1920 × 1080</option>
          <option value="720p">1280 × 720</option>
        </select>
      </label>
      </div>
    </>
  );
}
