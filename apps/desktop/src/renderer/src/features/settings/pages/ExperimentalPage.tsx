import type { ReactElement } from "react";
import { Card, Row, Switch } from "../components";
import { useSettingsContext } from "../SettingsContext";

export function ExperimentalPage(): ReactElement {
  const { settings, patch } = useSettingsContext();
  const v2 = settings?.experimental.v2FileFormat ?? false;
  const ready = settings !== null;

  const onChange = ready
    ? (next: boolean): void => {
        void patch({ experimental: { v2FileFormat: next } });
      }
    : undefined;

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

      <Card eyebrow="FILE FORMAT" title="File format">
        <Row
          label="PSP1 capture format"
          sub="Build coming in a later release. Toggle persists so you can opt in early."
          tag="experimental"
        >
          <Switch on={v2} onChange={onChange} />
        </Row>
      </Card>
    </>
  );
}
