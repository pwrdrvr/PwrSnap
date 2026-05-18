import type { ReactElement } from "react";
import { Card, Row, SegmentedControl, Switch, type SegmentOption } from "../components";
import { useSettingsContext } from "../SettingsContext";
import type { UpdateChannel } from "@pwrsnap/shared";

const UPDATE_CHANNEL_OPTIONS: readonly SegmentOption<UpdateChannel>[] = [
  { id: "latest", label: "Stable" },
  { id: "prerelease", label: "Prerelease" }
];

export function ExperimentalPage(): ReactElement {
  const { settings, patch } = useSettingsContext();
  const v2 = settings?.experimental.v2FileFormat ?? false;
  const developerMode = settings?.general.developerMode ?? false;
  const channel: UpdateChannel = settings?.updates.channel ?? "latest";
  const ready = settings !== null;

  const onV2Change = ready
    ? (next: boolean): void => {
        void patch({ experimental: { v2FileFormat: next } });
      }
    : undefined;

  const onDeveloperModeChange = ready
    ? (next: boolean): void => {
        void patch({ general: { developerMode: next } });
      }
    : undefined;

  const onChannelChange = ready
    ? (next: UpdateChannel): void => {
        void patch({ updates: { channel: next } });
      }
    : (): void => {};

  return (
    <>
      <div className="pss__main-hdr">
        <div className="pss__main-hdr-l">
          <div className="pss__main-eyebrow">Advanced</div>
          <h1 className="pss__main-title">Experimental</h1>
          <p className="pss__main-sub">
            Features that may change, break, or disappear. Toggles persist; the
            underlying feature might not exist yet.
          </p>
        </div>
      </div>

      <Card eyebrow="UPDATES" title="Update channel">
        <Row
          label="Release stream"
          sub='"Stable" tracks the latest signed release. "Prerelease" includes betas and alphas — earlier features, more rough edges. Takes effect on the next update check.'
          tag={channel}
        >
          <SegmentedControl
            options={UPDATE_CHANNEL_OPTIONS}
            value={channel}
            onChange={onChannelChange}
          />
        </Row>
      </Card>

      <Card eyebrow="DEVELOPER" title="Developer mode">
        <Row
          label="Show developer menu items"
          sub="Expose Reload, Force Reload, and Toggle Developer Tools in the View menu. Useful for filing bug reports or hacking on PwrSnap."
          tag="developer"
        >
          <Switch on={developerMode} onChange={onDeveloperModeChange} />
        </Row>
      </Card>

      <Card eyebrow="FILE FORMAT" title="File format">
        <Row
          label="PwrSnap1 capture format"
          sub="Build coming in a later release. Toggle persists so you can opt in early."
          tag="experimental"
        >
          <Switch on={v2} onChange={onV2Change} />
        </Row>
      </Card>
    </>
  );
}
