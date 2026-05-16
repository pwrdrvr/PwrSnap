// About page — version + license + links. The version block reads
// from the new `app:version` bus verb (apps/desktop/src/main/handlers/
// app-handlers.ts). License row is a hard-coded string from
// CLAUDE.md; links are inert placeholders until we have real URLs.

import { useEffect, useState, type ReactElement } from "react";
import { Card, Row } from "../components";
import { dispatch } from "../../../lib/pwrsnap";

type VersionInfo = {
  version: string;
  electronVersion: string;
  nodeVersion: string;
  chromeVersion: string;
};

export function AboutPage(): ReactElement {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [documentError, setDocumentError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await dispatch("app:version", {});
      if (cancelled) return;
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setInfo(result.value);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function openDocument(kind: "changelog" | "third-party-licenses"): Promise<void> {
    setDocumentError(null);
    const result = await dispatch("app:openDocumentWindow", { kind });
    if (!result.ok) {
      setDocumentError(result.error.message);
    }
  }

  return (
    <>
      <div className="pss__main-hdr">
        <div className="pss__main-hdr-l">
          <div className="pss__main-eyebrow">Advanced</div>
          <h1 className="pss__main-title">About PwrSnap</h1>
          <p className="pss__main-sub">
            Build metadata, license terms, and links to the project. PwrSnap is
            a closed-source product of PwrDrvr LLC; this release is for
            personal use under the proprietary terms below.
          </p>
        </div>
      </div>

      <Card eyebrow="BUILD" title="Build">
        <Row label="App version" sub="Reported by Electron at runtime." tag="version">
          <span className="pss__opt-primary">{info?.version ?? "—"}</span>
        </Row>
        <Row label="Electron" sub="Runtime version." tag="electron">
          <span className="pss__opt-primary">{info?.electronVersion ?? "—"}</span>
        </Row>
        <Row label="Node" sub="Bundled with Electron." tag="node">
          <span className="pss__opt-primary">{info?.nodeVersion ?? "—"}</span>
        </Row>
        <Row label="Chromium" sub="Renderer engine." tag="chrome">
          <span className="pss__opt-primary">{info?.chromeVersion ?? "—"}</span>
        </Row>
        {error !== null ? (
          <Row label="Status" sub="" tag="error">
            <span className="pss__opt-sub">Failed to load version: {error}</span>
          </Row>
        ) : null}
      </Card>

      <Card eyebrow="LICENSE" title="License">
        <Row
          label="Terms"
          sub="PwrSnap v1 is closed-source proprietary. Distribution, redistribution, or modification require a written grant from PwrDrvr LLC."
          tag="UNLICENSED"
        >
          <span className="pss__opt-primary">UNLICENSED · © 2026 PwrDrvr LLC</span>
        </Row>
        <Row
          label="Third-party notices"
          sub="Bundled dependency and font notices for this app build."
          tag="notices"
        >
          <button
            className="pss__top-btn"
            type="button"
            onClick={() => {
              void openDocument("third-party-licenses");
            }}
          >
            Open licenses
          </button>
        </Row>
        {documentError !== null ? (
          <Row label="Document status" sub="" tag="error">
            <span className="pss__opt-sub">Failed to open document: {documentError}</span>
          </Row>
        ) : null}
      </Card>

      <Card eyebrow="RELEASE NOTES" title="Changelog">
        <Row label="Release notes" sub="Bundled changelog for this app build." tag="changelog">
          <button
            className="pss__top-btn"
            type="button"
            onClick={() => {
              void openDocument("changelog");
            }}
          >
            Open changelog
          </button>
        </Row>
      </Card>

      <Card eyebrow="LINKS" title="Links">
        <Row label="Website" sub="Product page." tag="link">
          <a className="pss__opt-primary" href="#" onClick={(e) => e.preventDefault()}>
            pwrdrvr.com (coming soon)
          </a>
        </Row>
        <Row label="Repository" sub="Internal source." tag="link">
          <a className="pss__opt-primary" href="#" onClick={(e) => e.preventDefault()}>
            github.com/pwrdrvr/PwrSnap (private)
          </a>
        </Row>
      </Card>
    </>
  );
}
