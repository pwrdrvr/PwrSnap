// Settings → AI Providers → Apple Intelligence.
//
// The on-device model needs no key and no install, so this screen has one
// job: say what macOS reports, and when a step is missing, hand the user a
// prompt their own agent can act on. PwrSnap itself only reads — it never
// agrees to Apple's terms, changes fm's configuration, or installs anything.
//
// Design reference: "PwrSnap — Apple Intelligence" on the PwrSnap canvas.

import { useState, type ReactElement } from "react";
import {
  APPLE_FM_LINKS,
  appleFmAgentPrompt,
  appleFmStateCopy,
  appleFmTerminalCommand,
  type AppleFmStatus,
  type AppleFmTestResult
} from "@pwrsnap/shared";
import { dispatch } from "../../../lib/pwrsnap";
import { Card, Row } from "../components";
import { copyLabel, useCopyCommand } from "../CodexUpgradeHelp";

export type AppleIntelligenceCardProps = {
  /** Null until macOS has answered once. */
  status: AppleFmStatus | null;
  loading: boolean;
  /** Captions (or their fallback) are set to the on-device model. */
  inUse: boolean;
  /** Captions themselves are set to it; hides "Use for captions". */
  captionsRouted: boolean;
  onRecheck: () => void;
  onUseForCaptions: () => void;
};

type TestState =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "passed"; result: AppleFmTestResult }
  | { phase: "failed"; message: string };

function checkedLabel(checkedAt: number): string {
  return `Checked ${new Date(checkedAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  })}`;
}

function openLink(url: string): void {
  void dispatch("app:openExternal", { url });
}

type TerminalOpenState = "idle" | "opening" | "failed";

/** The one step only an administrator can take: copy the command, open
 *  Terminal, paste it there. PwrSnap launches Terminal empty and types
 *  nothing, so reading and agreeing to Apple's terms stays with the user. */
function TerminalStep({ command }: { command: string }): ReactElement {
  const { state: copyState, copy } = useCopyCommand(command);
  const [openState, setOpenState] = useState<TerminalOpenState>("idle");
  const openTerminal = (): void => {
    setOpenState("opening");
    void dispatch("appleFm:openTerminal", {}).then((result) => {
      setOpenState(result.ok ? "idle" : "failed");
    });
  };
  return (
    <div className="pss__afm-term">
      <div className="pss__afm-term-hdr">
        <span className="pss__afm-term-k" id="pss-afm-term-title">
          Run in Terminal
        </span>
        <span className="pss__afm-term-hint">
          Needs an administrator's password. Apple's terms open in Terminal to read before
          agreeing.
        </span>
      </div>
      <p className="pss__afm-term-hint">
        What the terms let the model be used for is in{" "}
        <a
          className="pss__text-link"
          href={APPLE_FM_LINKS.acceptableUse.url}
          onClick={(event) => {
            // Same pairing as the "From Apple" links: the guard refuses a
            // navigation; this path opens the browser and reports failure.
            event.preventDefault();
            openLink(APPLE_FM_LINKS.acceptableUse.url);
          }}
        >
          {APPLE_FM_LINKS.acceptableUse.label}
        </a>
        . The license Terminal shows does not link to it.
      </p>
      <div className="pss__afm-term-row">
        <code className="pss__afm-term-cmd" aria-labelledby="pss-afm-term-title">
          {command}
        </code>
        <button
          className="pss__key-btn"
          type="button"
          aria-label={
            copyState === "copied"
              ? "Copied the Terminal command"
              : copyState === "failed"
                ? "Copying the Terminal command failed"
                : "Copy the Terminal command"
          }
          onClick={() => {
            void copy();
          }}
        >
          {copyLabel(copyState, "Copy")}
        </button>
        <button
          className="pss__key-btn is-primary"
          type="button"
          disabled={openState === "opening"}
          onClick={openTerminal}
        >
          Open Terminal
        </button>
      </div>
      <p className="pss__afm-term-foot">
        {openState === "failed"
          ? "Terminal couldn't be opened. Open it from Applications › Utilities and paste the command there."
          : "The command macOS names, with the tool's full path. Afterwards, press Check again."}
      </p>
    </div>
  );
}

export function AppleIntelligenceCard({
  status,
  loading,
  inUse,
  captionsRouted,
  onRecheck,
  onUseForCaptions
}: AppleIntelligenceCardProps): ReactElement {
  const [test, setTest] = useState<TestState>({ phase: "idle" });
  const prompt = status !== null ? appleFmAgentPrompt(status) : null;
  const terminalCommand = status !== null ? appleFmTerminalCommand(status) : null;
  const { state: copyState, copy } = useCopyCommand(prompt ?? undefined);

  const recheck = (
    <button className="pss__top-btn" type="button" disabled={loading} onClick={onRecheck}>
      {loading ? "Checking…" : "Check again"}
    </button>
  );

  if (status === null) {
    return (
      <Card eyebrow="ON THIS MAC" title="On-device model" headerAction={recheck}>
        <Row label="Can it run?" sub="PwrSnap asks macOS and reads only what it answers.">
          <div className="pss__afm-status" role="status">
            <span className="pss__afm-status-title">
              {loading ? "Asking macOS…" : "Not checked yet"}
            </span>
          </div>
        </Row>
      </Card>
    );
  }

  const copyText = appleFmStateCopy(status);
  const ready = status.state === "ready";
  // Grey for a Mac that simply cannot run it; red once captions depend on it.
  const tone = ready ? "ok" : inUse ? "bad" : copyText.severity === "needs" ? "off" : "warn";
  const badgeClass =
    tone === "ok" ? " is-using" : tone === "bad" ? " is-danger" : tone === "warn" ? " is-warn" : "";

  const runTest = (): void => {
    setTest({ phase: "running" });
    void dispatch("appleFm:test", {}).then((result) => {
      setTest(
        result.ok
          ? { phase: "passed", result: result.value }
          : { phase: "failed", message: result.error.message }
      );
      // A failed test can mean the state moved; show what macOS says now.
      if (!result.ok) onRecheck();
    });
  };

  return (
    <Card eyebrow="ON THIS MAC" title="On-device model" headerAction={recheck}>
      <Row
        label="Can it run?"
        sub="PwrSnap asks macOS and reads only what it answers. It never agrees to terms, installs anything or changes a setting."
      >
        <div className={`pss__afm-status is-${tone}`} role="status">
          <div className="pss__afm-status-hdr">
            <span className="pss__afm-status-title">{copyText.title}</span>
            <span className={"pss__badge" + badgeClass}>{copyText.badge}</span>
          </div>
          <p className="pss__afm-status-body">{copyText.body}</p>
          {status.detail !== null ? (
            <p className="pss__afm-status-said">
              <span>macOS said: </span>
              {status.detail}
            </p>
          ) : null}
          {terminalCommand !== null ? <TerminalStep command={terminalCommand} /> : null}
          {!ready && inUse ? (
            <p className="pss__afm-status-body">
              Captions are set to this model, so new captures won't get one until it is ready.
            </p>
          ) : null}
          <span className="pss__afm-checked">{checkedLabel(status.checkedAt)}</span>
        </div>
        {ready && !captionsRouted ? (
          <div className="pss__afm-adopt">
            <button className="pss__key-btn is-primary" type="button" onClick={onUseForCaptions}>
              Use for captions
            </button>
            <span className="pss__afm-note">
              Sets Capture captions, tags &amp; OCR to this model. Chat is unchanged.
            </span>
          </div>
        ) : null}
      </Row>

      {ready ? (
        <Row
          label="Try it"
          sub="Sends one short text prompt to the model and times the answer. No capture is used."
        >
          <div className="pss__test">
            <span className="pss__test-icon" aria-hidden="true">
              fm
            </span>
            <div className="pss__test-l">
              <span className="pss__test-cmd">
                {test.phase === "passed"
                  ? `Answered in ${(test.result.ms / 1000).toFixed(1)} s`
                  : test.phase === "failed"
                    ? "No answer"
                    : "Model test"}
              </span>
              <span className="pss__test-sub">
                {test.phase === "failed"
                  ? test.message
                  : test.phase === "running"
                    ? "Waiting for the model…"
                    : `${status.modelLabel ?? "On-device model"} · on this Mac`}
              </span>
            </div>
            <div className="pss__test-r" role="status">
              {test.phase === "passed" ? <span className="pss__badge is-using">PASS</span> : null}
              {test.phase === "failed" ? <span className="pss__badge is-danger">FAIL</span> : null}
              <button
                className="pss__test-btn"
                type="button"
                disabled={test.phase === "running"}
                onClick={runTest}
              >
                {test.phase === "running" ? "Testing…" : "Test"}
              </button>
            </div>
          </div>
        </Row>
      ) : null}

      {ready ? (
        <Row label="Before you rely on it" sub="What this model is, and what it is not.">
          <ul className="pss__afm-facts">
            <li>
              <b>It runs on this Mac.</b> The capture is not sent to a server. No account, no
              key, no bill.
            </li>
            <li>
              <b>Captions only.</b> Title, description, tags and file name. Chat still needs an
              agent or a connection.
            </li>
            <li>
              <b>It is a small model.</b> Descriptions are shorter than a cloud model's, and it
              can misread small text.
            </li>
            <li>
              <b>It can decline a capture.</b> Apple's safety checks sometimes stop a request.
              That caption fails; the capture is never sent to another provider instead.
            </li>
          </ul>
        </Row>
      ) : null}

      {prompt !== null ? (
        <Row
          label="Get help setting it up"
          sub="Paste this into the agent you already use. It can look at this Mac, which PwrSnap can't, and walk you through the step that's missing."
        >
          <div className="pss__afm-prompt">
            <div className="pss__afm-prompt-hdr">
              <span id="pss-afm-prompt-title">Prompt for your agent</span>
              <button
                className="pss__key-btn"
                type="button"
                aria-label={
                  copyState === "copied"
                    ? "Copied the prompt for your agent"
                    : copyState === "failed"
                      ? "Copying the prompt for your agent failed"
                      : "Copy the prompt for your agent"
                }
                onClick={() => {
                  void copy();
                }}
              >
                {copyLabel(copyState, "Copy prompt")}
              </button>
            </div>
            <pre className="pss__pair-command pss__afm-prompt-text" aria-labelledby="pss-afm-prompt-title">
              {prompt}
            </pre>
          </div>
        </Row>
      ) : null}

      {!ready && copyText.links.length > 0 ? (
        <Row
          label="From Apple"
          sub="Apple's own pages on what the model needs. They open in your browser."
        >
          {copyText.severity === "needs" ? (
            <ul className="pss__afm-facts">
              <li>
                <b>macOS 27 or later</b>, on a Mac with M1 or later.
              </li>
              <li>
                <b>Device language and Siri language</b> set to the same supported language.
              </li>
              <li>
                <b>Free storage</b> for the models: up to 14 GB on some Macs, up to 8 GB on
                others.
              </li>
            </ul>
          ) : null}
          <ul className="pss__afm-links">
            {copyText.links.map((id) => {
              const link = APPLE_FM_LINKS[id];
              return (
                <li key={id}>
                  <a
                    className="pss__text-link"
                    href={link.url}
                    onClick={(event) => {
                      // The guard refuses a navigation; this is the path that
                      // reports a failure. Same pairing as About's links.
                      event.preventDefault();
                      openLink(link.url);
                    }}
                  >
                    {link.label}
                  </a>
                </li>
              );
            })}
          </ul>
          {!inUse ? (
            <span className="pss__afm-note">
              Captions keep running on whatever AI Features has selected. Nothing here needs
              fixing unless you want this model.
            </span>
          ) : null}
        </Row>
      ) : null}
    </Card>
  );
}
